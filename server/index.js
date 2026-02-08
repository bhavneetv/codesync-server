import http from 'http';
import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const PORT = process.env.PORT || process.env.CODE_SYNC_RUNTIME_PORT || 3001;

const previews = new Map();

const rewriteRootUrls = (content, basePrefix) => {
  if (!content) return content;
  const safeBase = basePrefix.endsWith('/') ? basePrefix.slice(0, -1) : basePrefix;
  let updated = content;
  updated = updated.replace(
    /(src|href)=([\"'])\/(?!preview\/)/g,
    `$1=$2${safeBase}/`
  );
  updated = updated.replace(
    /srcset=([\"'])\/(?!preview\/)/g,
    `srcset=$1${safeBase}/`
  );
  updated = updated.replace(
    /url\(\s*([\"']?)\/(?!preview\/)/g,
    `url($1${safeBase}/`
  );
  return updated;
};

const getMimeType = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.mjs':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'text/plain; charset=utf-8';
  }
};

const cleanupPreview = (previewId) => {
  const preview = previews.get(previewId);
  if (!preview) return;
  if (preview.timer) {
    clearTimeout(preview.timer);
  }
  try {
    fs.rmSync(preview.workdir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
  previews.delete(previewId);
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const segments = url.pathname.split('/').filter(Boolean);

  if (segments[0] === 'preview') {
    const previewId = segments[1];
    const preview = previews.get(previewId);
    if (!preview) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Preview not found');
      return;
    }

    const relPathRaw = segments.slice(2).join('/') || 'index.html';
    const relPath = path.normalize(relPathRaw).replace(/^(\.\.(\/|\\|$))+/, '');
    const filePath = path.join(preview.workdir, relPath);

    if (!filePath.startsWith(preview.workdir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
      return;
    }

    try {
      const ext = path.extname(filePath).toLowerCase();
      let data = fs.readFileSync(filePath);
      if (ext === '.html' || ext === '.htm') {
        const basePrefix = `/preview/${previewId}`;
        const text = data.toString('utf8');
        data = Buffer.from(rewriteRootUrls(text, basePrefix), 'utf8');
      } else if (ext === '.css') {
        const basePrefix = `/preview/${previewId}`;
        const text = data.toString('utf8');
        data = Buffer.from(rewriteRootUrls(text, basePrefix), 'utf8');
      }
      res.writeHead(200, {
        'Content-Type': getMimeType(filePath),
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Failed to read preview file');
    }
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Code Sync runtime is running');
});

const wss = new WebSocketServer({ server });

const cleanupProcess = (proc, workdir) => {
  if (proc && !proc.killed) {
    proc.kill('SIGKILL');
  }
  if (workdir) {
    try {
      fs.rmSync(workdir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
};

const resolvePythonCommand = () => {
  return process.platform === 'win32' ? 'python' : 'python3';
};

const runCommand = (cmd, args, options) => {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    child.on('error', (err) => {
      resolve({ code: -1, stdout: '', stderr: err.message });
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
};

const fileExists = (filePath) => {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
};

const findJavaMainClass = (files, workdir, entryFile) => {
  const javaFiles = files.map(f => f.name).filter(n => n && n.endsWith('.java'));
  let fallbackClass = path.basename(entryFile, '.java');
  let fallbackPackage = '';

  for (const file of javaFiles) {
    const fullPath = path.join(workdir, file);
    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }
    const pkgMatch = content.match(/^\s*package\s+([\w.]+)\s*;/m);
    const pkg = pkgMatch ? pkgMatch[1] : '';
    if (file === entryFile) {
      fallbackPackage = pkg;
    }
    const hasMain = /static\s+void\s+main\s*\(\s*String\s*\[\]\s*\w*\s*\)/.test(content);
    const classMatch = content.match(/^\s*(public\s+)?class\s+(\w+)/m);
    const className = classMatch ? classMatch[2] : null;
    if (hasMain && className) {
      return pkg ? `${pkg}.${className}` : className;
    }
  }

  return fallbackPackage ? `${fallbackPackage}.${fallbackClass}` : fallbackClass;
};

wss.on('connection', (ws) => {
  let proc = null;
  let workdir = null;
  const ownedPreviews = new Set();

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', data: 'Invalid JSON message' }));
      return;
    }

    if (msg.type === 'run') {
      cleanupProcess(proc, workdir);
      proc = null;
      workdir = null;

      try {
        workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-sync-'));
        const files = Array.isArray(msg.files) ? msg.files : [];
        for (const file of files) {
          if (!file?.name) continue;
          const filePath = path.join(workdir, file.name);
          const dir = path.dirname(filePath);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(filePath, file.content || '', 'utf8');
        }

        const entryFile = msg.main || (files[0] ? files[0].name : 'main.py');
        const entryPath = path.join(workdir, entryFile);

        if (!fileExists(entryPath)) {
          ws.send(JSON.stringify({ type: 'error', data: `Entry file not found: ${entryFile}` }));
          cleanupProcess(proc, workdir);
          proc = null;
          workdir = null;
          return;
        }

        const language = msg.language;
        if (language === 'python') {
          const pythonCmd = resolvePythonCommand();
          proc = spawn(pythonCmd, ['-u', entryFile], {
            cwd: workdir,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } else if (language === 'node') {
          let useEsm = false;
          try {
            const entryContent = fs.readFileSync(entryPath, 'utf8');
            useEsm = /\b(import\s+|export\s+)/.test(entryContent);
          } catch {
            useEsm = false;
          }
          if (useEsm) {
            try {
              fs.writeFileSync(path.join(workdir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
            } catch {
              // ignore
            }
          }
          proc = spawn('node', [entryFile], {
            cwd: workdir,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } else if (language === 'java') {
          const javaFiles = files.map(f => f.name).filter(n => n && n.endsWith('.java'));
          const compile = await runCommand('javac', javaFiles, { cwd: workdir });
          if (compile.code !== 0) {
            ws.send(JSON.stringify({ type: 'error', data: compile.stderr || 'Java compilation failed' }));
            cleanupProcess(proc, workdir);
            proc = null;
            workdir = null;
            return;
          }
          const mainClass = findJavaMainClass(files, workdir, entryFile);
          proc = spawn('java', ['-cp', workdir, mainClass], {
            cwd: workdir,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } else if (language === 'c') {
          const cFiles = files.map(f => f.name).filter(n => n && n.endsWith('.c'));
          const output = process.platform === 'win32' ? 'app.exe' : 'app.out';
          const compile = await runCommand('gcc', [...cFiles, '-o', output], { cwd: workdir });
          if (compile.code !== 0) {
            ws.send(JSON.stringify({ type: 'error', data: compile.stderr || 'C compilation failed' }));
            cleanupProcess(proc, workdir);
            proc = null;
            workdir = null;
            return;
          }
          proc = spawn(path.join(workdir, output), [], {
            cwd: workdir,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } else if (language === 'cpp') {
          const cppFiles = files.map(f => f.name).filter(n => n && (n.endsWith('.cpp') || n.endsWith('.cc') || n.endsWith('.cxx')));
          const output = process.platform === 'win32' ? 'app.exe' : 'app.out';
          const compile = await runCommand('g++', [...cppFiles, '-o', output], { cwd: workdir });
          if (compile.code !== 0) {
            ws.send(JSON.stringify({ type: 'error', data: compile.stderr || 'C++ compilation failed' }));
            cleanupProcess(proc, workdir);
            proc = null;
            workdir = null;
            return;
          }
          proc = spawn(path.join(workdir, output), [], {
            cwd: workdir,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } else if (language === 'prolog') {
          proc = spawn('swipl', ['-q', '-s', entryFile], {
            cwd: workdir,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } else if (language === 'ruby') {
          proc = spawn('ruby', [entryFile], {
            cwd: workdir,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } else {
          ws.send(JSON.stringify({ type: 'error', data: `Language not supported: ${language}` }));
          cleanupProcess(proc, workdir);
          proc = null;
          workdir = null;
          return;
        }

        if (!proc) {
          ws.send(JSON.stringify({ type: 'error', data: 'Failed to start runtime process' }));
          cleanupProcess(proc, workdir);
          proc = null;
          workdir = null;
          return;
        }

        proc.stdout.on('data', (data) => {
          ws.send(JSON.stringify({ type: 'stdout', data: data.toString() }));
        });

        proc.stderr.on('data', (data) => {
          ws.send(JSON.stringify({ type: 'stderr', data: data.toString() }));
        });

        proc.on('close', (code) => {
          ws.send(JSON.stringify({ type: 'exit', data: code }));
          cleanupProcess(proc, workdir);
          proc = null;
          workdir = null;
        });

        proc.on('error', (err) => {
          ws.send(JSON.stringify({ type: 'error', data: `Failed to start runtime: ${err.message}` }));
          cleanupProcess(proc, workdir);
          proc = null;
          workdir = null;
        });

      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', data: `Runtime error: ${err.message}` }));
        cleanupProcess(proc, workdir);
        proc = null;
        workdir = null;
      }
      return;
    }

    if (msg.type === 'preview') {
      const requestId = msg.requestId;
      const previewId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
      let previewDir = null;

      try {
        previewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-sync-preview-'));
        const files = Array.isArray(msg.files) ? msg.files : [];
        for (const file of files) {
          if (!file?.name) continue;
          const filePath = path.join(previewDir, file.name);
          const dir = path.dirname(filePath);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(filePath, file.content || '', 'utf8');
        }

        const entryFile = msg.main || (files[0] ? files[0].name : 'index.html');
        const entryPath = entryFile.replace(/^[\\/]+/, '');
        const entryFull = path.join(previewDir, entryPath);

        if (!fileExists(entryFull)) {
          ws.send(JSON.stringify({
            type: 'preview-error',
            data: `Entry file not found: ${entryFile}`,
            requestId
          }));
          if (previewDir) {
            fs.rmSync(previewDir, { recursive: true, force: true });
          }
          return;
        }

        const timer = setTimeout(() => cleanupPreview(previewId), 10 * 60 * 1000);
        previews.set(previewId, { workdir: previewDir, timer });
        ownedPreviews.add(previewId);

        ws.send(JSON.stringify({
          type: 'preview',
          requestId,
          url: `/preview/${previewId}/${entryPath}`
        }));
      } catch (err) {
        if (previewDir) {
          try {
            fs.rmSync(previewDir, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }
        ws.send(JSON.stringify({
          type: 'preview-error',
          data: `Preview error: ${err.message}`,
          requestId
        }));
      }
      return;
    }

    if (msg.type === 'input') {
      if (proc && proc.stdin.writable) {
        proc.stdin.write(`${msg.data ?? ''}\n`);
      }
      return;
    }

    if (msg.type === 'terminate') {
      cleanupProcess(proc, workdir);
      proc = null;
      workdir = null;
      ws.send(JSON.stringify({ type: 'exit', data: 'terminated' }));
      return;
    }
  });

  ws.on('close', () => {
    cleanupProcess(proc, workdir);
    proc = null;
    workdir = null;
    for (const previewId of ownedPreviews) {
      cleanupPreview(previewId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Code Sync runtime server listening on ${PORT}`);
});

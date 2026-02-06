import http from 'http';
import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PORT = process.env.PORT || process.env.CODE_SYNC_RUNTIME_PORT || 3001;

const server = http.createServer((req, res) => {
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
  });
});

server.listen(PORT, () => {
  console.log(`Code Sync runtime server listening on ${PORT}`);
});

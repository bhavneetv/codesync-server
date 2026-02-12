import http from 'http';
import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const PORT = process.env.PORT || process.env.CODE_SYNC_RUNTIME_PORT || 3001;

const previews = new Map();

const baseHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, baseHeaders);
    res.end();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Code Sync runtime is running');
});

const wss = new WebSocketServer({ server });

const cleanupProcess = (proc, workdir) => {
  if (proc && !proc.killed) proc.kill('SIGKILL');
  if (workdir) {
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {}
  }
};

const resolvePythonCommand = () =>
  process.platform === 'win32' ? 'python' : 'python3';

const runCommand = (cmd, args, options) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, options);
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', d => stdout += d.toString());
    child.stderr?.on('data', d => stderr += d.toString());

    child.on('error', err => resolve({ code: -1, stdout: '', stderr: err.message }));
    child.on('close', code => resolve({ code, stdout, stderr }));
  });

/*
Detect the Java class that defines a runnable main method.
*/
const parseJavaClassInfo = (workdir, fileName) => {
  try {
    const content = fs.readFileSync(path.join(workdir, fileName), 'utf8');
    const pkgMatch = content.match(/^\s*package\s+([\w.]+)\s*;/m);
    const classMatch = content.match(/\b(class|record|enum)\s+([A-Za-z_]\w*)/);
    const hasMain = /\b(public\s+static|static\s+public)\s+void\s+main\s*\(\s*(?:String\s*(?:\[\s*\]|\.\.\.)\s+[A-Za-z_]\w*|String\s+[A-Za-z_]\w*\s*\[\s*\])\s*\)/m.test(content);

    const pkg = pkgMatch ? pkgMatch[1] : '';
    const className = classMatch ? classMatch[2] : path.basename(fileName, '.java');
    const fqcn = pkg ? `${pkg}.${className}` : className;

    return { hasMain, fqcn };
  } catch {
    return { hasMain: false, fqcn: path.basename(fileName, '.java') };
  }
};

const findJavaMainClass = (workdir, entryFile, javaFiles) => {
  const candidates = Array.from(new Set([entryFile, ...javaFiles]))
    .filter(name => name && name.endsWith('.java'));

  for (const fileName of candidates) {
    const info = parseJavaClassInfo(workdir, fileName);
    if (info.hasMain) return info.fqcn;
  }

  return null;
};

wss.on('connection', (ws) => {
  let proc = null;
  let workdir = null;

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', data: 'Invalid JSON' }));
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
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, file.content || '', 'utf8');
        }

        const entryFile = msg.main || (files[0]?.name || 'main.py');
        const entryPath = path.join(workdir, entryFile);

        if (!fs.existsSync(entryPath)) {
          ws.send(JSON.stringify({ type: 'error', data: `Entry file not found: ${entryFile}` }));
          cleanupProcess(proc, workdir);
          return;
        }

        const language = msg.language;

        // 🐍 PYTHON
        if (language === 'python') {
          proc = spawn(resolvePythonCommand(), ['-u', entryFile], { cwd: workdir });
        }

        // 🟢 NODE
        else if (language === 'node') {
          proc = spawn('node', [entryFile], { cwd: workdir });
        }

        // ☕ JAVA — FIXED
        else if (language === 'java') {
          const javaFiles = files.map(f => f.name).filter(n => n.endsWith('.java'));
          if (!javaFiles.length) {
            ws.send(JSON.stringify({
              type: 'error',
              data: 'No Java source files found. Add at least one .java file.'
            }));
            cleanupProcess(proc, workdir);
            return;
          }

          const compile = await runCommand('javac', javaFiles, { cwd: workdir });

          if (compile.code !== 0) {
            ws.send(JSON.stringify({
              type: 'error',
              data: compile.stderr || 'Java compilation failed'
            }));
            cleanupProcess(proc, workdir);
            return;
          }

          const mainClass = findJavaMainClass(workdir, entryFile, javaFiles);
          if (!mainClass) {
            ws.send(JSON.stringify({
              type: 'error',
              data: 'Main method not found in submitted Java files. Define: public static void main(String[] args)'
            }));
            cleanupProcess(proc, workdir);
            return;
          }

          proc = spawn('java', ['-cp', workdir, mainClass], {
            cwd: workdir,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        }

        // 🧠 C
        else if (language === 'c') {
          const cFiles = files.map(f => f.name).filter(n => n.endsWith('.c'));
          const out = 'app.out';

          const compile = await runCommand('gcc', [...cFiles, '-o', out], { cwd: workdir });

          if (compile.code !== 0) {
            ws.send(JSON.stringify({ type: 'error', data: compile.stderr }));
            cleanupProcess(proc, workdir);
            return;
          }

          proc = spawn(path.join(workdir, out), [], { cwd: workdir });
        }

        // 🧠 CPP
        else if (language === 'cpp') {
          const cppFiles = files.map(f => f.name).filter(n =>
            n.endsWith('.cpp') || n.endsWith('.cc') || n.endsWith('.cxx')
          );

          const out = 'app.out';

          const compile = await runCommand('g++', [...cppFiles, '-o', out], { cwd: workdir });

          if (compile.code !== 0) {
            ws.send(JSON.stringify({ type: 'error', data: compile.stderr }));
            cleanupProcess(proc, workdir);
            return;
          }

          proc = spawn(path.join(workdir, out), [], { cwd: workdir });
        }

        else {
          ws.send(JSON.stringify({ type: 'error', data: 'Language not supported' }));
          cleanupProcess(proc, workdir);
          return;
        }

        if (!proc) {
          ws.send(JSON.stringify({ type: 'error', data: 'Process failed to start' }));
          cleanupProcess(proc, workdir);
          return;
        }

        proc.stdout.on('data', d => ws.send(JSON.stringify({ type: 'stdout', data: d.toString() })));
        proc.stderr.on('data', d => ws.send(JSON.stringify({ type: 'stderr', data: d.toString() })));

        proc.on('close', code => {
          ws.send(JSON.stringify({ type: 'exit', data: code }));
          cleanupProcess(proc, workdir);
        });

      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', data: err.message }));
        cleanupProcess(proc, workdir);
      }
    }

    if (msg.type === 'input') {
      if (proc?.stdin?.writable) proc.stdin.write(msg.data + '\n');
    }

    if (msg.type === 'terminate') {
      cleanupProcess(proc, workdir);
      ws.send(JSON.stringify({ type: 'exit', data: 'terminated' }));
    }
  });

  ws.on('close', () => cleanupProcess(proc, workdir));
});

server.listen(PORT, () => {
  console.log(`Runtime server running on ${PORT}`);
});


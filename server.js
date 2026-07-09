/**
 * SSH Server (ssh2) + WebSocket Proxy
 * - SSH server port 2222 dengan password auth custom (tidak perlu system user)
 * - WebSocket server port 8080 → proxy ke SSH 2222
 * - Proxy token wajib di Authorization header
 */

const { Server: SSHServer } = require('ssh2');
const http = require('http');
const net = require('net');
const WebSocket = require('ws');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

const SSH_PORT  = 2222;
const PROXY_PORT = 8080;

// Credentials & token dari environment (di-set oleh start.sh)
const SSH_USER    = process.env.SSH_USER    || 'admin';
const SSH_PASS    = process.env.SSH_PASS    || 'changeme';
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';

if (!PROXY_TOKEN) {
  console.error('[!] PROXY_TOKEN tidak di-set — semua koneksi WS akan ditolak.');
}

// ── Generate / load host key ──────────────────────────────────────────────────
const HOST_KEY_PATH = '/tmp/ssh_host_key.pem';
let hostKey;
if (fs.existsSync(HOST_KEY_PATH)) {
  hostKey = fs.readFileSync(HOST_KEY_PATH);
} else {
  // Generate RSA host key pakai Node.js crypto (format PKCS1 PEM — didukung ssh2)
  const { generateKeyPairSync } = require('crypto');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  fs.writeFileSync(HOST_KEY_PATH, privateKey, { mode: 0o600 });
  hostKey = Buffer.from(privateKey);
}

// ── SSH Server ────────────────────────────────────────────────────────────────
const sshServer = new SSHServer({
  hostKeys: [hostKey],
  banner: 'HTTP Custom SSH Server - Replit\n',
}, (client) => {
  const clientAddr = client._sock?.remoteAddress || 'unknown';
  console.log(`[SSH] Klien terhubung: ${clientAddr}`);

  client.on('authentication', (ctx) => {
    if (ctx.method === 'password'
        && ctx.username === SSH_USER
        && ctx.password === SSH_PASS) {
      console.log(`[SSH] Auth berhasil: ${ctx.username}`);
      ctx.accept();
    } else if (ctx.method === 'none') {
      ctx.reject(['password']);
    } else {
      console.warn(`[SSH] Auth gagal — user: ${ctx.username}, method: ${ctx.method}`);
      ctx.reject();
    }
  });

  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();

      session.on('pty', (accept) => accept && accept());

      session.on('shell', (accept) => {
        const stream = accept();
        // Spawn bash shell
        const shell = spawn('/bin/bash', ['--login'], {
          env: { ...process.env, TERM: 'xterm-256color', HOME: process.env.HOME || '/home/runner' },
        });

        stream.pipe(shell.stdin);
        shell.stdout.pipe(stream);
        shell.stderr.pipe(stream.stderr);

        shell.on('exit', (code) => {
          stream.exit(code || 0);
          stream.end();
        });

        stream.on('close', () => shell.kill());
      });

      session.on('exec', (accept, reject, info) => {
        const stream = accept();
        const parts = info.command.split(' ');
        const proc = spawn(parts[0], parts.slice(1), { env: process.env });
        proc.stdout.pipe(stream);
        proc.stderr.pipe(stream.stderr);
        proc.on('exit', (code) => { stream.exit(code || 0); stream.end(); });
        stream.on('close', () => proc.kill());
      });
    });
  });

  client.on('error', (err) => {
    console.error(`[SSH] Error dari ${clientAddr}: ${err.message}`);
  });

  client.on('end', () => {
    console.log(`[SSH] Klien disconnect: ${clientAddr}`);
  });
});

sshServer.listen(SSH_PORT, '127.0.0.1', () => {
  console.log(`[*] SSH Server berjalan di 127.0.0.1:${SSH_PORT}`);
  console.log(`[*] User: ${SSH_USER} | Pass: ${SSH_PASS}`);
});

// ── HTTP + WebSocket Proxy ────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});

const wss = new WebSocket.Server({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const clientIP = req.socket.remoteAddress;
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!PROXY_TOKEN || token !== PROXY_TOKEN) {
    console.warn(`[WS] Ditolak dari ${clientIP} — token tidak valid`);
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const clientIP = req.socket.remoteAddress;
  console.log(`[WS] Koneksi dari ${clientIP} — teruskan ke SSH :${SSH_PORT}`);

  const sshSocket = net.createConnection({ host: '127.0.0.1', port: SSH_PORT });

  sshSocket.on('connect', () => console.log(`[WS] SSH socket terhubung`));

  // SSH → WS
  sshSocket.on('data', (data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });

  // WS → SSH
  ws.on('message', (data) => {
    if (sshSocket.writable) sshSocket.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
  });

  ws.on('close', () => { console.log(`[WS] Ditutup dari ${clientIP}`); sshSocket.destroy(); });
  ws.on('error', (e) => { console.error(`[WS] Error: ${e.message}`); sshSocket.destroy(); });
  sshSocket.on('close', () => { if (ws.readyState === WebSocket.OPEN) ws.close(); });
  sshSocket.on('error', (e) => { console.error(`[SSH Socket] Error: ${e.message}`); if (ws.readyState === WebSocket.OPEN) ws.close(); });
});

httpServer.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`[*] WebSocket Proxy berjalan di 0.0.0.0:${PROXY_PORT}`);
});

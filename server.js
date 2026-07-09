/**
 * HTTP Custom SSH Server
 * - SSH server (ssh2) port 2222 — password auth, no system user
 * - Raw TCP proxy port 8080:
 *     1. Terima HTTP payload dari HTTP Custom
 *     2. Validasi Bearer token
 *     3. Balas 200 OK
 *     4. Pipe raw TCP → SSH 2222
 */

const net    = require('net');
const fs     = require('fs');
const crypto = require('crypto');
const { Server: SSHServer } = require('ssh2');
const { spawn } = require('child_process');

const SSH_PORT   = 2222;
const PROXY_PORT = 8080;

const SSH_USER    = process.env.SSH_USER    || 'admin';
const SSH_PASS    = process.env.SSH_PASS    || 'changeme';
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';

// ── Host key ──────────────────────────────────────────────────────────────────
const HOST_KEY_PATH = '/tmp/ssh_host_key.pem';
let hostKey;
if (fs.existsSync(HOST_KEY_PATH)) {
  hostKey = fs.readFileSync(HOST_KEY_PATH);
} else {
  const { generateKeyPairSync } = crypto;
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  fs.writeFileSync(HOST_KEY_PATH, privateKey, { mode: 0o600 });
  hostKey = Buffer.from(privateKey);
}

// ── SSH Server ────────────────────────────────────────────────────────────────
const sshServer = new SSHServer({ hostKeys: [hostKey] }, (client) => {
  const addr = client._sock?.remoteAddress || '?';
  console.log(`[SSH] Klien: ${addr}`);

  client.on('authentication', (ctx) => {
    if (ctx.method === 'password'
        && ctx.username === SSH_USER
        && ctx.password === SSH_PASS) {
      console.log(`[SSH] Auth OK: ${ctx.username}`);
      return ctx.accept();
    }
    if (ctx.method === 'none') return ctx.reject(['password']);
    console.warn(`[SSH] Auth GAGAL: ${ctx.username}/${ctx.method}`);
    ctx.reject();
  });

  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('pty', (accept) => accept && accept());
      session.on('shell', (accept) => {
        const stream = accept();
        const shell  = spawn('/bin/bash', ['--login'], {
          env: { ...process.env, TERM: 'xterm-256color' },
        });
        stream.pipe(shell.stdin);
        shell.stdout.pipe(stream);
        shell.stderr.pipe(stream.stderr);
        shell.on('exit', (c) => { stream.exit(c || 0); stream.end(); });
        stream.on('close', () => shell.kill());
      });
      session.on('exec', (accept, _rej, info) => {
        const stream = accept();
        const [cmd, ...args] = info.command.split(' ');
        const proc = spawn(cmd, args, { env: process.env });
        proc.stdout.pipe(stream);
        proc.stderr.pipe(stream.stderr);
        proc.on('exit', (c) => { stream.exit(c || 0); stream.end(); });
        stream.on('close', () => proc.kill());
      });
    });
  });

  client.on('error', (e) => console.error(`[SSH] Error: ${e.message}`));
  client.on('end',   ()  => console.log(`[SSH] Disconnect: ${addr}`));
});

sshServer.listen(SSH_PORT, '127.0.0.1', () => {
  console.log(`[*] SSH Server     → 127.0.0.1:${SSH_PORT}`);
  console.log(`[*] Credentials    → ${SSH_USER} / ${SSH_PASS}`);
});

// ── Raw TCP Proxy ─────────────────────────────────────────────────────────────
//
// HTTP Custom mengirim payload HTTP, lalu langsung kirim traffic SSH di
// koneksi yang sama. Kita cukup:
//   1. Baca header HTTP
//   2. Validasi Bearer token
//   3. Balas 200 OK\r\n\r\n
//   4. Pipe sisa bytes → SSH
//
const proxyServer = net.createServer((clientSock) => {
  const ip = clientSock.remoteAddress;
  let headerBuf  = Buffer.alloc(0);
  let headerDone = false;

  clientSock.on('data', (chunk) => {
    if (headerDone) {
      // Sudah masuk fase tunnel — pipe langsung ke SSH
      sshSock.write(chunk);
      return;
    }

    headerBuf = Buffer.concat([headerBuf, chunk]);
    const headerEnd = headerBuf.indexOf('\r\n\r\n');
    if (headerEnd === -1) return; // Header belum lengkap

    // Header sudah lengkap
    const headerStr = headerBuf.slice(0, headerEnd).toString();
    const bodyPart  = headerBuf.slice(headerEnd + 4); // sisa setelah header

    // Validasi token — cek header X-Token atau Authorization Bearer
    const xToken    = (headerStr.match(/X-Token:\s*(\S+)/i)     || [])[1] || '';
    const authMatch = (headerStr.match(/Authorization:\s*Bearer\s+(\S+)/i) || [])[1] || '';
    const token     = xToken || authMatch;

    if (PROXY_TOKEN && token !== PROXY_TOKEN) {
      console.warn(`[Proxy] Token tidak valid dari ${ip}`);
      clientSock.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      clientSock.destroy();
      return;
    }

    console.log(`[Proxy] Koneksi dari ${ip} — buka tunnel ke SSH`);
    headerDone = true;

    // Buka koneksi ke SSH
    sshSock = net.createConnection({ host: '127.0.0.1', port: SSH_PORT });

    sshSock.on('connect', () => {
      // Balas 200 OK agar HTTP Custom tahu tunnel siap
      clientSock.write('HTTP/1.1 200 OK\r\nConnection: keep-alive\r\n\r\n');
      // Kirim sisa bytes yang sudah terbaca (jika ada)
      if (bodyPart.length > 0) sshSock.write(bodyPart);
    });

    // SSH → client
    sshSock.on('data', (d) => { if (!clientSock.destroyed) clientSock.write(d); });
    sshSock.on('close', () => clientSock.destroy());
    sshSock.on('error', (e) => {
      console.error(`[Proxy] SSH socket error: ${e.message}`);
      clientSock.destroy();
    });
  });

  let sshSock; // referensi ke SSH socket (di-set setelah header terbaca)

  clientSock.on('close', () => { if (sshSock) sshSock.destroy(); });
  clientSock.on('error', (e) => {
    console.error(`[Proxy] Client error dari ${ip}: ${e.message}`);
    if (sshSock) sshSock.destroy();
  });
});

proxyServer.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`[*] Raw TCP Proxy  → 0.0.0.0:${PROXY_PORT}`);
});

/**
 * HTTP Custom SSH Tunneling Server
 *
 * Mode Replit  : SSH 127.0.0.1:2222 → bore.pub tunnel
 * Mode Railway : SSH 0.0.0.0:2222   → Railway TCP Proxy (domain statis)
 *
 * Fitur:
 * - SSH server (ssh2) dengan password auth custom (no system users)
 * - Direct TCP forwarding (tcpip) → forward traffic internet dari HP
 * - Raw TCP proxy (port 8080) → untuk mode payload HTTP Custom
 */

const net    = require('net');
const fs     = require('fs');
const crypto = require('crypto');
const { Server: SSHServer } = require('ssh2');
const { spawn } = require('child_process');

// ── Deteksi environment ───────────────────────────────────────────────────────
const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT;

const SSH_PORT   = parseInt(process.env.SSH_PORT   || '2222', 10);
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '8080', 10);
const SSH_BIND   = IS_RAILWAY ? '0.0.0.0' : '127.0.0.1';

const SSH_USER    = process.env.SSH_USER || 'admin';
const SSH_PASS    = process.env.SSH_PASS || 'changeme';
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';

console.log(`[*] Mode           → ${IS_RAILWAY ? 'Railway' : 'Replit'}`);

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
const sshServer = new SSHServer({
  hostKeys: [hostKey],
  // Dukung algoritma lama (ssh2js yang dipakai HTTP Custom)
  algorithms: {
    kex: [
      'curve25519-sha256', 'curve25519-sha256@libssh.org',
      'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
      'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group-exchange-sha1',
      'diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1',
      'diffie-hellman-group1-sha1',
    ],
    cipher: [
      'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
      'aes128-cbc', 'aes192-cbc', 'aes256-cbc',
      'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com',
      '3des-cbc',
    ],
    hmac: [
      'hmac-sha2-256', 'hmac-sha2-512',
      'hmac-sha1', 'hmac-sha1-96',
      'hmac-md5', 'hmac-md5-96',
      'hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com',
    ],
    compress: ['none', 'zlib@openssh.com', 'zlib'],
    serverHostKey: ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
  },
}, (client) => {
  const addr = client._sock?.remoteAddress || '?';
  console.log(`[SSH] Klien konek: ${addr}`);

  client.on('authentication', (ctx) => {
    if (ctx.method === 'password'
        && ctx.username === SSH_USER
        && ctx.password === SSH_PASS) {
      console.log(`[SSH] Auth OK: ${ctx.username}`);
      return ctx.accept();
    }
    if (ctx.method === 'none') return ctx.reject(['password']);
    console.warn(`[SSH] Auth GAGAL: ${ctx.username} / method=${ctx.method}`);
    ctx.reject();
  });

  client.on('ready', () => {

    // ── Direct TCP forwarding (SOCKS proxy / internet forwarding) ─────────
    // Setiap request dari HP (browser, app) diteruskan ke internet via sini.
    client.on('tcpip', (accept, reject, info) => {
      const { destAddr, destPort } = info;
      console.log(`[FWD] → ${destAddr}:${destPort}`);

      const dest = net.createConnection(destPort, destAddr);

      dest.on('error', (err) => {
        console.warn(`[FWD] Error → ${destAddr}:${destPort} : ${err.message}`);
        try { reject(); } catch (_) {}
      });

      dest.on('connect', () => {
        const stream = accept();
        if (!stream) { dest.destroy(); return; }
        stream.pipe(dest);
        dest.pipe(stream);
        stream.on('close', () => dest.destroy());
        dest.on('close',   () => { try { stream.close(); } catch (_) {} });
        stream.on('error', () => dest.destroy());
        dest.on('error',   () => { try { stream.close(); } catch (_) {} });
      });
    });

    // ── Shell session ─────────────────────────────────────────────────────
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

sshServer.listen(SSH_PORT, SSH_BIND, () => {
  console.log(`[*] SSH Server     → ${SSH_BIND}:${SSH_PORT}`);
  console.log(`[*] Credentials    → ${SSH_USER} / ${SSH_PASS}`);
});

// ── Raw TCP Proxy (port 8080) ─────────────────────────────────────────────────
// Untuk mode payload HTTP Custom: terima HTTP payload → balas 200 OK → pipe SSH
const proxyServer = net.createServer((clientSock) => {
  const ip = clientSock.remoteAddress;
  let headerBuf  = Buffer.alloc(0);
  let headerDone = false;
  let sshSock;

  clientSock.on('data', (chunk) => {
    if (headerDone) {
      if (sshSock && !sshSock.destroyed) sshSock.write(chunk);
      return;
    }

    headerBuf = Buffer.concat([headerBuf, chunk]);
    const headerEnd = headerBuf.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    const headerStr = headerBuf.slice(0, headerEnd).toString();
    const bodyPart  = headerBuf.slice(headerEnd + 4);

    const xToken    = (headerStr.match(/X-Token:\s*(\S+)/i)              || [])[1] || '';
    const authMatch = (headerStr.match(/Authorization:\s*Bearer\s+(\S+)/i) || [])[1] || '';
    const token     = xToken || authMatch;

    if (PROXY_TOKEN && token !== PROXY_TOKEN) {
      console.warn(`[Proxy] Token invalid dari ${ip}`);
      clientSock.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      clientSock.destroy();
      return;
    }

    headerDone = true;
    console.log(`[Proxy] Koneksi dari ${ip} → SSH`);

    sshSock = net.createConnection({ host: '127.0.0.1', port: SSH_PORT });
    sshSock.on('connect', () => {
      clientSock.write('HTTP/1.1 200 OK\r\nConnection: keep-alive\r\n\r\n');
      if (bodyPart.length > 0) sshSock.write(bodyPart);
    });
    sshSock.on('data',  (d) => { if (!clientSock.destroyed) clientSock.write(d); });
    sshSock.on('close', ()  => clientSock.destroy());
    sshSock.on('error', (e) => { console.error(`[Proxy] SSH err: ${e.message}`); clientSock.destroy(); });
  });

  clientSock.on('close', () => { if (sshSock) sshSock.destroy(); });
  clientSock.on('error', (e) => { console.error(`[Proxy] Client err ${ip}: ${e.message}`); if (sshSock) sshSock.destroy(); });
});

proxyServer.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`[*] TCP Proxy      → 0.0.0.0:${PROXY_PORT}`);
});

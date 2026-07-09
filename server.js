/**
 * HTTP Custom SSH Tunneling Server
 *
 * Mode Replit  : SSH 127.0.0.1:2222 → bore.pub tunnel (start.sh)
 * Mode Render  : SSH 0.0.0.0:2222   → bore.pub tunnel (server.js langsung)
 *                HTTP health  → 0.0.0.0:PORT (wajib untuk Render)
 *
 * Fitur:
 * - SSH server (ssh2) password auth custom (no system users)
 * - Direct TCP forwarding → internet proxy dari HP
 * - Raw TCP proxy port 8080 → mode payload HTTP Custom
 * - Health endpoint → keep-alive untuk Render free tier
 */

const net    = require('net');
const http   = require('http');
const fs     = require('fs');
const crypto = require('crypto');
const { Server: SSHServer } = require('ssh2');
const { spawn, execSync } = require('child_process');

// ── Environment ───────────────────────────────────────────────────────────────
const IS_RENDER  = !!process.env.RENDER;
const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT;
const IS_CLOUD   = IS_RENDER || IS_RAILWAY;

const SSH_PORT    = parseInt(process.env.SSH_PORT   || '2222', 10);
const PROXY_PORT  = parseInt(process.env.PROXY_PORT || '8080', 10);
const HEALTH_PORT = parseInt(process.env.PORT       || '3000', 10);
const SSH_BIND    = IS_CLOUD ? '0.0.0.0' : '127.0.0.1';

const SSH_USER    = process.env.SSH_USER || 'admin';
const SSH_PASS    = process.env.SSH_PASS || 'changeme';
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';
const BORE_PORT   = process.env.BORE_PORT || '0';  // 0 = acak, angka = statis

const mode = IS_RENDER ? 'Render' : IS_RAILWAY ? 'Railway' : 'Replit';
console.log(`[*] Mode           → ${mode}`);
console.log(`[*] SSH_USER       → ${SSH_USER}`);

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
    console.warn(`[SSH] Auth GAGAL: ${ctx.username} method=${ctx.method}`);
    ctx.reject();
  });

  client.on('ready', () => {
    // ── Direct TCP forwarding — internet proxy ────────────────────────────
    client.on('tcpip', (accept, reject, info) => {
      const { destAddr, destPort } = info;
      console.log(`[FWD] → ${destAddr}:${destPort}`);
      const dest = net.createConnection(destPort, destAddr);
      dest.on('error', (err) => {
        console.warn(`[FWD] Error ${destAddr}:${destPort}: ${err.message}`);
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
      session.on('pty', (a) => a && a());
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
const proxyServer = net.createServer((clientSock) => {
  const ip = clientSock.remoteAddress;
  let headerBuf = Buffer.alloc(0), headerDone = false, sshSock;
  clientSock.on('data', (chunk) => {
    if (headerDone) { if (sshSock && !sshSock.destroyed) sshSock.write(chunk); return; }
    headerBuf = Buffer.concat([headerBuf, chunk]);
    const end = headerBuf.indexOf('\r\n\r\n');
    if (end === -1) return;
    const hdr  = headerBuf.slice(0, end).toString();
    const body = headerBuf.slice(end + 4);
    const tok  = ((hdr.match(/X-Token:\s*(\S+)/i)              || [])[1]) ||
                 ((hdr.match(/Authorization:\s*Bearer\s+(\S+)/i) || [])[1]) || '';
    if (PROXY_TOKEN && tok !== PROXY_TOKEN) {
      clientSock.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      clientSock.destroy(); return;
    }
    headerDone = true;
    console.log(`[Proxy] ${ip} → SSH`);
    sshSock = net.createConnection({ host: '127.0.0.1', port: SSH_PORT });
    sshSock.on('connect', () => {
      clientSock.write('HTTP/1.1 200 OK\r\nConnection: keep-alive\r\n\r\n');
      if (body.length) sshSock.write(body);
    });
    sshSock.on('data',  (d) => { if (!clientSock.destroyed) clientSock.write(d); });
    sshSock.on('close', ()  => clientSock.destroy());
    sshSock.on('error', (e) => { console.error(`[Proxy] SSHErr: ${e.message}`); clientSock.destroy(); });
  });
  clientSock.on('close', () => { if (sshSock) sshSock.destroy(); });
  clientSock.on('error', (e) => { if (sshSock) sshSock.destroy(); });
});
proxyServer.listen(PROXY_PORT, '0.0.0.0', () =>
  console.log(`[*] TCP Proxy      → 0.0.0.0:${PROXY_PORT}`)
);

// ── Health / Status HTTP server (wajib untuk Render) ─────────────────────────
// Render butuh response di PORT, juga dipakai UptimeRobot untuk keep-alive.
let boreAddr = 'pending...';

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      mode,
      ssh: `${SSH_USER}@bore.pub (see /config)`,
      bore: boreAddr,
      uptime: Math.floor(process.uptime()) + 's',
    }));
  } else if (req.url === '/config') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end([
      '=== HTTP Custom Config ===',
      '',
      `SSH  : ${boreAddr}@${SSH_USER}:${SSH_PASS}`,
      '',
      'Use Payload : NO',
      'Enable DNS  : YES',
      'Enhanced    : NO',
    ].join('\n'));
  } else {
    res.writeHead(404); res.end('not found');
  }
});
healthServer.listen(HEALTH_PORT, '0.0.0.0', () =>
  console.log(`[*] Health Server  → 0.0.0.0:${HEALTH_PORT}`)
);

// ── Bore tunnel (Cloud mode) ──────────────────────────────────────────────────
// Di Replit, bore dijalankan oleh start.sh.
// Di Render/Railway, server.js jalankan bore sendiri.
if (IS_CLOUD) {
  console.log(`[*] Memulai bore tunnel (port request: ${BORE_PORT})...`);

  // Tunggu SSH server siap dulu
  const waitSSH = (cb, tries = 0) => {
    const s = net.createConnection(SSH_PORT, '127.0.0.1');
    s.on('connect', () => { s.destroy(); cb(); });
    s.on('error',   () => {
      if (tries > 20) { console.error('[!] SSH tidak kunjung siap'); return; }
      setTimeout(() => waitSSH(cb, tries + 1), 500);
    });
  };

  waitSSH(() => {
    const bore = spawn('bore', ['local', String(SSH_PORT), '--to', 'bore.pub', '--port', BORE_PORT], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onData = (data) => {
      const txt = data.toString();
      process.stdout.write('[bore] ' + txt);
      const m = txt.match(/listening at bore\.pub:(\d+)/);
      if (m) {
        boreAddr = `bore.pub:${m[1]}`;
        console.log('\n╔══════════════════════════════════════╗');
        console.log(`║  ✅ SSH SIAP                          ║`);
        console.log(`║  bore.pub:${m[1]}@${SSH_USER}:${SSH_PASS}`);
        console.log('╚══════════════════════════════════════╝');
        console.log(`[*] Config: https://<render-url>/config`);
      }
    };

    bore.stdout.on('data', onData);
    bore.stderr.on('data', onData);
    bore.on('exit', (code) => {
      console.error(`[!] bore exit code ${code} — restart dalam 5 detik...`);
      setTimeout(() => waitSSH(() => {}), 5000);
    });
  });
}

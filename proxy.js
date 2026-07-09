/**
 * WebSocket → SSH Proxy
 * Hanya menerima koneksi WebSocket yang menyertakan header Authorization yang benar.
 */

const http = require('http');
const net = require('net');
const WebSocket = require('ws');

const SSH_HOST = '127.0.0.1';
const SSH_PORT = 2222;
const PROXY_PORT = 8080;

// Token akses — wajib ada di env, jika tidak ada proxy akan menolak semua koneksi
const ACCESS_TOKEN = process.env.PROXY_TOKEN;
if (!ACCESS_TOKEN) {
  console.error('[!] PROXY_TOKEN tidak di-set. Proxy menolak semua koneksi untuk keamanan.');
}

// HTTP server — hanya untuk non-WS request (kembalikan 200 biasa)
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});

// WebSocket server dengan verifikasi upgrade manual
const wss = new WebSocket.Server({ noServer: true });

// Handle upgrade request — validasi token dulu sebelum upgrade ke WS
server.on('upgrade', (req, socket, head) => {
  const clientIP = req.socket.remoteAddress;

  // Cek Authorization header: "Bearer <token>"
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!ACCESS_TOKEN || token !== ACCESS_TOKEN) {
    console.warn(`[!] Akses ditolak dari ${clientIP} — token tidak valid`);
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  const clientIP = req.socket.remoteAddress;
  console.log(`[+] Koneksi WebSocket dari ${clientIP}`);

  // Buka koneksi TCP ke SSH server lokal
  const sshSocket = net.createConnection({ host: SSH_HOST, port: SSH_PORT });

  sshSocket.on('connect', () => {
    console.log(`[+] Terhubung ke SSH ${SSH_HOST}:${SSH_PORT}`);
  });

  // SSH → WebSocket
  sshSocket.on('data', (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  // WebSocket → SSH
  ws.on('message', (data) => {
    if (sshSocket.writable) {
      sshSocket.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
    }
  });

  ws.on('close', () => {
    console.log(`[-] WebSocket ditutup dari ${clientIP}`);
    sshSocket.destroy();
  });

  ws.on('error', (err) => {
    console.error(`[!] WS error dari ${clientIP}: ${err.message}`);
    sshSocket.destroy();
  });

  sshSocket.on('close', () => {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });

  sshSocket.on('error', (err) => {
    console.error(`[!] SSH socket error: ${err.message}`);
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`[*] WebSocket→SSH Proxy berjalan di port ${PROXY_PORT}`);
  console.log(`[*] Meneruskan koneksi ke SSH ${SSH_HOST}:${SSH_PORT}`);
});

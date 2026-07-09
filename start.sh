#!/bin/bash
set -e

echo "========================================"
echo "  HTTP Custom SSH Server Setup"
echo "========================================"

# ── 1. Buat direktori kerja ─────────────────
mkdir -p /tmp/dropbear/keys
mkdir -p ~/.ssh
chmod 700 ~/.ssh

# ── 2. Generate SSH host keys ────────────────
echo "[*] Generate SSH host keys..."
if [ ! -f /tmp/dropbear/keys/dropbear_rsa_host_key ]; then
  dropbearkey -t rsa -f /tmp/dropbear/keys/dropbear_rsa_host_key -s 2048 2>/dev/null
fi
if [ ! -f /tmp/dropbear/keys/dropbear_ecdsa_host_key ]; then
  dropbearkey -t ecdsa -f /tmp/dropbear/keys/dropbear_ecdsa_host_key 2>/dev/null
fi
echo "[+] Host keys siap."

# ── 3. Generate client key pair (Ed25519) ────
KEY_FILE=/tmp/dropbear/client_key
echo "[*] Generate client key pair (Ed25519)..."
if [ ! -f "$KEY_FILE" ]; then
  ssh-keygen -t ed25519 -f "$KEY_FILE" -N "" -C "http-custom-key" -q
fi

# Daftarkan public key ke authorized_keys runner
cat "$KEY_FILE.pub" >> ~/.ssh/authorized_keys
# Hapus duplikat
sort -u ~/.ssh/authorized_keys -o ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
echo "[+] Public key terdaftar di authorized_keys."

# ── 4. Token akses proxy (random) ───────────
PROXY_TOKEN=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c 32)
export PROXY_TOKEN

# ── 5. Jalankan Dropbear SSH ─────────────────
echo "[*] Menjalankan Dropbear SSH di port 2222..."
pkill dropbear 2>/dev/null || true
sleep 1

dropbear \
  -p 2222 \
  -r /tmp/dropbear/keys/dropbear_rsa_host_key \
  -r /tmp/dropbear/keys/dropbear_ecdsa_host_key \
  -F -E 2>/tmp/dropbear/ssh.log &

DROPBEAR_PID=$!
sleep 2

if ! kill -0 $DROPBEAR_PID 2>/dev/null; then
  echo "[!] Dropbear gagal start. Log:"
  cat /tmp/dropbear/ssh.log 2>/dev/null
  exit 1
fi

# Health check port 2222
for i in $(seq 1 10); do
  if nc -z 127.0.0.1 2222 2>/dev/null; then
    echo "[+] Dropbear SSH berjalan di port 2222."
    break
  fi
  [ $i -eq 10 ] && echo "[!] SSH tidak merespons." && exit 1
  sleep 1
done

# ── 6. Jalankan WebSocket Proxy ─────────────
echo "[*] Menjalankan WebSocket→SSH Proxy di port 8080..."
pkill -f "node proxy.js" 2>/dev/null || true
node proxy.js &
PROXY_PID=$!
sleep 2

if ! kill -0 $PROXY_PID 2>/dev/null; then
  echo "[!] WebSocket proxy gagal start."
  exit 1
fi
echo "[+] WebSocket Proxy berjalan di port 8080."

# ── 7. Cloudflare Quick Tunnel ───────────────
echo "[*] Menghubungkan ke Cloudflare Quick Tunnel..."
rm -f /tmp/cloudflared.log
cloudflared tunnel --url http://localhost:8080 \
  --no-autoupdate \
  2>&1 | tee /tmp/cloudflared.log &

CF_PID=$!

TUNNEL_URL=""
for i in $(seq 1 30); do
  sleep 1
  TUNNEL_URL=$(grep -oP 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' /tmp/cloudflared.log 2>/dev/null | head -1)
  [ -n "$TUNNEL_URL" ] && break
done

if [ -z "$TUNNEL_URL" ]; then
  echo "[!] Tunnel URL tidak terdeteksi. Cek /tmp/cloudflared.log"
  exit 1
fi

TUNNEL_DOMAIN=$(echo "$TUNNEL_URL" | sed 's|https://||')
SSH_USER="runner"
PRIVATE_KEY=$(cat "$KEY_FILE")

echo ""
echo "========================================"
echo "  ✅ SERVER SIAP!"
echo "========================================"
echo ""
echo "  📡 Tunnel : $TUNNEL_URL"
echo ""
echo "════════════════════════════════════════"
echo "  CONFIG HTTP CUSTOM — SSH + KEY AUTH"
echo "════════════════════════════════════════"
echo ""
echo "  SSH Server : $TUNNEL_DOMAIN"
echo "  Port       : 443"
echo "  User       : $SSH_USER"
echo "  Auth       : Private Key (lihat di bawah)"
echo ""
echo "  ┌─ Payload ──────────────────────────────────────────────────────────────────────────────────"
echo "  GET / HTTP/1.1[crlf]Host: $TUNNEL_DOMAIN[crlf]Authorization: Bearer $PROXY_TOKEN[crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]"
echo "  └────────────────────────────────────────────────────────────────────────────────────────────"
echo ""
echo "  ┌─ Private Key (copy semua termasuk header/footer) ──────────────────────"
echo "$PRIVATE_KEY"
echo "  └────────────────────────────────────────────────────────────────────────"
echo ""
echo "  Cara pakai di HTTP Custom:"
echo "  1. SSH tab → isi Server & Port"
echo "  2. Centang Use Payload → paste payload"
echo "  3. Di field SSH: pilih auth 'Private Key'"
echo "  4. Paste private key di atas"
echo "  5. ✅ Enable DNS  ✅ UDP Custom"
echo "  6. Tekan CONNECT"
echo ""
echo "  ⚠️  URL BERUBAH setiap restart Replit!"
echo "========================================"
echo ""
echo "[*] Tekan Ctrl+C untuk stop semua service."
wait $CF_PID

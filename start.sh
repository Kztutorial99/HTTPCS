#!/bin/bash
set -e

echo "========================================"
echo "  HTTP Custom SSH Server Setup"
echo "========================================"

# ── 1. Buat direktori kerja ─────────────────
mkdir -p /tmp/dropbear/keys
mkdir -p /tmp/dropbear/run

# ── 2. Generate host keys dropbear ──────────
echo "[*] Generate SSH host keys..."
if [ ! -f /tmp/dropbear/keys/dropbear_rsa_host_key ]; then
  dropbearkey -t rsa -f /tmp/dropbear/keys/dropbear_rsa_host_key -s 2048 2>/dev/null
fi
if [ ! -f /tmp/dropbear/keys/dropbear_ecdsa_host_key ]; then
  dropbearkey -t ecdsa -f /tmp/dropbear/keys/dropbear_ecdsa_host_key 2>/dev/null
fi
echo "[+] Host keys siap."

# ── 3. Generate credentials acak ────────────
# Password SSH: random 16 karakter (huruf + angka)
SSH_USER="httpuser"
SSH_PASS=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c 16)

# Token akses proxy: random 32 karakter
PROXY_TOKEN=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c 32)
export PROXY_TOKEN

echo "[*] Setup user SSH..."
if ! id "$SSH_USER" &>/dev/null 2>&1; then
  useradd -m -s /bin/bash "$SSH_USER" 2>/dev/null || true
fi
echo "$SSH_USER:$SSH_PASS" | chpasswd 2>/dev/null || {
  # Fallback jika chpasswd tidak tersedia (environment terbatas)
  echo "[!] chpasswd tidak tersedia di environment ini."
  echo "[!] Coba gunakan key-based auth atau jalankan di environment lain."
}

# ── 4. Jalankan Dropbear SSH server ─────────
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
  cat /tmp/dropbear/ssh.log 2>/dev/null || true
  exit 1
fi
echo "[+] Dropbear SSH berjalan (PID: $DROPBEAR_PID, port: 2222)"

# ── 5. Health check SSH ──────────────────────
echo "[*] Verifikasi koneksi SSH..."
for i in $(seq 1 10); do
  if nc -z 127.0.0.1 2222 2>/dev/null; then
    echo "[+] SSH port 2222 siap."
    break
  fi
  if [ $i -eq 10 ]; then
    echo "[!] SSH tidak merespons setelah 10 detik. Batalkan."
    exit 1
  fi
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
echo "[+] WebSocket Proxy berjalan (PID: $PROXY_PID)"

# ── 7. Jalankan Cloudflare Quick Tunnel ─────
echo "[*] Menghubungkan ke Cloudflare Quick Tunnel..."
cloudflared tunnel --url http://localhost:8080 \
  --no-autoupdate \
  2>&1 | tee /tmp/cloudflared.log &

CF_PID=$!

# Tunggu URL muncul (max 30 detik)
TUNNEL_URL=""
for i in $(seq 1 30); do
  sleep 1
  TUNNEL_URL=$(grep -oP 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' /tmp/cloudflared.log 2>/dev/null | head -1)
  if [ -n "$TUNNEL_URL" ]; then
    break
  fi
done

if [ -z "$TUNNEL_URL" ]; then
  echo "[!] Tunnel URL tidak terdeteksi setelah 30 detik."
  echo "[!] Cek log: /tmp/cloudflared.log"
  exit 1
fi

TUNNEL_DOMAIN=$(echo "$TUNNEL_URL" | sed 's|https://||')

echo ""
echo "========================================"
echo "  ✅ SERVER SIAP!"
echo "========================================"
echo ""
echo "  📡 Tunnel : $TUNNEL_URL"
echo ""
echo "════════════════════════════════════════"
echo "  CONFIG HTTP CUSTOM (SSH + WebSocket)"
echo "════════════════════════════════════════"
echo ""
echo "  SSH Server : $TUNNEL_DOMAIN"
echo "  Port       : 443"
echo "  User       : $SSH_USER"
echo "  Pass       : $SSH_PASS"
echo ""
echo "  ┌─ Payload (copy persis) ───────────────────────────────────────────────────────"
echo "  GET / HTTP/1.1[crlf]Host: $TUNNEL_DOMAIN[crlf]Authorization: Bearer $PROXY_TOKEN[crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]"
echo "  └───────────────────────────────────────────────────────────────────────────────"
echo ""
echo "  Checklist di HTTP Custom:"
echo "  ✅ Use Payload  ✅ Enable DNS  ✅ UDP Custom"
echo ""
echo "  ⚠️  URL BERUBAH setiap restart Replit!"
echo "========================================"

# Simpan config ke file (aman, hanya di /tmp)
cat > /tmp/http_custom_config.txt << EOF
=== HTTP CUSTOM CONFIG (generated: $(date)) ===
SSH Server : $TUNNEL_DOMAIN
Port       : 443
User       : $SSH_USER
Pass       : $SSH_PASS

Payload:
GET / HTTP/1.1[crlf]Host: $TUNNEL_DOMAIN[crlf]Authorization: Bearer $PROXY_TOKEN[crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]

Settings: Use Payload ✅ | Enable DNS ✅ | UDP Custom ✅
EOF

echo "[*] Tekan Ctrl+C untuk stop semua service."
wait $CF_PID

#!/bin/bash
set -e

echo "========================================"
echo "  HTTP Custom SSH Server Setup"
echo "========================================"

# ── 1. Generate credentials acak ────────────
SSH_USER="admin"
SSH_PASS=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c 12)
PROXY_TOKEN=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c 32)

export SSH_USER SSH_PASS PROXY_TOKEN

echo "[+] Credentials di-generate."

# ── 2. Jalankan server.js (SSH + WS Proxy) ──
echo "[*] Menjalankan SSH + WebSocket server..."
pkill -f "node server.js" 2>/dev/null || true
sleep 1

node server.js &
SERVER_PID=$!
sleep 3

if ! kill -0 $SERVER_PID 2>/dev/null; then
  echo "[!] server.js gagal start."
  exit 1
fi

# Health check port 2222 dan 8080
for PORT in 2222 8080; do
  for i in $(seq 1 10); do
    nc -z 127.0.0.1 $PORT 2>/dev/null && break
    [ $i -eq 10 ] && echo "[!] Port $PORT tidak merespons." && exit 1
    sleep 1
  done
  echo "[+] Port $PORT siap."
done

# ── 3. Cloudflare Quick Tunnel ───────────────
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

echo ""
echo "========================================"
echo "  ✅ SERVER SIAP!"
echo "========================================"
echo ""
echo "  📡 Tunnel : $TUNNEL_URL"
echo ""
echo "════════════════════════════════════════"
echo "  CONFIG HTTP CUSTOM"
echo "════════════════════════════════════════"
echo ""
echo "  ┌─ Kolom SSH ──────────────────────────────────────────────────────"
echo "  $TUNNEL_DOMAIN:443@$SSH_USER:$SSH_PASS"
echo "  └──────────────────────────────────────────────────────────────────"
echo ""
echo "  ┌─ Payload ────────────────────────────────────────────────────────"
echo "  GET / HTTP/1.1[crlf]Host: $TUNNEL_DOMAIN[crlf]Authorization: Bearer $PROXY_TOKEN[crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]"
echo "  └──────────────────────────────────────────────────────────────────"
echo ""
echo "  Checklist:"
echo "  ✅ Use Payload  ✅ Enable DNS  ✅ UDP Custom"
echo "  ❌ SSL  ❌ Enhanced  ❌ SlowDns  ❌ Psiphon  ❌ V2ray"
echo ""
echo "  ⚠️  URL & password BERUBAH setiap restart!"
echo "========================================"
echo ""
echo "[*] Tekan Ctrl+C untuk stop."
wait $CF_PID

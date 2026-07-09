#!/bin/bash
set -e

echo "========================================"
echo "  HTTP Custom SSH Server Setup"
echo "========================================"

# ── 1. Generate credentials ─────────────────
SSH_USER="admin"
SSH_PASS=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c 12)

export SSH_USER SSH_PASS PROXY_TOKEN=""

echo "[+] Credentials di-generate."

# ── 2. Jalankan server.js ───────────────────
echo "[*] Menjalankan SSH server..."
pkill -f "node server.js" 2>/dev/null || true
sleep 1

node server.js &
SERVER_PID=$!
sleep 3

if ! kill -0 $SERVER_PID 2>/dev/null; then
  echo "[!] server.js gagal start."
  exit 1
fi

# Health check port 2222
for i in $(seq 1 10); do
  nc -z 127.0.0.1 2222 2>/dev/null && break
  [ $i -eq 10 ] && echo "[!] Port 2222 tidak merespons." && exit 1
  sleep 1
done
echo "[+] Port 2222 (SSH) siap."

# ── 3. Bore Tunnel (raw TCP) ─────────────────
BORE_PORT_REQ="${BORE_PORT:-0}"   # 0 = acak, angka = minta port spesifik
echo "[*] Membuka bore tunnel ke bore.pub (port request: $BORE_PORT_REQ)..."
rm -f /tmp/bore.log
bore local 2222 --to bore.pub --port "$BORE_PORT_REQ" 2>&1 | tee /tmp/bore.log &
BORE_PID=$!

# Tunggu bore port muncul (max 30 detik)
BORE_PORT_ACTUAL=""
for i in $(seq 1 30); do
  sleep 1
  BORE_PORT_ACTUAL=$(grep -oP 'listening at bore\.pub:\K[0-9]+' /tmp/bore.log 2>/dev/null | head -1)
  [ -n "$BORE_PORT_ACTUAL" ] && break
done

if [ -z "$BORE_PORT_ACTUAL" ]; then
  echo "[!] bore port tidak terdeteksi. Log:"
  cat /tmp/bore.log 2>/dev/null
  exit 1
fi

echo ""
echo "========================================"
echo "  ✅ SERVER SIAP!"
echo "========================================"
echo ""
echo "  📡 Tunnel : bore.pub:$BORE_PORT_ACTUAL"
echo ""
echo "════════════════════════════════════════"
echo "  CONFIG HTTP CUSTOM (SSH LANGSUNG)"
echo "════════════════════════════════════════"
echo ""
echo "  ┌─ Kolom SSH ──────────────────────────"
echo "  bore.pub:$BORE_PORT_ACTUAL@$SSH_USER:$SSH_PASS"
echo "  └──────────────────────────────────────"
echo ""
echo "  ❌ Use Payload  → jangan centang"
echo "  ❌ Enhanced     → jangan centang"
echo "  ✅ Enable DNS"
echo "  ❌ SlowDns / UDP Custom / SSL / Psiphon / V2ray"
echo ""
echo "  (Koneksi langsung, tidak butuh payload!)"
echo ""
if [ "$BORE_PORT_REQ" != "0" ] && [ "$BORE_PORT_ACTUAL" = "$BORE_PORT_REQ" ]; then
  echo "  ✅ Port statis berhasil: bore.pub:$BORE_PORT_ACTUAL"
else
  echo "  ⚠️  Port & password BERUBAH setiap restart!"
fi
echo "========================================"
echo ""
echo "[*] Tekan Ctrl+C untuk stop."
wait $BORE_PID

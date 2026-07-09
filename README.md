# HTTPCS — HTTP Custom SSH Server

SSH tunneling server untuk aplikasi **HTTP Custom** (Android).

## Fitur
- SSH server dengan password auth (tanpa system user)
- Direct TCP forwarding (internet proxy via SSH)
- Kompatibel dengan ssh2js (library di HTTP Custom)
- Support Railway deployment (always-on, domain statis)

## Deploy ke Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template)

1. Fork repo ini
2. Buat project baru di [Railway](https://railway.app)
3. Connect GitHub repo ini
4. Tambah env variables:
   - `SSH_USER` — username (default: `admin`)
   - `SSH_PASS` — password kamu
5. Di Railway → Settings → Networking → **Add TCP Proxy** → port `2222`
6. Gunakan domain TCP Railway di HTTP Custom

## Config HTTP Custom (Railway)

```
SSH Server : <tcp-domain>.railway.app:<port>@<SSH_USER>:<SSH_PASS>
Use Payload : ❌
Enable DNS  : ✅
```

## Env Variables

| Variable | Default | Keterangan |
|----------|---------|------------|
| `SSH_USER` | `admin` | Username SSH |
| `SSH_PASS` | `changeme` | Password SSH — **ganti ini!** |
| `SSH_PORT` | `2222` | Port SSH internal |
| `PROXY_PORT` | `8080` | Port HTTP proxy |
| `PROXY_TOKEN` | _(kosong)_ | Token auth proxy (opsional) |

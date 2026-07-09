# HTTP Custom SSH Server

Server SSH tunneling untuk digunakan dengan aplikasi **HTTP Custom** di Android.

## Arsitektur

```
[HTTP Custom App] 
      ↓ WebSocket
[Cloudflare Quick Tunnel]
      ↓ HTTP/WS
[Replit: WebSocket Proxy :8080]
      ↓ TCP
[Dropbear SSH :2222]
```

## Cara Pakai

1. Klik **Run** (atau jalankan workflow "Start Server")
2. Tunggu hingga muncul **CONFIG HTTP CUSTOM** di console
3. Copy config ke aplikasi HTTP Custom di Android
4. CONNECT

## Komponen

| File | Fungsi |
|------|--------|
| `start.sh` | Script utama — start SSH, proxy, dan cloudflared |
| `proxy.js` | WebSocket → SSH proxy (Node.js) |

## Catatan

- Tunnel URL **berubah setiap restart** (Quick Tunnel gratis)
- Untuk URL permanen, gunakan Named Tunnel dengan domain kztutorial.site
- Credentials default: `httpuser` / `httppass123`

## User Preferences

- Bahasa: Indonesia

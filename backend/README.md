# 🔒 Proxy Backend — SRIKANDI Naskah AI

Proxy tipis untuk menampung API key AI (Kenari/Anthropic) di VPS Anda,
sehingga extension hanya membawa **token aplikasi** — bukan key AI.

```
Extension ── Bearer <token aplikasi> ──▶ Proxy (VPS) ── Bearer <key AI> ──▶ Kenari / Anthropic
```

- **Zero-dependency**: satu file `server.js`, Node ≥ 18, tidak perlu `npm install`.
- Auth token (timing-safe), rate limit per token, batas ukuran payload.
- Log hanya metadata (token hash, path, status, durasi) — **isi dokumen tidak pernah dilog**.

## Endpoint

| Route | Keterangan |
|---|---|
| `GET /healthz` | Health check, tanpa auth (untuk monitoring) |
| `POST /v1/chat/completions` | Forward ke upstream OpenAI-compatible (Kenari) |
| `POST /v1/messages` | Forward ke Anthropic (aktif bila `ANTHROPIC_API_KEY` diisi) |

---

## 0. Persiapan

1. **DNS**: arahkan subdomain ke IP VPS, mis. `A proxy.nama-anda.com → 1.2.3.4`.
   TLS akan diterbitkan otomatis oleh Caddy, jadi domain + port 80/443 terbuka wajib.
2. **Buat key AI baru** di panel Kenari (key lama yang ter-hardcode dianggap
   bocor — revoke/di-rotate setelah proxy jalan).
3. **Generate token aplikasi** untuk pengguna extension:

   ```bash
   openssl rand -hex 32
   ```

   Jalankan sekali per pengguna/instansi bila ingin kuota terpisah.

## 1. Konfigurasi

```bash
cd backend
cp .env.example .env
nano .env
```

Wajib diisi:

- `UPSTREAM_API_KEY` — key Kenari **baru**
- `APP_TOKENS` — token dari langkah 3 di atas (bisa beberapa, pisah koma)
- `RATE_LIMIT_PER_HOUR` — kuota per token, default 60/jam (±60 naskah/jam/pengguna)

## 2. Deploy — Opsi A: Docker (direkomendasikan)

```bash
# edit Caddyfile dulu: ganti proxy.example.com dengan domain Anda
nano Caddyfile

docker compose up -d --build
docker compose logs -f        # pastikan "listening" muncul
```

Caddy otomatis menerbitkan sertifikat TLS saat pertama diakses.

## 2. Deploy — Opsi B: systemd (tanpa Docker)

```bash
# Node 18+ harus terpasang: node -v
sudo useradd -r -s /usr/sbin/nologin srikandi
sudo mkdir -p /opt/srikandi-proxy
sudo cp server.js package.json .env /opt/srikandi-proxy/
sudo chown -R srikandi:srikandi /opt/srikandi-proxy

# Caddy / nginx di depan untuk TLS (contoh Caddyfile ada di folder ini):
sudo cp Caddyfile /etc/caddy/Caddyfile   # setelah install caddy & edit domain
sudo systemctl reload caddy

sudo cp srikandi-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now srikandi-proxy
sudo journalctl -u srikandi-proxy -f
```

## 3. Firewall (VPS)

Hanya 80/443 yang perlu terbuka dari luar; proxy bind `127.0.0.1` sehingga
tidak bisa diakses langsung:

```bash
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
```

## 4. Verifikasi

```bash
node smoke-test.mjs https://proxy.nama-anda.com TOKEN_APLIKASI
```

Harus keluar 4 cek ✔. Lalu di extension: klik kanan ikon → **Options** →
isi **Base URL** `https://proxy.nama-anda.com/v1` dan **Token aplikasi** → *Uji Koneksi*.

> Untuk provider Anthropic lewat proxy: Base URL Anthropic di Options diisi
> `https://proxy.nama-anda.com` (tanpa `/v1`) dan `ANTHROPIC_API_KEY` diatur
> di `.env` proxy.

## 5. Setelah proxy jalan

- **Revoke key Kenari lama** yang pernah ter-hardcode di repo.
- Distribusikan token aplikasi ke pengguna (bukan key AI).
- Rotasi token sewaktu-waktu: edit `APP_TOKENS` → restart service.

## Catatan keamanan

- Proxy memvalidasi token dengan `crypto.timingSafeEqual`.
- Data dokumen hanya **dialirkan**, tidak disimpan dan tidak dilog.
- Kalau instansi mensyaratkan data tidak keluar dari server pemerintah,
  arahkan `UPSTREAM_BASE_URL` ke endpoint AI on-premise yang setara
  (OpenAI-compatible) — arsitekturnya tidak berubah.
- Rate limit in-memory reset saat restart; untuk kuota tahan-banting,
  nanti bisa ditambah Redis — untuk skala puluhan–ratusan pengguna,
  in-memory cukup.

# Deploy backend ke VPS Oracle dengan PM2 + Cloudflare Tunnel

Panduan ini hanya untuk folder `backend/`. Frontend belum diperlukan agar API dapat dijalankan dan diuji.

## 1. Prasyarat VPS

Gunakan Node.js 20 atau lebih baru, lalu pasang PM2 dan cloudflared:

```bash
sudo apt update
sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

Clone project, masuk ke backend, dan install dependency production:

```bash
cd /opt
git clone <URL-REPOSITORY> license-manager
cd /opt/license-manager/backend
npm ci --omit=dev
cp .env.example .env
chmod 600 .env
nano .env
```

Isi semua secret dengan nilai acak yang kuat. `CORS_ORIGIN` diisi origin frontend nanti, dipisahkan koma jika ada lebih dari satu. Jangan memakai `0.0.0.0` untuk `HOST`; API sengaja hanya listen di localhost dan dipublikasikan melalui tunnel.

Buat secret dengan contoh berikut:

```bash
openssl rand -hex 32
```

## 2. Inisialisasi database dan jalankan PM2

Runtime Node terhubung ke database Turso/libSQL pada `TURSO_DATABASE_URL`, lalu otomatis memastikan schema serta tabel/kolom migrasi yang diperlukan tersedia. Jalankan:

```bash
pm2 start ecosystem.config.cjs
pm2 startup
```

Perintah `pm2 startup` akan menampilkan satu perintah `sudo ...`; jalankan perintah tersebut, kemudian jalankan:

```bash
pm2 save
```

Cek API dari VPS:

```bash
curl http://127.0.0.1:3000/health
pm2 status
pm2 logs license-manager-api --lines 100
```

Respons health yang benar memiliki `status: "ok"`.

## 3. Cloudflare Tunnel

Buat tunnel di dashboard Cloudflare atau CLI, lalu arahkan hostname API ke port lokal PM2. Contoh `/etc/cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: /etc/cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: api.example.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

Tes dan pasang sebagai service:

```bash
sudo cloudflared tunnel ingress validate
sudo cloudflared service install
sudo systemctl enable --now cloudflared
curl https://api.example.com/health
```

Ganti `api.example.com` dengan hostname API yang Anda pakai. Firewall VPS tidak perlu membuka port 3000; tunnel mengaksesnya secara lokal.

## 4. Operasional

```bash
pm2 restart license-manager-api --update-env
pm2 logs license-manager-api
sudo systemctl status cloudflared
```

Gunakan satu instance PM2 (`instances: 1`). Database production berada di Turso/libSQL, sehingga data tidak hilang saat proses PM2 restart dan tidak ada file database lokal yang perlu dikelola di VPS. Backup dan point-in-time recovery dikelola dari sisi Turso.

## Catatan keamanan

- Jangan commit `.env` atau token Turso.
- Set `TURNSTILE_ENABLED=true` di production dan isi `TURNSTILE_SECRET_KEY`.
- Batasi `CORS_ORIGIN` ke origin frontend yang benar.
- Ganti password admin bawaan sebelum API dipublikasikan.
- Endpoint `/health` tidak memerlukan autentikasi dan dipakai untuk pemeriksaan tunnel/monitoring.

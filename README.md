# license-manager-lynkid-with-pm2

Backend License Manager

Backend Cloudflare Workers + Hono untuk license manager Android/web sesuai `license-manager-spec-revised.md`.

Backend juga menyediakan runtime Node.js untuk deploy di VPS melalui PM2. Panduan deploy VPS + Cloudflare Tunnel ada di [`DEPLOY-VPS.md`](DEPLOY-VPS.md).

Frontend SvelteKit tersedia di folder `frontend/` dan menggunakan desain Stitch yang disimpan di `stitch-assets/`.

## Menjalankan lokal

```bash
npm install
npm run db:local
npm run dev
```

Untuk menjalankan frontend di terminal kedua:

```bash
cd frontend
npm install
npm run dev
```

Untuk runtime Node/PM2, isi `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `JWT_SECRET`, dan `MERCHANT_CONFIG_ENCRYPTION_KEY` di `.env` pada VPS. `LYNK_MERCHANT_KEY` tetap didukung sebagai fallback untuk webhook lama. Untuk deployment Worker Cloudflare, secret tetap dapat diatur dengan `wrangler secret put`. Untuk development lokal Worker, salin `.dev.vars.example` menjadi `.dev.vars` lalu isi nilainya.

Salin `.env.example` dan `frontend/.env.example` sebagai referensi konfigurasi. Jangan simpan `.env` atau secret Worker di source control.

`TURNSTILE_ENABLED=false` membuat endpoint check dan login admin bisa dipakai lokal tanpa token. Di production, set `TURNSTILE_ENABLED=true` dan `TURNSTILE_SECRET_KEY`. Frontend production juga harus memiliki `PUBLIC_TURNSTILE_SITE_KEY`.

Batas device ditentukan oleh `max_devices` pada product mapping; tidak ada lagi batas global dari environment.

## Endpoint

- `POST /admin/login`
- `GET|POST|PUT|DELETE /admin/mapping`
- `GET|POST|PUT /admin/lynk-accounts`
- `GET /admin/licenses?email=...`
- `GET /admin/licenses/:id/activations`
- `DELETE /admin/licenses/:id/activations/:activation_id`
- `POST /admin/licenses/:id/revoke|reactivate`
- `GET /admin/audit-logs`
- `POST /webhook/lynkid`
- `POST /webhook/lynkid/:account_slug`
- `POST /license/check`
- `POST /license/activate`
- `GET /license/validate?license_key=...&device_hash=...`

## Verifikasi lokal end-to-end

```bash
npm run db:local
npm run dev -- --local
```

Alur webhook → check → activate → validate dapat diuji dengan payload Lynk.id sesuai contoh di spesifikasi.

## Signature Lynk.id

`X-Lynk-Signature` diverifikasi sebagai `SHA256(grandTotal + refId + message_id + merchant_key)`. Untuk akun yang dikelola dashboard, merchant key disimpan terenkripsi menggunakan `MERCHANT_CONFIG_ENCRYPTION_KEY` dan webhook memakai URL unik `/webhook/lynkid/:account_slug`.

`POST /license/check` menggunakan `ref_id` dari transaksi Lynk.id sebagai bearer token. Email saja tidak dapat digunakan untuk lookup publik, sehingga email enumeration/scraping dapat dikurangi. Ref ID harus diperlakukan sebagai data rahasia.

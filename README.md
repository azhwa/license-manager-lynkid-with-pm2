# license-manager-lynkid-with-pm2

Backend License Manager

Backend Node.js + Hono untuk license manager Android/web dengan Turso/libSQL sebagai database.

Backend juga menyediakan runtime Node.js untuk deploy di VPS melalui PM2. Panduan deploy VPS + Cloudflare Tunnel ada di [`DEPLOY-VPS.md`](DEPLOY-VPS.md).

## Menjalankan lokal

```bash
npm install
npm run db:migrate
npm run dev
```

Untuk runtime Node/PM2, isi `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `JWT_SECRET`, dan `MERCHANT_CONFIG_ENCRYPTION_KEY` di `.env`. `LYNK_MERCHANT_KEY` tetap didukung sebagai fallback untuk webhook lama.

Salin `.env.example` sebagai referensi konfigurasi. Jangan simpan `.env` atau token Turso di source control.

`TURNSTILE_ENABLED=false` membuat endpoint check dan login admin bisa dipakai lokal tanpa token. Di production, set `TURNSTILE_ENABLED=true` dan `TURNSTILE_SECRET_KEY`. Frontend production juga harus memiliki `PUBLIC_TURNSTILE_SITE_KEY`.

Pada runtime Node/PM2, validasi lisensi selalu membaca Turso secara langsung tanpa cache response. Cache memory hanya digunakan untuk rate limit dan akan reset ketika proses PM2 restart.

Gunakan `/health` untuk liveness process dan `/health/ready` untuk memastikan koneksi Turso tersedia.

Smoke test bersifat write dan memerlukan `SMOKE_TEST_ALLOW_WRITE=true` secara eksplisit.

Batas device ditentukan oleh `max_devices` pada product mapping; tidak ada lagi batas global dari environment.

`plan_type` dapat diisi bebas sebagai teks (maksimal 50 karakter), termasuk perbedaan huruf besar/kecil, baik saat membuat license manual maupun product mapping. Nilai lama seperti `trial`, `monthly`, `bimonthly`, dan `yearly` tetap valid. Saat migrasi, database lama dengan CHECK constraint plan type akan diubah otomatis tanpa menghapus data.

## Endpoint

- `POST /admin/login`
- `GET|POST|PUT|DELETE /admin/mapping`
- `GET|POST|PUT /admin/lynk-accounts`
- `GET|POST /admin/licenses` (POST untuk membuat license manual)
- `GET /admin/licenses/:id/activations`
- `DELETE /admin/licenses/:id/activations/:activation_id`
- `POST /admin/licenses/:id/revoke|reactivate`
- `GET /admin/audit-logs`
- `POST /webhook/lynkid`
- `POST /webhook/lynkid/:account_slug`
- `POST /license/check`
- `POST /license/activate`
- `POST /license/unbind`
- `GET /license/validate?license_key=...&device_hash=...`

## Verifikasi lokal end-to-end

```bash
npm run db:migrate
npm run dev
```

Alur webhook → check → activate → validate dapat diuji dengan payload Lynk.id sesuai contoh di spesifikasi.

## Signature Lynk.id

`X-Lynk-Signature` diverifikasi sebagai `SHA256(grandTotal + refId + message_id + merchant_key)`. Untuk akun yang dikelola dashboard, merchant key disimpan terenkripsi menggunakan `MERCHANT_CONFIG_ENCRYPTION_KEY` dan webhook memakai URL unik `/webhook/lynkid/:account_slug`.

`POST /license/check` menggunakan `ref_id` dari transaksi Lynk.id sebagai bearer token. Email saja tidak dapat digunakan untuk lookup publik, sehingga email enumeration/scraping dapat dikurangi. Ref ID harus diperlakukan sebagai data rahasia.

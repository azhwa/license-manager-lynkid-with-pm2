# License Manager - Spesifikasi Lengkap (Revisi)

> Catatan: dokumen ini adalah rancangan historis. Deployment backend saat ini adalah Node.js + PM2 + Turso/libSQL melalui Cloudflare Tunnel; bagian Workers/D1/KV di bawah tidak lagi menjadi konfigurasi runtime.

## Ringkasan Sistem

Sistem license manager untuk aplikasi Android (Kotlin) dan web (SvelteKit/Next.js) dengan model lisensi **trial** dan **berlangganan 2 bulanan**, menggunakan **Lynk.id** sebagai payment gateway dan **Cloudflare Workers** sebagai backend serverless. Frontend menggunakan **SvelteKit** untuk performa optimal dan familiarity developer.

## Arsitektur Utama

### Stack Teknologi

| Komponen | Teknologi | Fungsi |
|----------|-----------|--------|
| Backend API | Cloudflare Workers + Hono v4 | Endpoint webhook, license check, activate, validate |
| Client Apps | Kotlin (Android), SvelteKit/Next.js (Web) | Aplikasi yang dilisensikan |
| Frontend Dashboard | SvelteKit 2.x + Tailwind CSS | Dashboard admin dan halaman cek license publik |
| Database | Cloudflare D1 (SQLite) | Penyimpanan license, transaksi, mapping produk |
| Cache | Cloudflare KV | Cache validasi license untuk hemat quota |
| Anti-bot | Cloudflare Turnstile | Proteksi form cek license publik |
| Scheduler | Workers Cron Trigger | Reminder renewal harian |
| Payment | Lynk.id | Checkout dan webhook notifikasi |
| Deployment | Cloudflare Pages (SvelteKit) + Workers | Hosting gratis, edge network global |

### Diagram Arsitektur

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER FACING                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐              ┌──────────────┐                │
│  │  Android App │              │   Web App    │                │
│  │  (Kotlin)    │              │ (SvelteKit/  │                │
│  │              │              │   Next.js)   │                │
│  └──────┬───────┘              └──────┬───────┘                │
│         │                             │                         │
│         └──────────┬──────────────────┘                         │
│                    │                                            │
│                    ▼                                            │
│         ┌──────────────────┐                                    │
│         │  Cloudflare      │                                    │
│         │  Pages (SvelteKit)│                                   │
│         │  - /check        │                                    │
│         │  - /dashboard    │                                    │
│         └────────┬─────────┘                                    │
│                  │                                              │
└──────────────────┼──────────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                      BACKEND (Cloudflare)                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Cloudflare Workers (Hono)                  │   │
│  │                                                         │   │
│  │  POST /webhook/lynkid    ← Lynk.id webhook             │   │
│  │  POST /license/check     ← User cek license            │   │
│  │  POST /license/activate  ← App bind device             │   │
│  │  GET  /license/validate  ← App cek status              │   │
│  │  GET  /admin/mapping     ← Dashboard admin             │   │
│  │  POST /admin/mapping     ← CRUD mapping produk         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                    │                                            │
│         ┌──────────┼──────────┐                                │
│         ▼          ▼          ▼                                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                       │
│  │   D1     │ │    KV    │ │ Turnstile│                       │
│  │ (SQLite) │ │ (Cache)  │ │ (Anti-bot)│                      │
│  └──────────┘ └──────────┘ └──────────┘                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                     EXTERNAL SERVICES                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐              ┌──────────────┐                │
│  │   Lynk.id    │              │ Google Sheets│                │
│  │  (Payment)   │              │  (Audit Log) │                │
│  └──────────────┘              └──────────────┘                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Endpoint API

### 1. POST /webhook/lynkid

**Fungsi:** Menerima notifikasi transaksi dari Lynk.id

**Headers:**
- `X-Lynk-Signature`: SHA256 signature untuk verifikasi

**Body (JSON):**
```json
{
  "event": "payment.received",
  "data": {
    "message_action": "SUCCESS",
    "message_code": "0",
    "message_data": {
      "createdAt": "2025-04-10T14:30:45",
      "customer": {
        "email": "user@example.com",
        "name": "User Name",
        "phone": "08123456789"
      },
      "items": [
        {
          "title": "Aplikasi Autogas 1 Bulan",
          "price": 50000,
          "qty": 1,
          "uuid": "xxx-yyy-zzz"
        }
      ],
      "refId": "abc123def456",
      "totals": {
        "grandTotal": 50000
      }
    },
    "message_id": "API_CALL_123456"
  }
}
```

**Logika:**
1. Verifikasi `X-Lynk-Signature` dengan rumus: `SHA256(grandTotal + refId + message_id + merchant_key)`
2. Cek `message_id` belum pernah diproses (unique constraint di DB)
3. Mapping `items[0].title` ke `duration_days` via tabel `product_mapping`
4. Cari license berdasarkan `customer.email`:
   - Jika tidak ada → INSERT baru, `current_period_end = now + duration_days`
   - Jika ada dan masih aktif → UPDATE, `current_period_end = current_period_end + duration_days` (stacking)
   - Jika sudah expired → UPDATE, `current_period_end = now + duration_days`
5. Generate `license_key` unik (format: `XXXX-XXXX-XXXX-XXXX`)
6. Insert ke tabel `transactions` dengan status `signature_verified = true`
7. Invalidate cache KV `license:{email}`
8. Response `200 OK`

**Keamanan:**
- Signature wajib diverifikasi sebelum proses data
- `message_id` harus unique (anti replay attack)
- Simpan `raw_payload` untuk audit

---

### 2. POST /license/check

**Fungsi:** User cek license berdasarkan `refId` transaksi Lynk.id

**Body (JSON):**
```json
{
  "ref_id": "abc123def456",
  "turnstile_token": "xxx.yyy.zzz"
}
```

**Response:**
```json
{
  "licenses": [
    {
      "refId": "abc123def456",
      "license_key": "A1B2-C3D4-E5F6-G7H8",
      "status": "active",
      "current_period_end": "2026-10-24T10:00:00Z",
      "days_remaining": 61,
      "plan_type": "bimonthly"
    }
  ]
}
```

**Keamanan:**
- Wajib Cloudflare Turnstile token (anti-bot)
- Rate limiting: max 10 request/IP/menit
- Ref ID diperlakukan sebagai bearer token dan tidak boleh dibagikan secara publik

---

### 3. POST /license/activate

**Fungsi:** Bind device ke license key

**Body (JSON):**
```json
{
  "license_key": "A1B2-C3D4-E5F6-G7H8",
  "device_hash": "sha256_device_fingerprint",
  "platform": "android" // atau "web" untuk web app
}
```

**Logika:**
1. Validasi `license_key` ada dan status `active`
2. Cek `current_period_end > now`
3. Hitung jumlah device yang sudah terbind (`COUNT(activations)`)
4. Jika `COUNT < max_devices` pada license, INSERT ke `activations`
5. Response dengan status aktivasi

**Response:**
```json
{
  "success": true,
  "message": "Device activated successfully",
  "device_slot_used": 2,
  "max_devices": 3,
  "expires_at": "2026-10-24T10:00:00Z"
}
```

---

### 4. GET /license/validate

**Fungsi:** Validasi status license saat app dibuka

**Query Params:**
- `license_key`: string
- `device_hash`: string

**Response:**
```json
{
  "valid": true,
  "status": "active",
  "expires_at": "2026-10-24T10:00:00Z",
  "days_remaining": 61,
  "plan_type": "bimonthly"
}
```

**Optimasi:**
- Cek cache KV dulu (TTL 24 jam)
- Jika cache miss, query D1 dan update cache
- Return JWT signed untuk validasi offline di app

---

### 5. GET /admin/mapping

**Fungsi:** Dashboard admin untuk manage mapping produk

**Auth:** Simple JWT login (hanya untuk internal)

**Response:**
```json
{
  "mappings": [
    {
      "id": 1,
      "title_pattern": "Aplikasi Autogas 1 Bulan",
      "duration_days": 30,
      "plan_type": "monthly"
    },
    {
      "id": 2,
      "title_pattern": "Aplikasi Autogas 2 Bulan",
      "duration_days": 60,
      "plan_type": "bimonthly"
    }
  ]
}
```

---

### 6. POST /admin/mapping

**Fungsi:** Tambah/edit mapping produk

**Body (JSON):**
```json
{
  "title_pattern": "Aplikasi Autogas 1 Bulan",
  "duration_days": 30,
  "plan_type": "monthly"
}
```

---

## Skema Database (D1)

### Tabel: licenses

```sql
CREATE TABLE licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  key TEXT UNIQUE NOT NULL,
  plan_type TEXT NOT NULL, -- 'trial' | 'monthly' | 'bimonthly' | 'yearly'
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'expired' | 'revoked'
  current_period_end DATETIME,
  trial_ends_at DATETIME,
  max_devices INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_licenses_email ON licenses(email);
CREATE INDEX idx_licenses_status ON licenses(status);
```

---

### Tabel: activations

```sql
CREATE TABLE activations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL,
  device_hash TEXT NOT NULL,
  device_name TEXT,
  platform TEXT NOT NULL, -- 'android' (Kotlin) | 'web' (SvelteKit/Next.js)
  activated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (license_id) REFERENCES licenses(id),
  UNIQUE(license_id, device_hash)
);

CREATE INDEX idx_activations_license ON activations(license_id);
```

---

### Tabel: transactions

```sql
CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT UNIQUE NOT NULL,
  refId TEXT NOT NULL,
  email TEXT NOT NULL,
  gateway TEXT NOT NULL DEFAULT 'lynkid',
  product_title TEXT NOT NULL,
  amount INTEGER NOT NULL,
  duration_days_applied INTEGER,
  previous_period_end DATETIME,
  new_period_end DATETIME,
  renewal_type TEXT, -- 'new' | 'stacked' | 'reactivated'
  signature_verified BOOLEAN NOT NULL DEFAULT true,
  raw_payload TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_transactions_email ON transactions(email);
CREATE INDEX idx_transactions_refId ON transactions(refId);
```

---

### Tabel: product_mapping

```sql
CREATE TABLE product_mapping (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title_pattern TEXT UNIQUE NOT NULL,
  duration_days INTEGER NOT NULL,
  plan_type TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_product_mapping_active ON product_mapping(is_active);
```

---

### Tabel: webhook_logs

```sql
CREATE TABLE webhook_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,
  raw_payload TEXT NOT NULL,
  signature_valid BOOLEAN NOT NULL,
  processed BOOLEAN DEFAULT false,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_webhook_logs_message_id ON webhook_logs(message_id);
```

---

## Struktur File Project

```
license-manager/
│
├── src/                          # Backend Workers
│   ├── index.ts                  # Entry point Hono
│   ├── routes/
│   │   ├── webhook.ts            # /webhook/lynkid
│   │   ├── license.ts            # /license/*
│   │   └── admin.ts              # /admin/*
│   ├── db/
│   │   ├── schema.sql            # D1 migration
│   │   └── queries.ts            # Helper query
│   ├── utils/
│   │   ├── signature.ts          # Verifikasi Lynk signature
│   │   ├── license-key.ts        # Generate license key
│   │   └── jwt.ts                # JWT sign/verify
│   └── types.ts                  # TypeScript types
│
├── frontend/                     # Frontend SvelteKit
│   ├── src/
│   │   ├── routes/
│   │   │   ├── +page.svelte      # Root redirect
│   │   │   ├── check/
│   │   │   │   └── +page.svelte  # Publik cek license
│   │   │   ├── login/
│   │   │   │   └── +page.svelte  # Login admin
│   │   │   └── dashboard/
│   │   │       └── +page.svelte  # Dashboard mapping
│   │   ├── lib/
│   │   │   ├── api.ts            # API client
│   │   │   └── stores.ts         # Svelte stores
│   │   ├── app.html
│   │   └── app.css
│   ├── static/
│   │   └── favicon.png
│   ├── svelte.config.js
│   ├── tailwind.config.js
│   ├── vite.config.ts
│   └── package.json
│
├── wrangler.toml                 # Workers config
├── package.json                  # Backend deps
├── tsconfig.json                 # TypeScript config
└── README.md                     # Dokumentasi setup
```

---

## Konfigurasi wrangler.toml

```toml
name = "license-manager"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "license-manager-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

[[kv_namespaces]]
binding = "KV_CACHE"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

[vars]
LYNK_MERCHANT_KEY = "your-merchant-key"
JWT_SECRET = "your-jwt-secret"

[triggers]
crons = ["0 0 * * *"]  # Daily reminder job
```

---

## SvelteKit Config

```javascript
// frontend/svelte.config.js
import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      routes: {
        include: ['/*'],
        exclude: ['/api/*']
      }
    }),
    alias: {
      $lib: './src/lib'
    }
  }
};
```

---

## Alur Kerja

### 1. Setup Awal

1. Buat produk di Lynk.id dengan judul eksplisit (misal "Aplikasi Autogas 1 Bulan")
2. Daftarkan webhook URL di Lynk.id: `https://license-manager.appkamu.com/webhook/lynkid`
3. Tambahkan mapping di tabel `product_mapping` via dashboard admin
4. Deploy Worker dengan `wrangler deploy`
5. Deploy SvelteKit dengan `wrangler pages deploy`

### 2. Transaksi Pembelian

1. User checkout di Lynk.id dengan email mereka
2. Lynk.id kirim webhook `payment.received` ke Worker
3. Worker verifikasi signature, mapping durasi, generate license key
4. Simpan ke D1, invalidate cache KV
5. User buka `license.appkamu.com/check`, input email, dapat license key

### 3. Aktivasi di App

1. User input license key di Android (Kotlin) atau web app (SvelteKit/Next.js)
2. App kirim ke `/license/activate` dengan device hash
3. Worker bind device ke license (max 3 devices)
4. App simpan JWT untuk validasi offline

### 4. Validasi Harian

1. App buka → cek `/license/validate` (max 1-2x/hari)
2. Worker cek cache KV, fallback ke D1
3. Return status valid/invalid + expiry

### 5. Renewal Otomatis

1. User beli lagi dengan email yang sama
2. Webhook masuk → Worker cek existing license
3. Jika masih aktif → stacking durasi baru
4. Jika expired → reset dari sekarang
5. User dapat tambahan hari tanpa kehilangan sisa lama

---

## Keamanan

### Webhook

- Verifikasi `X-Lynk-Signature` wajib sebelum proses data
- `message_id` unique constraint mencegah duplikasi
- Simpan `raw_payload` untuk audit/replay

### License Check

- Cloudflare Turnstile wajib di form
- Rate limiting 10 request/IP/menit
- Hanya tampilkan data email yang diminta

### Device Binding

- Device hash dari kombinasi MAC address + hardware ID
- Max 3 devices per license (configurable)
- JWT signed untuk validasi offline

### Database

- Prepared statements untuk cegah SQL injection
- Unique constraints di kolom kritis
- Foreign keys untuk integrity

---

## Optimasi Free Tier

### Cloudflare Workers

- Limit: 100.000 request/hari (free tier)
- Strategi: cache KV untuk validasi, cron job untuk reminder

### D1

- Limit: 5M rows read/hari, 5GB storage
- Strategi: index di kolom yang sering query (email, status)

### KV

- Limit: 100.000 read/hari, 1.000 write/hari
- Strategi: TTL 24 jam, hanya update saat ada perubahan status

### Turnstile

- Gratis unlimited untuk use case normal
- Deploy di form cek license publik

---

## Monitoring & Debugging

### Webhook Logs

- Semua webhook masuk dicatat di `webhook_logs`
- Flag `signature_valid` dan `processed` untuk tracking
- Query manual untuk troubleshooting

### Transaction History

- Setiap transaksi tercatat di `transactions`
- Kolom `renewal_type` untuk analisis pola renewal
- `previous_period_end` dan `new_period_end` untuk audit

### Admin Dashboard

- Dashboard mapping produk (SvelteKit)
- Query manual license by email untuk customer support
- Export CSV untuk laporan

---

## Fallback & Disaster Recovery

### Jika Webhook Gagal

- Lynk.id akan retry (pastikan response 200 OK)
- Cek `webhook_logs` untuk webhook yang `processed = false`
- Reprocess manual via query SQL

### Jika User Kehilangan Email

- Lookup manual by email di dashboard admin
- Tampilkan semua license aktif milik email tersebut
- Lookup publik menggunakan refId; admin tetap dapat melakukan lookup manual berdasarkan email

### Jika D1 Down

- Fallback ke Google Sheets integration (read-only)
- Manual lookup via dashboard Lynk.id
- Customer support handle via email/WA

---

## Roadmap Pengembangan

### Fase 1 (MVP)

- [ ] Setup D1 schema
- [ ] Implement webhook handler
- [ ] Implement license check endpoint
- [ ] Deploy Worker + SvelteKit

### Fase 2 (Optimasi)

- [ ] Implement device activation
- [ ] Implement license validation
- [ ] Add KV caching
- [ ] Add Turnstile protection

### Fase 3 (Admin)

- [ ] Build dashboard mapping produk
- [ ] Add JWT auth untuk admin
- [ ] Implement renewal reminder cron

### Fase 4 (Scale)

- [ ] Monitoring & alerting
- [ ] Rate limiting lebih ketat
- [ ] Analytics renewal rate
- [ ] Multi-product support

---

## Deployment Guide

### 1. Setup Database

```bash
# Create D1 database
wrangler d1 create license-manager-db

# Run migration
wrangler d1 execute license-manager-db --file=src/db/schema.sql
```

### 2. Deploy Backend

```bash
# Install dependencies
npm install

# Set secrets
wrangler secret put LYNK_MERCHANT_KEY
wrangler secret put JWT_SECRET
wrangler secret put ADMIN_USERNAME
wrangler secret put ADMIN_PASSWORD

# Deploy Workers
wrangler deploy
```

### 3. Deploy Frontend

```bash
cd frontend
npm install
npm run build
wrangler pages deploy build --project-name=license-manager-admin
```

### 4. Setup External

- Daftarkan webhook URL di Lynk.id dashboard
- Setup Turnstile site key di Cloudflare dashboard
- (Opsional) Aktifkan Google Sheets integration di Lynk.id

---

## Environment Variables

### Backend (Workers Secrets)

```bash
wrangler secret put LYNK_MERCHANT_KEY
wrangler secret put JWT_SECRET
wrangler secret put ADMIN_USERNAME
wrangler secret put ADMIN_PASSWORD
```

### Frontend (SvelteKit)

```env
# frontend/.env
PUBLIC_TURNSTILE_SITE_KEY=1x000000000000000000000AA
PUBLIC_API_URL=https://license-manager.workers.dev
```

---

## Cost Estimate (Free Tier)

| Service | Free Tier Limit | Cukup untuk 10k user? |
|---------|-----------------|----------------------|
| Workers | 100K request/hari | ✅ Ya (dengan caching) |
| D1 | 5M rows read/hari | ✅ Ya |
| KV | 100K read/hari | ✅ Ya (TTL 24 jam) |
| Pages | Unlimited request | ✅ Ya |
| Turnstile | Unlimited | ✅ Ya |

**Total biaya: $0/bulan** (selama traffic dalam batas free tier)

---

## Catatan Penting

1. **Jangan hardcode merchant key** di source code — simpan di Workers Secrets
2. **Testing webhook** pakai tool seperti ngrok atau webhook.site sebelum deploy
3. **Backup D1** secara berkala dengan `wrangler d1 export`
4. **Monitor quota** free tier di dashboard Cloudflare
5. **Dokumentasi API** untuk tim mobile/web app developer
6. **SvelteKit adapter** harus `@sveltejs/adapter-cloudflare` untuk deployment optimal di Pages
7. **Client apps** (Kotlin Android, SvelteKit/Next.js web) bisa diintegrasikan dengan API `/license/activate` dan `/license/validate` secara independen

---

## Referensi

- [Lynk.id Webhook Documentation](https://documenter.getpostman.com/view/43601478/2sBXc8o3kn)
- [Cloudflare D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Hono Documentation](https://hono.dev/)
- [Cloudflare Turnstile](https://www.cloudflare.com/products/turnstile/)
- [SvelteKit Documentation](https://kit.svelte.dev/)
- [SvelteKit Adapter Cloudflare](https://kit.svelte.dev/docs/adapter-cloudflare)

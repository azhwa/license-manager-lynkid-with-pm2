# License Manager API

Dokumentasi endpoint untuk License Manager API.

## Konvensi umum

- Base URL production: `https://api-license.id-manager.my.id`
- Semua request JSON harus memakai header `Content-Type: application/json`.
- Response error menggunakan format berikut:

```json
{
  "error": "Pesan error",
  "details": {
    "field": "Informasi tambahan"
  }
}
```

- Endpoint admin membutuhkan header:

```http
Authorization: Bearer <admin_jwt>
```

- JWT admin berlaku selama 8 jam.
- Nilai `plan_type` adalah teks bebas maksimal 50 karakter. Kapitalisasi dipertahankan, misalnya `Premium VIP`, `PREMIUM`, atau `premium`.
- `device_hash` harus berupa SHA-256 hex lowercase/uppercase dengan panjang 64 karakter. Server menormalisasikannya menjadi lowercase.
- Timestamp yang dikirim API menggunakan ISO-8601 dengan zona UTC (`Z`). Timestamp internal SQLite seperti `created_at` dan `last_seen` juga diperlakukan sebagai UTC saat ditampilkan.
- Runtime backend memakai `APP_TIMEZONE` untuk menafsirkan input tanggal tanpa jam, misalnya `Asia/Jakarta`.

---

## 1. Health dan informasi API

### GET `/`

Memeriksa informasi dasar API.

**Response `200 OK`**

```json
{
  "name": "License Manager API",
  "version": "0.1.0",
  "status": "ok"
}
```

### GET `/health`

Liveness check untuk memastikan process API sedang berjalan.

**Response `200 OK`**

```json
{
  "status": "ok",
  "timestamp": "2026-08-26T12:00:00.000Z"
}
```

### GET `/health/ready`

Readiness check yang sekaligus memeriksa koneksi ke database Turso.

**Response `200 OK`**

```json
{
  "status": "ok",
  "database": "ok",
  "timestamp": "2026-08-26T12:00:00.000Z"
}
```

**Response `503 Service Unavailable`**

```json
{
  "status": "error",
  "database": "unavailable",
  "timestamp": "2026-08-26T12:00:00.000Z"
}
```

---

## 2. Autentikasi admin

### POST `/admin/login`

Login dashboard admin dan mendapatkan JWT.

Rate limit: maksimal 5 request per 15 menit per IP.

**Request JSON**

```json
{
  "username": "admin",
  "password": "password-admin",
  "turnstile_token": "token-cloudflare-turnstile"
}
```

`turnstile_token` wajib dikirim jika `TURNSTILE_ENABLED=true`. Jika Turnstile disabled, field tersebut boleh dikosongkan.

**Response `200 OK`**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_in": 28800,
  "user": {
    "username": "admin",
    "role": "admin"
  }
}
```

Error umum: `401` kredensial salah, `403` Turnstile gagal, `429` terlalu banyak request.

---

## 3. Manajemen Lynk.id account — Admin

Semua endpoint pada bagian ini membutuhkan JWT admin.

### GET `/admin/lynk-accounts`

Mengambil seluruh akun Lynk.id.

**Response `200 OK`**

```json
{
  "accounts": [
    {
      "id": 1,
      "name": "AutoGas Store",
      "slug": "autogas-store",
      "is_active": 1,
      "created_at": "2026-08-26 12:00:00",
      "updated_at": "2026-08-26 12:00:00",
      "webhook_path": "/webhook/lynkid/autogas-store"
    }
  ]
}
```

Merchant key tidak pernah dikembalikan oleh endpoint ini.

### POST `/admin/lynk-accounts`

Membuat akun Lynk.id baru. Merchant key disimpan terenkripsi oleh backend.

**Request JSON**

```json
{
  "name": "AutoGas Store",
  "slug": "autogas-store",
  "merchant_key": "lynk-merchant-key-rahasia",
  "is_active": true
}
```

`slug` hanya boleh berisi huruf kecil, angka, dan tanda penghubung, misalnya `autogas-store`.

**Response `201 Created`**

```json
{
  "account": {
    "id": 1,
    "name": "AutoGas Store",
    "slug": "autogas-store",
    "is_active": 1,
    "created_at": "2026-08-26 12:00:00",
    "updated_at": "2026-08-26 12:00:00",
    "webhook_path": "/webhook/lynkid/autogas-store"
  }
}
```

### PUT `/admin/lynk-accounts/:id`

Mengubah akun Lynk.id. `merchant_key` bersifat opsional; jika tidak dikirim, key lama tetap digunakan.

**Request JSON**

```json
{
  "name": "AutoGas Store Production",
  "slug": "autogas-store",
  "merchant_key": "merchant-key-baru",
  "is_active": true
}
```

**Response `200 OK`** menggunakan format `account` yang sama seperti endpoint POST.

### DELETE `/admin/lynk-accounts/:id`

Menghapus akun Lynk.id yang belum memiliki histori webhook atau transaksi.

**Response `204 No Content`** tidak memiliki body.

Jika akun sudah memiliki histori, response `409 Conflict` dan akun harus dinonaktifkan menggunakan `PUT` dengan `is_active: false`.

---

## 4. Product mapping — Admin

Product mapping menghubungkan judul produk Lynk.id dengan durasi license, plan type, dan batas device. Semua endpoint membutuhkan JWT admin.

### GET `/admin/mapping`

**Response `200 OK`**

```json
{
  "mappings": [
    {
      "id": 1,
      "title_pattern": "Aplikasi AutoGas 2 Bulan",
      "duration_days": 60,
      "plan_type": "Premium VIP",
      "max_devices": 2,
      "is_trial": 0,
      "is_active": 1,
      "created_at": "2026-08-26 12:00:00"
    }
  ]
}
```

### POST `/admin/mapping`

Membuat product mapping baru.

**Request JSON**

```json
{
  "title_pattern": "Aplikasi AutoGas 2 Bulan",
  "duration_days": 60,
  "plan_type": "Premium VIP",
  "max_devices": 2,
  "is_trial": false,
  "is_active": true
}
```

Ketentuan: `duration_days` minimal 1, `max_devices` antara 1 sampai 100, dan `plan_type` wajib diisi maksimal 50 karakter.

**Response `201 Created`**

```json
{
  "mapping": {
    "id": 1,
    "title_pattern": "Aplikasi AutoGas 2 Bulan",
    "duration_days": 60,
    "plan_type": "Premium VIP",
    "max_devices": 2,
    "is_trial": 0,
    "is_active": 1,
    "created_at": "2026-08-26 12:00:00"
  }
}
```

### PUT `/admin/mapping/:id`

Mengubah product mapping.

**Request JSON**

```json
{
  "title_pattern": "AutoGas Premium 2 Bulan",
  "duration_days": 60,
  "plan_type": "PREMIUM_2M",
  "max_devices": 3,
  "is_trial": false,
  "is_active": true
}
```

**Response `200 OK`** menggunakan format `mapping` yang sama seperti endpoint POST.

### DELETE `/admin/mapping/:id`

Menghapus product mapping.

**Response `204 No Content`** tidak memiliki body.

---

## 5. Manajemen license — Admin

Semua endpoint pada bagian ini membutuhkan JWT admin.

### GET `/admin/licenses`

Mengambil maksimal 100 license terbaru. Bisa difilter berdasarkan email.

**Query opsional**

```text
/admin/licenses?email=customer@example.com
```

**Response `200 OK`**

```json
{
  "licenses": [
    {
      "id": 10,
      "email": "customer@example.com",
      "name": "Budi Santoso",
      "key": "AUTO-ABCD-EFGH-IJKL",
      "plan_type": "Premium VIP",
      "access_type": "paid",
      "status": "active",
      "current_period_end": "2026-09-25T12:00:00.000Z",
      "trial_ends_at": null,
      "max_devices": 2,
      "created_at": "2026-08-26 12:00:00",
      "updated_at": "2026-08-26 12:00:00",
      "devices_used": 1
    }
  ]
}
```

### POST `/admin/licenses`

Membuat license secara manual. Jika `key` dikosongkan, server membuat key otomatis.

**Request JSON**

```json
{
  "email": "customer@example.com",
  "name": "Budi Santoso",
  "key": "AUTO-ABCD-EFGH-IJKL",
  "plan_type": "Premium VIP",
  "duration_days": 30,
  "max_devices": 2
}
```

`duration_days` antara 1 sampai 3650. Key hanya boleh berisi huruf, angka, dan tanda penghubung dengan panjang 8 sampai 64 karakter; key akan disimpan uppercase.

**Response `201 Created`**

```json
{
  "success": true,
  "license": {
    "id": 10,
    "email": "customer@example.com",
    "name": "Budi Santoso",
    "key": "AUTO-ABCD-EFGH-IJKL",
    "plan_type": "Premium VIP",
    "status": "active",
    "current_period_end": "2026-09-25T12:00:00.000Z",
    "max_devices": 2,
    "created_at": "2026-08-26 12:00:00",
    "updated_at": "2026-08-26T12:00:00.000Z"
  }
}
```

### PUT `/admin/licenses/:id`

Mengubah data license manual yang sudah ada. License key tidak diubah agar aplikasi client tetap menggunakan key yang sama. `name` bersifat opsional.

**Request JSON**

```json
{
  "email": "customer@example.com",
  "name": "Budi Santoso",
  "plan_type": "PREMIUM VIP",
  "expires_at": "2026-10-25",
  "max_devices": 3
}
```

`expires_at` dapat berupa tanggal `YYYY-MM-DD` atau timestamp ISO-8601. Jika berupa tanggal saja, masa berlaku dihitung sampai akhir tanggal tersebut. `max_devices` tidak boleh lebih kecil dari jumlah device yang sedang aktif.

License berbayar tidak dapat diubah menjadi Trial melalui endpoint edit.

**Response `200 OK`**

```json
{
  "success": true,
  "license": {
    "id": 10,
    "email": "customer@example.com",
    "name": "Budi Santoso",
    "key": "AUTO-ABCD-EFGH-IJKL",
    "plan_type": "PREMIUM VIP",
    "status": "active",
    "current_period_end": "2026-10-25T23:59:59.999Z",
    "trial_ends_at": null,
    "max_devices": 3,
    "created_at": "2026-08-26 12:00:00",
    "updated_at": "2026-08-26T12:00:00.000Z"
  }
}
```

Jika `max_devices` lebih kecil dari device aktif, endpoint mengembalikan `409 Conflict` agar device tidak melebihi batas.

### DELETE `/admin/licenses/:id`

Menghapus license dan activation device-nya. Histori transaksi, Trial claim, dan blocklist account tetap disimpan. License yang sedang dibanned harus di-unban terlebih dahulu.

### POST `/admin/licenses/:id/ban`

Memasukkan email dan nomor telepon license ke blocklist. License menjadi tidak valid dan pembelian berikutnya dari identitas tersebut tidak akan membuat license baru.

**Request JSON opsional**

```json
{ "reason": "Pelanggaran kebijakan penggunaan" }
```

### POST `/admin/licenses/:id/unban`

Menghapus account dari blocklist dan mengaktifkan kembali kemungkinan pembelian. Status license yang tersimpan tetap mengikuti status sebelum ban.

### GET `/admin/licenses/:id/activations`

Melihat device yang ter-bind pada license.

**Response `200 OK`**

```json
{
  "license": {
    "id": 10,
    "key": "AUTO-ABCD-EFGH-IJKL",
    "max_devices": 2
  },
  "activations": [
    {
      "id": 20,
      "device_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "device_name": "Samsung A54",
      "platform": "android",
      "activated_at": "2026-08-26 12:00:00",
      "last_seen": "2026-08-26 12:30:00"
    }
  ]
}
```

### DELETE `/admin/licenses/:id/activations/:activationId`

Unbind device dari sisi admin.

**Response `204 No Content`** tidak memiliki body.

### POST `/admin/licenses/:id/revoke`

Menonaktifkan license secara permanen sampai direaktivasi.

**Request body:** tidak ada.

**Response `200 OK`**

```json
{
  "success": true,
  "status": "revoked"
}
```

### POST `/admin/licenses/:id/reactivate`

Mengaktifkan kembali license yang belum expired.

**Request body:** tidak ada.

**Response `200 OK`**

```json
{
  "success": true,
  "status": "active"
}
```

License expired tidak dapat direaktivasi dan menghasilkan `409 Conflict`.

---

## 6. Audit log — Admin

### GET `/admin/audit-logs`

Mengambil maksimal 200 aktivitas admin terbaru.

**Response `200 OK`**

```json
{
  "logs": [
    {
      "id": 100,
      "action": "license.created",
      "license_id": 10,
      "target_type": "license",
      "target_id": "10",
      "details": "{\"source\":\"manual\",\"plan_type\":\"Premium VIP\"}",
      "created_at": "2026-08-26 12:00:00"
    }
  ]
}
```

---

## 7. Public license API

Endpoint berikut digunakan oleh frontend publik atau aplikasi client dan tidak membutuhkan JWT admin.

### POST `/license/check`

Mencari license berdasarkan `ref_id` transaksi Lynk.id.

Rate limit: maksimal 20 request per menit per IP.

**Request JSON**

```json
{
  "ref_id": "ORDER-20260826-ABC123",
  "turnstile_token": "token-cloudflare-turnstile"
}
```

`turnstile_token` wajib jika Turnstile diaktifkan.

**Response `200 OK`**

```json
{
  "licenses": [
    {
      "refId": "ORDER-20260826-ABC123",
      "name": "Budi Santoso",
      "license_key": "AUTO-ABCD-EFGH-IJKL",
      "access_type": "paid",
      "is_trial": false,
      "trial_ends_at": null,
      "status": "active",
      "current_period_end": "2026-09-25T12:00:00.000Z",
      "days_remaining": 30,
      "plan_type": "Premium VIP"
    }
  ]
}
```

Jika transaksi tidak ditemukan, response tetap `200` dengan `licenses: []`.

### POST `/license/activate`

Mengikat license ke device. Endpoint ini idempotent untuk device yang sama: jika device sudah terdaftar, `last_seen` akan diperbarui.

Rate limit: maksimal 20 request per menit per IP.

**Request JSON**

```json
{
  "license_key": "AUTO-ABCD-EFGH-IJKL",
  "device_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "platform": "android",
  "device_name": "Samsung A54"
}
```

`platform` hanya menerima `android` atau `web`.

**Response `200 OK`**

```json
{
  "success": true,
  "message": "Device activated successfully",
  "name": "Budi Santoso",
  "access_type": "paid",
  "is_trial": false,
  "trial_ends_at": null,
  "device_slot_used": 1,
  "max_devices": 2,
  "expires_at": "2026-09-25T12:00:00.000Z",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

Token license berlaku 24 jam. Jika batas device tercapai, response `409 Conflict`:

```json
{
  "error": "Maximum device limit reached",
  "details": {
    "max_devices": 2,
    "used_devices": 2
  }
}
```

### POST `/license/unbind`

Melepas binding device dari license. Endpoint ini dipakai oleh aplikasi client ketika user memilih “Lepas Lisensi”. Jika device sudah tidak ada, request tetap dianggap berhasil.

Rate limit: maksimal 20 request per menit per IP.

**Request JSON**

```json
{
  "license_key": "AUTO-ABCD-EFGH-IJKL",
  "device_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

**Response `200 OK`**

```json
{
  "success": true,
  "message": "Device unbound successfully"
}
```

### GET `/license/validate`

Memvalidasi license dan memastikan device sudah ter-bind.

**Query wajib**

```text
/license/validate?license_key=AUTO-ABCD-EFGH-IJKL&device_hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

**Response license aktif `200 OK`**

```json
{
  "valid": true,
  "name": "Budi Santoso",
  "access_type": "paid",
  "is_trial": false,
  "trial_ends_at": null,
  "status": "active",
  "expires_at": "2026-09-25T12:00:00.000Z",
  "days_remaining": 30,
  "plan_type": "Premium VIP"
}
```

**Response license tidak ditemukan `200 OK`**

```json
{
  "valid": false,
  "status": "not_found",
  "expires_at": null,
  "days_remaining": 0
}
```

Status lain dapat berupa `expired` atau `revoked`.

---

## 8. Webhook Lynk.id

Webhook tidak membutuhkan JWT admin. Gunakan URL sesuai konfigurasi akun:

```text
https://api-license.id-manager.my.id/webhook/lynkid/<account_slug>
```

Contoh:

```text
https://api-license.id-manager.my.id/webhook/lynkid/autogas-store
```

Route legacy yang menggunakan environment `LYNK_MERCHANT_KEY` tetap tersedia:

```text
https://api-license.id-manager.my.id/webhook/lynkid
```

### GET `/webhook/lynkid/:slug`

Memeriksa apakah URL webhook dapat dijangkau.

**Response `200 OK`**

```json
{
  "success": true,
  "message": "Webhook endpoint reachable"
}
```

### GET `/webhook/lynkid`

Health check untuk route webhook legacy. Response sama seperti route dengan slug.

### POST `/webhook/lynkid/:slug`

Menerima notifikasi pembayaran Lynk.id dan otomatis membuat atau memperpanjang license berdasarkan product mapping.

**Header wajib untuk transaksi production**

```http
Content-Type: application/json
X-Lynk-Signature: <sha256-signature>
```

Signature dihitung dengan formula:

```text
SHA256(grandTotal + refId + message_id + merchant_key)
```

`message_id` yang diprioritaskan adalah `data.message_data.message_id`.

**Request JSON transaksi `payment.received`**

```json
{
  "event": "payment.received",
  "data": {
    "message_action": "PAYMENT_RECEIVED",
    "message_code": "200",
    "message_data": {
      "message_id": "msg-20260826-001",
      "createdAt": "2026-08-26T12:00:00.000Z",
      "customer": {
        "name": "Budi",
        "email": "customer@example.com",
        "phone": "081234567890"
      },
      "refId": "ORDER-20260826-ABC123",
      "items": [
        {
          "title": "Aplikasi AutoGas 2 Bulan",
          "price": 50000,
          "qty": 1,
          "uuid": "product-uuid"
        }
      ],
      "totals": {
        "grandTotal": 50000
      }
    }
  }
}
```

Field minimal yang dibutuhkan backend:

- `data.message_data.message_id` atau `data.message_id`
- `data.message_data.customer.email`
- `data.message_data.refId`
- `data.message_data.items[0].title`
- `data.message_data.totals.grandTotal`

`grandTotal` dapat berupa angka atau string angka.

`customer.name` disimpan ke license dan ditampilkan pada lookup publik serta dashboard admin. Field ini opsional untuk menjaga kompatibilitas payload lama.

Product mapping dengan `is_trial: true` hanya dapat memberikan satu Trial per email atau nomor telepon yang sudah dinormalisasi. Pembelian Trial berikutnya diakui dengan `200 OK`, tetapi tidak memperpanjang license dan mengembalikan `granted: false` serta `reason: trial_already_used`.

**Response transaksi berhasil `200 OK`**

```json
{
  "success": true,
  "granted": true,
  "account": "autogas-store",
  "license_key": "AUTO-ABCD-EFGH-IJKL",
  "renewal_type": "new",
  "expires_at": "2026-10-25T12:00:00.000Z"
}
```

Kemungkinan nilai `renewal_type`: `new`, `stacked`, `reactivated`, atau `converted` saat Trial berubah menjadi paket berbayar.

Jika email atau nomor telepon customer sudah pernah memakai Trial, webhook tetap diakui dengan `200 OK`, tetapi tidak membuat atau memperpanjang license:

```json
{
  "success": true,
  "granted": false,
  "reason": "trial_already_used"
}
```

**Response duplicate `200 OK`**

```json
{
  "success": true,
  "duplicate": true
}
```

**Response endpoint test/empty `200 OK`**

Lynk.id dapat mengirim payload kosong atau event non-payment ketika melakukan test URL. Backend mengakuinya agar test endpoint tidak gagal.

```json
{
  "success": true,
  "message": "Webhook event acknowledged"
}
```

**Error webhook**

`400` payload JSON atau field wajib tidak valid:

```json
{
  "error": "Missing required Lynk.id fields",
  "details": {
    "fields": [
      "message_data.refId",
      "message_data.items[0].title"
    ]
  }
}
```

`401` signature tidak valid:

```json
{
  "error": "Invalid webhook signature"
}
```

`404` slug akun tidak ditemukan atau tidak aktif, `422` tidak ada product mapping aktif, dan `500` konfigurasi/database webhook bermasalah.

### POST `/webhook/lynkid`

Route legacy dengan format payload dan response yang sama, tetapi signature menggunakan `LYNK_MERCHANT_KEY` dari environment.

---

## 9. Contoh cURL singkat

### Login admin

```bash
curl -X POST "https://api-license.id-manager.my.id/admin/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"password-admin","turnstile_token":"token"}'
```

### Membuat license manual

```bash
curl -X POST "https://api-license.id-manager.my.id/admin/licenses" \
  -H "Authorization: Bearer <admin_jwt>" \
  -H "Content-Type: application/json" \
  -d '{"email":"customer@example.com","plan_type":"PREMIUM VIP","duration_days":30,"max_devices":2}'
```

### Aktivasi device

```bash
curl -X POST "https://api-license.id-manager.my.id/license/activate" \
  -H "Content-Type: application/json" \
  -d '{"license_key":"AUTO-ABCD-EFGH-IJKL","device_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","platform":"android","device_name":"Samsung A54"}'
```

### Unbind device

```bash
curl -X POST "https://api-license.id-manager.my.id/license/unbind" \
  -H "Content-Type: application/json" \
  -d '{"license_key":"AUTO-ABCD-EFGH-IJKL","device_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
```

### Test URL webhook

```bash
curl -i "https://api-license.id-manager.my.id/webhook/lynkid/autogas-store" \
  -H "Content-Type: application/json" \
  -d '{"event":"webhook.test"}'
```

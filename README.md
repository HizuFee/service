## Bot WhatsApp Customer Service

Proyek ini adalah bot WhatsApp berbasis Node.js yang menggunakan Google Gemini untuk menjawab otomatis, dengan fitur greeting pertama kali, FAQ, knowledge base, pengalihan ke admin, sistem manajemen order lengkap, rate limiter anti-spam, memory per-user, dan logging berwarna + JSONL ke file.

### Fitur Utama
- Greeting pertama kali dengan tagline + daftar FAQ
- Jawab pertanyaan umum dari `data/faq.json` dan `data/knowledge.json`
- AI (Google Gemini) untuk pertanyaan di luar FAQ/knowledge
- Mode Admin (ambil alih chat, selesai, list, help)
- **Sistem Manajemen Order** (tambah, lihat, edit, hapus, export Excel)
- Rate limiter per user (anti-spam)
- Memory percakapan per user (ringkas, disimpan ke `sessions.json`)
- Logging berwarna di console dan JSONL ke `logs/bot.log`

### Persyaratan
- Node.js 18+ (disarankan LTS terbaru)
- Akun Google Generative AI (API key Gemini)
- WhatsApp aktif untuk login via QR

### Instalasi
```bash
npm install
```

### Konfigurasi
1) Buat file `.env` di root:
```env
GEMINI_API_KEY=ISI_API_KEY_ANDA
ADMIN_ID=628xxxxxx@c.us
# Batasi respon (opsional). Mode: all | allowlist
ALLOW_MODE=all
# Daftar nomor diizinkan saat allowlist (pisahkan koma). Boleh JID atau nomor.
# Contoh: 628111222333,628444555666@c.us
ALLOW_LIST=
```
2) Sesuaikan dependensi di `package.json` bila perlu.

### Menjalankan Bot
```bash
npm start
```
Login dengan memindai QR yang tampil di terminal. Setelah mengubah `.env`, restart bot.

### Struktur Proyek
```
app.js                  # Kode utama bot
data/faq.json           # Daftar pertanyaan untuk greeting (menu FAQ)
data/knowledge.json     # Knowledge base (keyword -> jawaban/info)
logs/bot.log            # Log file (JSONL)
sessions.json           # State per user (mode, greeted, memory)
orders.json             # Data order (ID, nama, harga, detail, status, waktu)
.wwebjs_auth/           # Auth data WhatsApp (jangan commit)
```

### Alur Utama
1) Greeting awal: saat user pertama kali chat, bot kirim tagline + daftar FAQ (dari `data/faq.json`).
2) Pertanyaan (tahapan jawaban):
   1. Jika cocok FAQ → kirim jawaban cepat dari FAQ
   2. Jika ada context di `knowledge.json` → panggil AI dengan prompt yang dibatasi oleh context tersebut (meminimalkan halusinasi)
   3. Jika tidak ada data yang cocok → AI menjawab singkat dan sopan, serta dengan halus menyarankan untuk ketik: "aku mau chat dengan admin" bila butuh jawaban pasti
3) Mode Admin:
   - `!ambil <nomor>`: ubah `sessions[<nomor>@c.us].mode = "human"` (admin ambil alih)
   - `!selesai <nomor>`: kembalikan `mode = "ai"`
   - `!list`, `!help`: utilitas
4) Rate limiter: max 3 pesan / 10 detik per user (kecuali admin/self)
5) Memory per user: simpan ringkas 10 pesan terakhir (user/bot) ke `sessions[from].memory`

### Mode Balas: all vs allowlist
- `ALLOW_MODE=all` → bot membalas semua nomor (default)
- `ALLOW_MODE=allowlist` → bot HANYA membalas nomor pada `ALLOW_LIST`

Contoh `.env` untuk membalas semua:
```env
ALLOW_MODE=all
ALLOW_LIST=
```

Contoh `.env` hanya untuk nomor tertentu:
```env
ALLOW_MODE=allowlist
ALLOW_LIST=628111222333,628444555666@c.us
```

Catatan:
- Entri pada `ALLOW_LIST` boleh berupa nomor murni (otomatis dinormalisasi menjadi `@c.us`) atau JID lengkap.
- Saat `allowlist` aktif, bot sama sekali tidak mengirim balasan ke nomor yang tidak diizinkan.

### File Data
- `data/faq.json` (hanya pertanyaan untuk ditampilkan di greeting)
```json
[
  { "question": "Berapa harga jasa editing video?" },
  { "question": "Berapa lama waktu pengerjaan?" }
]
```

- `data/knowledge.json` (sumber jawaban cepat berbasis keyword)
```json
[
  { "keyword": "harga", "info": "Harga mulai dari Rp150.000 ..." },
  { "keyword": "waktu pengerjaan", "info": "Rata-rata 2–3 hari kerja ..." }
]
```

### Kustomisasi Utama (di `app.js`)
- Model Gemini: cari `getGenerativeModel({ model: "gemini-2.5-flash" })` dan ganti bila perlu
- Rate limiter: ubah `RATE_LIMIT_MAX` dan `RATE_LIMIT_WINDOW_MS`
- Memory: ubah `MEMORY_MAX_MESSAGES` (jumlah total item user+bot)
- Greeting: ubah teks di blok greeting (cari komentar "Greeting pertama kali")
- Matching knowledge: fungsi `findContext(question)` → cocokkan `keyword`
- Matching FAQ: fungsi `findFaqAnswer(question)` → cocokkan exact/contains pertanyaan

### Mode Admin
- Set `ADMIN_ID` di `.env` ke JID WhatsApp admin, format `628xxxxx@c.us`
- Perintah (dikirim dari akun admin atau dari `fromMe` dengan awalan `!`):

#### Chat Management:
  - `!ambil 628xxxx` → ambil alih chat user
  - `!selesai 628xxxx` → kembalikan ke AI
  - `!list` → daftar user `mode=human`
  - `!help` → bantuan

#### Order Management:
  - `!order add <nama> <harga> <detail> <pekerjaan>` → tambah order baru
  - `!order view [id]` → lihat order (semua atau spesifik)
  - `!order edit <id> <field> <value>` → edit order
  - `!order delete <id>` → hapus order
  - `!order export` → export ke Excel

### Logging
- Console: berwarna dan ringkas
- File: `logs/bot.log` format JSON Lines (1 record per baris)
- Jika write gagal, logger auto-menonaktifkan file logging dan menampilkan peringatan di console

### Penyimpanan State
- `sessions.json`: menyimpan `mode`, `greeted`, dan `memory` per user
- `orders.json`: menyimpan data order dengan struktur lengkap
- Disimpan setiap kali ada perubahan penting (mis. ganti mode, tambah memory, update order)

## 📋 Sistem Manajemen Order

### Gambaran Umum
Bot WhatsApp sekarang dilengkapi dengan sistem manajemen order yang komprehensif, memungkinkan admin untuk membuat, melihat, mengedit, menghapus, dan mengekspor order dengan informasi detail.

### Fitur Order Management
- ✅ **Tambah Order**: Membuat order baru dengan detail pelanggan
- ✅ **Lihat Order**: Menampilkan semua order atau order spesifik berdasarkan ID
- ✅ **Edit Order**: Mengupdate field apapun dari order yang sudah ada
- ✅ **Hapus Order**: Menghapus order dari sistem
- ✅ **Export ke Excel**: Membuat file Excel dengan semua data order
- ✅ **Tracking Status**: Melacak progres order (todo, on progress, done, canceled)

### Struktur Order
Setiap order berisi:
- **ID**: Identifier unik yang dibuat otomatis (ORD-0001, ORD-0002, dst.)
- **Nama Orderer**: Nama pelanggan
- **Harga**: Harga order dalam Rupiah Indonesia
- **Detail**: Deskripsi detail dari order (bisa panjang dengan spasi)
- **Pekerjaan**: Jenis pekerjaan/layanan
- **Status**: Status saat ini (todo, on progress, done, canceled)
- **Waktu**: Timestamp ketika order dibuat
- **Deadline**: Tanggal deadline (opsional)

### Perintah Order Management
Semua perintah harus dikirim dari akun admin dengan prefix `!`:

#### 1. Tambah Order Baru
Sistem mendukung 2 format input untuk memudahkan input detail yang panjang:

**Format 1 (Single Line dengan |):**
```
!order add nama|harga|detail|pekerjaan|deadline
```

**Contoh Format 1:**
```
!order add "John Doe"|500000|"Video editing untuk pernikahan dengan efek khusus"|"Video Editing"|2024-12-31
```

**Format Deadline yang Didukung:**
- YYYY-MM-DD (contoh: 2024-12-31)
- DD/MM/YYYY (contoh: 31/12/2024)
- DD-MM-YYYY (contoh: 31-12-2024)

#### 2. Lihat Order
```
!order view                    # Lihat semua order
!order view ORD-0001          # Lihat order spesifik
```

#### 3. Edit Order
```
!order edit <id> <field> <value>
```
**Field yang bisa diedit:**
- `ordererName`: Nama pelanggan
- `price`: Harga order (harus angka positif)
- `details`: Detail order
- `work`: Jenis pekerjaan
- `status`: Status order
- `deadline`: Deadline order

**Status yang valid:**
- `todo`: Order baru, belum dimulai
- `on progress`: Sedang dikerjakan
- `done`: Selesai
- `canceled`: Dibatalkan

**Contoh:**
```
!order edit ORD-0001 status "on progress"
!order edit ORD-0001 price 750000
!order edit ORD-0001 details "Update requirements untuk video editing"
!order edit ORD-0001 deadline "2024-12-31"
```

#### 4. Hapus Order
```
!order delete <id>
```
**Contoh:**
```
!order delete ORD-0001
```

#### 5. Export ke Excel
```
!order export
```
Perintah ini akan:
- Membuat file Excel dengan semua order
- **Formatting profesional** dengan warna dan styling
- **Summary section** dengan total order dan revenue
- **Status color coding** untuk mudah dibaca
- **Column width optimization** untuk readability
- Mengirim file ke admin via WhatsApp
- Otomatis membersihkan file temporary


### Penyimpanan Data Order
- Order disimpan di `orders.json`
- Struktur file:
```json
{
  "orders": {
    "ORD-0001": {
      "id": "ORD-0001",
      "ordererName": "John Doe",
      "price": 500000,
      "details": "Video editing untuk pernikahan dengan efek khusus",
      "work": "Video Editing",
      "status": "todo",
      "time": 1703123456789,
      "deadline": 1735689600000
    }
  },
  "counter": 2
}
```

### Penanganan Error
Sistem dilengkapi dengan penanganan error yang komprehensif:
- ✅ Validasi input untuk harga (harus angka positif)
- ✅ Validasi status (hanya status yang valid)
- ✅ Validasi format deadline (YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY)
- ✅ Pengecekan keberadaan order
- ✅ Validasi field untuk edit
- ✅ Penanganan error export Excel
- ✅ Validasi format input (single line dengan | atau multi-line)

### Contoh Penggunaan Lengkap

#### Workflow Lengkap:
1. **Tambah Order (Format Multi-line):**
   ```
   !order add
   Sarah Wilson
   300000
   Logo animation dengan efek 3D dan transisi yang smooth
   Animation
   2024-12-31
   ```

2. **Lihat Order:**
   ```
   !order view ORD-0001
   ```

3. **Update Status:**
   ```
   !order edit ORD-0001 status "on progress"
   ```

4. **Update Harga:**
   ```
   !order edit ORD-0001 price 350000
   ```

5. **Update Deadline:**
   ```
   !order edit ORD-0001 deadline "2025-01-15"
   ```

6. **Tandai Selesai:**
   ```
   !order edit ORD-0001 status "done"
   ```

7. **Export Semua Order:**
   ```
   !order export
   ```

### Integrasi dengan Fitur Existing
- Order management bekerja bersamaan dengan chat management yang sudah ada
- Admin masih bisa menggunakan perintah `!ambil`, `!selesai`, `!list`
- Semua perintah tersedia di perintah `!help` yang sudah diupdate
- Order tersimpan permanen meskipun bot restart

### Manajemen File
- Export Excel otomatis dibersihkan setelah 30 detik
- Order disimpan langsung setelah ada modifikasi
- Disarankan backup `orders.json` untuk penggunaan production
- Menggunakan `xlsx` untuk fungsi Excel dan `xlsx-style` untuk styling yang proper

### Fitur Excel Export
- ✅ **Header Styling**: Header dengan background biru dan teks putih
- ✅ **Alternating Rows**: Baris bergantian warna untuk readability
- ✅ **Status Color Coding**: 
  - 🟢 **Done**: Hijau muda
  - 🟡 **On Progress**: Kuning muda  
  - 🔴 **Canceled**: Merah muda
  - ⚪ **Todo**: Abu-abu muda
- ✅ **Column Formatting**: 
  - Price: Right-aligned dengan format angka
  - Details: Text wrapping untuk detail panjang
  - Status: Center-aligned dengan color coding
- ✅ **Summary Section**: 
  - Total Orders count
  - Total Revenue calculation
  - Status breakdown statistics
- ✅ **Professional Borders**: Border tipis di semua cell
- ✅ **Optimized Column Width**: Auto-sizing untuk readability

### Catatan Keamanan
- Hanya akun admin yang bisa mengakses perintah order management
- Semua perintah memerlukan prefix `!` untuk keamanan
- Validasi input mencegah injeksi data berbahaya

### Troubleshooting
- "Unexpected end of JSON input": pastikan file JSON (`sessions.json`, `orders.json`, `data/*.json`) valid. Jika kosong, isi `{}` atau `[]` sesuai kebutuhan.
- Log tidak tersimpan: pastikan folder `logs/` bisa ditulis. Logger memakai path absolut relatif file `app.js`.
- QR tidak muncul: pastikan WhatsApp Web bisa diakses dan tidak ada blokir jaringan.
- Gemini error: cek `GEMINI_API_KEY` dan batasan quota API.
- Order tidak tersimpan: pastikan file `orders.json` bisa ditulis dan format JSON valid.
- Export Excel gagal: pastikan package `xlsx` terinstall (`npm install xlsx`).
- Perintah order tidak bekerja: pastikan dikirim dari akun admin dengan prefix `!`.





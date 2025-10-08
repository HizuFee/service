## Bot WhatsApp Customer Service

Proyek ini adalah bot WhatsApp berbasis Node.js yang menggunakan Google Gemini untuk menjawab otomatis, dengan fitur greeting pertama kali, FAQ, knowledge base, pengalihan ke admin, rate limiter anti-spam, memory per-user, dan logging berwarna + JSONL ke file.

### Fitur Utama
- Greeting pertama kali dengan tagline + daftar FAQ
- Jawab pertanyaan umum dari `data/faq.json` dan `data/knowledge.json`
- AI (Google Gemini) untuk pertanyaan di luar FAQ/knowledge
- Mode Admin (ambil alih chat, selesai, list, help)
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
  - `!ambil 628xxxx` → ambil alih chat user
  - `!selesai 628xxxx` → kembalikan ke AI
  - `!list` → daftar user `mode=human`
  - `!help` → bantuan

### Logging
- Console: berwarna dan ringkas
- File: `logs/bot.log` format JSON Lines (1 record per baris)
- Jika write gagal, logger auto-menonaktifkan file logging dan menampilkan peringatan di console

### Penyimpanan State
- `sessions.json`: menyimpan `mode`, `greeted`, dan `memory` per user
- Disimpan setiap kali ada perubahan penting (mis. ganti mode, tambah memory)

### Troubleshooting
- "Unexpected end of JSON input": pastikan file JSON (`sessions.json`, `data/*.json`) valid. Jika kosong, isi `{}` atau `[]` sesuai kebutuhan.
- Log tidak tersimpan: pastikan folder `logs/` bisa ditulis. Logger memakai path absolut relatif file `app.js`.
- QR tidak muncul: pastikan WhatsApp Web bisa diakses dan tidak ada blokir jaringan.
- Gemini error: cek `GEMINI_API_KEY` dan batasan quota API.





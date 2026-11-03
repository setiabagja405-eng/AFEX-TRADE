# AFEX Trade Bot — Panduan Deploy & Fitur Lengkap (Poin 1 s/d Poin 5)

Arsitektur: **Vercel** (frontend Mini App) → rewrite `/api` → **Render** (bot + API + auto-trade multi-user) → **MongoDB Atlas** (data user, paket sewa & kredensial terenkripsi).

## Ringkasan Seluruh Fitur (100% Selesai)

1. **Tampilan Mini App ala Afex Mining + Ikon Berkilau + Koin 3D**:
   - Tema gelap-emas metalik, ikon SVG berkilau tanpa emoji, serta koin 3D berputar yang otomatis berubah emblem sesuai aset yang dipilih (`BTC`, `ETH`, `BNB`, `XAUUSD`, `USOIL`, `XNGUSD`, dll.).
2. **Poin 1 — Multi-Broker (`Binance Testnet`, `Binance Live`, `MetaTrader 5`, `MetaTrader 4`)**:
   - Menyimpan kredensial tiap broker dengan enkripsi `AES-256-GCM`, mendukung *auto-detect* region & akhiran simbol di MT4/MT5 via MetaApi Cloud, serta *worker pool* paralel untuk ratusan pengguna sekaligus.
3. **Poin 2 — Multi-Aset (11 Instrumen di 3 Kategori)**:
   - Mencakup **Kripto** (`BTC`, `ETH`, `BNB`, `SOL`, `XRP`), **Komoditas & Energi** (`XAUUSD` Emas, `XAGUSD` Perak, `USOIL` Minyak WTI, `UKOIL` Minyak Brent, `XNGUSD` Gas Alam), dan **Forex** (`EURUSD`).
4. **Poin 3 — Login User (Tanpa OTP) + Sistem Paket Sewa**:
   - Login langsung menggunakan `ID Telegram / @username` + `Password/PIN` sekaligus menyambungkan broker ke bot.
   - Mewajibkan kepemilikan **Paket Sewa Aktif** sebelum login (kecuali Owner Admin).
5. **Poin 4 — Panel Admin Khusus (`7706512451` & `8821716544`) + Face Scan & PIN**:
   - Menu **Admin** hanya tampil untuk ID `7706512451` dan `8821716544`, dilindungi oleh **PIN Eksekutif** dan **Biometric Owner Face Scan** ala *Afex Mining*.
   - Mengelola daftar paket sewa (nama, harga, durasi jam/hari), metode pembayaran (rekening/wallet & instruksi), persetujuan (**ACC / Tolak**) bukti sewa, serta penambahan/pencabutan waktu sewa user manual.
6. **Poin 5 — Kirim Status & Gambar Grafik Realtime ke Bot + Jam UTC 1s + Analisis + 4 Mode Grafik**:
   - **Generator PNG Grafik Murni di Server (`zlib`)**: Mengirimkan gambar grafik gelap (`BTC/USDT · 5m` dan `Grafik Profit 7 Hari`) langsung ke chat Bot Telegram (`bot.sendPhoto`) tanpa ketergantungan C++ sehingga 100% berjalan lancar di Termux maupun Render.
   - **Sinkronisasi Status Realtime ke Bot (`Live Chat: ON ●`)**: Memperbarui panel status di chat Bot secara otomatis dengan waktu **UTC (`HH:MM:SS UTC`)** yang berjalan setiap detik serta **Keterangan Analisis Teknikal** (`STRONG BUY/SELL`, `EMA 9/21`, `RSI 14`, `Support/Resistance`).
   - **4 Mode Grafik di Mini App**: Mendukung perpindahan instan antara **Candlestick Chart**, **Live Chart (1s Tick)**, **Bar Chart**, dan **Area Chart**.

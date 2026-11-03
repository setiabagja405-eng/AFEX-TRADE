# AFEX Trade Bot — Panduan Deploy & Multi-Broker

Arsitektur: **Vercel** (frontend Mini App) → rewrite `/api` → **Render** (bot + API + auto-trade multi-user) → **MongoDB Atlas** (data user & kredensial terenkripsi).

## Broker yang Didukung (Poin 1)

Setiap pengguna dapat memilih dan menyimpan kredensial untuk 4 broker berbeda langsung dari Mini App:

1. **Binance Testnet (`binance_testnet`)**
   - Spot Sandbox (`testnet.binance.vision`) menggunakan saldo simulasi USDT.
   - Kredensial: `API Key` & `Secret Key` HMAC-SHA-256.
2. **Binance Live (`binance`)**
   - Spot Real (`binance.com`) menggunakan akun nyata.
   - Kredensial: `API Key` & `Secret Key` (aktifkan *Enable Spot & Margin Trading*, **jangan** aktifkan *Withdraw*).
3. **MetaTrader 5 (`mt5`) via MetaApi Cloud**
   - Mendukung semua broker MT5 (Exness, XM, FBS, Octa, IC Markets, dll.).
   - Cara mendapatkan kredensial:
     1. Daftar di `app.metaapi.cloud`.
     2. Klik **Add Account** → pilih **MT5** → isi Login, Investor/Master Password, dan nama Server MT5 → salin **Account ID**.
     3. Buka menu **API Access → Generate Token** → salin **Auth Token**.
     4. Masukkan **Auth Token**, **Account ID**, dan **Simbol Broker** (misal `BTCUSD`, `BTCUSDm`, atau `XAUUSD`) di Mini App. Region server (`singapore`, `london`, `new-york`) akan dideteksi otomatis.
4. **MetaTrader 4 (`mt4`) via MetaApi Cloud**
   - Mendukung semua broker MT4 melalui jembatan REST MetaApi yang sama.
   - Langkah koneksi sama seperti MT5 (pilih platform **MT4** saat *Add Account* di `app.metaapi.cloud`).

## Optimasi Multi-User

- **Worker Pool Paralel (`WORKER_CONCURRENCY`)**: Eksekusi sinyal Auto-Trade berjalan paralel (default 8 worker sekaligus) sehingga ratusan pengguna tidak saling mengantre.
- **Shared Market Cache**: Data OHLCV dan perhitungan RSI di-cache per broker & simbol selama 10 detik untuk menghemat *rate limit* API.
- **Enkripsi Kredensial (`AES-256-GCM`)**: Semua `API Key`, `Secret Key`, dan `MetaApi Token` dienkripsi sebelum disimpan ke MongoDB dan tidak pernah dikirim kembali ke browser.

## Langkah Deploy

1. **MongoDB Atlas**: Buat cluster gratis (`M0`), tambahkan IP `0.0.0.0/0`, dan salin `MONGO_URI`.
2. **Telegram (BotFather)**: Buat bot lewat `/newbot` dan simpan `TG_BOT_TOKEN`.
3. **Render (Backend)**:
   - Letakkan `server.js`, `mt5.js`, dan `package.json` di folder backend.
   - Build Command: `npm install` · Start Command: `npm start`.
   - Environment Variables:
     - `TG_BOT_TOKEN`: Token dari BotFather
     - `MONGO_URI`: Connection string MongoDB Atlas
     - `ENCRYPTION_KEY`: 64 karakter hex (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
     - `WEBAPP_URL`: URL Vercel Anda (`https://nama-app.vercel.app`)
     - `MAX_USERS`: Kuota maksimal pengguna (default `500`)
4. **Vercel (Frontend)**:
   - Letakkan `index.html` dan `vercel.json` di folder frontend.
   - Edit `vercel.json` dan ganti `GANTI-NAMA-APP.onrender.com` dengan domain Render Anda, lalu deploy ke Vercel.

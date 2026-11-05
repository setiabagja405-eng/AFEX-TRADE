# AFEX Trade Bot

Vercel (Mini App `index.html`) → rewrite `/api` → Render (`server.js`) → MongoDB Atlas.

## Isi repo (semua di luar, TANPA folder — kecuali .github untuk opsi keepalive)
```
index.html        # Mini App (Vercel)
server.js         # Bot + API (Render)   <- huruf kecil semua!
mt5.js            # Adapter MetaTrader    <- huruf kecil semua!
package.json
vercel.json
render.yaml
.env.example      # daftar variabel (jangan isi rahasia di GitHub)
.gitignore
README.md
.github/workflows/keepalive.yml   # opsional
```

## Urutan deploy
1. MongoDB Atlas: buat cluster gratis, Database User, Network Access `0.0.0.0/0`, salin connection string -> `MONGO_URI`.
2. @BotFather: `/newbot` -> `TG_BOT_TOKEN`.
3. GitHub: repo baru, upload semua file di atas.
4. Render: New > Web Service > pilih repo. Build `npm install`, Start `node server.js`, Free. Isi variabel. Cek `https://NAMA.onrender.com/health`.
5. Edit `vercel.json`: ganti `GANTI-NAMA-APP` dengan nama layanan Render. Commit.
6. Vercel: Add New > Project > import repo. Framework `Other`, kosongkan Build/Output. Deploy.
7. Render: isi `WEBAPP_URL` = URL Vercel (tanpa `/` di akhir), lalu Manual Deploy.

## Variabel Render
| Variabel | Keterangan |
|---|---|
| `TG_BOT_TOKEN` (wajib) | token BotFather |
| `MONGO_URI` (wajib) | connection string Atlas |
| `ENCRYPTION_KEY` (wajib) | 64 hex: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `WEBAPP_URL` | URL Vercel |
| `ADMIN_IDS` | ID admin dipisah koma |
| `KEEPALIVE_MIN` | menit antar ping sendiri (default 5; 0 = mati) |
| `KEEPALIVE_URL` | otomatis dari `RENDER_EXTERNAL_URL`; isi hanya jika perlu |
| `ALLOWED_USER_IDS` | KOSONGKAN agar semua akun bisa pakai |
| `MONGO_DB`, `MAX_USERS`, `WORKER_CONCURRENCY`, `ADMIN_PIN`, `BTN_STYLE`, `ICON_IDS`, `METAAPI_BASE_URL` | opsional |

## Render tidak tidur (tiap 5 menit)
- Server ping `/health` miliknya sendiri tiap `KEEPALIVE_MIN` menit.
- Tambahan wajib sebagai cadangan: UptimeRobot (uptimerobot.com) > New monitor > HTTP(s) > `https://NAMA.onrender.com/health` > interval 5 menit.
- Opsi lain: `.github/workflows/keepalive.yml` + secret `RENDER_URL`.
- Render free punya jatah 750 jam/bulan; satu layanan aktif 24 jam cukup.

## ID Telegram
Mini App membaca ID dari Telegram (`initData` bertanda tangan) -> tiap akun otomatis memakai ID-nya sendiri. Buka lewat tombol Dashboard di bot, bukan lewat link biasa.

## Masalah umum
- `Cannot find module './mt5'` -> nama file harus `mt5.js` (huruf kecil).
- Akun lain ditolak -> kosongkan `ALLOWED_USER_IDS`.
- Mini App kosong / error API -> periksa `vercel.json` sudah berisi URL Render yang benar, lalu redeploy Vercel.
- Respons pertama lambat -> Render baru bangun; pasang UptimeRobot.

## Admin: PIN & Face ID
- PIN utama: `(PIN utama: lihat env/panel admin)` -> scan wajah (3 percobaan otomatis) -> jika gagal 3x / kamera tidak bisa: PIN cadangan `(PIN cadangan: lihat env/panel admin)` (angka, maks 8 digit).
- PIN diperiksa di server (`/api/admin/verify-pin`), 5x salah = kunci 60 detik. Tambahan PIN lewat env `ADMIN_PIN` / `ADMIN_FALLBACK_PIN`.

## Menu Admin: data user & log
- **Data User:** timer sewa berjalan, waktu pembelian, paket, profit / loss / net, win-loss, P/L hari ini, riwayat trade per user.
- **Log Aktivitas** (koleksi MongoDB `activity_logs`, otomatis dihapus setelah 90 hari): daftar, login, buka Mini App, simpan API key, BUY/SELL (+PnL), pengajuan/ACC/tolak/tambah/cabut sewa, PIN & face scan admin.
- Statistik win/loss/profit/loss per user dihitung mulai versi ini; trade lama hanya terhitung di Net P/L.

## Semua koin Binance
Saat server start, semua pair spot `XXX/USDT` yang aktif di Binance otomatis masuk dropdown **Opsi Aset Trading** (grup "Semua koin Binance"). Jumlah beli tetap dalam satuan koin; label di bawah dropdown menampilkan harga 1 koin supaya mudah dihitung. Nilai awal ≈ `DEFAULT_ORDER_USDT`, batas atas ≈ `MAX_ORDER_USDT` (hanya untuk koin tambahan).

## Uji coba uang asli ($10)
1. Binance > API Management > buat key baru: aktifkan **Enable Spot & Margin Trading** saja, matikan Withdrawals, batasi IP bila bisa.
2. Dompet: **Spot**, saldo dalam **USDT** (sisakan sedikit untuk fee 0,1%).
3. Mini App > Broker > pilih **Binance Live** > masukkan API Key & Secret.
4. Pilih koin, isi jumlah beli senilai ±$8 (harga 1 koin tampil di label), TP/SL, lalu tes tombol Buy manual dulu. Nyalakan Auto-Trade setelah manual Buy/Sell berhasil.
5. Render harus di region **Singapore** (Binance.com menolak IP Amerika).

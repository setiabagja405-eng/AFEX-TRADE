const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Blokir akun: tolak SEMUA API user dari akun yang diblokir admin (status disimpan di MongoDB oleh routes/afexface.js).
// Harus dipasang SEBELUM route lain. Jika file belum ada / error, server tetap hidup.
try {
    const _afexRoute = require('./routes/afexface');
    if (typeof _afexRoute.blockGuard === 'function') { app.use('/api', _afexRoute.blockGuard); console.log('Guard blokir akun aktif'); }
} catch (e) { console.error('GAGAL memasang guard blokir -> ' + e.message); }

// 1. Rute Sambutan Utama
app.get('/', (req, res) => {
    res.send('AFEX Backend API is Running Successfully!');
});

// 2. Ambil URI dari Environment Variable Render
const MONGODB_URI = process.env.MONGODB_URI;

// 3. Hubungkan ke MongoDB Atlas dengan konfigurasi stabil
mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
})
.then(() => console.log('Berhasil terhubung ke MongoDB Atlas!'))
.catch(err => console.error('Koneksi MongoDB gagal:', err));

// ==========================================
// 4. SKEMA & MODEL DATABASE
// ==========================================

// Skema Pengguna
const userSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    username: { type: String, default: 'Tamu' },
    balanceAfex: { type: Number, default: 0 },
    usdtBalance: { type: Number, default: 0 },
    usdtDepositBalance: { type: Number, default: 0 },
    userPoints: { type: Number, default: 0 },
    lastCheckInTime: { type: Number, default: 0 },
    checkInDay: { type: Number, default: 1 },
    usdtSpeedBoost: { type: Number, default: 0 },
    isMining: { type: Boolean, default: false },
    miningStartTime: { type: Number, default: 0 },
    miningEndTime: { type: Number, default: 0 },
    tgTaskEndTime: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

// Skema Deposit (Sinkron dengan Bot Telegram di Termux)
const depositSchema = new mongoose.Schema({
    userId: Number,
    txhash: String,
    amount: Number,
    status: { type: String, default: 'PENDING_APPROVAL' },
    timestamp: { type: Date, default: Date.now }
});
const Deposit = mongoose.model('Deposit', depositSchema);

// ==========================================
// 5. ROUTE USER (Sync & Update)  -- dilindungi initData Telegram
// ==========================================
const crypto = require('crypto');
const MAIN_TOKEN = String(process.env.MAIN_BOT_TOKEN || process.env.BOT_TOKEN || '').trim();

// Validasi initData Telegram (header X-Telegram-Init-Data atau body.initData). Mengembalikan { id } atau null.
function authUser(req) {
    try {
        if (!MAIN_TOKEN) return null;
        const initData = String((req.headers && (req.headers['x-telegram-init-data'])) || (req.body && req.body.initData) || '');
        if (!initData) return null;
        const p = new URLSearchParams(initData), hash = p.get('hash');
        if (!hash) return null;
        p.delete('hash');
        const dcs = Array.from(p.keys()).sort().map(k => k + '=' + p.get(k)).join('\n');
        const secret = crypto.createHmac('sha256', 'WebAppData').update(MAIN_TOKEN).digest();
        const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
        const a = Buffer.from(calc), b = Buffer.from(hash);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
        if (Math.abs(Date.now() / 1000 - Number(p.get('auth_date') || 0)) > 86400) return null;
        const u = JSON.parse(p.get('user') || '{}');
        return u.id ? { id: String(u.id) } : null;
    } catch (e) { return null; }
}

// Frontend memanggil GET /api/user/sync?userId=..  dan membaca data.user  (POST tetap didukung)
async function syncHandler(req, res) {
    try {
        const src = req.method === 'GET' ? (req.query || {}) : (req.body || {});
        const userId = String(src.userId || '');
        if (!userId) return res.status(400).json({ success: false, error: 'userId diperlukan' });
        const au = authUser(req);
        if (!au || au.id !== userId) return res.status(401).json({ success: false, error: 'initData tidak valid' });

        let user = await User.findOne({ userId });
        if (!user) {
            user = new User({ userId, username: String(src.username || 'Tamu') });
            await user.save();
        }
        res.json({ success: true, user });
    } catch (error) {
        console.error('Error Sync:', error);
        res.status(500).json({ success: false, error: error.message });
    }
}
app.get('/api/user/sync', syncHandler);
app.post('/api/user/sync', syncHandler);

app.post('/api/user/update', async (req, res) => {
    try {
        const {
            userId, username, balanceAfex, usdtBalance, usdtDepositBalance, userPoints,
            lastCheckInTime, checkInDay, usdtSpeedBoost, isMining,
            miningStartTime, miningEndTime, tgTaskEndTime
        } = req.body;

        if (!userId) return res.status(400).json({ success: false, error: 'userId diperlukan' });
        const au = authUser(req);
        if (!au || au.id !== String(userId)) return res.status(401).json({ success: false, error: 'initData tidak valid' });

        const num = v => { const n = Number(v); return isFinite(n) && n >= 0 ? n : 0; };
        const updatedUser = await User.findOneAndUpdate(
            { userId: au.id },
            { $set: {
                username: String(username || 'Tamu').slice(0, 64),
                balanceAfex: num(balanceAfex),
                usdtBalance: num(usdtBalance),
                usdtDepositBalance: num(usdtDepositBalance),
                userPoints: num(userPoints),
                lastCheckInTime: num(lastCheckInTime),
                checkInDay: Number(checkInDay) || 1,
                usdtSpeedBoost: num(usdtSpeedBoost),
                isMining: Boolean(isMining),
                miningStartTime: num(miningStartTime),
                miningEndTime: num(miningEndTime),
                tgTaskEndTime: num(tgTaskEndTime)
            } },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );

        res.json({ success: true, user: updatedUser });
    } catch (error) {
        console.error('Error Update:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 6. ROUTE ADMIN DEPOSIT (Pending & Approve)
// ==========================================

// Endpoint untuk Admin melihat daftar deposit yang perlu di-approve
app.get('/api/admin/deposits-pending', async (req, res) => {
    try {
        const pendingDeposits = await Deposit.find({ status: 'PENDING_APPROVAL' }).sort({ timestamp: -1 });
        res.json({ success: true, data: pendingDeposits });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Endpoint untuk Admin menekan tombol "Approve"
app.post('/api/admin/approve-deposit/:id', async (req, res) => {
    try {
        const depositId = req.params.id;
        const deposit = await Deposit.findById(depositId);

        if (!deposit) {
            return res.status(404).json({ success: false, message: 'Data deposit tidak ditemukan.' });
        }

        // Ubah status menjadi APPROVED
        deposit.status = 'APPROVED';
        await deposit.save();

        // [OPSIONAL] Jika ingin otomatis menambah saldo user saat di-approve:
        // await User.findOneAndUpdate({ userId: deposit.userId }, { $inc: { usdtBalance: deposit.amount } });

        res.json({ success: true, message: 'Deposit berhasil disetujui (Approved)!' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Pasang route dengan aman: jika file route belum ada / error, server TETAP hidup dan penyebabnya dicetak di log
function mountRoute(base, file) {
    try { app.use(base, require(file)); console.log('Route dimuat: ' + file); }
    catch (e) { console.error('GAGAL memuat ' + file + ' -> ' + e.message); }
}

// 6a. OTP bot, registry wajah (anti akun ganda), status A2F  ->  POST /api/afex , POST /telegram/:secret
mountRoute('/', './routes/afexface');

// 6a2. Kirim foto + caption referral ke chat pengguna  ->  POST /api/referral/send
mountRoute('/api', './routes/referral');

// 6b. Notifikasi bot Telegram (withdraw, deposit, status)
mountRoute('/api', './routes/notify');

// 6c. Hadiah massal (Kirim Hadiah dari Panel Admin)  ->  /api/gift/send , /api/gift/list , /api/gift/open
mountRoute('/api', './routes/gift');

// 6d. Sinkron lock menu + Founder Gacha sederhana  ->  /api/cfg/get , /api/cfg/set , /api/founder/check , /api/founder/claim , /api/founder/grant
mountRoute('/api', './routes/appcfg');

// 6e. Menu User (admin) + OTP pemulihan akun per user (5 menit)  ->  /api/users/list , /api/users/otp , /api/users/verify , /api/users/my-otp
mountRoute('/api', './routes/users');

// 6e2. Pengaturan hadiah REFERRAL & MILESTONE (admin)  ->  /api/refcfg/get , /api/refcfg/set , /api/refcfg/reset
mountRoute('/api', './routes/refcfg');

// 6e3. Task buatan admin (tambah / hapus / ubah hadiah) + override hadiah task bawaan  ->  /api/tasks/get , /api/tasks/claim , /api/tasks/add , /api/tasks/set , /api/tasks/delete , /api/tasks/reward
mountRoute('/api', './routes/tasks');

// 6f. Daftar TIM (nama + jabatan) di menu About, diatur admin dari Panel Admin  ->  /api/team/get , /api/team/set , /api/team/reset
mountRoute('/api', './routes/team');

// 7. Jalankan Server di Port Render
['MONGODB_URI','OTP_BOT_TOKEN','HASH_SALT','WEBHOOK_SECRET'].forEach(function (k) {
    if (!process.env[k]) console.warn('PERINGATAN: Environment variable ' + k + ' belum diisi');
});
if (!process.env.MAIN_BOT_TOKEN && !process.env.BOT_TOKEN) console.warn('PERINGATAN: MAIN_BOT_TOKEN / BOT_TOKEN belum diisi (OTP akan unauthorized)');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
});

require('dotenv').config();
const crypto = require('crypto');
const zlib = require('zlib');
const express = require('express');
const ccxt = require('ccxt');
const { RSI, MACD, BollingerBands, EMA } = require('technicalindicators');
const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const mt5Adapter = require('./mt5');

// ================= KONFIGURASI =================
const TIMEFRAME = '5m';
const RSI_PERIOD = 14;
const LOOP_SEC = 10; // cek sinyal & pergerakan tiap 10 detik
const LIVE_BOT_SYNC_SEC = 10; // update otomatis panel status & grafik realtime di chat bot
const STATUS_INTERVAL_MIN = 30; // kirim panel baru berkala (jika tidak ada pesan panel aktif)
const DAILY_REPORT_HOUR = 21; // 21:00 UTC
const CHART_CANDLES = 96;
const COOLDOWN_MIN = 5;
const MAX_AUTO_FAILS = 5;
const WORKER_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 8);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MARKET_CACHE_TTL_MS = 2000; // cache pasar 2 detik untuk update realtime
const DEFAULT_SETTINGS = { amount: 0.001, tp: 1.0, sl: 0.7, rsiBuy: 30, rsiSell: 70, maxLossStreak: 0, breakEvenPct: 0, trailAtr: 0, strategy: 'rsi', trendFilter: 0, dailyLossLimit: 0, sessionOn: 0, sessionStart: 7, sessionEnd: 21, humanize: 1 };

// ID Admin Khusus sesuai permintaan user
const ADMIN_IDS = (process.env.ADMIN_IDS || '7706512451,8821716544')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const isAdminId = (id) => ADMIN_IDS.includes(String(id || '').trim());

const sha256Hex = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
// PIN Eksekutif Admin: hanya hash di bawah. Disarankan memakai env ADMIN_PIN / ADMIN_FALLBACK_PIN.
// Disimpan sebagai hash. Bisa ditambah lewat env ADMIN_PIN / ADMIN_FALLBACK_PIN.
const MAIN_ADMIN_PIN_HASHES = [
  '3f85f14582604240238d1f15659d23eae027664aefe5617e2042dd788f6f14e9',
  ...(process.env.ADMIN_PIN ? [sha256Hex(process.env.ADMIN_PIN)] : []),
];
const FALLBACK_ADMIN_PIN_HASHES = [
  '5ed4fb3310b651ead0153f942016f35eb42f2b45d7552fdd30bb4e5dd254b3d6',
  ...(process.env.ADMIN_FALLBACK_PIN ? [sha256Hex(process.env.ADMIN_FALLBACK_PIN)] : []),
];
const trialRefuseAt = new Map(); // id -> waktu pesan tolak terakhir (cegah spam bot)
const adminPinFails = new Map();
// PIN yang diganti lewat panel disimpan di database sebagai hash scrypt + salt acak (bukan di kode / README).
// Setelah PIN suatu jenis diganti, hash bawaan lama untuk jenis itu otomatis tidak berlaku lagi.
function scryptPin(pin, saltHex) {
  return crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), 32).toString('hex');
}
function makePinRecord(pin, byId) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: scryptPin(pin, salt), at: Date.now(), by: String(byId) };
}
function storedPinOk(rec, pin) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const a = Buffer.from(scryptPin(pin, rec.salt), 'hex'), b = Buffer.from(String(rec.hash), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function adminPinMatches(kind, pin) {
  const rec = rentalConfig.adminPin && rentalConfig.adminPin[kind];
  if (rec) return storedPinOk(rec, pin);
  const sha = sha256Hex(pin);
  return (kind === 'fallback' ? FALLBACK_ADMIN_PIN_HASHES : [...MAIN_ADMIN_PIN_HASHES, ...(rentalConfig.adminPinHashes || [])]).includes(sha);
}
function publicRentalConfig() {
  const { adminPin, adminPinHashes, ...rest } = rentalConfig; // jangan kirim hash PIN ke klien
  return rest;
}
function weakPin(pin) {
  if (/^(\d)\1+$/.test(pin)) return true;
  const d = pin.split('').map(Number);
  const step = d[1] - d[0];
  return Math.abs(step) === 1 && d.every((x, i) => i === 0 || x - d[i - 1] === step);
}

const DEFAULT_RENTAL_CONFIG = {
  _id: 'rental_config',
  requireRental: true,
  autoApprove: false,
  autoVerify: true,
  instructions:
    'Pilih paket sewa di bawah, lakukan pembayaran sesuai harga paket ke salah satu metode pembayaran resmi, lalu isi Bukti Transfer / TxHash dan klik Kirim Pembayaran Sewa.',
  packages: [
    { id: 'pkg_trial', tier: 'starter', trial: true, name: 'Uji Coba Trade (1 Hari)', price: 'GRATIS', discountPrice: '', durationHours: 24,
      desc: 'Gratis 1 hari · 1 kali per IP · fitur Starter' },
    { id: 'pkg_1d', tier: 'starter', name: 'Starter (1 Hari)', price: '5 USDT', discountPrice: '', durationHours: 24,
      desc: '1 aset · Auto-trade RSI · maks 5 transaksi/hari · tanpa konfirmasi tambahan' },
    { id: 'pkg_7d', tier: 'trader', name: 'Trader (7 Hari)', price: '25 USDT', discountPrice: '', durationHours: 168,
      desc: 'Sampai 3 aset · semua grafik · maks 20 transaksi/hari · Konfirmasi Sinyal L1 (pembalikan)' },
    { id: 'pkg_30d', tier: 'pro', name: 'Pro (30 Hari)', price: '75 USDT', discountPrice: '', durationHours: 720,
      desc: 'Semua aset & MT4/MT5 · tanpa batas · Konfirmasi Sinyal L2 (+momentum & volatilitas) · 4 strategi' },
    { id: 'pkg_365d', tier: 'elite', name: 'Elite VIP (365 Hari)', price: '900 USDT', discountPrice: '580 USDT', durationHours: 8760,
      desc: 'Semua fitur Pro · Konfirmasi Sinyal L3 (+tren/harga murah) · alarm harga · laporan VIP' },
  ],
  paymentMethods: [
    {
      id: 'pm_paypal',
      name: 'PayPal',
      account: '',
      holder: 'AFEX Official',
      country: 'ALL',
    },
    {
      id: 'pm_bep20',
      name: 'USDT (Jaringan BEP20 / BSC)',
      account: '0x8F9c3b7A12dE4567890aBcDeF1234567890AbCdE',
      holder: 'AFEX Official Treasury',
      country: 'ALL',
    },
    {
      id: 'pm_trc20',
      name: 'USDT (Jaringan TRC20 / TRON)',
      account: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE',
      holder: 'AFEX Official Treasury',
      country: 'ALL',
    },
    {
      id: 'pm_bank',
      name: 'Transfer Bank / E-Wallet (IDR)',
      account: 'BCA 8820194821 / DANA 081234567890',
      holder: 'A/N Admin AFEX Trade',
      country: 'ID',
    },
  ],
};

// Katalog Broker (Poin 1)
const BROKERS = {
  binance_testnet: {
    id: 'binance_testnet',
    name: 'Binance Testnet',
    short: 'Testnet',
    auth: 'hmac',
    sandbox: true,
    isMt: false,
    quote: 'USDT',
  },
  binance: {
    id: 'binance',
    name: 'Binance Live',
    short: 'Binance',
    auth: 'hmac',
    sandbox: false,
    isMt: false,
    quote: 'USDT',
  },
  mt5: {
    id: 'mt5',
    name: 'MetaTrader 5',
    short: 'MT5',
    auth: 'metaapi',
    sandbox: false,
    isMt: true,
    quote: 'USD',
  },
  mt4: {
    id: 'mt4',
    name: 'MetaTrader 4',
    short: 'MT4',
    auth: 'metaapi',
    sandbox: false,
    isMt: true,
    quote: 'USD',
  },
};

// Katalog Aset / Instrumen Trading (Poin 2)
const ASSETS = {
  BTC: {
    id: 'BTC',
    name: 'Bitcoin',
    category: 'crypto',
    base: 'BTC',
    spotSymbol: 'BTC/USDT',
    mtSymbol: 'BTCUSD',
    yahoo: 'BTC-USD',
    decimals: 2,
    fallbackPrice: 87420.5,
    spotDefault: 0.001,
    spotMin: 0.0001,
    spotMax: 10,
    mtDefault: 0.01,
    mtMin: 0.01,
    mtMax: 50,
  },
  ETH: {
    id: 'ETH',
    name: 'Ethereum',
    category: 'crypto',
    base: 'ETH',
    spotSymbol: 'ETH/USDT',
    mtSymbol: 'ETHUSD',
    yahoo: 'ETH-USD',
    decimals: 2,
    fallbackPrice: 2645.8,
    spotDefault: 0.01,
    spotMin: 0.001,
    spotMax: 100,
    mtDefault: 0.01,
    mtMin: 0.01,
    mtMax: 50,
  },
  BNB: {
    id: 'BNB',
    name: 'BNB Coin',
    category: 'crypto',
    base: 'BNB',
    spotSymbol: 'BNB/USDT',
    mtSymbol: 'BNBUSD',
    yahoo: 'BNB-USD',
    decimals: 2,
    fallbackPrice: 618.4,
    spotDefault: 0.05,
    spotMin: 0.01,
    spotMax: 500,
    mtDefault: 0.01,
    mtMin: 0.01,
    mtMax: 50,
  },
  SOL: {
    id: 'SOL',
    name: 'Solana',
    category: 'crypto',
    base: 'SOL',
    spotSymbol: 'SOL/USDT',
    mtSymbol: 'SOLUSD',
    yahoo: 'SOL-USD',
    decimals: 2,
    fallbackPrice: 188.6,
    spotDefault: 0.1,
    spotMin: 0.01,
    spotMax: 1000,
    mtDefault: 0.01,
    mtMin: 0.01,
    mtMax: 50,
  },
  XRP: {
    id: 'XRP',
    name: 'Ripple (XRP)',
    category: 'crypto',
    base: 'XRP',
    spotSymbol: 'XRP/USDT',
    mtSymbol: 'XRPUSD',
    yahoo: 'XRP-USD',
    decimals: 4,
    fallbackPrice: 0.6245,
    spotDefault: 20,
    spotMin: 1,
    spotMax: 100000,
    mtDefault: 0.01,
    mtMin: 0.01,
    mtMax: 50,
  },
  XAUUSD: {
    id: 'XAUUSD',
    name: 'Gold (Emas)',
    category: 'commodity',
    base: 'PAXG',
    spotSymbol: 'PAXG/USDT',
    mtSymbol: 'XAUUSD',
    yahoo: 'GC=F',
    decimals: 2,
    fallbackPrice: 2746.5,
    spotDefault: 0.01,
    spotMin: 0.001,
    spotMax: 50,
    mtDefault: 0.01,
    mtMin: 0.01,
    mtMax: 50,
  },
  XAGUSD: {
    id: 'XAGUSD',
    name: 'Silver (Perak)',
    category: 'commodity',
    base: 'XAG',
    spotSymbol: null,
    mtSymbol: 'XAGUSD',
    yahoo: 'SI=F',
    decimals: 3,
    fallbackPrice: 32.64,
    spotDefault: 0.01,
    spotMin: 0.01,
    spotMax: 50,
    mtDefault: 0.01,
    mtMin: 0.01,
    mtMax: 50,
  },
  USOIL: {
    id: 'USOIL',
    name: 'Minyak WTI (Crude Oil)',
    category: 'commodity',
    base: 'OIL',
    spotSymbol: null,
    mtSymbol: 'USOIL',
    yahoo: 'CL=F',
    decimals: 2,
    fallbackPrice: 71.45,
    spotDefault: 0.01,
    spotMin: 0.01,
    spotMax: 50,
    mtDefault: 0.01,
    mtMin: 0.01,
    mtMax: 50,
  },
  UKOIL: {
    id: 'UKOIL',
    name: 'Minyak Brent',
    category: 'commodity',
    base: 'BRENT',
    spotSymbol: null,
    mtSymbol: 'UKOIL',
    yahoo: 'BZ=F',
    decimals: 2,
    fallbackPrice: 75.15,
    spotDefault: 0.01,
    spotMin: 0.01,
    spotMax: 50,
    mtDefault: 0.01,
    mtMin: 0.01,
    mtMax: 50,
  },
  XNGUSD: {
    id: 'XNGUSD',
    name: 'Gas Alam (Natural Gas)',
    category: 'commodity',
    base: 'GAS',
    spotSymbol: null,
    mtSymbol: 'XNGUSD',
    yahoo: 'NG=F',
    decimals: 3,
    fallbackPrice: 2.865,
    spotDefault: 0.01,
    spotMin: 0.01,
    spotMax: 50,
    mtDefault: 0.01,
    mtMin: 0.01,
    mtMax: 50,
  },
  EURUSD: {
    id: 'EURUSD',
    name: 'EUR / USD',
    category: 'forex',
    base: 'EUR',
    spotSymbol: 'EUR/USDT',
    mtSymbol: 'EURUSD',
    yahoo: 'EURUSD=X',
    decimals: 4,
    fallbackPrice: 1.0864,
    spotDefault: 10,
    spotMin: 1,
    spotMax: 100000,
    mtDefault: 0.01,
    mtMin: 0.01,
    mtMax: 50,
  },
};
// ===============================================

const TOKEN = process.env.TG_BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const WEBAPP_URL = (process.env.WEBAPP_URL || '').replace(/\/$/, '');
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || '').replace(/\/$/, '');
const PORT = process.env.PORT || 3000;
const MAX_USERS = Number(process.env.MAX_USERS || 500);
const WHITELIST = (process.env.ALLOWED_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const KEY = Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex');

if (!TOKEN || !MONGO_URI || KEY.length !== 32) {
  console.error('Wajib diisi: TG_BOT_TOKEN, MONGO_URI, ENCRYPTION_KEY (64 karakter hex)');
  process.exit(1);
}

// ---------- Generator Gambar Grafik PNG Murni (Poin 5: Tanpa Dependency C++, Jalan di Termux & Render) ----------
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crcBuf]);
}
function encodePng(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const FONT5X7 = {
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  ',': [0x00, 0x00, 0x00, 0x00, 0x0c, 0x04, 0x08],
  ':': [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  '/': [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  '+': [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
  '%': [0x19, 0x19, 0x02, 0x04, 0x08, 0x13, 0x13],
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
};

function createCanvasCtx(W, H) {
  const buf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H * 4; i += 4) {
    buf[i] = 18;
    buf[i + 1] = 23;
    buf[i + 2] = 34;
    buf[i + 3] = 255;
  }
  const setPx = (x, y, r, g, b, a = 255) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const idx = (y * W + x) * 4;
    if (a >= 255) {
      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
      buf[idx + 3] = 255;
    } else {
      const inv = 255 - a;
      buf[idx] = (r * a + buf[idx] * inv) >> 8;
      buf[idx + 1] = (g * a + buf[idx + 1] * inv) >> 8;
      buf[idx + 2] = (b * a + buf[idx + 2] * inv) >> 8;
      buf[idx + 3] = 255;
    }
  };
  const drawText = (txt, x, y, scale, r, g, b) => {
    const s = String(txt).toUpperCase();
    let cx = Math.round(x);
    for (let i = 0; i < s.length; i++) {
      const gl = FONT5X7[s[i]] || FONT5X7[' '];
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if ((gl[row] >> (4 - col)) & 1) {
            for (let sy = 0; sy < scale; sy++) {
              for (let sx = 0; sx < scale; sx++) {
                setPx(cx + col * scale + sx, Math.round(y) + row * scale + sy, r, g, b, 255);
              }
            }
          }
        }
      }
      cx += 6 * scale;
    }
  };
  const drawLine = (x0, y0, x1, y1, thick, r, g, b, a = 255, dashed = false) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    const rad = thick / 2;
    for (let i = 0; i <= steps; i++) {
      if (dashed && Math.floor(i / 6) % 2 === 1) continue;
      const px = x0 + ((x1 - x0) * i) / steps;
      const py = y0 + ((y1 - y0) * i) / steps;
      for (let dy = -Math.ceil(rad); dy <= Math.ceil(rad); dy++) {
        for (let dx = -Math.ceil(rad); dx <= Math.ceil(rad); dx++) {
          if (dx * dx + dy * dy <= rad * rad + 0.5) {
            setPx(Math.round(px + dx), Math.round(py + dy), r, g, b, a);
          }
        }
      }
    }
  };
  const fillRect = (x0, y0, w, h, r, g, b, a = 255) => {
    for (let y = Math.round(y0); y < Math.round(y0 + h); y++) {
      for (let x = Math.round(x0); x < Math.round(x0 + w); x++) {
        setPx(x, y, r, g, b, a);
      }
    }
  };
  return { buf, setPx, drawText, drawLine, fillRect };
}

function renderPriceChartPng(s) {
  const W = 740,
    H = 380;
  const { buf, setPx, drawText, drawLine } = createCanvasCtx(W, H);
  const closes = (s.candles && s.candles.closes) || [s.price || 100];
  const labels = (s.candles && s.candles.labels) || ['00:00'];
  const dec = s.decimals || 2;

  const title = `${s.symbol} - ${s.timeframe || '5M'}`;
  drawText(title, W / 2 - (title.length * 12) / 2, 16, 2, 248, 250, 252);
  const utcTag = s.serverUtc || new Date().toISOString().slice(11, 19) + ' UTC';
  drawText(utcTag, W - utcTag.length * 6 - 18, 18, 1, 250, 204, 21);

  const isUp = closes.length > 1 && closes[closes.length - 1] >= closes[0];
  const lr = isUp ? 34 : 239,
    lg = isUp ? 197 : 68,
    lb = isUp ? 94 : 68;

  for (let y = 40; y <= 52; y++) {
    for (let x = W / 2 - 48; x <= W / 2 - 18; x++) {
      const edge = y === 40 || y === 52 || x === W / 2 - 48 || x === W / 2 - 18;
      setPx(x, y, lr, lg, lb, edge ? 255 : 65);
    }
  }
  drawText('HARGA', W / 2 - 10, 40, 2, 203, 213, 225);

  const padL = 96,
    padR = 24,
    padT = 68,
    padB = 54;
  const plotW = W - padL - padR,
    plotH = H - padT - padB;
  let minP = Math.min(...closes),
    maxP = Math.max(...closes);
  if (s.position) {
    minP = Math.min(minP, s.position.sl);
    maxP = Math.max(maxP, s.position.tp);
  }
  if (s.closeLines) {
    minP = Math.min(minP, s.closeLines.entry, s.closeLines.exit);
    maxP = Math.max(maxP, s.closeLines.entry, s.closeLines.exit);
  }
  const span = maxP - minP || 1;
  const lo = minP - span * 0.09,
    hi = maxP + span * 0.09;
  const yOf = (val) => padT + plotH * (1 - (val - lo) / (hi - lo || 1));

  for (let i = 0; i <= 6; i++) {
    const gy = Math.round(padT + (plotH * i) / 6);
    for (let x = padL; x <= W - padR; x++) setPx(x, gy, 38, 49, 68, 180);
    const val = hi - ((hi - lo) * i) / 6;
    const lbl = val.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    drawText(lbl, Math.max(6, padL - lbl.length * 6 - 8), gy - 3, 1, 148, 163, 184);
  }
  for (let i = 0; i <= 7; i++) {
    const gx = Math.round(padL + (plotW * i) / 7);
    for (let y = padT; y <= padT + plotH; y++) setPx(gx, y, 38, 49, 68, 140);
    const idx = Math.min(labels.length - 1, Math.round(((labels.length - 1) * i) / 7));
    if (labels[idx]) drawText(labels[idx], gx - 15, padT + plotH + 14, 1, 148, 163, 184);
  }

  const pts = closes.map((v, i) => ({
    x: padL + (plotW * i) / Math.max(1, closes.length - 1),
    y: yOf(v),
  }));
  for (let x = 0; x < plotW; x++) {
    const pos = (x / plotW) * Math.max(1, pts.length - 1);
    const i0 = Math.floor(pos),
      i1 = Math.min(pts.length - 1, i0 + 1);
    const t = pos - i0;
    const py = pts[i0].y * (1 - t) + pts[i1].y * t;
    for (let y = Math.round(py); y <= padT + plotH; y++) {
      setPx(padL + x, y, lr, lg, lb, 44);
    }
  }
  for (let i = 0; i < pts.length - 1; i++) {
    drawLine(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, 3.2, lr, lg, lb, 255);
  }

  if (s.position) {
    drawLine(padL, yOf(s.position.entry), W - padR, yOf(s.position.entry), 1.8, 250, 204, 21, 230, true);
    drawLine(padL, yOf(s.position.tp), W - padR, yOf(s.position.tp), 1.8, 74, 222, 128, 230, true);
    drawLine(padL, yOf(s.position.sl), W - padR, yOf(s.position.sl), 1.8, 248, 113, 113, 230, true);
  }
  if (s.closeLines) {
    // trade yang baru ditutup: kuning = harga masuk, hijau/merah = harga keluar (profit/rugi)
    drawLine(padL, yOf(s.closeLines.entry), W - padR, yOf(s.closeLines.entry), 1.8, 250, 204, 21, 230, true);
    const win = s.closeLines.exit >= s.closeLines.entry;
    drawLine(padL, yOf(s.closeLines.exit), W - padR, yOf(s.closeLines.exit), 2.2, win ? 74 : 248, win ? 222 : 113, win ? 128 : 113, 240, true);
  }

  return encodePng(W, H, buf);
}

function renderProfitChartPng(s) {
  const W = 740,
    H = 380;
  const { buf, setPx, drawText, fillRect, drawLine } = createCanvasCtx(W, H);
  const hist =
    s.history && s.history.length
      ? s.history
      : [{ date: new Date().toISOString().slice(0, 10), pnl: s.realizedPnl || 0 }];

  const title = `GRAFIK PROFIT 7 HARI (${s.quote || 'USDT'})`;
  drawText(title, W / 2 - (title.length * 12) / 2, 18, 2, 250, 204, 21);
  const sub = `TOTAL REALIZED: ${s.realizedPnl >= 0 ? '+' : ''}${(s.realizedPnl || 0).toFixed(2)} ${s.quote || 'USDT'}`;
  drawText(sub, W / 2 - (sub.length * 6) / 2, 42, 1, 203, 213, 225);

  const padL = 88,
    padR = 28,
    padT = 68,
    padB = 54;
  const plotW = W - padL - padR,
    plotH = H - padT - padB;
  const vals = hist.map((h) => Number(h.pnl) || 0);
  const maxAbs = Math.max(1, ...vals.map((v) => Math.abs(v))) * 1.2;
  const lo = -maxAbs,
    hi = maxAbs;
  const yOf = (val) => padT + plotH * (1 - (val - lo) / (hi - lo || 1));
  const zeroY = Math.round(yOf(0));

  for (let i = 0; i <= 4; i++) {
    const gy = Math.round(padT + (plotH * i) / 4);
    for (let x = padL; x <= W - padR; x++) setPx(x, gy, 38, 49, 68, 180);
    const val = hi - ((hi - lo) * i) / 4;
    const lbl = (val >= 0 ? '+' : '') + val.toFixed(2);
    drawText(lbl, Math.max(8, padL - lbl.length * 6 - 8), gy - 3, 1, 148, 163, 184);
  }
  drawLine(padL, zeroY, W - padR, zeroY, 1.5, 250, 204, 21, 180);

  const n = hist.length;
  const colW = plotW / Math.max(1, n);
  const barW = Math.min(56, colW * 0.55);
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    const cx = padL + colW * (i + 0.5);
    const yVal = Math.round(yOf(v));
    const top = Math.min(zeroY, yVal);
    const h = Math.max(4, Math.abs(yVal - zeroY));
    if (v >= 0) fillRect(cx - barW / 2, top, barW, h, 34, 197, 94, 230);
    else fillRect(cx - barW / 2, top, barW, h, 239, 68, 68, 230);
    const dLbl = String(hist[i].date || '').slice(5);
    drawText(dLbl, cx - (dLbl.length * 6) / 2, padT + plotH + 14, 1, 148, 163, 184);
  }

  return encodePng(W, H, buf);
}

// ---------- Enkripsi & Token Sesi ----------
const enc = (txt) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const d = Buffer.concat([c.update(String(txt), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), d].map((b) => b.toString('base64')).join('.');
};
const dec = (s) => {
  const [iv, tag, d] = String(s).split('.').map((x) => Buffer.from(x, 'base64'));
  const c = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  c.setAuthTag(tag);
  return Buffer.concat([c.update(d), c.final()]).toString('utf8');
};

const hashPin = (pin, uid) =>
  crypto.createHmac('sha256', KEY).update(`pin:${uid}:${String(pin).trim()}`).digest('hex');

function makeSessionToken(uid) {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${uid}.${exp}`;
  const sig = crypto.createHmac('sha256', KEY).update(`sess:${payload}`).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [uid, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!uid || !Number.isFinite(exp) || Date.now() > exp) return null;
  const expected = crypto.createHmac('sha256', KEY).update(`sess:${uid}.${expStr}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return uid;
}

const bot = new TelegramBot(TOKEN, { polling: false });

function makeBinance(opts = {}, sandbox = true) {
  const ex = new ccxt.binance({
    enableRateLimit: true,
    timeout: 20000,
    options: { defaultType: 'spot', adjustForTimeDifference: true },
    ...opts,
  });
  if (sandbox) ex.setSandboxMode(true);
  return ex;
}
const pubTestnet = makeBinance({}, true);
const pubLive = makeBinance({}, false);

// ---------- Penyimpanan (MongoDB) ----------
let usersCol = null;
let logsCol = null;
let csCol = null;
let trCol = null;
// Catatan aktivitas (login, daftar, trade, sewa, aksi admin). Otomatis dihapus setelah 90 hari.
function logActivity(type, userId, name, detail, extra) {
  if (!logsCol) return;
  logsCol
    .insertOne({
      time: new Date(),
      type,
      userId: String(userId || ''),
      name: String(name || ''),
      detail: String(detail || '').slice(0, 300),
      extra: extra || null,
    })
    .catch(() => {});
}
let tradesCol = null;
let configCol = null;
let rentalsCol = null;

const users = new Map();

// ---------- Terjemahan: dipakai Mini App (/api/i18n) & SEMUA pesan bot sesuai bahasa pilihan user ----------
const TR_LANGS = { en: 'en', es: 'es', de: 'de', fr: 'fr', tr: 'tr', uz: 'uz', ru: 'ru', vi: 'vi', tl: 'tl', th: 'th', ms: 'ms', hi: 'hi', ur: 'ur', zh: 'zh-CN', ko: 'ko', ja: 'ja', af: 'af', ar: 'ar' };
const trCache = new Map();
const trInflight = new Map();
const trHits = new Map();
setInterval(() => trHits.clear(), 60 * 1000).unref();
let trActive = 0;
const trWait = [];
const trAcquire = () => new Promise((res) => { if (trActive < 6) { trActive++; res(); } else trWait.push(res); });
const trRelease = () => { const n = trWait.shift(); if (n) n(); else trActive--; };
const trTimeout = (ms) => AbortSignal.timeout(ms);

// 3 jalur terjemahan (cadangan berurutan) agar tidak ada teks yang gagal diterjemahkan
async function gtServer(text, tl) {
  const q = encodeURIComponent(text);
  const routes = [
    async () => {
      const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=id&tl=${encodeURIComponent(tl)}&dt=t&q=${q}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: trTimeout(7000) });
      if (!r.ok) throw new Error('gtx ' + r.status);
      const j = await r.json();
      return (j[0] || []).map((x) => x[0]).join('');
    },
    async () => {
      const r = await fetch(`https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=id&tl=${encodeURIComponent(tl)}&q=${q}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: trTimeout(7000) });
      if (!r.ok) throw new Error('dict ' + r.status);
      const j = await r.json();
      if (j && Array.isArray(j.sentences)) return j.sentences.map((x) => x.trans || '').join('');
      if (Array.isArray(j)) return (Array.isArray(j[0]) ? j[0][0] : j[0]) || '';
      return '';
    },
    async () => {
      if (text.length > 480) throw new Error('mymemory len');
      const r = await fetch(`https://api.mymemory.translated.net/get?q=${q}&langpair=id|${encodeURIComponent(tl)}`, { signal: trTimeout(7000) });
      if (!r.ok) throw new Error('mm ' + r.status);
      const j = await r.json();
      return (j && j.responseData && j.responseData.translatedText) || '';
    },
  ];
  let lastErr = null;
  for (const route of routes) {
    try {
      const out = String((await route()) || '').trim();
      if (out) return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('tr kosong');
}

async function translateText(raw, tl) {
  const t = String(raw || '').replace(/\s*\n\s*/g, ' ').trim().slice(0, 1500);
  if (!t) return '';
  const key = tl + '|' + t;
  if (trCache.has(key)) return trCache.get(key);
  if (trInflight.has(key)) return trInflight.get(key);
  const p = (async () => {
    const id = sha256Hex(key).slice(0, 40);
    if (trCol) {
      try {
        const d = await trCol.findOne({ _id: id });
        if (d && d.t) { trCache.set(key, d.t); return d.t; }
      } catch (e) {}
    }
    let out = '';
    await trAcquire();
    try { out = (await gtServer(t, tl)).trim(); } catch (e) { out = ''; } finally { trRelease(); }
    if (out) {
      if (trCache.size > 30000) trCache.clear();
      trCache.set(key, out);
      if (trCol) trCol.replaceOne({ _id: id }, { _id: id, l: tl, s: t.slice(0, 160), t: out, at: new Date() }, { upsert: true }).catch(() => {});
    }
    return out;
  })().finally(() => trInflight.delete(key));
  trInflight.set(key, p);
  return p;
}

// ----- Terjemah pesan bot (HTML Telegram / teks biasa) tanpa merusak tag, ID, angka -----
const NUM_RE = /\d[\d.,:]*\d|\d/g;
const trWorthy = (core) => {
  const c = String(core).replace(/\{\d+\}/g, '');
  if (c.length < 2 || !/[A-Za-z\u00C0-\u024F]{2,}/.test(c)) return false;
  if (/^[\sA-Z0-9:.,%$+\-\/()#@_]+$/.test(c) && c.length <= 8) return false;
  return true;
};
async function translateTemplate(text, tl) {
  const nums = [];
  const tpl = text.replace(NUM_RE, (m) => { nums.push(m); return `{${nums.length}}`; });
  if (!nums.length) return translateText(text, tl);
  const has = (s) => { for (let i = 1; i <= nums.length; i++) if (!new RegExp('\\{\\s*' + i + '\\s*\\}').test(s)) return false; return true; };
  const put = (s) => s.replace(/\{\s*(\d+)\s*\}/g, (m, n) => (nums[n - 1] !== undefined ? nums[n - 1] : m));
  const out = await translateText(tpl, tl);
  if (out && has(out)) return put(out);
  // cadangan: terjemahkan hanya potongan huruf, angka dibiarkan
  const parts = text.split(/(\d[\d.,:]*\d|\d)/);
  const done = await Promise.all(parts.map(async (p, i) => {
    if (i % 2 === 1 || !trWorthy(p)) return p;
    const m = p.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const o = await translateText(m[2], tl);
    return o ? m[1] + o + m[3] : p;
  }));
  return done.join('');
}
async function trLine(line, tl) {
  const m = line.match(/^([^A-Za-z\u00C0-\u024F]*)([\s\S]*?)([^A-Za-z\u00C0-\u024F]*)$/);
  if (!m || !m[2] || !trWorthy(m[2])) return line;
  const out = await translateTemplate(m[2], tl);
  return out ? m[1] + out + m[3] : line;
}
async function trMarkup(text, tl, html) {
  if (!html) return (await Promise.all(text.split('\n').map((l) => trLine(l, tl)))).join('\n');
  const parts = text.split(/(<[^>]+>)/);
  let skip = 0;
  const jobs = parts.map((p) => {
    if (/^<[^>]+>$/.test(p)) {
      if (/^<(code|pre|blockquote)[\s>]/i.test(p)) skip++;
      else if (/^<\/(code|pre|blockquote)>/i.test(p)) skip = Math.max(0, skip - 1);
      return Promise.resolve(p);
    }
    if (skip || !p.trim()) return Promise.resolve(p);
    const dec = p.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    return Promise.all(dec.split('\n').map((l) => trLine(l, tl))).then((ls) => ls.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  });
  return (await Promise.all(jobs)).join('');
}
const userLangOf = (u) => (u && u.lang === 'id' ? 'id' : u && u.lang && TR_LANGS[u.lang] ? u.lang : 'en'); // default Inggris
async function localizeText(u, text, html) {
  const L = userLangOf(u);
  if (L === 'id' || !text) return text;
  try {
    return await Promise.race([trMarkup(String(text), TR_LANGS[L], !!html), new Promise((r) => setTimeout(() => r(text), 6000))]);
  } catch (e) {
    return text;
  }
}
async function localizeMarkup(u, rm) {
  if (userLangOf(u) === 'id' || !rm || !Array.isArray(rm.inline_keyboard)) return rm;
  const rows = await Promise.all(rm.inline_keyboard.map((row) => Promise.all(row.map(async (b) => (b && b.text ? { ...b, text: await localizeText(u, b.text, false) } : b)))));
  return { ...rm, inline_keyboard: rows };
}
// Bahasa pilihan di Mini App tersimpan di akun -> semua notifikasi bot memakai bahasa itu
function touchLang(u, req) {
  const L = String((req && req.get && req.get('x-lang')) || '').toLowerCase().slice(0, 5);
  if (u && L && (L === 'id' || TR_LANGS[L]) && u.lang !== L) {
    u.lang = L;
    saveUser(u);
  }
}
// Bungkus bot agar semua pesan/caption/tombol otomatis diterjemahkan ke bahasa user
(function patchBotLocalization() {
  const uOf = (chatId) => users.get(String(chatId));
  const html = (o) => !!o && String(o.parse_mode || '').toUpperCase() === 'HTML';
  const oSend = bot.sendMessage.bind(bot);
  bot.sendRaw = oSend; // kirim apa adanya (tanpa terjemahan otomatis)
  const oPhoto = bot.sendPhoto.bind(bot);
  bot.sendPhotoRaw = oPhoto; // kirim foto apa adanya (untuk grup, tanpa terjemahan otomatis)
  const oDoc = bot.sendDocument.bind(bot);
  const oEditCap = bot.editMessageCaption.bind(bot);
  const oEditTxt = bot.editMessageText.bind(bot);
  bot.sendMessage = async (chatId, text, opts) => {
    const u = uOf(chatId);
    if (userLangOf(u) === 'id') return oSend(chatId, text, opts);
    const o = opts ? { ...opts } : undefined;
    const t = await localizeText(u, text, html(o));
    if (o && o.reply_markup) o.reply_markup = await localizeMarkup(u, o.reply_markup);
    return oSend(chatId, t, o);
  };
  const mediaWrap = (orig) => async (chatId, media, opts, fileOpts) => {
    const u = uOf(chatId);
    if (userLangOf(u) === 'id' || !opts) return orig(chatId, media, opts, fileOpts);
    const o = { ...opts };
    if (o.caption) o.caption = await localizeText(u, o.caption, html(o));
    if (o.reply_markup) o.reply_markup = await localizeMarkup(u, o.reply_markup);
    return orig(chatId, media, o, fileOpts);
  };
  bot.sendPhoto = mediaWrap(oPhoto);
  bot.sendDocument = mediaWrap(oDoc);
  bot.editMessageCaption = async (caption, opts) => {
    const u = opts && uOf(opts.chat_id);
    if (!u || userLangOf(u) === 'id') return oEditCap(caption, opts);
    const o = { ...opts };
    const c = await localizeText(u, caption, html(o));
    if (o.reply_markup) o.reply_markup = await localizeMarkup(u, o.reply_markup);
    return oEditCap(c, o);
  };
  bot.editMessageText = async (text, opts) => {
    const u = opts && uOf(opts.chat_id);
    if (!u || userLangOf(u) === 'id') return oEditTxt(text, opts);
    const o = { ...opts };
    const t = await localizeText(u, text, html(o));
    if (o.reply_markup) o.reply_markup = await localizeMarkup(u, o.reply_markup);
    return oEditTxt(t, o);
  };
})();

const runtimes = new Map();
let rentalConfig = { ...DEFAULT_RENTAL_CONFIG };
const rentalOrders = new Map();

const rt = (id) => {
  if (!runtimes.has(id)) {
    runtimes.set(id, {
      busy: false,
      adapter: null,
      adapterKey: '',
      bal: null,
      balAt: 0,
      fails: 0,
      save: null,
      panelMsgId: null,
      panelChartType: 'price',
      lastPanelUpdateAt: 0,
    });
  }
  return runtimes.get(id);
};

function getBrokerCfg(brokerId) {
  return BROKERS[brokerId] || BROKERS.binance_testnet;
}

function getAssetCfg(assetId) {
  return ASSETS[assetId] || ASSETS.BTC;
}

function isRentalActive(u) {
  if (!u) return false;
  if (isAdminId(u._id)) return true;
  if (!rentalConfig.requireRental) return true;
  return Number(u.rentalExpiresAt || 0) > Date.now();
}

// ---------- Paket / Tier ----------
const TIER_LIMITS = {
  starter: { label: 'Starter', maxAssets: 1, maxTradesPerDay: 5 },
  trader: { label: 'Trader', maxAssets: 3, maxTradesPerDay: 20 },
  pro: { label: 'Pro', maxAssets: 0, maxTradesPerDay: 0 }, // 0 = tanpa batas
  elite: { label: 'Elite', maxAssets: 0, maxTradesPerDay: 0 },
};
// Fitur yang tampil di Mini App sesuai paket. Paket Starter = hanya fitur trade inti.
const TIER_FEATURES = {
  starter: ['trade', 'humanize'],
  // Grafik: Starter = Candlestick saja · Trader = + Bar/Area + RSI & analisis · Pro/Elite = + Live Chart + riwayat profit
  trader: ['trade', 'humanize', 'chart', 'analysis', 'trader_tools', 'chart_modes', 'chart_rsi'],
  pro: ['trade', 'humanize', 'chart', 'analysis', 'trader_tools', 'pro_tools', 'chart_modes', 'chart_rsi', 'chart_live', 'chart_pnl'],
  elite: ['trade', 'humanize', 'chart', 'analysis', 'trader_tools', 'pro_tools', 'alarm', 'chart_modes', 'chart_rsi', 'chart_live', 'chart_pnl'],
};
const hasPurchased = (u) => isAdminId(u._id) || Number(u.purchaseCount || 0) > 0;
function featuresFor(u) {
  const base = TIER_FEATURES[getUserTier(u)] || TIER_FEATURES.starter;
  return [...base, 'cs']; // 'cs' = chat customer service, tersedia untuk semua akun (menu CS)
}
const hasFeature = (u, f) => featuresFor(u).includes(f);
function inferTier(p) {
  if (p && TIER_LIMITS[p.tier]) return p.tier;
  const h = Number(p && p.durationHours) || 24;
  return h >= 8000 ? 'elite' : h >= 600 ? 'pro' : h >= 100 ? 'trader' : 'starter';
}
function getUserTier(u) {
  if (isAdminId(u._id)) return 'elite';
  return TIER_LIMITS[u.rentalTier] ? u.rentalTier : 'pro'; // user lama tanpa tier = Pro
}
function getPlanLimits(u) {
  return TIER_LIMITS[getUserTier(u)];
}
function effectivePrice(p) {
  const d = String((p && p.discountPrice) || '').trim();
  return d || String((p && p.price) || '');
}
function utcDayKey() {
  return new Date().toISOString().slice(0, 10);
}
function tradesToday(u) {
  return u.tradeDay === utcDayKey() ? Number(u.tradeCount) || 0 : 0;
}

// ---------- Strategi entry / exit ----------
const STRATEGIES = { rsi: 'RSI Standar', ema_rsi: 'EMA + RSI', macd: 'MACD', bollinger: 'Bollinger Bands' };
function lastOf(arr, back = 0) {
  return arr && arr.length > back ? arr[arr.length - 1 - back] : undefined;
}
function strategySignals(m, rsiBuy, rsiSell, strategy) {
  const closes = (m && m.closes) || [];
  const price = m.price;
  const out = { buy: false, sell: false, why: '' };
  if (strategy === 'ema_rsi') {
    const e9 = EMA.calculate({ values: closes, period: 9 });
    const e21 = EMA.calculate({ values: closes, period: 21 });
    const f = lastOf(e9), sl = lastOf(e21);
    if (!Number.isFinite(f) || !Number.isFinite(sl)) return out;
    out.buy = f > sl && m.rsi < Math.min(rsiSell - 10, rsiBuy + 20);
    out.sell = f < sl && m.rsi > rsiBuy + 10;
    out.why = `EMA9 ${f > sl ? '>' : '<'} EMA21 · RSI ${m.rsi.toFixed(1)}`;
  } else if (strategy === 'macd') {
    const mc = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
    const a = lastOf(mc), b = lastOf(mc, 1);
    if (!a || !b || !Number.isFinite(a.histogram) || !Number.isFinite(b.histogram)) return out;
    out.buy = b.histogram <= 0 && a.histogram > 0;   // golden cross
    out.sell = b.histogram >= 0 && a.histogram < 0;  // death cross
    out.why = `MACD hist ${a.histogram.toFixed(4)}`;
  } else if (strategy === 'bollinger') {
    const bb = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
    const a = lastOf(bb);
    if (!a) return out;
    out.buy = price <= a.lower;
    out.sell = price >= a.upper;
    out.why = `Bollinger bawah ${a.lower.toFixed(4)} / atas ${a.upper.toFixed(4)}`;
  }
  return out;
}
// Filter tren: entry hanya bila EMA20 di atas EMA50 (tren naik)
function trendIsUp(m) {
  const closes = (m && m.closes) || [];
  if (closes.length < 55) return true; // data kurang -> jangan memblokir
  const e20 = lastOf(EMA.calculate({ values: closes, period: 20 }));
  const e50 = lastOf(EMA.calculate({ values: closes, period: 50 }));
  return !(Number.isFinite(e20) && Number.isFinite(e50)) || e20 > e50;
}

// ---------- Konfirmasi sinyal bertingkat per paket ----------
// Makin tinggi paket, makin banyak syarat yang harus terpenuhi sebelum BUY otomatis
// (lebih sedikit sinyal palsu). Ini TIDAK menjamin profit; hanya memperketat entry.
//  Starter: tanpa konfirmasi tambahan
//  Trader : RSI mulai naik + candle terakhir naik (pembalikan terkonfirmasi)
//  Pro    : + histogram MACD menguat + volatilitas (ATR) tidak ekstrem
//  Elite  : + tren naik (EMA20>EMA50) ATAU harga jauh di bawah rata-rata Bollinger
const CONFIRM_LEVEL = { starter: 0, trader: 1, pro: 2, elite: 3 };
function confirmEntry(m, tier) {
  const lvl = CONFIRM_LEVEL[tier] || 0;
  if (lvl === 0) return { ok: true, level: 0 };
  const closes = (m && m.closes) || [], highs = (m && m.highs) || [], lows = (m && m.lows) || [];
  const rs = (m && m.rsiSeries) || [];
  const n = closes.length;
  if (n < 65 || rs.length < 2) return { ok: true, level: lvl }; // data kurang: jangan memblokir
  if (!(rs[rs.length - 1] > rs[rs.length - 2] && closes[n - 1] > closes[n - 2])) return { ok: false, level: lvl, why: 'menunggu pembalikan' };
  if (lvl >= 2) {
    const mc = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
    const a = lastOf(mc), b = lastOf(mc, 1);
    if (!a || !b || !Number.isFinite(a.histogram) || !Number.isFinite(b.histogram)) return { ok: true, level: lvl };
    if (!(a.histogram > b.histogram)) return { ok: false, level: lvl, why: 'momentum MACD belum menguat' };
    const tr = (i) => Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    let sum = 0;
    for (let i = n - 51; i < n - 1; i++) sum += tr(i);
    const avgTr = sum / 50;
    if (avgTr > 0 && Number.isFinite(tr(n - 1)) && tr(n - 1) > 2 * avgTr) return { ok: false, level: lvl, why: 'volatilitas terlalu ekstrem' };
  }
  if (lvl >= 3) {
    const e20 = lastOf(EMA.calculate({ values: closes, period: 20 }));
    const e50 = lastOf(EMA.calculate({ values: closes, period: 50 }));
    const bb = lastOf(BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 }));
    const up = Number.isFinite(e20) && Number.isFinite(e50) && e20 > e50;
    const deep = bb && Number.isFinite(bb.middle) && closes[n - 1] <= bb.middle - (bb.middle - bb.lower) * 0.75;
    if (!(up || deep)) return { ok: false, level: lvl, why: 'belum searah tren / belum cukup murah' };
  }
  return { ok: true, level: lvl };
}

// ---------- Perjanjian risiko trading (wajib sebelum kirim pembayaran) ----------
const AGREEMENT_VERSION = '2026-11-v1';
function validateAgreement(a) {
  if (!a || a.accepted !== true) {
    throw new Error('Anda harus membaca dan mencentang persetujuan Perjanjian Risiko Trading sebelum mengirim pembayaran.');
  }
  if (String(a.version || '') !== AGREEMENT_VERSION) {
    throw new Error('Versi perjanjian sudah diperbarui. Tutup lalu buka ulang Mini App, kemudian centang lagi.');
  }
  return { version: AGREEMENT_VERSION };
}

const isProUp = (u) => ['pro', 'elite'].includes(getUserTier(u));
const isElite = (u) => getUserTier(u) === 'elite';

// ---------- Poin 6 (Elite): alarm harga ----------
const MAX_ALARMS = 10;
function alarmHit(a, price) {
  if (!a || !Number.isFinite(price)) return false;
  return a.dir === 'above' ? price >= a.level : price <= a.level;
}
function newAlarmId() {
  return 'al_' + crypto.randomBytes(4).toString('hex');
}
function dailyLossHit(u) {
  const dl = Number(u.settings && u.settings.dailyLossLimit) || 0;
  if (!(dl > 0) || !isProUp(u)) return false;
  ensureToday(u);
  return u.today.pnl <= -dl;
}
function inSession(u) {
  if (!isProUp(u) || Number(u.settings.sessionOn) !== 1) return true;
  const h = new Date().getUTCHours();
  const a = Number(u.settings.sessionStart), b = Number(u.settings.sessionEnd);
  return a <= b ? h >= a && h < b : h >= a || h < b;
}
function computeStats(rows) {
  const sells = rows.filter((r) => r.side === 'SELL' && Number.isFinite(Number(r.pnl)));
  let cum = 0, peak = 0, maxDd = 0, gp = 0, gl = 0, wins = 0, losses = 0, best = null, worst = null;
  const perAsset = {};
  for (const r of sells) {
    const p = Number(r.pnl);
    cum += p;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
    if (p >= 0) { wins++; gp += p; } else { losses++; gl += p; }
    best = best === null ? p : Math.max(best, p);
    worst = worst === null ? p : Math.min(worst, p);
    const k = r.asset || r.symbol || '?';
    perAsset[k] = perAsset[k] || { pnl: 0, trades: 0, wins: 0 };
    perAsset[k].pnl += p; perAsset[k].trades++; if (p >= 0) perAsset[k].wins++;
  }
  const n = sells.length;
  return {
    trades: n, wins, losses,
    winRate: n ? (wins / n) * 100 : 0,
    totalPnl: cum, grossProfit: gp, grossLoss: gl,
    profitFactor: gl < 0 ? gp / -gl : (gp > 0 ? null : 0),
    avgWin: wins ? gp / wins : 0, avgLoss: losses ? gl / losses : 0,
    best: best === null ? 0 : best, worst: worst === null ? 0 : worst,
    maxDrawdown: maxDd,
    perAsset: Object.entries(perAsset).map(([asset, v]) => ({ asset, ...v })).sort((a, b) => b.pnl - a.pnl),
  };
}
const csvCell = (v) => {
  const t = String(v === undefined || v === null ? '' : v);
  const safe = /^[=+\-@]/.test(t) ? "'" + t : t; // cegah formula injection di Excel
  return /[",\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
};

function calcAtr(m, period = 14) {
  const h = (m && m.highs) || [], l = (m && m.lows) || [], c = (m && m.closes) || [];
  const n = c.length;
  if (n < period + 1) return 0;
  let sum = 0;
  for (let i = n - period; i < n; i++) {
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    if (!Number.isFinite(tr)) return 0;
    sum += tr;
  }
  return sum / period;
}

function getUserTradeInfo(u) {
  const b = getBrokerCfg(u.broker);
  const a = getAssetCfg(u.asset);
  if (b.isMt) {
    const customSym = u.customMtSymbol && u.asset === 'CUSTOM' ? u.customMtSymbol : a.mtSymbol;
    return {
      broker: b,
      asset: a,
      symbol: customSym,
      base: a.base,
      quote: b.quote,
      unit: 'Lot',
      decimals: a.decimals,
      defaultAmount: a.mtDefault,
      minAmount: a.mtMin,
      maxAmount: a.mtMax,
      supportedOnBroker: true,
    };
  }
  return {
    broker: b,
    asset: a,
    symbol: a.spotSymbol || `${a.id}/USDT`,
    base: a.base,
    quote: b.quote,
    unit: a.base,
    decimals: a.decimals,
    defaultAmount: a.spotDefault,
    minAmount: a.spotMin,
    maxAmount: a.spotMax,
    supportedOnBroker: !!a.spotSymbol,
  };
}

function getActiveKeyObj(u) {
  if (u.brokerKeys && u.brokerKeys[u.broker]) return u.brokerKeys[u.broker];
  if (u.keys && (!u.keys.broker || u.keys.broker === u.broker)) return u.keys;
  return null;
}

function hasBrokerKeys(u, brokerId = u.broker) {
  if (u.brokerKeys && u.brokerKeys[brokerId]) return true;
  if (u.keys && (!u.keys.broker || u.keys.broker === brokerId)) return true;
  return false;
}

function newUser(from) {
  const idStr = String(from.id);
  return {
    _id: idStr,
    name: from.first_name || from.username || 'User',
    username: from.username || '',
    pinHash: null,
    isSessionLocked: false,
    lastLoginAt: 0,
    rentalExpiresAt: isAdminId(idStr) ? Date.now() + 100 * 365 * 86400000 : 0,
    rentalPlanName: isAdminId(idStr) ? 'OWNER UNLIMITED' : '',
    lang: (() => { const c = String(from.language_code || '').slice(0, 2).toLowerCase(); return c && c !== 'id' && TR_LANGS[c] ? c : ''; })(),
    liveBotStatus: true, // Poin 5: kirim/update status & grafik realtime di chat bot
    createdAt: new Date(),
    broker: 'binance_testnet',
    asset: 'BTC',
    mtSymbol: 'BTCUSD',
    keys: null,
    brokerKeys: {},
    isAutoTrade: false,
    position: null,
    realizedPnl: 0,
    today: { date: '', trades: 0, pnl: 0, reported: false },
    history: {},
    settings: { ...DEFAULT_SETTINGS },
    lastSellAt: 0,
    alarms: [],
  };
}

function normalizeUserDoc(doc) {
  const base = newUser({ id: doc._id, first_name: doc.name, username: doc.username });
  const u = {
    ...base,
    ...doc,
    liveBotStatus: doc.liveBotStatus !== false,
    broker: BROKERS[doc.broker] ? doc.broker : 'binance_testnet',
    asset: ASSETS[doc.asset] ? doc.asset : 'BTC',
    brokerKeys: { ...(doc.brokerKeys || {}) },
    settings: { ...DEFAULT_SETTINGS, ...(doc.settings || {}) },
    alarms: Array.isArray(doc.alarms) ? doc.alarms : [],
  };
  if (isAdminId(u._id)) {
    u.rentalExpiresAt = Date.now() + 100 * 365 * 86400000;
    u.rentalPlanName = 'OWNER UNLIMITED';
  }
  if (u.keys && u.keys.k && !u.brokerKeys.binance_testnet) {
    u.brokerKeys.binance_testnet = { broker: 'binance_testnet', k: u.keys.k, s: u.keys.s };
  }
  u.keys = getActiveKeyObj(u);
  return u;
}

function saveUser(u) {
  u.keys = getActiveKeyObj(u);
  const r = rt(u._id);
  r.save = (r.save || Promise.resolve())
    .then(() => usersCol.replaceOne({ _id: u._id }, u, { upsert: true }))
    .catch((e) => console.error('Simpan user:', e.message));
}

async function saveRentalConfig() {
  if (!configCol) return;
  await configCol
    .replaceOne({ _id: 'rental_config' }, rentalConfig, { upsert: true })
    .catch((e) => console.error('Simpan rentalConfig:', e.message));
}

function logTrade(u, side, price, amount, pnl, note) {
  const info = getUserTradeInfo(u);
  logActivity(
    side === 'BUY' ? 'TRADE_BUY' : 'TRADE_SELL',
    u._id,
    u.name,
    `${side} ${info.symbol} @ ${Number(price)} x ${Number(amount)}` + (side === 'SELL' ? ` · PnL ${Number(pnl)}` : ''),
    { pnl: Number(pnl), price: Number(price), amount: Number(amount), asset: u.asset, broker: u.broker, note: String(note || '') }
  );
  tradesCol
    .insertOne({
      userId: u._id,
      broker: u.broker,
      asset: u.asset,
      symbol: info.symbol,
      time: new Date(),
      side,
      price: Number(price),
      amount: Number(amount),
      pnl: Number(pnl),
      note,
    })
    .catch((e) => console.error('Simpan trade:', e.message));
}

async function ensureUser(from) {
  const id = String(from.id);
  let u = users.get(id);
  if (u) {
    let changed = false;
    if (from.first_name && u.name !== from.first_name) {
      u.name = from.first_name;
      changed = true;
    }
    if (from.username && u.username !== from.username) {
      u.username = from.username;
      changed = true;
    }
    if (changed) saveUser(u);
    return u;
  }
  if (WHITELIST.length && !WHITELIST.includes(id) && !isAdminId(id)) return null;
  if (users.size >= MAX_USERS && !isAdminId(id)) return null;
  u = newUser(from);
  users.set(id, u);
  await usersCol.insertOne(u).catch((e) => console.error('Insert user:', e.message));
  logActivity('REGISTER', id, u.name, 'Akun baru terdaftar' + (u.username ? ' (@' + u.username + ')' : ''));
  return u;
}

// ID/username dikunci ke akun Telegram: lewat Telegram identitas diambil dari initData (tidak bisa diganti),
// di luar Telegram hanya ID angka yang diterima (bukan @username).
function checkIdentLock(tgUser, ident) {
  const q = String(ident || '').trim();
  if (tgUser) {
    if (!q) return null;
    const un = String(tgUser.username || '').toLowerCase();
    if (q === String(tgUser.id) || (un && q.replace(/^@/, '').toLowerCase() === un)) return null;
    return 'ID terkunci sesuai akun Telegram Anda dan tidak bisa diganti.';
  }
  if (!/^\d{3,20}$/.test(q)) return 'Masukkan ID Telegram berupa angka. Username tidak bisa dipakai untuk login.';
  return null;
}
function findUserByIdentifier(raw) {
  const q = String(raw || '').trim();
  if (!q) return null;
  if (users.has(q)) return users.get(q);
  const cleanUser = q.replace(/^@/, '').toLowerCase();
  for (const u of users.values()) {
    if (u.username && u.username.toLowerCase() === cleanUser) return u;
    if (u.name && u.name.toLowerCase() === cleanUser) return u;
  }
  return null;
}

// ---------- Worker Pool ----------
async function runPool(items, concurrency, taskFn) {
  const list = [...items];
  if (!list.length) return;
  const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (list.length > 0) {
      const item = list.shift();
      if (!item) break;
      try {
        await taskFn(item);
      } catch (e) {
        console.error('Pool worker error:', e.message);
      }
    }
  });
  await Promise.all(workers);
}

// ---------- Ikon emas berkilau ----------
const TWINKLE = ['✦', '✧', '✶', '✷'];
const tw = () => TWINKLE[Math.floor(Date.now() / 1000) % TWINKLE.length];
const GLYPH = {
  dash: '◈',
  buy: '▲',
  sell: '▼',
  power: '⏻',
  refresh: '⟳',
  key: '⚿',
  broker: '⇄',
  asset: '❖',
  chart: '▤',
  live: '◷',
  check: '✓',
  cross: '✕',
};
const ICON_IDS = (() => {
  try {
    return JSON.parse(process.env.ICON_IDS || '{}');
  } catch (e) {
    return {};
  }
})();
const BTN_STYLE = process.env.BTN_STYLE !== '0';
let fancy = true;

function btn(icon, label, extra, style) {
  const b = { text: `${GLYPH[icon] || '◈'} ${label} ${tw()}`, ...extra };
  if (fancy) {
    if (ICON_IDS[icon]) {
      b.icon_custom_emoji_id = ICON_IDS[icon];
      b.text = `${label} ${tw()}`;
    }
    if (BTN_STYLE && style) b.style = style;
  }
  return b;
}
async function tgSafe(fn) {
  try {
    return await fn();
  } catch (e) {
    if (fancy && !/not modified/i.test(e.message) && /400|button|emoji|icon|style|premium/i.test(e.message)) {
      fancy = false;
      return fn();
    }
    throw e;
  }
}

// ---------- Helper Waktu UTC Realtime ----------
const todayKey = () => new Date().toISOString().slice(0, 10);
const utcHour = () => new Date().getUTCHours();
const utcTimeStr = (t = Date.now()) => new Date(t).toISOString().slice(11, 19) + ' UTC';
const utcHHMM = (t) => new Date(t).toISOString().slice(11, 16);

function ensureToday(u) {
  if (u.today.date !== todayKey()) u.today = { date: todayKey(), trades: 0, pnl: 0, reported: false };
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n, d = 2) =>
  Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const dot = (v) => (v >= 0 ? '▲' : '▼');
const sign = (v, d = 2) => `${v >= 0 ? '+' : ''}${fmt(v, d)}`;
const rsiLabel = (u, r) =>
  r < u.settings.rsiBuy ? '▽ Oversold' : r > u.settings.rsiSell ? '△ Overbought' : '◇ Netral';
const rsiBar = (r) => {
  const filled = Math.max(0, Math.min(10, Math.round(r / 10)));
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg, code) => Object.assign(new Error(msg), { code });

function formatRemainingRental(u) {
  if (isAdminId(u._id)) return 'UNLIMITED (Owner/Admin)';
  const rem = Number(u.rentalExpiresAt || 0) - Date.now();
  if (rem <= 0) return 'Habis / Belum Sewa';
  const d = Math.floor(rem / 86400000);
  const h = Math.floor((rem % 86400000) / 3600000);
  const m = Math.floor((rem % 3600000) / 60000);
  return `${d}h ${h}j ${m}m`;
}

function notify(u, text, silent = false) {
  return bot
    .sendMessage(u._id, text, { parse_mode: 'HTML', disable_notification: silent })
    .catch((e) => {
      const code = e.response && e.response.statusCode;
      if (code === 403 && u.isAutoTrade) {
        u.isAutoTrade = false;
        saveUser(u);
      }
      console.error(`Notify ${u._id}:`, e.message);
    });
}

async function withLock(u, fn) {
  const r = rt(u._id);
  if (r.busy) throw fail('Sedang memproses, coba lagi sebentar', 'BUSY');
  r.busy = true;
  try {
    return await fn();
  } finally {
    r.busy = false;
  }
}

// ---------- Perhitungan Keterangan Analisis Teknikal Realtime ----------
function calcEMA(values, period) {
  if (!values || !values.length) return 0;
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function buildMarketAnalysis(m, u, info) {
  const closes = m.closes || [];
  const highs = m.highs || closes;
  const lows = m.lows || closes;
  const price = m.price || 0;
  const rsi = Number.isFinite(m.rsi) ? m.rsi : 50;
  const dec = info.decimals || 2;
  const { rsiBuy, rsiSell, tp, sl } = u.settings;

  const ema9 = calcEMA(closes.slice(-30), 9);
  const ema21 = calcEMA(closes.slice(-45), 21);
  const recentHighs = highs.slice(-24);
  const recentLows = lows.slice(-24);
  const resistance = recentHighs.length ? Math.max(...recentHighs) : price * 1.01;
  const support = recentLows.length ? Math.min(...recentLows) : price * 0.99;
  const rangePct = price > 0 ? ((resistance - support) / price) * 100 : 0;
  const prevClose = closes.length > 1 ? closes[closes.length - 2] : price;
  const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;

  const trendBullish = ema9 >= ema21;
  const trendText = trendBullish ? 'Bullish (Naik)' : 'Bearish (Turun)';
  const momentumText =
    rsi < rsiBuy
      ? 'Jenuh Jual (Oversold — Potensi Rebound Naik)'
      : rsi > rsiSell
      ? 'Jenuh Beli (Overbought — Rawan Koreksi)'
      : rsi >= 52
      ? 'Dominasi Buyer (Tekanan Beli Stabil)'
      : rsi <= 48
      ? 'Dominasi Seller (Tekanan Jual Stabil)'
      : 'Seimbang / Sideways';

  let signal = 'WAIT / NETRAL';
  let signalCode = 'NEUTRAL';
  if (rsi <= rsiBuy && trendBullish) {
    signal = 'STRONG BUY';
    signalCode = 'STRONG_BUY';
  } else if (rsi <= rsiBuy || (trendBullish && rsi < rsiSell - 8 && price >= ema9)) {
    signal = 'BUY / AKUMULASI';
    signalCode = 'BUY';
  } else if (rsi >= rsiSell && !trendBullish) {
    signal = 'STRONG SELL';
    signalCode = 'STRONG_SELL';
  } else if (rsi >= rsiSell || (!trendBullish && rsi > rsiBuy + 8 && price < ema9)) {
    signal = 'SELL / TAKE PROFIT';
    signalCode = 'SELL';
  }

  const targetTpPrice = price * (1 + tp / 100);
  const targetSlPrice = price * (1 - sl / 100);

  const summary =
    `Harga ${info.symbol} bergerak di ${fmt(price, dec)} (${sign(changePct, 2)}%) dalam tren ${trendText} ` +
    `(EMA-9: ${fmt(ema9, dec)} vs EMA-21: ${fmt(ema21, dec)}). ` +
    `Indikator RSI(14) berada di ${rsi.toFixed(1)} (${momentumText}). ` +
    `Area Support terdekat di ${fmt(support, dec)} dan Resistance di ${fmt(resistance, dec)} (volatilitas ${rangePct.toFixed(2)}%). ` +
    `Estimasi Target TP (+${tp}%) di ${fmt(targetTpPrice, dec)} & batas risiko SL (-${sl}%) di ${fmt(targetSlPrice, dec)}.`;

  return {
    signal,
    signalCode,
    trend: trendText,
    trendBullish,
    momentum: momentumText,
    ema9,
    ema21,
    support,
    resistance,
    rangePct,
    changePct,
    targetTpPrice,
    targetSlPrice,
    summary,
  };
}

// ---------- Mode Anti-Deteksi Bot (Humanize) · Starter, Trader, Pro, Elite ----------
// Mengurangi pola khas bot: jeda acak sebelum order, ukuran lot sedikit bervariasi (tidak pernah melebihi
// jumlah yang Anda atur), tanpa komentar/tag "bot" pada order, dan ID order acak. Ini TIDAK menjamin broker
// tidak mendeteksi; pastikan aturan broker Anda mengizinkan trading otomatis.
const HUMAN_DELAY_MS = [600, 3500];
const humanizeOn = (u) => Number(u && u.settings && u.settings.humanize) !== 0;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function humanPause(u) {
  if (!humanizeOn(u)) return 0;
  const ms = HUMAN_DELAY_MS[0] + Math.floor(Math.random() * (HUMAN_DELAY_MS[1] - HUMAN_DELAY_MS[0]));
  await sleepMs(ms);
  return ms;
}
function humanizeAmount(u, amount, minAmount) {
  const a = Number(amount);
  if (!humanizeOn(u) || !(a > 0)) return a;
  const v = Number((a * (0.95 + Math.random() * 0.05)).toFixed(6));
  return Math.min(a, Math.max(Number(minAmount) || 0, v));
}
const humanOrderId = () => crypto.randomBytes(9).toString('hex'); // 18 karakter acak, tanpa awalan khas bot

// ---------- Adapter Broker Terpadu ----------
function buildBinanceAdapter(apiKey, secret, sandbox) {
  const ex = makeBinance({ apiKey, secret }, sandbox);
  return {
    kind: sandbox ? 'binance_testnet' : 'binance',
    isMt: false,
    raw: ex,
    async check() {
      const b = await ex.fetchBalance();
      return { balance: b.USDT ? b.USDT.free : 0, currency: 'USDT' };
    },
    async balance(symbol, baseAsset = 'BTC') {
      const b = await ex.fetchBalance();
      const usdt = b.USDT ? Number(b.USDT.free) || 0 : 0;
      const baseBal = b[baseAsset] ? Number(b[baseAsset].free) || 0 : 0;
      return { quote: usdt, base: baseBal, equity: null, currency: 'USDT' };
    },
    async candles(s, tf, n) {
      return ex.fetchOHLCV(s, tf, undefined, n);
    },
    async marketBuy(s, amount, baseAsset = 'BTC', opts = {}) {
      let order = await ex.createMarketBuyOrder(s, amount, opts.humanize ? { newClientOrderId: humanOrderId() } : undefined);
      if (!order.filled && order.id) {
        try {
          order = await ex.fetchOrder(order.id, s);
        } catch (e) {}
      }
      const filled = Number(order.filled) || Number(amount);
      const price = Number(order.average || order.price) || 0;
      const feeBase = (order.fees || [])
        .filter((f) => f.currency === baseAsset)
        .reduce((sum, f) => sum + (Number(f.cost) || 0), 0);
      const got = Math.max(0, filled - feeBase);
      const cost = Number(order.cost) || price * filled;
      return { price, filled: got, cost, contractSize: 1, positionId: order.id ? String(order.id) : null, symbol: s };
    },
    async marketSell(s, amount, pos, baseAsset = 'BTC', opts = {}) {
      const b = await ex.fetchBalance();
      const free = b[baseAsset] ? Number(b[baseAsset].free) || 0 : 0;
      const target = pos && pos.amount ? Math.min(pos.amount, free) : free;
      const qty = Number(ex.amountToPrecision(s, target));
      if (!(qty > 0)) throw new Error(`Saldo ${baseAsset} tidak cukup untuk dijual`);
      const order = await ex.createMarketSellOrder(s, qty, opts.humanize ? { newClientOrderId: humanOrderId() } : undefined);
      const price = Number(order.average || order.price) || 0;
      const proceeds = Number(order.cost) || price * qty;
      const pnl = proceeds - (pos ? pos.cost : price * qty);
      return { price, qty, pnl };
    },
  };
}

function getAdapter(u) {
  const k = getActiveKeyObj(u);
  if (!k) return null;
  const r = rt(u._id);
  const cacheKey = `${u.broker}:${k.k || k.token || ''}:${k.id || ''}:${k.region || ''}`;
  if (r.adapter && r.adapterKey === cacheKey) return r.adapter;

  const cfg = getBrokerCfg(u.broker);
  if (cfg.isMt) {
    r.adapter = mt5Adapter.create({
      token: dec(k.token),
      id: dec(k.id),
      region: k.region || 'singapore',
      kind: u.broker,
    });
  } else {
    r.adapter = buildBinanceAdapter(dec(k.k), dec(k.s), cfg.sandbox);
  }
  r.adapterKey = cacheKey;
  return r.adapter;
}

function requireAdapter(u) {
  const ad = getAdapter(u);
  const cfg = getBrokerCfg(u.broker);
  if (!ad) throw fail(`Hubungkan kredensial ${cfg.name} dulu di Dashboard`, 'NOKEY');
  return ad;
}

// ---------- Data Pasar OHLC Lengkap & Realtime ----------
const marketCache = new Map();

function computeMarketFromCandles(candles, overridePrice) {
  const times = candles.map((c) => Number(c[0]));
  const opens = candles.map((c) => Number(c[1]));
  const highs = candles.map((c) => Number(c[2]));
  const lows = candles.map((c) => Number(c[3]));
  const closes = candles.map((c) => Number(c[4]));
  if (Number.isFinite(overridePrice) && overridePrice > 0 && closes.length) {
    const lastIdx = closes.length - 1;
    closes[lastIdx] = overridePrice;
    if (overridePrice > highs[lastIdx]) highs[lastIdx] = overridePrice;
    if (overridePrice < lows[lastIdx]) lows[lastIdx] = overridePrice;
  }
  const rsiSeries = RSI.calculate({ values: closes, period: RSI_PERIOD });
  return {
    rsi: rsiSeries[rsiSeries.length - 1],
    rsiSeries,
    price: closes[closes.length - 1],
    opens,
    highs,
    lows,
    closes,
    times,
  };
}

function generateFallbackCandles(assetCfg) {
  const now = Math.floor(Date.now() / 300000) * 300000;
  const basePrice = assetCfg.fallbackPrice || 100;
  const vol = basePrice * 0.0025;
  const dec = assetCfg.decimals || 2;
  const out = [];
  let prevClose = basePrice;
  for (let i = 99; i >= 0; i--) {
    const t = now - i * 300000;
    const wave = Math.sin(i * 0.35) * vol + Math.cos(i * 0.19) * (vol * 0.6);
    const open = Number(prevClose.toFixed(dec));
    const close = Number((basePrice + wave).toFixed(dec));
    const high = Number((Math.max(open, close) + Math.abs(Math.sin(i)) * vol * 0.45).toFixed(dec));
    const low = Number((Math.min(open, close) - Math.abs(Math.cos(i)) * vol * 0.45).toFixed(dec));
    out.push([t, open, high, low, close]);
    prevClose = close;
  }
  return out;
}

async function fetchYahooCandles(yahooTicker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?interval=5m&range=2d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const j = await res.json();
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  const ts = (r && r.timestamp) || [];
  const q = (r && r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const closes = q.close || [];
  const opens = q.open || [];
  const highs = q.high || [];
  const lows = q.low || [];
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] !== null && closes[i] !== undefined && Number.isFinite(Number(closes[i]))) {
      const c = Number(closes[i]);
      const o = Number(opens[i] || c);
      const h = Number(highs[i] || Math.max(o, c));
      const l = Number(lows[i] || Math.min(o, c));
      candles.push([ts[i] * 1000, o, h, l, c]);
    }
  }
  if (candles.length < RSI_PERIOD + 5) throw new Error('Data candle Yahoo kurang');
  return candles.slice(-100);
}

async function getPublicAssetMarket(assetId, sandbox = false) {
  const a = getAssetCfg(assetId);
  const key = `pub:${sandbox ? 'test' : 'live'}:${a.id}`;
  const entry = marketCache.get(key) || { data: null, at: 0, p: null };
  if (entry.data && Date.now() - entry.at < MARKET_CACHE_TTL_MS) return entry.data;
  if (entry.p) return entry.p;

  entry.p = (async () => {
    if (a.spotSymbol) {
      try {
        const ex = sandbox && a.id !== 'XAUUSD' && a.id !== 'EURUSD' ? pubTestnet : pubLive;
        const candles = await ex.fetchOHLCV(a.spotSymbol, TIMEFRAME, undefined, 100);
        entry.data = computeMarketFromCandles(candles);
        entry.at = Date.now();
        return entry.data;
      } catch (e) {
        try {
          const candles = await pubLive.fetchOHLCV(a.spotSymbol, TIMEFRAME, undefined, 100);
          entry.data = computeMarketFromCandles(candles);
          entry.at = Date.now();
          return entry.data;
        } catch (err) {}
      }
    }
    if (a.yahoo) {
      try {
        const candles = await fetchYahooCandles(a.yahoo);
        entry.data = computeMarketFromCandles(candles);
        entry.at = Date.now();
        return entry.data;
      } catch (e) {}
    }
    const fallback = generateFallbackCandles(a);
    entry.data = computeMarketFromCandles(fallback);
    entry.data.simulated = true; // data cadangan buatan: jangan dipakai untuk alarm harga
    entry.at = Date.now();
    return entry.data;
  })().finally(() => {
    entry.p = null;
  });
  marketCache.set(key, entry);
  return entry.p;
}

async function getMarketForUser(u) {
  const info = getUserTradeInfo(u);
  if (!info.broker.isMt) {
    return getPublicAssetMarket(info.asset.id, info.broker.sandbox);
  }
  const ad = getAdapter(u);
  if (!ad) {
    return getPublicAssetMarket(info.asset.id, false);
  }
  const k = getActiveKeyObj(u);
  const cacheKey = `mt:${k && k.region ? k.region : 'sg'}:${info.symbol}:${TIMEFRAME}`;
  const entry = marketCache.get(cacheKey) || { data: null, at: 0, p: null };
  if (entry.data && Date.now() - entry.at < MARKET_CACHE_TTL_MS) return entry.data;
  if (entry.p) return entry.p;

  entry.p = (async () => {
    try {
      const candles = await ad.candles(info.symbol, TIMEFRAME, 100);
      entry.data = computeMarketFromCandles(candles);
      entry.at = Date.now();
      return entry.data;
    } catch (e) {
      const baseMkt = await getPublicAssetMarket(info.asset.id, false);
      let livePrice = baseMkt.price;
      try {
        const pr = await ad.price(info.symbol);
        livePrice = Number(pr.bid || pr.ask) || livePrice;
      } catch (err) {}
      const rawCandles = baseMkt.times.map((t, idx) => [
        t,
        baseMkt.opens[idx],
        baseMkt.highs[idx],
        baseMkt.lows[idx],
        baseMkt.closes[idx],
      ]);
      entry.data = computeMarketFromCandles(rawCandles, livePrice);
      if (baseMkt.simulated) entry.data.simulated = true;
      entry.at = Date.now();
      return entry.data;
    }
  })().finally(() => {
    entry.p = null;
  });
  marketCache.set(cacheKey, entry);
  return entry.p;
}

async function getBalance(u) {
  const ad = getAdapter(u);
  const info = getUserTradeInfo(u);
  if (!ad) return { usdt: 0, btc: 0, equity: 0, currency: info.quote, floatingPnl: null };
  const r = rt(u._id);
  const balKey = `${u.broker}:${u.asset}`;
  if (r.bal && r.balKey === balKey && Date.now() - r.balAt < 5000) return r.bal;
  const b = await ad.balance(info.symbol, info.base);
  r.bal = {
    usdt: Number(b.quote) || 0,
    btc: Number(b.base) || 0,
    equity: b.equity !== null && b.equity !== undefined ? Number(b.equity) : null,
    currency: b.currency || info.quote,
    server: b.server || '',
    floatingPnl: typeof b.floatingPnl === 'number' ? b.floatingPnl : null,
  };
  r.balKey = balKey;
  r.balAt = Date.now();
  return r.bal;
}

// ---------- Eksekusi BUY & SELL ----------
async function buy(u, note) {
  if (!isRentalActive(u)) {
    throw new Error('Masa sewa akun Anda sudah berakhir. Silakan perpanjang paket sewa di menu Login.');
  }
  const lim = getPlanLimits(u);
  if (lim.maxTradesPerDay > 0 && tradesToday(u) >= lim.maxTradesPerDay) {
    throw new Error(`Batas transaksi harian paket ${lim.label} tercapai (${lim.maxTradesPerDay}/hari, reset 00:00 UTC). Upgrade paket untuk menambah batas.`);
  }
  if (dailyLossHit(u)) {
    throw new Error(`Batas rugi harian tercapai (${u.settings.dailyLossLimit}). Trading dihentikan sampai 00:00 UTC.`);
  }
  const slots0 = Array.isArray(u.assetSlots) ? u.assetSlots : [];
  if (lim.maxAssets > 0 && !slots0.includes(u.asset) && slots0.length >= lim.maxAssets) {
    throw new Error(`Paket ${lim.label} hanya boleh ${lim.maxAssets} aset. Upgrade paket untuk menambah aset.`);
  }
  const info = getUserTradeInfo(u);
  if (!info.supportedOnBroker) {
    throw new Error(
      `Aset ${info.asset.name} (${info.asset.mtSymbol}) khusus untuk broker MetaTrader 4 / MetaTrader 5. Silakan ganti broker ke MT4/MT5.`
    );
  }
  const ad = requireAdapter(u);
  const amount = humanizeAmount(u, Number(u.settings.amount) || info.defaultAmount, info.minAmount);
  await humanPause(u);
  const order = await ad.marketBuy(info.symbol, amount, info.base, { humanize: humanizeOn(u) });
  const got = Number(order.filled) || amount;
  const m = await getMarketForUser(u);
  const price = Number(order.price) || m.price;
  const contractSize = Number(order.contractSize) || 1;
  const cost = Number(order.cost) || price * got * contractSize;

  const pos = u.position || {
    amount: 0,
    cost: 0,
    ids: [],
    broker: u.broker,
    asset: u.asset,
    symbol: info.symbol,
    contractSize,
  };
  pos.amount = Number((pos.amount + got).toFixed(6));
  pos.cost += cost;
  pos.contractSize = contractSize;
  pos.entry = pos.cost / (pos.amount * contractSize);
  pos.broker = u.broker;
  pos.asset = u.asset;
  pos.symbol = order.symbol || info.symbol;
  if (order.positionId) {
    pos.ids = [...new Set([...(pos.ids || []), String(order.positionId)])];
  }
  u.position = pos;
  ensureToday(u);
  u.today.trades++;
  rt(u._id).balAt = 0;
  saveUser(u);
  logTrade(u, 'BUY', price, got, 0, note);
  if (!Array.isArray(u.assetSlots)) u.assetSlots = [];
  if (!u.assetSlots.includes(u.asset)) u.assetSlots.push(u.asset);
  const dk = utcDayKey();
  if (u.tradeDay !== dk) { u.tradeDay = dk; u.tradeCount = 0; }
  u.tradeCount = (Number(u.tradeCount) || 0) + 1;
  saveUser(u);
  return { price, got, unit: info.unit, symbol: pos.symbol, decimals: info.decimals };
}

// ---------- Notifikasi close trade ke GRUP Telegram ----------
// Konfigurasi: env TRADE_GROUP_ID (+ opsional TRADE_GROUP_THREAD_ID untuk topik forum),
// atau admin ketik /setgroup di dalam grup (disimpan di database, menimpa env). /unsetgroup untuk mematikan.
const TRADE_GROUP_ID_ENV = String(process.env.TRADE_GROUP_ID || '').trim();
const TRADE_GROUP_THREAD_ENV = String(process.env.TRADE_GROUP_THREAD_ID || '').trim();
function tradeGroupCfg() {
  const c = rentalConfig.tradeGroup;
  if (c && c.chatId) return c.enabled === false ? null : c;
  if (TRADE_GROUP_ID_ENV) return { chatId: TRADE_GROUP_ID_ENV, threadId: TRADE_GROUP_THREAD_ENV, enabled: true, source: 'env' };
  return null;
}
// Label akun: TESTNET / DEMO (bukan uang asli) atau LIVE (akun real)
function accountLabel(u) {
  const cfg = BROKERS[u.broker] || BROKERS.binance_testnet;
  if (cfg.sandbox) return { tag: '🧪 TESTNET', desc: 'bukan uang asli', name: cfg.name };
  let server = '';
  try { const k = getActiveKeyObj(u); server = String((k && k.serverName) || ''); } catch (e) {}
  const name = cfg.name + (server ? ` · ${server}` : '');
  if (cfg.isMt && /demo|trial|test|practice|contest/i.test(server)) return { tag: '🧪 DEMO', desc: 'akun demo, bukan uang asli', name };
  return { tag: '🔴 LIVE', desc: 'akun real', name };
}
async function postTradeToGroup(u, d) {
  const g = tradeGroupCfg();
  if (!g) return;
  const { pos, price, qty, pnl, note, m, info } = d;
  if (!(pnl > 0)) return; // hanya trade PROFIT yang dikirim ke grup (loss / impas tidak diposting)
  const lab = accountLabel(u);
  const win = true;
  const entry = Number(pos.entry) || 0;
  const pct = entry > 0 ? ((price - entry) / entry) * 100 : 0;
  const q = info.quote || 'USDT';
  const dec = info.decimals || 2;
  const tag = `<a href="tg://user?id=${esc(u._id)}">${esc(u.name || 'User')}</a>` + (u.username ? ` (@${esc(u.username)})` : '');
  const decided = (u.wins || 0) + (u.losses || 0);
  const winRate = decided ? Math.round(((u.wins || 0) / decided) * 100) : 0;
  const caption =
    `✅ <b>TRADE DITUTUP · PROFIT</b>\n` +
    `👤 ${tag}\n` +
    `🏷 Akun: <b>${lab.tag}</b> (${esc(lab.desc)})\n` +
    `🏦 ${esc(lab.name)}\n\n` +
    `📊 <b>${esc(pos.symbol || info.symbol)}</b> · TF ${esc(TIMEFRAME)}\n` +
    `▸ Masuk: <b>${fmt(entry, dec)}</b>\n` +
    `▸ Keluar: <b>${fmt(price, dec)}</b>\n` +
    `▸ Jumlah: ${fmt(qty, 6)} ${esc(info.unit || '')}\n` +
    `💰 Hasil: <b>${sign(pnl, 4)} ${esc(q)}</b> (${sign(pct, 2)}%)\n` +
    (note ? `📝 ${esc(String(note).slice(0, 80))}\n` : '') +
    `\n📅 Hari ini: ${u.today ? u.today.trades : 0} trade · ${sign((u.today && u.today.pnl) || 0, 2)} ${esc(q)}\n` +
    `🎯 Win rate: ${winRate}% (${u.wins || 0}W / ${u.losses || 0}L)\n` +
    `⏰ ${new Date().toISOString().slice(0, 10)} ${utcTimeStr()}`;
  const opts = { parse_mode: 'HTML', disable_web_page_preview: true };
  if (g.threadId) opts.message_thread_id = Number(g.threadId);
  let png = null;
  try {
    const n = CHART_CANDLES;
    const closes = ((m && m.closes) || []).slice(-n);
    if (closes.length > 1) {
      png = renderPriceChartPng({
        symbol: pos.symbol || info.symbol,
        timeframe: TIMEFRAME.toUpperCase(),
        price,
        decimals: dec,
        serverUtc: utcTimeStr(),
        candles: { closes, labels: ((m && m.times) || []).slice(-n).map(utcHHMM) },
        closeLines: { entry, exit: price },
      });
    }
  } catch (e) {
    console.error('Chart grup:', e.message);
  }
  try {
    if (png) await bot.sendPhotoRaw(g.chatId, png, { ...opts, caption }, { filename: 'trade_close.png', contentType: 'image/png' });
    else await bot.sendRaw(g.chatId, caption, opts);
  } catch (e) {
    console.error('Kirim ke grup:', e.message);
    if (png) await bot.sendRaw(g.chatId, caption, opts).catch(() => {}); // cadangan: teks saja
  }
}

async function sellPosition(u, note) {
  const pos = u.position;
  if (!pos || pos.amount <= 0) return null;
  const info = getUserTradeInfo(u);
  const ad = requireAdapter(u);
  const sym = pos.symbol || info.symbol;
  await humanPause(u);
  const res = await ad.marketSell(sym, pos.amount, pos, info.base, { humanize: humanizeOn(u) });
  const m = await getMarketForUser(u);
  const price = Number(res.price) || m.price;
  const qty = Number(res.qty) || pos.amount;
  const pnl = Number.isFinite(res.pnl) ? Number(res.pnl) : (price - pos.entry) * qty * (pos.contractSize || 1);

  u.realizedPnl += pnl;
  if (pnl >= 0) { u.wins = (u.wins || 0) + 1; u.grossProfit = (u.grossProfit || 0) + pnl; }
  else { u.losses = (u.losses || 0) + 1; u.grossLoss = (u.grossLoss || 0) + pnl; }
  ensureToday(u);
  u.today.trades++;
  u.today.pnl += pnl;
  u.history[todayKey()] = (u.history[todayKey()] || 0) + pnl;
  const keys = Object.keys(u.history).sort();
  keys.slice(0, Math.max(0, keys.length - 30)).forEach((k) => delete u.history[k]);
  u.position = null;
  u.lastSellAt = Date.now();
  rt(u._id).balAt = 0;
  u.lossStreak = pnl < 0 ? (Number(u.lossStreak) || 0) + 1 : 0;
  const maxLS = Number(u.settings && u.settings.maxLossStreak) || 0;
  let paused = false;
  if (maxLS > 0 && u.isAutoTrade && u.lossStreak >= maxLS) {
    u.isAutoTrade = false;
    paused = true;
  }
  let dlPaused = false;
  if (u.isAutoTrade && dailyLossHit(u)) { u.isAutoTrade = false; dlPaused = true; }
  saveUser(u);
  logTrade(u, 'SELL', price, qty, pnl.toFixed(4), note);
  postTradeToGroup(u, { pos, price, qty, pnl, note, m, info }).catch((e) => console.error('Grup:', e.message)); // tidak menghambat proses close
  if (dlPaused) {
    logActivity('DAILY_LOSS_STOP', u._id, u.name, `Auto-Trade berhenti: rugi harian ${Number(u.today.pnl).toFixed(4)} melewati batas ${u.settings.dailyLossLimit}`);
    notify(
      u,
      `🛑 <b>BATAS RUGI HARIAN TERCAPAI</b>\n` +
        `Rugi hari ini: <b>${Number(u.today.pnl).toFixed(4)}</b> (batas ${u.settings.dailyLossLimit}).\n` +
        `Auto-Trade dihentikan sampai 00:00 UTC.`
    );
  }
  if (paused) {
    logActivity('AUTO_PAUSE', u._id, u.name, `Auto-Trade dijeda otomatis setelah ${u.lossStreak} loss beruntun`, { lossStreak: u.lossStreak });
    notify(
      u,
      `⏸ <b>AUTO-TRADE DIJEDA OTOMATIS</b>\n` +
        `Terjadi <b>${u.lossStreak}</b> loss beruntun (batas: ${maxLS}).\n` +
        `Tinjau pengaturan Anda, lalu aktifkan Auto-Trade lagi secara manual bila siap.`
    );
    u.lossStreak = 0;
    saveUser(u);
  }
  return { price, qty, pnl, unit: info.unit, quote: info.quote, symbol: sym, decimals: info.decimals };
}

// ---------- Aksi ----------
const SRC = { bot: 'via bot', app: 'via Mini App', auto: 'otomatis' };

const actionBuy = (u, src) =>
  withLock(u, async () => {
    const info = getUserTradeInfo(u);
    const r = await buy(u, `manual ${src}`);
    await notify(
      u,
      `▲ <b>BUY berhasil</b> (${SRC[src]} · ${info.broker.short})\n${esc(r.symbol)} (${esc(info.asset.name)})\n` +
        `▣ <code>${info.broker.isMt ? r.got.toFixed(2) : r.got.toFixed(4)}</code> ${info.unit} @ <code>${fmt(r.price, info.decimals)}</code>\n` +
        `◷ ${utcTimeStr()}`
    );
    return r;
  });

const actionSell = (u, src) =>
  withLock(u, async () => {
    const info = getUserTradeInfo(u);
    const r = await sellPosition(u, `manual ${src}`);
    if (r) {
      await notify(
        u,
        `▼ <b>SELL berhasil</b> (${SRC[src]} · ${info.broker.short})\n${esc(r.symbol)}\n` +
          `▣ <code>${info.broker.isMt ? Number(r.qty).toFixed(2) : r.qty}</code> ${info.unit} @ <code>${fmt(r.price, info.decimals)}</code>\n` +
          `${dot(r.pnl)} PnL: <b>${sign(r.pnl, 4)} ${info.quote}</b>\n` +
          `◷ ${utcTimeStr()}`
      );
    }
    return r;
  });

const actionPanic = (u) =>
  withLock(u, async () => {
    const wasAuto = !!u.isAutoTrade;
    u.isAutoTrade = false;
    rt(u._id).fails = 0;
    saveUser(u);
    let r = null;
    let err = null;
    if (u.position) {
      try {
        r = await sellPosition(u, 'DARURAT: tutup semua posisi');
      } catch (e) {
        err = e;
      }
    }
    logActivity('PANIC', u._id, u.name, `Tombol darurat: auto-trade dimatikan${r ? `, posisi ditutup (PnL ${Number(r.pnl).toFixed(4)})` : ''}`, { wasAuto, closed: !!r });
    if (err) {
      await notify(u, `🚨 <b>DARURAT</b>: Auto-Trade dimatikan, tetapi posisi GAGAL ditutup:\n<code>${esc(err.message)}</code>\nTutup manual di broker Anda.`);
      throw new Error(`Auto-Trade dimatikan, tetapi posisi gagal ditutup: ${err.message}`);
    }
    const info = getUserTradeInfo(u);
    await notify(
      u,
      `🚨 <b>TOMBOL DARURAT</b>\nAuto-Trade: <b>NONAKTIF</b>\n` +
        (r
          ? `Posisi ${esc(r.symbol)} ditutup @ <code>${fmt(r.price, info.decimals)}</code>\n${dot(r.pnl)} PnL: <b>${sign(r.pnl, 4)} ${info.quote}</b>`
          : `Tidak ada posisi terbuka.`) +
        `\n◷ ${utcTimeStr()}`
    );
    return { r, wasAuto };
  });

function setAuto(u, on, src) {
  if (on && !isRentalActive(u)) {
    throw fail('Masa sewa belum aktif. Silakan aktifkan paket sewa di menu Login terlebih dahulu.', 'NORENTAL');
  }
  const info = getUserTradeInfo(u);
  if (on && !hasBrokerKeys(u)) throw fail(`Hubungkan kredensial ${info.broker.name} dulu`, 'NOKEY');
  if (on && !info.supportedOnBroker) {
    throw fail(`Aset ${info.asset.name} hanya tersedia di broker MT4/MT5`, 'UNSUPPORTED');
  }
  u.isAutoTrade = !!on;
  if (!u.autoByBroker || typeof u.autoByBroker !== 'object') u.autoByBroker = {};
  u.autoByBroker[u.broker] = !!on;
  rt(u._id).fails = 0;
  saveUser(u);
  notify(
    u,
    `⏻ Auto-Trade <b>${esc(info.symbol)}</b> (${info.broker.short}) sekarang: <b>${u.isAutoTrade ? 'AKTIF ●' : 'NONAKTIF ○'}</b> (${SRC[src]})`
  );
}

function selectAsset(u, assetId) {
  const cleanId = String(assetId || '').trim().toUpperCase();
  if (!ASSETS[cleanId]) throw new Error('Pilihan aset trade tidak valid');
  if (u.position && u.asset !== cleanId) {
    throw new Error(`Tutup posisi aktif di ${u.position.symbol || u.asset} dulu sebelum mengganti aset trade`);
  }
  const lim = getPlanLimits(u);
  const slots = Array.isArray(u.assetSlots) ? u.assetSlots : [];
  if (lim.maxAssets > 0 && !slots.includes(cleanId) && slots.length >= lim.maxAssets) {
    throw new Error(`Paket ${lim.label} hanya boleh ${lim.maxAssets} aset (sudah dipakai: ${slots.join(', ')}). Upgrade paket untuk menambah aset.`);
  }
  const changed = u.asset !== cleanId;
  u.asset = cleanId;
  const info = getUserTradeInfo(u);
  u.mtSymbol = info.asset.mtSymbol;

  if (changed) {
    u.settings.amount = info.defaultAmount;
  } else if (u.settings.amount < info.minAmount || u.settings.amount > info.maxAmount) {
    u.settings.amount = info.defaultAmount;
  }

  if (!info.supportedOnBroker && u.isAutoTrade) {
    u.isAutoTrade = false;
  }

  const r = rt(u._id);
  r.bal = null;
  r.balAt = 0;
  saveUser(u);
  return info;
}

function selectBroker(u, brokerId, mtSymbolInput) {
  if (!BROKERS[brokerId]) throw new Error('Pilihan broker tidak valid');
  if (u.position && u.broker !== brokerId) {
    throw new Error(`Tutup posisi aktif di ${getBrokerCfg(u.broker).name} dulu sebelum mengganti broker`);
  }
  const prevBroker = u.broker;
  const prevIsMt = getBrokerCfg(prevBroker).isMt;
  // Ingat status Auto-Trade tiap broker agar ON/OFF ikut berpindah bersama broker (aman: Live tidak otomatis ON).
  if (!u.autoByBroker || typeof u.autoByBroker !== 'object') u.autoByBroker = {};
  u.autoByBroker[prevBroker] = !!u.isAutoTrade;
  u.broker = brokerId;
  const info = getUserTradeInfo(u);

  if (info.broker.isMt && mtSymbolInput) {
    const clean = String(mtSymbolInput).replace(/[^a-zA-Z0-9._#-]/g, '').toUpperCase();
    const matchedAsset = Object.values(ASSETS).find((a) => a.mtSymbol === clean || a.id === clean);
    if (matchedAsset) u.asset = matchedAsset.id;
    u.mtSymbol = clean || info.asset.mtSymbol;
  }

  const updatedInfo = getUserTradeInfo(u);
  if (prevIsMt !== updatedInfo.broker.isMt) {
    u.settings.amount = updatedInfo.defaultAmount;
  } else if (u.settings.amount < updatedInfo.minAmount || u.settings.amount > updatedInfo.maxAmount) {
    u.settings.amount = updatedInfo.defaultAmount;
  }

  // Auto-Trade broker tujuan = status terakhir broker itu sendiri (jika kredensial & aset didukung).
  u.isAutoTrade =
    !!u.autoByBroker[brokerId] && hasBrokerKeys(u, brokerId) && updatedInfo.supportedOnBroker && isRentalActive(u);
  u.autoByBroker[brokerId] = u.isAutoTrade;

  const r = rt(u._id);
  r.adapter = null;
  r.adapterKey = '';
  r.bal = null;
  r.balAt = 0;
  r.fails = 0;
  saveUser(u);
  return updatedInfo.broker;
}

function applySettings(u, input) {
  if (input.asset && ASSETS[String(input.asset).toUpperCase()]) {
    selectAsset(u, input.asset);
  }
  const info = getUserTradeInfo(u);
  const lim = {
    amount: [info.minAmount, info.maxAmount],
    tp: [0.1, 20],
    sl: [0.1, 20],
    rsiBuy: [5, 50],
    rsiSell: [50, 95],
    maxLossStreak: [0, 10],
    dailyLossLimit: [0, 1000000000],
    sessionStart: [0, 23],
    sessionEnd: [1, 24],
    breakEvenPct: [0, 20],
    trailAtr: [0, 10],
  };
  const out = { ...u.settings };
  for (const k of Object.keys(lim)) {
    if (input[k] === undefined || input[k] === '') continue;
    const v = Number(input[k]);
    if (!Number.isFinite(v) || v < lim[k][0] || v > lim[k][1]) {
      throw new Error(`Nilai "${k}" harus antara ${lim[k][0]} dan ${lim[k][1]}`);
    }
    out[k] = v;
  }
  if (Number(out.maxLossStreak) > 0 && ['starter', 'trader'].includes(getUserTier(u))) {
    throw new Error('Auto-pause setelah loss beruntun khusus paket Pro dan Elite. Upgrade paket untuk memakainya.');
  }
  if (input.sessionOn !== undefined && input.sessionOn !== '') {
    out.sessionOn = input.sessionOn === true || Number(input.sessionOn) === 1 ? 1 : 0;
  }
  if ((Number(out.dailyLossLimit) > 0 || Number(out.sessionOn) === 1) && !['pro', 'elite'].includes(getUserTier(u))) {
    throw new Error('Batas rugi harian dan jadwal jam trading khusus paket Pro dan Elite. Upgrade paket untuk memakainya.');
  }
  if (input.strategy !== undefined && input.strategy !== '') {
    const st = String(input.strategy);
    if (!STRATEGIES[st]) throw new Error('Strategi tidak dikenal');
    out.strategy = st;
  }
  if (input.humanize !== undefined && input.humanize !== '') {
    out.humanize = input.humanize === true || Number(input.humanize) === 1 ? 1 : 0;
  }
  if (input.trendFilter !== undefined && input.trendFilter !== '') {
    out.trendFilter = input.trendFilter === true || Number(input.trendFilter) === 1 ? 1 : 0;
  }
  if (out.strategy && out.strategy !== 'rsi' && !['pro', 'elite'].includes(getUserTier(u))) {
    throw new Error('Strategi ' + STRATEGIES[out.strategy] + ' khusus paket Pro dan Elite. Upgrade paket untuk memakainya.');
  }
  if (Number(out.trendFilter) === 1 && getUserTier(u) === 'starter') {
    throw new Error('Filter tren khusus paket Trader ke atas. Upgrade paket untuk memakainya.');
  }
  if (Number(out.breakEvenPct) > 0 && getUserTier(u) === 'starter') {
    throw new Error('Break-even otomatis khusus paket Trader ke atas. Upgrade paket untuk memakainya.');
  }
  if (Number(out.trailAtr) > 0 && ['starter', 'trader'].includes(getUserTier(u))) {
    throw new Error('Trailing stop ATR khusus paket Pro dan Elite. Upgrade paket untuk memakainya.');
  }
  if (out.rsiBuy >= out.rsiSell) throw new Error('RSI beli harus lebih kecil dari RSI jual');
  u.settings = out;
  saveUser(u);
  return out;
}

async function saveKeys(u, body = {}) {
  const targetBroker = BROKERS[body.broker] ? body.broker : u.broker;
  if (u.position && u.broker !== targetBroker) {
    throw new Error(`Jual posisi aktif di ${getBrokerCfg(u.broker).name} dulu sebelum pindah broker`);
  }
  if (body.asset && ASSETS[String(body.asset).toUpperCase()]) {
    selectAsset(u, body.asset);
  }
  const cfg = selectBroker(u, targetBroker, body.mtSymbol);

  if (cfg.isMt) {
    const token = String(body.token || body.apiKey || '').trim();
    const accountId = String(body.accountId || body.secret || '').trim();
    const region = String(body.region || 'singapore').trim().toLowerCase();

    if (token.length < 20 || accountId.length < 8 || accountId.length > 64) {
      throw new Error('Token MetaApi atau Account ID MT4/MT5 tidak valid');
    }

    let info;
    try {
      const probe = mt5Adapter.create({ token, id: accountId, region, kind: cfg.id });
      info = await probe.check();
    } catch (e) {
      throw new Error(`Gagal terhubung ke ${cfg.name} (MetaApi): ${e.message}`);
    }

    if (!u.brokerKeys) u.brokerKeys = {};
    u.brokerKeys[cfg.id] = {
      broker: cfg.id,
      token: enc(token),
      id: enc(accountId),
      region: info.region || region || 'singapore',
      mtSymbol: getUserTradeInfo(u).symbol,
      serverName: info.broker || info.server || cfg.name,
      currency: info.currency || 'USD',
    };
    const r = rt(u._id);
    r.adapter = null;
    r.adapterKey = '';
    r.balAt = 0;
    r.fails = 0;
    saveUser(u);
    notify(
      u,
      `⚿ <b>${cfg.name} terhubung</b> (${esc(info.broker || info.server || info.region)})\n` +
        `Aset aktif: <code>${esc(getUserTradeInfo(u).symbol)}</code> · Region: <code>${esc(info.region)}</code>`,
      true
    );
    return { broker: cfg.id, region: info.region };
  }

  const apiKey = String(body.apiKey || '').trim();
  const secret = String(body.secret || '').trim();
  if (apiKey.length < 20 || apiKey.length > 128 || secret.length < 20 || secret.length > 128) {
    throw new Error('Format API Key / Secret Key tidak valid');
  }
  try {
    await makeBinance({ apiKey, secret }, cfg.sandbox).fetchBalance();
  } catch (e) {
    throw new Error(
      cfg.sandbox
        ? 'API key ditolak Binance Testnet. Pastikan key dari testnet.binance.vision'
        : 'API key ditolak Binance Live. Pastikan izin Read & Spot Trading aktif di binance.com'
    );
  }
  if (!u.brokerKeys) u.brokerKeys = {};
  u.brokerKeys[cfg.id] = { broker: cfg.id, k: enc(apiKey), s: enc(secret) };
  const r = rt(u._id);
  r.adapter = null;
  r.adapterKey = '';
  r.balAt = 0;
  r.fails = 0;
  saveUser(u);
  notify(u, `⚿ <b>API key ${cfg.name} tersimpan</b> (terenkripsi AES-256-GCM).`, true);
  return { broker: cfg.id };
}

function removeKeys(u) {
  if (u.position) throw new Error('Jual posisi bot dulu sebelum menghapus kredensial broker');
  if (u.brokerKeys) delete u.brokerKeys[u.broker];
  u.keys = null;
  u.isAutoTrade = false;
  const r = rt(u._id);
  r.adapter = null;
  r.adapterKey = '';
  r.bal = null;
  saveUser(u);
  notify(u, `✕ Kredensial ${getBrokerCfg(u.broker).name} dihapus dan Auto-Trade dimatikan.`, true);
}

// ---------- Password Login Otomatis (dibuat setelah pembayaran, dihapus saat sewa habis kecuali di-Keep / diperpanjang) ----------
const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PW_GRACE_MS = 25 * 60 * 60 * 1000; // password dihapus 25 jam setelah peringatan (peringatan dikirim saat sewa habis)
function genAutoPassword(len = 10) {
  let out = '';
  for (let i = 0; i < len; i++) out += PW_ALPHABET[crypto.randomInt(PW_ALPHABET.length)];
  return out;
}
// Membuat password hanya bila user belum punya PIN. PIN buatan sendiri tidak pernah ditimpa / dihapus otomatis.
function ensureAutoPassword(u) {
  if (u.pinHash && u.pwAuto) {
    u.pwWarned = false; // diperpanjang: password lama tetap dipakai
    u.pwDeleteAt = 0;
    return { created: false };
  }
  if (u.pinHash) return { created: false, manual: true };
  const pw = genAutoPassword();
  u.pinHash = hashPin(pw, u._id);
  u.pwEnc = enc(pw);
  u.pwAuto = true;
  u.pwKeep = false;
  u.pwWarned = false;
  u.pwDeleteAt = 0;
  u.pwCreatedAt = Date.now();
  return { created: true, password: pw };
}
function revealAutoPassword(u) {
  if (!u.pwAuto || !u.pwEnc) return null;
  try { return dec(u.pwEnc); } catch (e) { return null; }
}
function pwKeepMarkup() {
  const rows = [[btn('lock', 'Keep Password', { callback_data: 'pw_keep' }, 'success')]];
  if (WEBAPP_URL) rows.push([btn('dash', 'Perpanjang Sewa', { web_app: { url: WEBAPP_URL } }, 'primary')]);
  return { inline_keyboard: rows };
}
async function sweepAutoPasswords() {
  const now = Date.now();
  for (const u of users.values()) {
    if (!u.pwAuto || !u.pinHash || isAdminId(u._id)) continue;
    if (isRentalActive(u)) continue; // sewa aktif: tidak ada yang dihapus
    if (u.pwKeep) continue; // di-Keep: dipertahankan
    if (!u.pwWarned) {
      // Sewa baru habis: kirim peringatan, password kedaluwarsa 25 jam kemudian
      u.pwWarned = true;
      u.pwDeleteAt = now + PW_GRACE_MS;
      saveUser(u);
      logActivity('PW_WARN', u._id, u.name, 'Peringatan password akan dihapus 25 jam lagi');
      bot.sendMessage(
        u._id,
        `⏳ <b>Sewa Anda sudah habis</b>\nPassword login otomatis akan <b>kedaluwarsa dan DIHAPUS</b> pada <code>${utcTimeStr(u.pwDeleteAt)}</code> (25 jam dari sekarang).\nTekan <b>Keep Password</b> untuk menyimpannya, atau perpanjang sewa di Dashboard.`,
        { parse_mode: 'HTML', reply_markup: pwKeepMarkup() }
      ).catch(() => {});
      continue;
    }
    if (now < Number(u.pwDeleteAt || 0)) continue;
    u.pinHash = null;
    u.pwEnc = null;
    u.pwAuto = false;
    u.pwWarned = false;
    u.pwDeleteAt = 0;
    saveUser(u);
    logActivity('PW_AUTO_DELETED', u._id, u.name, 'Password login otomatis kedaluwarsa dan dihapus');
    notify(u, `🗑 <b>Password login otomatis kedaluwarsa dan dihapus.</b>\nBeli/perpanjang paket sewa untuk mendapat password baru.`);
  }
}
setInterval(() => { sweepAutoPasswords().catch((e) => console.error('Sweep password:', e.message)); }, 60 * 1000).unref();

// ---------- Proses Sewa / Paket Langganan ----------
async function approveRentalOrder(orderId, adminUserId) {
  const ord = rentalOrders.get(String(orderId));
  if (!ord) throw new Error('Data pesanan sewa tidak ditemukan');
  if (ord.status === 'approved') return ord;

  const u = users.get(String(ord.userId));
  if (!u) throw new Error('User pemesan tidak ditemukan');

  const addMs = Math.max(1, Number(ord.durationHours) || 24) * 3600 * 1000;
  const baseTime = Math.max(Date.now(), Number(u.rentalExpiresAt) || 0);
  u.rentalExpiresAt = baseTime + addMs;
  u.rentalPlanName = ord.packageName || 'Paket Sewa';
  u.rentalTier = TIER_LIMITS[ord.tier] ? ord.tier : 'pro';
  u.assetSlots = [];
  u.purchasedAt = Date.now();
  u.purchaseCount = (u.purchaseCount || 0) + 1;
  const pwRes = ensureAutoPassword(u);
  saveUser(u);
  logActivity('RENTAL_APPROVED', u._id, u.name, `Sewa ${ord.packageName} (${ord.durationHours} jam · ${ord.price}) disetujui oleh ${adminUserId || 'SYSTEM'}`, { orderId: String(ord._id || orderId), price: ord.price });

  ord.status = 'approved';
  ord.approvedBy = String(adminUserId || 'SYSTEM');
  ord.approvedAt = Date.now();
  if (rentalsCol) {
    await rentalsCol.replaceOne({ _id: ord._id }, ord, { upsert: true }).catch(() => {});
  }

  notify(
    u,
    `✦ <b>PAKET SEWA AKTIF!</b>\n` +
      `━━━━━━━━━━━━━━\n` +
      `📦 Paket: <b>${esc(ord.packageName)}</b> (${ord.durationHours} Jam)\n` +
      `◷ Aktif s/d: <code>${utcTimeStr(u.rentalExpiresAt)}</code>\n\n` +
      (pwRes.created
        ? `🔑 <b>Password Login Anda:</b> <code>${esc(pwRes.password)}</code>\nSimpan baik-baik. Setelah sewa habis Anda dapat peringatan, lalu password dihapus 25 jam kemudian, kecuali Anda tekan Keep atau memperpanjang.\n\n`
        : u.pwAuto
          ? `🔑 Password login Anda tetap sama (bisa dilihat di Mini App > Login).\n\n`
          : '') +
      `Silakan Login di Mini App untuk menyambungkan Bot ke akun Trading Anda.`,
    false
  );
  if (pwRes.created && u.pwAuto) {
    bot.sendMessage(u._id, 'Ingin password tetap disimpan setelah sewa habis?', { reply_markup: pwKeepMarkup() }).catch(() => {});
  }
  return ord;
}

// ---------- Snapshot data ----------
async function snapshot(u) {
  const info = getUserTradeInfo(u);
  const { broker: cfg, asset: assetCfg, symbol: sym } = info;
  const hasKeys = hasBrokerKeys(u);
  const kObj = getActiveKeyObj(u);
  const rentalActive = isRentalActive(u);

  const m = await getMarketForUser(u);
  let bal = { usdt: 0, btc: 0, equity: null, currency: info.quote, server: '', floatingPnl: null };
  let keyError = null;
  if (hasKeys && !u.isSessionLocked && rentalActive) {
    try {
      bal = await getBalance(u);
    } catch (e) {
      keyError = `Gagal membaca akun ${cfg.short}: periksa koneksi/kredensial`;
    }
  }
  const { tp, sl } = u.settings;
  const pos = u.position;
  ensureToday(u);

  let position = null;
  if (pos) {
    const cSize = Number(pos.contractSize) || 1;
    const rawFloating =
      cfg.isMt && typeof bal.floatingPnl === 'number' && bal.btc > 0
        ? bal.floatingPnl
        : (m.price - pos.entry) * pos.amount * cSize;
    position = {
      amount: pos.amount,
      entry: pos.entry,
      floating: rawFloating,
      pct: ((m.price - pos.entry) / pos.entry) * 100,
      tp: pos.entry * (1 + tp / 100),
      sl: pos.entry * (1 - sl / 100),
      beArmed: !!pos.beArmed,
      trailArmed: !!pos.trailArmed,
      peak: Number.isFinite(pos.peak) ? pos.peak : null,
      unit: info.unit,
      symbol: pos.symbol || sym,
    };
  }

  const n = CHART_CANDLES;
  const history = Object.keys(u.history)
    .sort()
    .slice(-7)
    .map((d) => ({ date: d, pnl: u.history[d] }));

  const connectedBrokers = Object.keys(BROKERS).filter((id) => hasBrokerKeys(u, id));
  const totalVal = cfg.isMt
    ? bal.equity !== null
      ? bal.equity
      : bal.usdt + (position ? position.floating : 0)
    : bal.usdt + bal.btc * m.price;

  const analysis = buildMarketAnalysis(m, u, info);
  const myPendingOrders = [...rentalOrders.values()]
    .filter((o) => o.userId === u._id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5);

  return {
    userId: u._id,
    username: u.username || '',
    isAdmin: isAdminId(u._id),
    hasPin: !!u.pinHash,
    pwAuto: !!u.pwAuto,
    pwKeep: !!u.pwKeep,
    pwDeleteAt: Number(u.pwDeleteAt) || 0,
    isLoggedIn: !u.isSessionLocked && rentalActive && (hasKeys || !!u.lastLoginAt),
    isSessionLocked: !!u.isSessionLocked,
    liveBotStatus: u.liveBotStatus !== false,
    rentalActive,
    rentalExpiresAt: u.rentalExpiresAt || 0,
    rentalPlanName: u.rentalPlanName || '',
    lossStreak: Number(u.lossStreak) || 0,
    planTier: getUserTier(u),
    features: featuresFor(u),
    vip: isElite(u),
    alarms: isElite(u) ? (u.alarms || []).map((a) => ({ id: a.id, asset: a.asset, level: a.level, dir: a.dir, createdAt: a.createdAt })) : [],
    maxAlarms: MAX_ALARMS,
    planLimits: {
      label: getPlanLimits(u).label,
      maxAssets: getPlanLimits(u).maxAssets,
      maxTradesPerDay: getPlanLimits(u).maxTradesPerDay,
      assetsUsed: (u.assetSlots || []).length,
      tradesToday: tradesToday(u),
    },
    rentalConfig: {
      requireRental: rentalConfig.requireRental,
      autoApprove: rentalConfig.autoApprove,
      autoVerify: rentalConfig.autoVerify !== false,
      instructions: rentalConfig.instructions,
      packages: rentalConfig.packages,
      paymentMethods: (rentalConfig.paymentMethods || []).filter((m) => !m.disabled), // metode nonaktif tidak tampil ke user
    },
    myRentalOrders: myPendingOrders,
    broker: cfg.id,
    brokerName: cfg.name,
    brokerShort: cfg.short,
    authType: cfg.auth,
    isMt: cfg.isMt,
    asset: assetCfg.id,
    assetName: assetCfg.name,
    assetCategory: assetCfg.category,
    supportedOnBroker: info.supportedOnBroker,
    decimals: info.decimals,
    unit: info.unit,
    quote: bal.currency || info.quote,
    mtRegion: (kObj && kObj.region) || 'singapore',
    mtServer: bal.server || (kObj && kObj.serverName) || '',
    mtSymbol: assetCfg.mtSymbol,
    connectedBrokers,
    brokers: Object.values(BROKERS),
    assets: Object.values(ASSETS),
    symbol: sym,
    base: info.base,
    timeframe: TIMEFRAME,
    name: u.name,
    hasKeys,
    keyError,
    price: m.price,
    rsi: m.rsi,
    analysis,
    usdt: bal.usdt,
    btc: bal.btc,
    equity: bal.equity,
    total: totalVal,
    position,
    realizedPnl: u.realizedPnl,
    isAutoTrade: u.isAutoTrade,
    today: { trades: u.today.trades, pnl: u.today.pnl },
    settings: u.settings,
    history,
    candles: {
      labels: m.times.slice(-n).map(utcHHMM),
      times: m.times.slice(-n),
      opens: m.opens.slice(-n),
      highs: m.highs.slice(-n),
      lows: m.lows.slice(-n),
      closes: m.closes.slice(-n),
      rsi: m.rsiSeries.slice(-n),
    },
    busy: rt(u._id).busy,
    serverUtc: utcTimeStr(),
    updatedAt: Date.now(),
  };
}

// ---------- Format Status & Panel Gambar Grafik ke Bot Telegram (Poin 5) ----------
function statusText(u, s) {
  const pos = s.position;
  const dec = s.decimals || 2;
  const amtFmt = s.isMt ? Number(pos ? pos.amount : 0).toFixed(2) : Number(pos ? pos.amount : 0).toFixed(6);
  const posText = pos
    ? `▣ <code>${amtFmt}</code> ${s.unit} @ <code>${fmt(pos.entry, dec)}</code>\n` +
      `${dot(pos.floating)} Floating: <b>${sign(pos.floating)} ${s.quote}</b> (${sign(pos.pct)}%)`
    : '▢ Tidak ada posisi';
  const rsi = s.rsi;
  const an = s.analysis || {};
  const balLine = s.isMt
    ? `❖ <b>Akun</b>\n` +
      `$ Saldo: <code>${fmt(s.usdt)}</code>\n` +
      `◈ Lot: <code>${Number(s.btc || 0).toFixed(2)}</code>\n` +
      `Σ Total: <b>${fmt(s.total)} ${s.quote}</b>\n\n`
    : `❖ <b>Akun</b>\n` +
      `$ ${s.quote}: <code>${fmt(s.usdt)}</code>\n` +
      `◈ ${esc(s.base)}: <code>${Number(s.btc || 0).toFixed(6)}</code>\n` +
      `Σ Total: <b>${fmt(s.total)} ${s.quote}</b>\n\n`;

  const akun = s.hasKeys
    ? balLine +
      `⌖ <b>Posisi bot</b>\n${posText}\n\n` +
      `${dot(s.realizedPnl)} Profit tertutup: <b>${sign(s.realizedPnl)} ${s.quote}</b>\n` +
      `⏻ Auto-Trade: <b>${s.isAutoTrade ? 'ON ●' : 'OFF ○'}</b>\n`
    : `⚿ <i>Belum terhubung ke ${esc(s.brokerName)}. Buka Dashboard untuk Login &amp; menyambungkan broker.</i>\n`;

  return (
    `◈ <b>${esc(s.symbol)}</b> · ${esc(s.brokerShort)} ${tw()}\n` +
    (isElite(u) ? `✦ <b>VIP ELITE</b>\n` : '') +
    `━━━━━━━━━━━━━━\n` +
    `◆ Harga: <code>${fmt(s.price, dec)}</code>\n` +
    `∿ RSI(${RSI_PERIOD}): <code>${rsi ? rsi.toFixed(1) : '-'}</code> ${rsi ? rsiLabel(u, rsi) : ''}\n` +
    `${rsi ? `<code>${rsiBar(rsi)}</code>\n` : ''}` +
    `✦ Analisis: <b>${esc(an.signal || 'NETRAL')}</b> (${esc(an.trend || '-')})\n\n` +
    akun +
    `◷ ${utcTimeStr()}`
  );
}

function panelKeyboard(u, chartType = 'price') {
  const info = getUserTradeInfo(u);
  const rows = [];
  if (WEBAPP_URL) rows.push([btn('dash', 'Buka Dashboard', { web_app: { url: WEBAPP_URL } }, 'primary')]);
  if (hasBrokerKeys(u) && info.supportedOnBroker && isRentalActive(u)) {
    rows.push([
      btn('buy', `Buy ${u.settings.amount} ${info.unit}`, { callback_data: 'manual_buy' }, 'success'),
      btn('sell', 'Jual posisi', { callback_data: 'manual_sell' }, 'danger'),
    ]);
    rows.push([
      btn(
        'power',
        u.isAutoTrade ? 'Matikan Auto-Trade' : 'Nyalakan Auto-Trade',
        { callback_data: 'toggle_auto' },
        u.isAutoTrade ? 'danger' : 'success'
      ),
    ]);
  }
  rows.push([
    btn(
      'chart',
      chartType === 'profit' ? 'Grafik Harga' : 'Grafik Profit',
      { callback_data: chartType === 'profit' ? 'show_price_chart' : 'show_profit_chart' }
    ),
    btn('refresh', 'Refresh', { callback_data: 'refresh' }),
  ]);
  rows.push([
    btn('asset', `Aset: ${info.asset.id}`, { callback_data: 'cycle_asset' }),
    btn('broker', `Broker: ${info.broker.short}`, { callback_data: 'cycle_broker' }),
  ]);
  rows.push([
    btn(
      'live',
      `Live Chat: ${u.liveBotStatus !== false ? 'ON ●' : 'OFF ○'}`,
      { callback_data: 'toggle_live_bot' },
      u.liveBotStatus !== false ? 'success' : undefined
    ),
  ]);
  return { inline_keyboard: rows };
}

async function sendPanel(u, chartType = 'price', prefixCaption = '') {
  const s = await snapshot(u);
  const r = rt(u._id);
  const png = chartType === 'profit' ? renderProfitChartPng(s) : renderPriceChartPng(s);
  const caption = (prefixCaption ? `${prefixCaption}\n\n` : '') + statusText(u, s);
  const kb = panelKeyboard(u, chartType);

  try {
    const sent = await tgSafe(() =>
      bot.sendPhoto(
        u._id,
        png,
        { caption, parse_mode: 'HTML', reply_markup: kb },
        { filename: `${chartType}_chart.png`, contentType: 'image/png' }
      )
    );
    if (sent && sent.message_id) {
      if (r.panelMsgId && r.panelMsgId !== sent.message_id) {
        bot.deleteMessage(u._id, r.panelMsgId).catch(() => {});
      }
      r.panelMsgId = sent.message_id;
      r.panelChartType = chartType;
      r.lastPanelUpdateAt = Date.now();
    }
    return sent;
  } catch (err) {
    // Fallback ke pesan teks jika pengiriman foto gagal
    const sent = await tgSafe(() =>
      bot.sendMessage(u._id, caption, { parse_mode: 'HTML', reply_markup: kb })
    );
    if (sent && sent.message_id) {
      r.panelMsgId = sent.message_id;
      r.panelChartType = chartType;
      r.lastPanelUpdateAt = Date.now();
    }
    return sent;
  }
}

async function refreshPanel(u, message, forceChartType) {
  const r = rt(u._id);
  const msgId = (message && message.message_id) || r.panelMsgId;
  const chartType = forceChartType || r.panelChartType || 'price';
  r.panelChartType = chartType;

  if (!msgId) {
    return sendPanel(u, chartType);
  }

  try {
    const s = await snapshot(u);
    const caption = statusText(u, s);
    const kb = panelKeyboard(u, chartType);

    // Jika pesan memiliki foto, kirim ulang panel foto baru & hapus yang lama agar gambar chart ikut ter-update
    if (message && message.photo) {
      const png = chartType === 'profit' ? renderProfitChartPng(s) : renderPriceChartPng(s);
      const sent = await tgSafe(() =>
        bot.sendPhoto(
          u._id,
          png,
          { caption, parse_mode: 'HTML', reply_markup: kb, disable_notification: true },
          { filename: `${chartType}_chart.png`, contentType: 'image/png' }
        )
      );
      if (sent && sent.message_id) {
        bot.deleteMessage(u._id, msgId).catch(() => {});
        r.panelMsgId = sent.message_id;
        r.lastPanelUpdateAt = Date.now();
      }
      return;
    }

    // Update caption pesan foto secara live untuk refresh cepat tanpa kedip
    await tgSafe(() =>
      bot.editMessageCaption(caption, {
        chat_id: u._id,
        message_id: msgId,
        parse_mode: 'HTML',
        reply_markup: kb,
      })
    );
    r.lastPanelUpdateAt = Date.now();
  } catch (err) {
    if (/there is no caption/i.test(err.message)) {
      try {
        const s = await snapshot(u);
        await tgSafe(() =>
          bot.editMessageText(statusText(u, s), {
            chat_id: u._id,
            message_id: msgId,
            parse_mode: 'HTML',
            reply_markup: panelKeyboard(u, chartType),
          })
        );
        r.lastPanelUpdateAt = Date.now();
      } catch (e2) {}
    } else if (/message to edit not found/i.test(err.message)) {
      r.panelMsgId = null;
    } else if (!/not modified/i.test(err.message)) {
      console.error('Refresh panel:', err.message);
    }
  }
}

// ---------- Chat Customer Service (khusus pembeli, bukan uji coba) ----------
// Pesan dari Mini App diteruskan ke Admin lewat bot Telegram; Admin membalas dengan "Reply" pesan itu
// (atau /balas <id> <teks>). Balasan tampil di Mini App dan juga dikirim ke chat bot user.
const csChats = new Map();
const csHits = new Map();
setInterval(() => csHits.clear(), 60 * 1000).unref();
const CS_MAX_LEN = 1000;
const csAdminMsgs = new Map(); // `${adminId}:${message_id}` -> userId (pesan CS yang dikirim ke admin)
const csUserMsgs = new Set(); // `${userId}:${message_id}` (pesan CS yang dikirim ke user di bot)
function csRemember(map, key, val) {
  if (map instanceof Set) map.add(key); else map.set(key, val);
  if (map.size > 3000) { const k = map.keys().next().value; map.delete(k); }
}
function csAdd(userId, from, text) {
  const msg = { _id: crypto.randomBytes(6).toString('hex'), userId: String(userId), from, text: String(text).slice(0, CS_MAX_LEN), at: Date.now() };
  const arr = csChats.get(msg.userId) || [];
  arr.push(msg);
  if (arr.length > 200) arr.splice(0, arr.length - 200);
  csChats.set(msg.userId, arr);
  if (csCol) csCol.insertOne({ ...msg }).catch(() => {});
  return msg;
}
const csList = (u) => (csChats.get(String(u._id)) || []).slice(-100).map((m) => ({ id: m._id, from: m.from, text: m.text, at: m.at }));
function requireCs(u) {
  if (!hasFeature(u, 'cs')) {
    throw new Error('Chat Customer Service tidak tersedia untuk akun ini.');
  }
}
async function csFromUser(u, rawText) {
  requireCs(u);
  const text = String(rawText || '').trim();
  if (!text) throw new Error('Tulis pesan terlebih dahulu.');
  if (text.length > CS_MAX_LEN) throw new Error(`Pesan terlalu panjang (maks ${CS_MAX_LEN} karakter).`);
  const n = (csHits.get(u._id) || 0) + 1;
  csHits.set(u._id, n);
  if (n > 10) throw new Error('Terlalu banyak pesan, tunggu sebentar.');
  csAdd(u._id, 'user', text);
  logActivity('CS_MSG', u._id, u.name, 'Mengirim chat ke Customer Service');
  for (const admId of ADMIN_IDS) {
    bot
      .sendMessage(
        admId,
        `💬 <b>Chat Customer Service</b>\n` +
          `Dari: <b>${esc(u.name)}</b>${u.username ? ' (@' + esc(u.username) + ')' : ''}\n` +
          `ID: <code>${u._id}</code>\n` +
          `Paket: ${esc(u.rentalPlanName || '-')}\n\n<blockquote>${esc(text)}</blockquote>\n\n` +
          `↩︎ <i>Reply pesan ini untuk membalas, atau /balas ${u._id} teks</i>`,
        { parse_mode: 'HTML' }
      )
      .then((sent) => { if (sent && sent.message_id) csRemember(csAdminMsgs, `${admId}:${sent.message_id}`, String(u._id)); })
      .catch(() => {});
  }
}
async function csFromAdmin(adminId, targetId, rawText) {
  const text = String(rawText || '').trim().slice(0, CS_MAX_LEN);
  const t = users.get(String(targetId));
  if (!t) return bot.sendMessage(adminId, `✕ User ${esc(targetId)} tidak ditemukan.`, { parse_mode: 'HTML' });
  if (!text) return bot.sendMessage(adminId, '✕ Isi balasan kosong.');
  csAdd(t._id, 'cs', text);
  logActivity('CS_REPLY', t._id, t.name, `Dibalas CS oleh ${adminId}`);
  const sentToUser = await bot.sendMessage(t._id, `💬 <b>Customer Service:</b>\n<blockquote>${esc(text)}</blockquote>`, { parse_mode: 'HTML' }).catch(() => null);
  if (sentToUser && sentToUser.message_id) csRemember(csUserMsgs, `${t._id}:${sentToUser.message_id}`);
  return bot.sendMessage(adminId, `✓ Balasan terkirim ke <code>${t._id}</code> (${esc(t.name)}).`, { parse_mode: 'HTML' });
}

// Perintah /cs (user pembeli) dan /balas (admin), serta Reply admin pada pesan CS
bot.onText(/^\/cs(@\w+)?(?:\s+([\s\S]+))?$/, async (msg, m) => {
  if (msg.chat.type !== 'private') return;
  const u = await ensureUser(msg.from);
  if (!u) return;
  try {
    requireCs(u);
    if (!m[2]) {
      return bot.sendMessage(msg.chat.id, '💬 Kirim pesan ke Customer Service:\n<code>/cs tulis pesan Anda di sini</code>\nBalasan admin akan muncul di chat ini dan di Mini App > CS.', { parse_mode: 'HTML' });
    }
    await csFromUser(u, m[2]);
    return bot.sendMessage(msg.chat.id, '✓ Pesan terkirim ke Customer Service. Balasan akan muncul di sini.');
  } catch (e) {
    return bot.sendMessage(msg.chat.id, `✕ ${esc(e.message)}`, { parse_mode: 'HTML' });
  }
});
bot.onText(/^\/balas(@\w+)?\s+(\d+)\s+([\s\S]+)$/, async (msg, m) => {
  if (msg.chat.type !== 'private' || !isAdminId(msg.from.id)) return;
  await csFromAdmin(String(msg.from.id), m[2], m[3]);
});
// ---------- Admin: atur grup notifikasi close trade ----------
bot.onText(/^\/setgroup(@\w+)?(?:\s+(-?\d+))?(?:\s+(\d+))?\s*$/, async (msg, m) => {
  if (!isAdminId(msg.from.id)) return;
  const inGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  const chatId = inGroup ? String(msg.chat.id) : (m[2] || '');
  if (!chatId) return bot.sendRaw(msg.chat.id, 'Ketik <code>/setgroup</code> di dalam grup tujuan, atau kirim <code>/setgroup -100xxxxxxxxxx</code> di chat pribadi.', { parse_mode: 'HTML' });
  const threadId = inGroup ? (msg.is_topic_message && msg.message_thread_id ? String(msg.message_thread_id) : '') : (m[3] || '');
  rentalConfig.tradeGroup = { chatId, threadId, enabled: true, title: inGroup ? String(msg.chat.title || '') : '' };
  await saveRentalConfig();
  logActivity('ADMIN', String(msg.from.id), 'admin', `Grup notifikasi close trade diatur: ${chatId}${threadId ? ' topik ' + threadId : ''}`);
  await bot.sendRaw(msg.chat.id, `✅ Notifikasi close trade semua pengguna akan dikirim ke grup ini${threadId ? ' (topik ini)' : ''}.\nID: <code>${esc(chatId)}</code>\nPastikan bot sudah jadi anggota/admin grup. Matikan dengan /unsetgroup.`, { parse_mode: 'HTML' }).catch(() => {});
});
bot.onText(/^\/unsetgroup(@\w+)?\s*$/, async (msg) => {
  if (!isAdminId(msg.from.id)) return;
  rentalConfig.tradeGroup = { ...(rentalConfig.tradeGroup || {}), chatId: (rentalConfig.tradeGroup && rentalConfig.tradeGroup.chatId) || '', enabled: false };
  await saveRentalConfig();
  await bot.sendRaw(msg.chat.id, '⏹ Notifikasi close trade ke grup dimatikan.').catch(() => {});
});
bot.onText(/^\/groupstatus(@\w+)?\s*$/, async (msg) => {
  if (!isAdminId(msg.from.id)) return;
  const g = tradeGroupCfg();
  await bot.sendRaw(msg.chat.id, g ? `📣 Grup notifikasi AKTIF\nID: <code>${esc(g.chatId)}</code>${g.threadId ? '\nTopik: ' + esc(g.threadId) : ''}\nSumber: ${g.source === 'env' ? 'env TRADE_GROUP_ID' : '/setgroup'}` : '📣 Grup notifikasi belum diatur / nonaktif. Ketik /setgroup di grup tujuan.', { parse_mode: 'HTML' }).catch(() => {});
});

bot.on('message', async (msg) => {
  try {
    if (!msg || msg.chat.type !== 'private' || !msg.text || /^\//.test(msg.text) || !msg.reply_to_message) return;
    const rep = msg.reply_to_message;
    // A) Admin membalas pesan CS -> masuk ke Mini App user (+ chat bot user)
    if (isAdminId(msg.from.id)) {
      let target = csAdminMsgs.get(`${msg.chat.id}:${rep.message_id}`) || '';
      if (!target && rep.from && rep.from.is_bot) {
        // cadangan setelah server restart / pesan sudah diterjemahkan: ambil ID dari entity <code> atau angka panjang pertama
        const src = String(rep.text || '');
        const ents = Array.isArray(rep.entities) ? rep.entities : [];
        for (const e of ents) {
          if (e.type === 'code') {
            const v = src.substr(e.offset, e.length).trim();
            if (/^\d{5,15}$/.test(v) && users.get(v)) { target = v; break; }
          }
        }
        if (!target) {
          const m = src.match(/\d{6,15}/g) || [];
          target = m.find((v) => users.get(v) && !isAdminId(v)) || '';
        }
        if (target && !/Customer|Pelanggan|Service|CS|Chat/i.test(src) && !ents.some((e) => e.type === 'blockquote')) target = '';
      }
      if (!target) return;
      await csFromAdmin(String(msg.from.id), target, msg.text);
      return;
    }
    // B) User membalas pesan "Customer Service" di bot -> diteruskan ke admin + tampil di Mini App
    if (csUserMsgs.has(`${msg.chat.id}:${rep.message_id}`)) {
      const u = await ensureUser(msg.from);
      if (!u) return;
      try {
        await csFromUser(u, msg.text);
        await bot.sendMessage(msg.chat.id, '✓ Pesan terkirim ke Customer Service.');
      } catch (e) {
        await bot.sendMessage(msg.chat.id, `✕ ${esc(e.message)}`, { parse_mode: 'HTML' });
      }
    }
  } catch (e) {
    console.error('CS reply:', e.message);
  }
});

// ---------- Perintah & tombol Telegram ----------
bot.onText(/^\/(menu|start|status|broker|asset|profit)(@\w+)?/, async (msg) => {
  if (msg.chat.type !== 'private') return;
  const u = await ensureUser(msg.from);
  if (!u) return bot.sendMessage(msg.chat.id, '✕ Akses ditolak atau kuota pengguna penuh.');
  try {
    if (!hasBrokerKeys(u) && /^\/start/.test(msg.text)) {
      await bot.sendMessage(
        msg.chat.id,
        `✦ Halo <b>${esc(u.name)}</b> (ID: <code>${u._id}</code>)!\n\n` +
          `<b>AFEX TRADE BOT</b> — Multi-Broker &amp; Multi-Aset:\n` +
          `⚿ <b>Login &amp; Sewa Bot</b>: Pilih paket sewa &amp; login langsung di Dashboard untuk menyambungkan bot ke trade\n` +
          `◈ <b>Broker</b>: Binance Testnet, Binance Live, MT5, MT4\n` +
          `❖ <b>Aset</b>: BTC, ETH, BNB, SOL, XRP, Emas (XAUUSD), Perak, Minyak (USOIL/UKOIL), Gas Alam (XNGUSD), &amp; EURUSD\n` +
          `◷ <b>Waktu Server</b>: ${utcTimeStr()}`,
        { parse_mode: 'HTML' }
      );
    }
    const cType = /^\/profit/.test(msg.text) ? 'profit' : 'price';
    await sendPanel(u, cType);
  } catch (err) {
    notify(u, `⚠︎ Gagal ambil info: ${esc(err.message)}`);
  }
});

bot.on('callback_query', async (q) => {
  bot.answerCallbackQuery(q.id).catch(() => {});
  if (!q.message || q.message.chat.type !== 'private') return;
  const u = await ensureUser(q.from);
  if (!u) return;
  try {
    if (q.data === 'pw_keep') {
      if (!u.pwAuto) return notify(u, 'ℹ︎ Tidak ada password otomatis yang perlu disimpan.');
      u.pwKeep = true;
      saveUser(u);
      logActivity('PW_KEEP', u._id, u.name, 'Password otomatis ditahan (Keep) via bot');
      return notify(u, '✓ Password login Anda akan <b>disimpan</b> walau sewa habis. Bisa dibatalkan di Mini App > Login.');
    }
    if (q.data && q.data.startsWith('adm_acc_')) {
      if (!isAdminId(u._id)) return notify(u, '✕ Khusus Admin Owner.');
      const ordId = q.data.replace('adm_acc_', '');
      const ord = await approveRentalOrder(ordId, u._id);
      await bot.sendMessage(
        u._id,
        `✓ Sewa untuk user <code>${ord.userId}</code> (${esc(ord.packageName)}) berhasil di-ACC!`,
        { parse_mode: 'HTML' }
      );
      return;
    }
    if (q.data && q.data.startsWith('adm_rej_')) {
      if (!isAdminId(u._id)) return notify(u, '✕ Khusus Admin Owner.');
      const ordId = q.data.replace('adm_rej_', '');
      const ord = rentalOrders.get(ordId);
      if (ord) {
        ord.status = 'rejected';
        if (rentalsCol) await rentalsCol.replaceOne({ _id: ord._id }, ord, { upsert: true }).catch(() => {});
        const targetU = users.get(String(ord.userId));
        if (targetU) notify(targetU, `✕ Pengajuan sewa (${esc(ord.packageName)}) ditolak oleh Admin.`);
      }
      await bot.sendMessage(u._id, `✕ Pengajuan sewa ${ordId} ditolak.`);
      return;
    }
    if (q.data === 'show_profit_chart') {
      await refreshPanel(u, q.message, 'profit');
      return;
    }
    if (q.data === 'show_price_chart') {
      await refreshPanel(u, q.message, 'price');
      return;
    }
    if (q.data === 'toggle_live_bot') {
      u.liveBotStatus = u.liveBotStatus === false;
      saveUser(u);
      await refreshPanel(u, undefined, rt(u._id).panelChartType);
      return;
    }
    if (q.data === 'manual_buy') await actionBuy(u, 'bot');
    else if (q.data === 'manual_sell') {
      const r = await actionSell(u, 'bot');
      if (!r) await notify(u, '▢ Tidak ada posisi bot untuk dijual.');
    } else if (q.data === 'toggle_auto') {
      setAuto(u, !u.isAutoTrade, 'bot');
    } else if (q.data === 'cycle_broker') {
      const order = Object.keys(BROKERS).filter((id) => id === u.broker || hasBrokerKeys(u, id));
      if (order.length < 2) {
        return notify(u, 'ℹ︎ Belum ada broker lain yang terhubung. Hubungkan broker lain di Mini App (menu Home > Broker).');
      }
      const nextIdx = (order.indexOf(u.broker) + 1) % order.length;
      selectBroker(u, order[nextIdx]);
    } else if (q.data === 'cycle_asset') {
      const order = Object.keys(ASSETS);
      const nextIdx = (order.indexOf(u.asset) + 1) % order.length;
      selectAsset(u, order[nextIdx]);
    }
    await refreshPanel(u, q.message);
  } catch (err) {
    notify(u, err.code === 'BUSY' ? '◷ Sedang memproses, tunggu...' : `⚠︎ Gagal: ${esc(err.message)}`);
  }
});

// ---------- Web server + API Mini App ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));

if (ALLOWED_ORIGIN) {
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.set('Access-Control-Allow-Headers', 'Content-Type, x-init-data, x-session-token');
    res.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

app.get('/', (req, res) => res.send('AFEX Trade Bot Realtime UTC API'));
app.get('/health', (req, res) => res.send('ok'));

function verifyInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  const a = Buffer.from(calc);
  const b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
  try {
    return JSON.parse(params.get('user'));
  } catch (e) {
    return null;
  }
}

const hits = new Map();
setInterval(() => hits.clear(), 60 * 1000).unref();


// ---------- Auto cek TxHash / ID transaksi (on-chain, USDT/USDC) -> auto approve bila cocok ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function tronToHex20(addr) {
  let n = 0n;
  for (const ch of String(addr || '').trim()) {
    const i = B58.indexOf(ch);
    if (i < 0) return '';
    n = n * 58n + BigInt(i);
  }
  const hex = n.toString(16).padStart(50, '0'); // 1 byte prefix + 20 byte + 4 byte checksum = 25 byte
  return hex.slice(2, 42).toLowerCase();
}
const TRANSFER_SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const EVM_CHAINS = {
  bep20: { name: 'BSC (BEP20)', rpc: ['https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-rpc.publicnode.com'],
    tokens: { '0x55d398326f99059ff775485246999027b3197955': { sym: 'USDT', dec: 18 }, '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { sym: 'USDC', dec: 18 } } },
  erc20: { name: 'Ethereum (ERC20)', rpc: ['https://ethereum-rpc.publicnode.com', 'https://cloudflare-eth.com'],
    tokens: { '0xdac17f958d2ee523a2206206994597c13d831ec7': { sym: 'USDT', dec: 6 }, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { sym: 'USDC', dec: 6 } } },
  polygon: { name: 'Polygon', rpc: ['https://polygon-rpc.com', 'https://polygon-bor-rpc.publicnode.com'],
    tokens: { '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': { sym: 'USDT', dec: 6 }, '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': { sym: 'USDC', dec: 6 } } },
};
const TRON_USDT_HEX = tronToHex20('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
const CHAIN_LABELS = { trc20: 'TRON (TRC20)', ...Object.fromEntries(Object.entries(EVM_CHAINS).map(([k, v]) => [k, v.name])) };
const VERIFY_WINDOW_MS = 30 * 60 * 1000;
const vTimeout = (ms) => (AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

async function evmRpc(chain, method, params) {
  let last = null;
  for (const url of EVM_CHAINS[chain].rpc) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: vTimeout(8000) });
      const j = await r.json();
      if (j && !j.error) return j.result;
      last = new Error((j && j.error && j.error.message) || 'rpc error');
    } catch (e) { last = e; }
  }
  throw last || new Error('rpc gagal');
}
const decBig = (hex, dec) => Number(BigInt(hex || '0x0')) / Math.pow(10, dec);

// hasil: { status: 'ok' | 'notfound' | 'mismatch' | 'manual', reason, amount, symbol }
async function verifyTx(proof, method, expectUsd) {
  const chain = String((method && method.chain) || '').toLowerCase();
  const wallet = String((method && method.account) || '').trim();
  if (!chain || !CHAIN_LABELS[chain] || !wallet) return { status: 'manual', reason: 'Metode ini tidak dicek otomatis (bukan jaringan crypto yang didukung).' };
  if (!(expectUsd > 0)) return { status: 'manual', reason: 'Harga paket bukan USDT/USDC, tidak bisa dicek otomatis.' };
  const tol = 0.01;
  try {
    if (chain === 'trc20') {
      const m = String(proof).match(/\b[a-fA-F0-9]{64}\b/);
      if (!m) return { status: 'mismatch', reason: 'Format TxHash TRON tidak valid (harus 64 karakter hex).' };
      const to20 = tronToHex20(wallet);
      if (!to20) return { status: 'manual', reason: 'Alamat wallet admin tidak valid.' };
      const r = await fetch('https://api.trongrid.io/wallet/gettransactioninfobyid', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: m[0] }), signal: vTimeout(8000) });
      const j = await r.json();
      if (!j || !j.id) return { status: 'notfound', reason: 'Transaksi belum ditemukan di jaringan TRON.' };
      if (j.receipt && j.receipt.result && j.receipt.result !== 'SUCCESS') return { status: 'mismatch', reason: 'Transaksi TRON gagal (' + j.receipt.result + ').' };
      for (const lg of j.log || []) {
        const topics = (lg.topics || []).map((t) => String(t).toLowerCase().replace(/^0x/, ''));
        if (String(lg.address || '').toLowerCase().replace(/^41/, '') !== TRON_USDT_HEX && String(lg.address || '').toLowerCase() !== TRON_USDT_HEX) continue;
        if (topics.length < 3 || topics[0] !== TRANSFER_SIG.replace(/^0x/, '')) continue;
        if (topics[2].slice(-40) !== to20) continue;
        const amt = decBig('0x' + (lg.data || '0'), 6);
        if (amt + tol >= expectUsd) return { status: 'ok', amount: amt, symbol: 'USDT', reason: 'TRC20 USDT ' + amt + ' diterima.' };
        return { status: 'mismatch', reason: 'Nominal kurang: terkirim ' + amt + ' USDT, harga ' + expectUsd + '.' };
      }
      return { status: 'mismatch', reason: 'Tidak ada transfer USDT TRC20 ke wallet pembayaran pada transaksi ini.' };
    }
    const m = String(proof).match(/0x[a-fA-F0-9]{64}/);
    if (!m) return { status: 'mismatch', reason: 'Format TxHash tidak valid (harus 0x + 64 karakter hex).' };
    const rc = await evmRpc(chain, 'eth_getTransactionReceipt', [m[0]]);
    if (!rc) return { status: 'notfound', reason: 'Transaksi belum ditemukan / belum terkonfirmasi di ' + EVM_CHAINS[chain].name + '.' };
    if (rc.status !== '0x1') return { status: 'mismatch', reason: 'Transaksi gagal di jaringan.' };
    const head = Number(BigInt(await evmRpc(chain, 'eth_blockNumber', [])));
    if (head - Number(BigInt(rc.blockNumber)) < 1) return { status: 'notfound', reason: 'Menunggu konfirmasi blok.' };
    const wl = wallet.toLowerCase();
    for (const lg of rc.logs || []) {
      const tk = EVM_CHAINS[chain].tokens[String(lg.address || '').toLowerCase()];
      if (!tk || !lg.topics || lg.topics[0] !== TRANSFER_SIG || lg.topics.length < 3) continue;
      if ('0x' + String(lg.topics[2]).slice(-40).toLowerCase() !== wl) continue;
      const amt = decBig(lg.data, tk.dec);
      if (amt + tol >= expectUsd) return { status: 'ok', amount: amt, symbol: tk.sym, reason: tk.sym + ' ' + amt + ' diterima.' };
      return { status: 'mismatch', reason: 'Nominal kurang: terkirim ' + amt + ' ' + tk.sym + ', harga ' + expectUsd + '.' };
    }
    return { status: 'mismatch', reason: 'Tidak ada transfer USDT/USDC ke wallet pembayaran pada transaksi ini.' };
  } catch (e) {
    return { status: 'notfound', reason: 'Gagal menghubungi jaringan: ' + e.message };
  }
}
function txKeyOf(proof) {
  const m = String(proof || '').match(/0x[a-fA-F0-9]{64}|\b[a-fA-F0-9]{64}\b/);
  return m ? m[0].toLowerCase() : '';
}
const usdOfPrice = (p) => (/(usdt|usdc|usd|\$)/i.test(String(p || '')) ? parseFloat(String(p).replace(',', '.').replace(/[^0-9.]/g, '')) || 0 : 0);
// Cek ulang order yang masih menunggu (belum terdeteksi di jaringan) tiap menit sampai 30 menit
async function sweepVerifyOrders() {
  if (!rentalConfig.autoVerify) return;
  for (const ord of [...rentalOrders.values()]) {
    if (ord.status !== 'pending' || !ord.verifyUntil || ord.verifyUntil < Date.now() || ord.verifyDone) continue;
    const pm = (rentalConfig.paymentMethods || []).find((m) => m.id === ord.methodId) || (rentalConfig.paymentMethods || []).find((m) => m.name === ord.methodName);
    const res = await verifyTx(ord.txProof, pm, usdOfPrice(ord.price));
    ord.verifyNote = res.reason;
    if (res.status === 'ok') {
      ord.verifyDone = true;
      await approveRentalOrder(ord._id, 'AUTO-VERIFY').catch((e) => console.error('Auto verify approve:', e.message));
    } else if (res.status === 'mismatch' || res.status === 'manual') {
      ord.verifyDone = true;
      notifyAdminsVerify(ord, res.reason);
    }
  }
}
function notifyAdminsVerify(ord, reason) {
  for (const admId of ADMIN_IDS) {
    bot.sendMessage(admId, `⚠︎ <b>Cek otomatis TxHash belum lolos</b>\nOrder: <code>${esc(ord._id)}</code> · User <code>${esc(ord.userId)}</code>\nAlasan: ${esc(reason)}\nSilakan cek manual lewat Admin > Antrean Pembayaran.`, { parse_mode: 'HTML' }).catch(() => {});
  }
}
setInterval(() => { sweepVerifyOrders().catch((e) => console.error('Sweep verify:', e.message)); }, 60 * 1000).unref();


// ---------- Harga realtime semua aset (harga asli pasar; tanpa data buatan) ----------
const livePrices = new Map(); // assetId -> { price, prev, changePct, at, src }
let livePricesWantedAt = 0;
let livePricesBusy = false;
const BINANCE_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision', 'https://api1.binance.com'];
async function fetchBinance24h(symbols) {
  const q = encodeURIComponent(JSON.stringify(symbols));
  let last = null;
  for (const host of BINANCE_HOSTS) {
    try {
      const r = await fetch(`${host}/api/v3/ticker/24hr?symbols=${q}`, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { last = e; }
  }
  throw last || new Error('Binance gagal');
}
async function fetchYahooQuote(ticker) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('Yahoo HTTP ' + r.status);
  const j = await r.json();
  const meta = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
  const price = Number(meta && meta.regularMarketPrice);
  const prev = Number(meta && (meta.chartPreviousClose || meta.previousClose));
  if (!(price > 0)) throw new Error('Harga Yahoo kosong');
  return { price, prev: prev > 0 ? prev : 0, at: Number(meta.regularMarketTime) * 1000 || Date.now() };
}
const YAHOO_OVERRIDE = { XAUUSD: ['XAUUSD=X', 'GC=F'], XAGUSD: ['XAGUSD=X', 'SI=F'] };
function setLive(id, price, prev, src, at) {
  if (!(price > 0)) return;
  livePrices.set(id, { price, prev: prev > 0 ? prev : 0, changePct: prev > 0 ? ((price - prev) / prev) * 100 : 0, at: at || Date.now(), src });
}
let liveCycle = 0;
async function refreshLivePrices() {
  if (livePricesBusy) return;
  livePricesBusy = true;
  try {
    liveCycle++;
    const crypto = Object.values(ASSETS).filter((a) => a.category === 'crypto' && a.spotSymbol);
    let cryptoOk = new Set();
    try {
      const rows = await fetchBinance24h(crypto.map((a) => a.spotSymbol.replace('/', '')));
      for (const row of rows) {
        const a = crypto.find((x) => x.spotSymbol.replace('/', '') === row.symbol);
        if (a) { setLive(a.id, Number(row.lastPrice), Number(row.openPrice), 'binance'); cryptoOk.add(a.id); }
      }
    } catch (e) { /* jatuh ke Yahoo di bawah */ }
    // Komoditas/forex (dan crypto yang gagal) dari Yahoo, tiap ~9 detik agar tidak kena limit
    if (liveCycle % 3 === 1) {
      const todo = Object.values(ASSETS).filter((a) => !cryptoOk.has(a.id) && (a.yahoo || YAHOO_OVERRIDE[a.id]));
      await runPool(todo, 4, async (a) => {
        for (const tk of YAHOO_OVERRIDE[a.id] || [a.yahoo]) {
          try { const q = await fetchYahooQuote(tk); setLive(a.id, q.price, q.prev, 'yahoo', q.at); return; } catch (e) { /* coba berikutnya */ }
        }
      });
    }
  } finally {
    livePricesBusy = false;
  }
}
setInterval(() => {
  if (Date.now() - livePricesWantedAt < 120000) refreshLivePrices().catch(() => {});
}, 3000).unref();

app.get('/api/prices', async (req, res) => {
  try {
    const ip = clientIp(req);
    const k = 'pr:' + ip;
    hits.set(k, (hits.get(k) || 0) + 1);
    if (hits.get(k) > 90) return res.status(429).json({ ok: false, error: 'Terlalu sering' });
    const cold = Date.now() - livePricesWantedAt > 120000 || !livePrices.size;
    livePricesWantedAt = Date.now();
    if (cold) { liveCycle = 0; await refreshLivePrices().catch(() => {}); }
    const out = {};
    for (const a of Object.values(ASSETS)) {
      const p = livePrices.get(a.id);
      out[a.id] = p ? { price: p.price, changePct: p.changePct, at: p.at, src: p.src } : null;
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, now: Date.now(), prices: out });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});


// ---------- Deteksi bahasa dari lokasi IP (default Inggris bila negara tidak ada di menu bahasa) ----------
const COUNTRY_LANG = (() => {
  const m = {};
  const add = (lang, list) => list.split(' ').forEach((c) => { m[c] = lang; });
  add('id', 'ID');
  add('en', 'US GB AU CA NZ IE SG ZW');
  add('es', 'ES MX AR CO CL PE VE EC GT CU BO DO HN PY SV NI CR PA UY PR GQ');
  add('de', 'DE AT CH LI');
  add('fr', 'FR BE LU MC SN CI CM CD MG HT');
  add('tr', 'TR');
  add('uz', 'UZ');
  add('ru', 'RU BY KZ KG');
  add('vi', 'VN');
  add('tl', 'PH');
  add('th', 'TH');
  add('ms', 'MY BN');
  add('hi', 'IN');
  add('ur', 'PK');
  add('zh', 'CN TW HK MO');
  add('ko', 'KR');
  add('ja', 'JP');
  add('af', 'ZA NA');
  add('ar', 'SA AE EG IQ JO KW QA BH OM YE LB SY LY DZ MA TN SD PS MR');
  return m;
})();
const geoCache = new Map(); // ip -> { country, at }
async function countryOfIp(req) {
  const hdr = String(req.get('x-vercel-ip-country') || req.get('cf-ipcountry') || '').toUpperCase();
  if (/^[A-Z]{2}$/.test(hdr) && hdr !== 'XX') return hdr;
  const ip = clientIp(req);
  if (!ip || ip === 'unknown' || /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd)/i.test(ip)) return '';
  const c = geoCache.get(ip);
  if (c && Date.now() - c.at < 6 * 3600 * 1000) return c.country;
  let country = '';
  const tryUrl = async (url, pick) => {
    if (country) return;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return;
      const v = String(pick(await r.json()) || '').toUpperCase();
      if (/^[A-Z]{2}$/.test(v)) country = v;
    } catch (e) { /* coba sumber berikutnya */ }
  };
  await tryUrl(`https://api.country.is/${encodeURIComponent(ip)}`, (j) => j && j.country);
  await tryUrl(`https://ipwho.is/${encodeURIComponent(ip)}`, (j) => j && j.success !== false && j.country_code);
  await tryUrl(`https://ipapi.co/${encodeURIComponent(ip)}/country/`.replace(/\/country\/$/, '/json/'), (j) => j && j.country_code);
  if (geoCache.size > 5000) geoCache.clear();
  geoCache.set(ip, { country, at: Date.now() });
  return country;
}
app.get('/api/geo', async (req, res) => {
  try {
    const country = await countryOfIp(req);
    const lang = COUNTRY_LANG[country] || 'en';
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, country, lang });
  } catch (e) {
    return res.json({ ok: true, country: '', lang: 'en' });
  }
});

// ---------- Endpoint Publik: Paket Sewa & Pengajuan ----------
app.get('/api/rental/public-config', (req, res) => {
  res.json({
    ok: true,
    rentalConfig: {
      requireRental: rentalConfig.requireRental,
      autoApprove: rentalConfig.autoApprove,
      autoVerify: rentalConfig.autoVerify !== false,
      instructions: rentalConfig.instructions,
      packages: rentalConfig.packages,
      paymentMethods: (rentalConfig.paymentMethods || []).filter((m) => !m.disabled), // metode nonaktif tidak tampil ke user
    },
    serverUtc: utcTimeStr(),
  });
});

app.post('/api/rental/order', async (req, res) => {
  try {
    const body = req.body || {};
    const tgUser = verifyInitData(req.get('x-init-data'));
    const lockErr = tgUser || String(body.identifier || '').trim() ? checkIdentLock(tgUser, body.identifier) : null;
    if (lockErr) return res.status(403).json({ ok: false, error: lockErr });
    let u = null;
    if (tgUser) {
      u = await ensureUser(tgUser);
    } else {
      const ident = String(body.identifier || '').trim();
      u = findUserByIdentifier(ident);
      // Tanpa Telegram: hanya akun yang SUDAH ada & sudah punya PIN. Tidak boleh membuat akun / menimpa PIN orang lain.
      if (u && !u.pinHash) {
        return res.status(403).json({
          ok: false,
          error: 'Akun ini belum punya PIN. Login pertama wajib lewat tombol Dashboard di bot Telegram.',
        });
      }
    }
    if (!u) {
      return res.status(400).json({
        ok: false,
        error: 'Masukkan ID Telegram atau @username Anda terlebih dahulu (pastikan sudah klik /start di Bot).',
      });
    }

    const pkg = (rentalConfig.packages || []).find((p) => p.id === body.packageId) || rentalConfig.packages[0];
    if (!pkg) return res.status(400).json({ ok: false, error: 'Paket sewa tidak ditemukan' });

    if (pkg.trial) {
      return res.status(400).json({ ok: false, error: 'Paket uji coba gratis diklaim lewat tombol Klaim Uji Coba, bukan lewat pembayaran.' });
    }
    const activePms = (rentalConfig.paymentMethods || []).filter((m) => !m.disabled);
    const reqPm = (rentalConfig.paymentMethods || []).find((m) => m.id === body.methodId);
    if (reqPm && reqPm.disabled) {
      return res.status(400).json({ ok: false, error: 'Metode pembayaran ini sedang dinonaktifkan. Pilih metode lain.' });
    }
    const pm = reqPm || activePms[0] || { name: 'Transfer Manual' };
    const agreement = validateAgreement(body.agreement);
    const txProof = String(body.txProof || '').trim();
    if (txProof.length < 3) {
      return res.status(400).json({
        ok: false,
        error: 'Masukkan Bukti Pembayaran / TxHash / Nomor Referensi transaksi Anda.',
      });
    }

    const dupKey = txKeyOf(txProof);
    if (dupKey && [...rentalOrders.values()].some((o) => o.txKey === dupKey && o.status !== 'rejected')) {
      return res.status(400).json({ ok: false, error: 'TxHash / ID transaksi ini sudah pernah dipakai pada pengajuan lain.' });
    }
    const orderId = 'RNT' + Date.now().toString(36).toUpperCase();
    const ord = {
      _id: orderId,
      id: orderId,
      userId: u._id,
      userName: u.name,
      packageId: pkg.id,
      packageName: pkg.name,
      price: effectivePrice(pkg),
      originalPrice: String(pkg.price || ''),
      tier: inferTier(pkg),
      durationHours: Number(pkg.durationHours) || 24,
      methodName: pm.name,
      methodId: pm.id || '',
      txProof,
      txKey: txKeyOf(txProof),
      status: 'pending',
      createdAt: Date.now(),
      agreement: {
        ...agreement,
        acceptedAt: Date.now(),
        ip: clientIp(req),
        ua: String(req.get('user-agent') || '').slice(0, 160),
        telegramId: u._id,
      },
    };
    rentalOrders.set(orderId, ord);
    logActivity('RENTAL_ORDER', u._id, u.name, `Mengajukan sewa ${pkg.name} (${effectivePrice(pkg)}) via ${pm.name}`, { orderId });
    if (rentalsCol) {
      await rentalsCol.insertOne(ord).catch(() => {});
    }

    if (rentalConfig.autoApprove) {
      await approveRentalOrder(orderId, 'AUTO');
      return res.json({
        ok: true,
        autoApproved: true,
        message: `Paket ${pkg.name} berhasil diaktifkan! Sekarang Anda dapat langsung Login.`,
        // Password hanya dikirim balik bila identitas terbukti dari Telegram (bukan sekadar mengetik ID orang lain).
        ...(tgUser && u.pwAuto ? { password: revealAutoPassword(u) } : {}),
        data: await snapshot(u),
      });
    }

    let verifyNote = '';
    let verifyWaiting = false;
    if (rentalConfig.autoVerify !== false && pm.chain && pm.chain !== 'manual') {
      const vr = await verifyTx(txProof, pm, usdOfPrice(ord.price));
      verifyNote = vr.reason || '';
      if (vr.status === 'ok') {
        await approveRentalOrder(orderId, 'AUTO-VERIFY');
        return res.json({
          ok: true,
          autoApproved: true,
          message: `Pembayaran terverifikasi otomatis! Paket ${pkg.name} aktif. Silakan Login.`,
          ...(tgUser && u.pwAuto ? { password: revealAutoPassword(u) } : {}),
          data: await snapshot(u),
        });
      }
      if (vr.status === 'notfound') {
        verifyWaiting = true;
        ord.verifyUntil = Date.now() + VERIFY_WINDOW_MS;
      } else {
        ord.verifyDone = true;
      }
      ord.verifyNote = verifyNote;
      if (rentalsCol) await rentalsCol.replaceOne({ _id: ord._id }, ord, { upsert: true }).catch(() => {});
    }
    for (const admId of ADMIN_IDS) {
      bot
        .sendMessage(
          admId,
          `📦 <b>PENGAJUAN SEWA BARU</b> ${tw()}\n` +
            `━━━━━━━━━━━━━━\n` +
            `👤 User: <b>${esc(u.name)}</b> (<code>${u._id}</code>)\n` +
            `🏷 Paket: <b>${esc(pkg.name)}</b> (${pkg.durationHours} Jam · ${esc(effectivePrice(pkg))})\n` +
            `💳 Metode: ${esc(pm.name)}\n` +
            `🧾 Bukti/TxHash: <code>${esc(txProof)}</code>\n` +
            (verifyNote ? `🔎 Cek otomatis: ${esc(verifyNote)}\n` : '') +
            `◷ Waktu: ${utcTimeStr()}`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  btn('check', 'ACC / Aktifkan Sewa', { callback_data: `adm_acc_${orderId}` }, 'success'),
                  btn('cross', 'Tolak', { callback_data: `adm_rej_${orderId}` }, 'danger'),
                ],
              ],
            },
          }
        )
        .catch(() => {});
    }

    return res.json({
      ok: true,
      autoApproved: false,
      message: verifyWaiting
        ? 'Bukti terkirim. Transaksi belum terdeteksi di jaringan; sistem akan mengecek otomatis tiap menit (maks 30 menit) dan mengaktifkan paket jika cocok.'
        : 'Bukti pembayaran sewa terkirim! Menunggu verifikasi Admin.',
      data: await snapshot(u),
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message || 'Gagal mengirim pesanan sewa' });
  }
});


// ---------- Penjaga IP Uji Coba Gratis (1 IP = 1 uji coba) ----------
const ipGuard = {}; // ip -> { ip, status: 'used'|'blocked'|'whitelist', userId, name, note, at, users: [] }
function clientIp(req) {
  const raw = req.get('x-vercel-forwarded-for') || (req.get('x-forwarded-for') || '').split(',')[0] || req.ip || '';
  return String(raw).trim().replace(/^::ffff:/, '').slice(0, 64) || 'unknown';
}
async function saveIpGuard() {
  if (!configCol) return;
  await configCol.replaceOne({ _id: 'ip_guard' }, { _id: 'ip_guard', entries: ipGuard }, { upsert: true }).catch(() => {});
}

app.post('/api/rental/trial', async (req, res) => {
  try {
    const tgUser = verifyInitData(req.get('x-init-data'));
    if (!tgUser) {
      return res.status(403).json({ ok: false, error: 'Uji coba gratis hanya bisa diklaim dari Mini App lewat tombol Dashboard di bot Telegram.' });
    }
    const u = await ensureUser(tgUser);
    const pkg = (rentalConfig.packages || []).find((p) => p.trial);
    if (!pkg) return res.status(400).json({ ok: false, error: 'Paket uji coba belum tersedia.' });
    const ip = clientIp(req);
    const ent = ipGuard[ip];
    if (ent && ent.status === 'blocked') {
      return res.status(403).json({ ok: false, error: 'IP Anda diblokir karena terdeteksi memakai uji coba lebih dari satu akun. Hubungi admin.' });
    }
    if (u.trialUsed) {
      // Penolakan dikirim ke chat bot dalam bahasa Inggris (tanpa terjemahan otomatis)
      if (Date.now() - (trialRefuseAt.get(String(u._id)) || 0) > 60000) {
        trialRefuseAt.set(String(u._id), Date.now());
        bot.sendRaw(
        u._id,
        '⛔ You have already received the free trial.\nYou cannot claim it again. Please use another package.',
        WEBAPP_URL ? { reply_markup: { inline_keyboard: [[{ text: 'Choose a package', web_app: { url: WEBAPP_URL } }]] } } : undefined
        ).catch(() => {});
      }
      logActivity('TRIAL_REFUSED', u._id, u.name, 'Klaim uji coba ditolak: ID sudah pernah klaim');
      return res.status(400).json({ ok: false, error: 'Anda sudah menerima uji coba. Silakan gunakan paket lain.' });
    }
    // Pastikan bot bisa mengirim pesan ke user (password dikirim lewat chat bot) sebelum uji coba dipakai
    try {
      await bot.sendChatAction(u._id, 'typing');
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'Bot tidak bisa mengirim pesan ke Anda. Buka chat bot lalu tekan /start, kemudian coba lagi.' });
    }
    // Cek ulang setelah await: dua klik/permintaan bersamaan tidak boleh sama-sama lolos
    if (u.trialUsed) {
      return res.status(400).json({ ok: false, error: 'Anda sudah menerima uji coba. Silakan gunakan paket lain.' });
    }
    if ((!ent || ent.status !== 'whitelist') && ent && ent.status === 'used' && String(ent.userId) !== String(u._id)) {
      ent.status = 'blocked';
      ent.note = `IP dipakai 2 akun: ${ent.name || ent.userId} (${ent.userId}) lalu ${u.name} (${u._id})`;
      ent.at = Date.now();
      ent.users = [...new Set([...(ent.users || []), String(u._id)])];
      await saveIpGuard();
      logActivity('IP_BLOCKED', u._id, u.name, ent.note, { ip });
      for (const admId of ADMIN_IDS) {
        bot.sendMessage(admId, `🚫 <b>IP DIBLOKIR (uji coba ganda)</b>\nIP: <code>${esc(ip)}</code>\n${esc(ent.note)}\nBuka blokir / whitelist lewat panel Admin.`, { parse_mode: 'HTML' }).catch(() => {});
      }
      return res.status(403).json({ ok: false, error: 'IP ini sudah dipakai untuk uji coba akun lain. IP diblokir dan dicatat ke admin.' });
    }
    const addMs = Math.max(1, Number(pkg.durationHours) || 24) * 3600 * 1000;
    u.rentalExpiresAt = Math.max(Date.now(), Number(u.rentalExpiresAt) || 0) + addMs;
    u.rentalPlanName = pkg.name;
    u.rentalTier = 'starter';
    u.assetSlots = [];
    u.trialUsed = true;
    const pwRes = ensureAutoPassword(u); // password acak (hanya bila user belum punya PIN)
    saveUser(u);
    const prev = ent || {};
    ipGuard[ip] = { ...prev, ip, status: prev.status === 'whitelist' ? 'whitelist' : 'used', userId: String(u._id), name: u.name, at: Date.now(), users: [...new Set([...(prev.users || []), String(u._id)])] };
    await saveIpGuard();
    logActivity('TRIAL_CLAIMED', u._id, u.name, `Uji coba 1 hari dari IP ${ip}`, { ip });
    // Password acak dikirim ke chat bot milik ID Telegram yang mengklaim (tidak dikembalikan lewat API)
    const trialMsg =
      `🎁 <b>Uji coba gratis 1 hari aktif</b>\nBerlaku sampai <code>${utcTimeStr(u.rentalExpiresAt)}</code>.\n\n` +
      (pwRes.created
        ? `🔑 <b>Password Login Anda:</b> <code>${esc(pwRes.password)}</code>\nGunakan ID Telegram Anda dan password ini di menu Login Mini App.`
        : `🔑 Gunakan password login Anda yang sudah ada di menu Login Mini App.`);
    bot.sendMessage(u._id, trialMsg, { parse_mode: 'HTML' }).catch(() => {});
    return res.json({ ok: true, message: 'Uji coba gratis aktif! Password login dikirim ke chat bot Telegram Anda.', data: await snapshot(u) });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message || 'Gagal klaim uji coba' });
  }
});

// ---------- Proxy terjemahan Mini App (semua bahasa jalan walau HP tidak bisa akses Google langsung) ----------
app.post('/api/i18n', async (req, res) => {
  try {
    const ip = clientIp(req);
    const n = (trHits.get(ip) || 0) + 1;
    trHits.set(ip, n);
    if (n > 400) return res.status(429).json({ ok: false, error: 'rate' });
    const tl = TR_LANGS[String((req.body || {}).lang || '')];
    const texts = Array.isArray((req.body || {}).texts) ? req.body.texts.slice(0, 40) : [];
    if (!tl || !texts.length) return res.status(400).json({ ok: false });
    const out = new Array(texts.length).fill('');
    await runPool(texts.map((t, i) => ({ t, i })), 8, async ({ t, i }) => {
      out[i] = await translateText(String(t || ''), tl);
    });
    return res.json({ ok: true, texts: out });
  } catch (e) {
    return res.status(400).json({ ok: false });
  }
});

// ---------- Login User Langsung Tanpa OTP + Cek Paket Sewa + Sambungkan Trade ----------
app.post('/api/auth/login', async (req, res) => {
  try {
    const body = req.body || {};
    const tgUser = verifyInitData(req.get('x-init-data'));
    const lockErr = checkIdentLock(tgUser, body.identifier);
    if (lockErr) return res.status(403).json({ ok: false, error: lockErr });
    let u = null;
    if (tgUser) {
      u = await ensureUser(tgUser);
    } else {
      const ident = String(body.identifier || '').trim();
      // Login manual (tanpa Telegram): hanya untuk akun yang SUDAH ada. Tidak membuat akun baru dari ID sembarang.
      u = findUserByIdentifier(ident);
    }
    if (!u) {
      return res.status(404).json({
        ok: false,
        error: 'Akun tidak ditemukan. Masukkan ID Telegram Anda (pastikan sudah menekan /start di Bot).',
      });
    }

    if (!isRentalActive(u)) {
      return res.status(402).json({
        ok: false,
        needRental: true,
        error: 'Masa sewa belum aktif. Silakan beli/aktifkan Paket Sewa terlebih dahulu pada menu di bawah.',
        data: await snapshot(u),
      });
    }

    const pin = String(body.pin || '').trim();
    if (tgUser) {
      // Identitas sudah terbukti dari Telegram (tanda tangan initData): PIN tidak wajib.
      if (!u.pinHash && pin && pin.length >= 4) u.pinHash = hashPin(pin, u._id);
    } else {
      // Tanpa Telegram, PIN wajib. Akun tanpa PIN tidak bisa dimasuki lewat ID (cegah pengambilalihan akun).
      if (!u.pinHash) {
        return res.status(403).json({
          ok: false,
          error: 'Akun ini belum punya PIN. Buka Mini App lewat tombol Dashboard di bot Telegram agar ID terbaca otomatis.',
        });
      }
      if (!pin || hashPin(pin, u._id) !== u.pinHash) {
        return res.status(401).json({ ok: false, error: 'Password / PIN Login tidak sesuai' });
      }
    }

    const hasNewCreds = (body.apiKey && body.secret) || (body.token && body.accountId);
    if (hasNewCreds) {
      await saveKeys(u, body);
    } else {
      if (body.broker && BROKERS[body.broker]) selectBroker(u, body.broker);
      if (body.asset && ASSETS[String(body.asset).toUpperCase()]) selectAsset(u, body.asset);
    }

    touchLang(u, req);
    u.isSessionLocked = false;
    u.lastLoginAt = Date.now();
    logActivity('LOGIN', u._id, u.name, 'Login Mini App');
    saveUser(u);

    const info = getUserTradeInfo(u);
    const sessionToken = makeSessionToken(u._id);
    // Langsung kirim panel status bergambar ke chat bot saat berhasil login
    sendPanel(u, 'price', '✦ <b>Login &amp; Sinkronisasi Bot Berhasil</b>').catch(() => {});

    return res.json({
      ok: true,
      sessionToken,
      message: `Login Berhasil & Bot terhubung ke ${info.broker.name} (${info.symbol})!`,
      data: await snapshot(u),
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message || 'Gagal memproses login' });
  }
});

// Middleware Autentikasi API
app.use('/api', async (req, res, next) => {
  let u = null;
  const tgUser = verifyInitData(req.get('x-init-data'));
  if (tgUser) {
    u = await ensureUser(tgUser);
  } else {
    const uid = verifySessionToken(req.get('x-session-token'));
    if (uid && users.has(String(uid))) {
      u = users.get(String(uid));
    }
  }
  if (!u) {
    return res.status(401).json({
      ok: false,
      needLogin: true,
      error: 'Silakan Login terlebih dahulu untuk menyambungkan Bot ke Trade.',
    });
  }
  const n = (hits.get(u._id) || 0) + 1;
  hits.set(u._id, n);
  if (n > 180) return res.status(429).json({ ok: false, error: 'Terlalu banyak permintaan, tunggu sebentar' });
  touchLang(u, req);
  req.user = u;
  next();
});

const h = (fn, allowWhenLocked = false) => async (req, res) => {
  try {
    // Catat saat user membuka Mini App (maks. sekali per 6 jam)
    if (req.user && Date.now() - (req.user.lastSeenAt || 0) > 6 * 3600 * 1000) {
      req.user.lastSeenAt = Date.now();
      logActivity('OPEN', req.user._id, req.user.name, 'Membuka Mini App');
    }
    if (!allowWhenLocked && (req.user.isSessionLocked || !isRentalActive(req.user))) {
      return res.status(401).json({
        ok: false,
        needLogin: true,
        needRental: !isRentalActive(req.user),
        error: !isRentalActive(req.user)
          ? 'Masa sewa Anda sudah berakhir. Silakan pilih Paket Sewa di menu Login.'
          : 'Sesi terkunci. Silakan Login kembali untuk melanjutkan trading.',
      });
    }
    res.json({ ok: true, ...(await fn(req.user, req)) });
  } catch (e) {
    res.status(e.code === 'BUSY' ? 409 : 400).json({ ok: false, error: e.message });
  }
};

app.get('/api/status', h(async (u) => ({ data: await snapshot(u) }), true));

app.get('/api/cs/messages', h(async (u) => { requireCs(u); return { messages: csList(u) }; }, true));
app.post('/api/cs/send', h(async (u, req) => {
  await csFromUser(u, req.body && req.body.text);
  return { message: 'Pesan terkirim ke Customer Service', messages: csList(u) };
}, true));

// Password otomatis: lihat & Keep. Hanya pemilik akun (Telegram initData / sesi login).
app.post(
  '/api/pw/reveal',
  h(async (u) => {
    const pw = revealAutoPassword(u);
    if (!pw) throw new Error('Tidak ada password otomatis aktif untuk akun ini.');
    logActivity('PW_REVEAL', u._id, u.name, 'Melihat password otomatis');
    return { password: pw };
  }, true)
);
app.post(
  '/api/pw/keep',
  h(async (u, req) => {
    if (!u.pwAuto) throw new Error('Tidak ada password otomatis untuk disimpan.');
    u.pwKeep = !!(req.body && req.body.keep);
    if (!u.pwKeep && !isRentalActive(u)) { u.pwWarned = true; u.pwDeleteAt = Date.now() + PW_GRACE_MS; }
    saveUser(u);
    logActivity(u.pwKeep ? 'PW_KEEP' : 'PW_UNKEEP', u._id, u.name, u.pwKeep ? 'Password otomatis ditahan (Keep)' : 'Keep password dibatalkan');
    return {
      message: u.pwKeep ? 'Password disimpan: tidak dihapus walau sewa habis.' : 'Keep dibatalkan: password dihapus otomatis saat sewa habis.',
      data: await snapshot(u),
    };
  }, true)
);

app.post(
  '/api/auth/logout',
  h(
    async (u) => {
      u.isSessionLocked = true;
      saveUser(u);
      return { message: 'Sesi Anda berhasil dikunci (Logout)' };
    },
    true
  )
);

// ---------- Endpoint Khusus Admin (Hanya ID 7706512451 & 8821716544) ----------
function requireAdmin(u) {
  if (!isAdminId(u._id)) {
    throw fail('Akses ditolak: Menu ini khusus untuk Owner Admin (7706512451 / 8821716544).', 'FORBIDDEN');
  }
}

app.post(
  '/api/admin/verify-pin',
  h(
    async (u, req) => {
      requireAdmin(u);
      const pinVal = String((req.body && req.body.pin) || '').trim();
      const kind = req.body && req.body.kind === 'fallback' ? 'fallback' : 'main';
      const rec = adminPinFails.get(String(u._id)) || { n: 0, until: 0 };
      if (Date.now() < rec.until) {
        throw new Error('Terlalu banyak salah. Coba lagi dalam ' + Math.ceil((rec.until - Date.now()) / 1000) + ' detik');
      }
      if (!pinVal || !adminPinMatches(kind, pinVal)) {
        rec.n += 1;
        if (rec.n >= 5) { rec.n = 0; rec.until = Date.now() + 60000; }
        adminPinFails.set(String(u._id), rec);
        logActivity('ADMIN_PIN_FAIL', u._id, u.name, `PIN ${kind === 'fallback' ? 'cadangan' : 'utama'} salah`);
        throw new Error(kind === 'fallback' ? 'PIN cadangan tidak sesuai' : 'PIN Eksekutif Admin tidak sesuai');
      }
      adminPinFails.delete(String(u._id));
      logActivity('ADMIN_PIN_OK', u._id, u.name, `PIN ${kind === 'fallback' ? 'cadangan' : 'utama'} benar`);
      return { message: 'PIN Admin Terverifikasi' };
    },
    true
  )
);

app.post(
  '/api/admin/change-pin',
  h(
    async (u, req) => {
      requireAdmin(u);
      const b = req.body || {};
      const kind = b.kind === 'fallback' ? 'fallback' : 'main';
      const cur = String(b.current || '').trim();
      const next = String(b.next || '').trim();
      const lockKey = 'chg:' + String(u._id);
      const rec = adminPinFails.get(lockKey) || { n: 0, until: 0 };
      if (Date.now() < rec.until) throw new Error('Terlalu banyak salah. Coba lagi dalam ' + Math.ceil((rec.until - Date.now()) / 1000) + ' detik');
      // Wajib memasukkan PIN utama yang berlaku sekarang
      if (!cur || !adminPinMatches('main', cur)) {
        rec.n += 1;
        if (rec.n >= 5) { rec.n = 0; rec.until = Date.now() + 5 * 60000; }
        adminPinFails.set(lockKey, rec);
        logActivity('ADMIN_PIN_CHANGE_FAIL', u._id, u.name, 'Ganti PIN gagal: PIN saat ini salah');
        throw new Error('PIN utama saat ini tidak sesuai');
      }
      adminPinFails.delete(lockKey);
      if (!/^\d{6,8}$/.test(next)) throw new Error('PIN baru harus 6 sampai 8 angka.');
      if (next !== String(b.confirm || '').trim()) throw new Error('Ulangi PIN baru tidak sama.');
      if (weakPin(next)) throw new Error('PIN terlalu mudah ditebak (angka sama / berurutan). Pilih PIN lain.');
      if (adminPinMatches('main', next) || adminPinMatches('fallback', next)) throw new Error('PIN baru tidak boleh sama dengan PIN utama atau cadangan yang berlaku.');
      rentalConfig.adminPin = { ...(rentalConfig.adminPin || {}), [kind]: makePinRecord(next, u._id) };
      await saveRentalConfig();
      logActivity('ADMIN_PIN_CHANGED', u._id, u.name, `PIN ${kind === 'fallback' ? 'cadangan' : 'utama'} diganti lewat panel`);
      for (const admId of ADMIN_IDS) {
        bot.sendMessage(admId, `🔐 <b>PIN admin ${kind === 'fallback' ? 'cadangan' : 'utama'} diganti</b>\nOleh: ${esc(u.name)} (<code>${esc(u._id)}</code>)\nWaktu: <code>${utcTimeStr()}</code>\nBukan Anda? Segera ganti PIN lagi dan periksa Log Aktivitas.`, { parse_mode: 'HTML' }).catch(() => {});
      }
      const left = ['main', 'fallback'].filter((k) => !(rentalConfig.adminPin && rentalConfig.adminPin[k]));
      return {
        message: 'PIN ' + (kind === 'fallback' ? 'cadangan' : 'utama') + ' berhasil diganti.' +
          (left.length ? ' PIN ' + (left[0] === 'fallback' ? 'cadangan' : 'utama') + ' masih memakai bawaan lama; segera ganti juga.' : ''),
        pinStatus: { main: !!rentalConfig.adminPin.main, fallback: !!rentalConfig.adminPin.fallback },
      };
    },
    true
  )
);

app.get(
  '/api/admin/overview',
  h(
    async (u) => {
      requireAdmin(u);
      const userList = [...users.values()].map((usr) => ({
        id: usr._id,
        name: usr.name,
        username: usr.username,
        broker: usr.broker,
        asset: usr.asset,
        isAutoTrade: usr.isAutoTrade,
        hasKeys: hasBrokerKeys(usr),
        rentalActive: isRentalActive(usr),
        rentalExpiresAt: usr.rentalExpiresAt || 0,
        rentalPlanName: usr.rentalPlanName || '',
        realizedPnl: usr.realizedPnl || 0,
        wins: usr.wins || 0,
        losses: usr.losses || 0,
        grossProfit: usr.grossProfit || 0,
        grossLoss: usr.grossLoss || 0,
        todayPnl: usr.today && usr.today.pnl ? usr.today.pnl : 0,
        purchasedAt: usr.purchasedAt || 0,
        purchaseCount: usr.purchaseCount || 0,
        createdAt: usr.createdAt ? new Date(usr.createdAt).getTime() : 0,
        lastLoginAt: usr.lastLoginAt || 0,
        hasPosition: !!usr.position,
      }));
      const summary = {
        totalUsers: userList.length,
        activeRentals: userList.filter((x) => x.rentalActive).length,
        autoOn: userList.filter((x) => x.isAutoTrade).length,
        totalPnl: userList.reduce((a, x) => a + x.realizedPnl, 0),
        totalProfit: userList.reduce((a, x) => a + x.grossProfit, 0),
        totalLoss: userList.reduce((a, x) => a + x.grossLoss, 0),
        totalWins: userList.reduce((a, x) => a + x.wins, 0),
        totalLosses: userList.reduce((a, x) => a + x.losses, 0),
      };
      const orders = [...rentalOrders.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
      return {
        rentalConfig: publicRentalConfig(),
        users: userList,
        summary,
        orders,
        serverUtc: utcTimeStr(),
      };
    },
    true
  )
);

app.get(
  '/api/admin/ip-guard',
  h(
    async (u) => {
      requireAdmin(u);
      const list = Object.values(ipGuard).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 200);
      return { ips: list };
    },
    true
  )
);

app.post(
  '/api/admin/ip-guard',
  h(
    async (u, req) => {
      requireAdmin(u);
      const b = req.body || {};
      const ip = String(b.ip || '').trim();
      if (!ip) throw new Error('IP wajib diisi');
      const act = String(b.action || '');
      const ent = ipGuard[ip];
      if (act === 'unblock') {
        if (!ent) throw new Error('IP tidak ada di catatan');
        delete ipGuard[ip];
      } else if (act === 'whitelist') {
        ipGuard[ip] = { ...(ent || {}), ip, status: 'whitelist', note: 'Whitelist oleh admin', at: Date.now(), users: (ent && ent.users) || [] };
      } else if (act === 'unwhitelist' || act === 'remove') {
        delete ipGuard[ip];
      } else if (act === 'block') {
        ipGuard[ip] = { ...(ent || {}), ip, status: 'blocked', note: 'Diblokir manual oleh admin', at: Date.now(), users: (ent && ent.users) || [] };
      } else {
        throw new Error('Aksi tidak dikenal');
      }
      await saveIpGuard();
      logActivity('IP_GUARD_' + act.toUpperCase(), u._id, u.name, `${act} IP ${ip}`, { ip });
      return { ips: Object.values(ipGuard).sort((a, c) => (c.at || 0) - (a.at || 0)).slice(0, 200), message: 'Tersimpan' };
    },
    true
  )
);

app.get(
  '/api/admin/logs',
  h(
    async (u, req) => {
      requireAdmin(u);
      if (!logsCol) return { logs: [] };
      const q = {};
      const type = String(req.query.type || '');
      if (type === 'trade') q.type = /^TRADE_/;
      else if (type === 'rental') q.type = /^RENTAL_/;
      else if (type === 'login') q.type = { $in: ['LOGIN', 'REGISTER', 'OPEN', 'KEYS'] };
      else if (type === 'admin') q.type = /^ADMIN_/;
      if (req.query.userId) q.userId = String(req.query.userId);
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));
      const rows = await logsCol.find(q).sort({ time: -1 }).limit(limit).toArray();
      return {
        logs: rows.map((r) => ({
          id: String(r._id),
          t: new Date(r.time).getTime(),
          type: r.type,
          userId: r.userId,
          name: r.name,
          detail: r.detail,
          pnl: r.extra && Number.isFinite(r.extra.pnl) ? r.extra.pnl : null,
        })),
      };
    },
    true
  )
);

app.get(
  '/api/admin/user-trades',
  h(
    async (u, req) => {
      requireAdmin(u);
      const uid = String(req.query.userId || '');
      if (!uid) throw new Error('userId wajib');
      const rows = await tradesCol.find({ userId: uid }).sort({ time: -1 }).limit(30).toArray();
      return {
        trades: rows.map((r) => ({
          t: new Date(r.time).getTime(), side: r.side, symbol: r.symbol, price: r.price, amount: r.amount, pnl: r.pnl, note: r.note,
        })),
      };
    },
    true
  )
);

// Hasil face scan admin dicatat sebagai jejak audit
app.post(
  '/api/admin/audit',
  h(
    async (u, req) => {
      requireAdmin(u);
      const ev = String((req.body && req.body.event) || '');
      const map = {
        FACE_OK: ['ADMIN_FACE_OK', 'Face scan cocok, panel admin dibuka'],
        FACE_FAIL: ['ADMIN_FACE_FAIL', 'Face scan gagal'],
        FALLBACK_OK: ['ADMIN_FALLBACK_OK', 'Panel admin dibuka lewat PIN cadangan'],
      };
      if (map[ev]) logActivity(map[ev][0], u._id, u.name, map[ev][1]);
      return { message: 'ok' };
    },
    true
  )
);

app.post(
  '/api/admin/rental-config',
  h(
    async (u, req) => {
      requireAdmin(u);
      const body = req.body || {};
      if (Array.isArray(body.packages) && body.packages.length) {
        rentalConfig.packages = body.packages.map((p, idx) => ({
          id: String(p.id || `pkg_${idx + 1}`),
          name: String(p.name || 'Paket Sewa').trim(),
          tier: TIER_LIMITS[p.tier] ? p.tier : inferTier(p),
          price: String(p.price || '10 USDT').trim(),
          discountPrice: String(p.discountPrice || '').trim(),
          durationHours: Math.max(1, Number(p.durationHours) || 24),
          desc: String(p.desc || '').trim(),
          trial: !!p.trial,
        }));
      }
      if (Array.isArray(body.paymentMethods) && body.paymentMethods.length) {
        rentalConfig.paymentMethods = body.paymentMethods.map((m, idx) => ({
          id: String(m.id || `pm_${idx + 1}`),
          name: String(m.name || 'Metode Pembayaran').trim(),
          account: String(m.account || '').trim(),
          holder: String(m.holder || '').trim(),
          country: (/^(ALL|[A-Za-z]{2})$/.test(String(m.country || '').trim()) ? String(m.country).trim().toUpperCase() : 'ALL'),
          chain: (CHAIN_LABELS[String(m.chain || '').toLowerCase()] ? String(m.chain).toLowerCase() : 'manual'),
          disabled: !!m.disabled,
        }));
      }
      if (body.instructions !== undefined) {
        rentalConfig.instructions = String(body.instructions || '').trim();
      }
      if (body.requireRental !== undefined) {
        rentalConfig.requireRental = !!body.requireRental;
      }
      if (body.autoApprove !== undefined) {
        rentalConfig.autoApprove = !!body.autoApprove;
      }
      if (body.autoVerify !== undefined) {
        rentalConfig.autoVerify = !!body.autoVerify;
      }
      await saveRentalConfig();
      return {
        message: 'Konfigurasi Paket Sewa & Pembayaran berhasil disimpan!',
        rentalConfig: publicRentalConfig(),
      };
    },
    true
  )
);

app.post(
  '/api/admin/rental-action',
  h(
    async (u, req) => {
      requireAdmin(u);
      const { action, orderId, targetUserId, hours, planName, tier } = req.body || {};
      if (action === 'approve' && orderId) {
        const ord = await approveRentalOrder(orderId, u._id);
        return { message: `Sewa user ${ord.userId} (${ord.packageName}) berhasil di-ACC!` };
      }
      if (action === 'reject' && orderId) {
        const ord = rentalOrders.get(String(orderId));
        if (!ord) throw new Error('Pesanan sewa tidak ditemukan');
        ord.status = 'rejected';
        if (rentalsCol) await rentalsCol.replaceOne({ _id: ord._id }, ord, { upsert: true }).catch(() => {});
        const targetU = users.get(String(ord.userId));
        if (targetU) notify(targetU, `✕ Pengajuan sewa (${esc(ord.packageName)}) ditolak oleh Admin.`);
        logActivity('RENTAL_REJECTED', ord.userId, ord.userName, `Pengajuan ${ord.packageName} ditolak oleh ${u._id}`, { orderId: String(orderId) });
        return { message: `Pesanan ${orderId} ditolak` };
      }
      if (action === 'grant') {
        const uid = String(targetUserId || '').trim();
        if (!uid) throw new Error('Masukkan User ID Telegram');
        let targetU = users.get(uid) || findUserByIdentifier(uid);
        if (!targetU && /^\d{5,15}$/.test(uid)) {
          targetU = await ensureUser({ id: uid, first_name: 'Trader ' + uid.slice(-4) });
        }
        if (!targetU) throw new Error('User tidak ditemukan');
        const addH = Number(hours) || 24;
        const base = Math.max(Date.now(), Number(targetU.rentalExpiresAt) || 0);
        targetU.rentalExpiresAt = base + addH * 3600 * 1000;
        targetU.rentalPlanName = planName || `Aktif Manual (+${addH} Jam)`;
        if (TIER_LIMITS[tier]) { targetU.rentalTier = tier; targetU.assetSlots = []; }
        targetU.purchasedAt = Date.now();
        targetU.purchaseCount = Math.max(1, Number(targetU.purchaseCount) || 0);
        saveUser(targetU);
        logActivity('RENTAL_GRANT', targetU._id, targetU.name, `Admin ${u._id} menambah sewa +${addH} jam`, { hours: addH });
        notify(
          targetU,
          `✦ <b>MASA SEWA DITAMBAHKAN ADMIN</b>\n` +
            `Durasi: <b>+${addH} Jam</b>\n` +
            `Aktif s/d: <code>${utcTimeStr(targetU.rentalExpiresAt)}</code>`
        );
        return { message: `Masa sewa user ${targetU._id} ditambah ${addH} jam!` };
      }
      if (action === 'revoke') {
        const uid = String(targetUserId || '').trim();
        const targetU = users.get(uid) || findUserByIdentifier(uid);
        if (!targetU) throw new Error('User tidak ditemukan');
        if (isAdminId(targetU._id)) throw new Error('Tidak dapat mencabut akses Owner Admin');
        targetU.rentalExpiresAt = 0;
        targetU.rentalPlanName = 'Berakhir / Dicabut';
        targetU.isAutoTrade = false;
        saveUser(targetU);
        logActivity('RENTAL_REVOKE', targetU._id, targetU.name, `Sewa dicabut oleh admin ${u._id}`);
        notify(targetU, `⚠︎ Masa sewa bot Anda telah dihentikan oleh Admin. Auto-Trade dimatikan.`);
        return { message: `Masa sewa user ${targetU._id} berhasil dicabut` };
      }
      throw new Error('Aksi admin tidak dikenal');
    },
    true
  )
);

// ---------- Endpoint Trading User ----------
app.post(
  '/api/broker',
  h(async (u, req) => {
    const cfg = selectBroker(u, req.body && req.body.broker, req.body && req.body.mtSymbol);
    return {
      message: `Broker aktif: ${cfg.name} · Auto-Trade ${u.isAutoTrade ? 'ON' : 'OFF'}`,
      broker: cfg.id,
      hasKeys: hasBrokerKeys(u, cfg.id),
      isAutoTrade: !!u.isAutoTrade,
    };
  })
);

app.post(
  '/api/asset',
  h(async (u, req) => {
    const info = selectAsset(u, req.body && req.body.asset);
    return {
      message: `Aset aktif: ${info.asset.name} (${info.symbol})`,
      asset: info.asset.id,
      symbol: info.symbol,
    };
  })
);

app.post(
  '/api/buy',
  h(async (u) => {
    const info = getUserTradeInfo(u);
    const r = await actionBuy(u, 'app');
    return {
      message: `BUY ${info.broker.isMt ? r.got.toFixed(2) : r.got.toFixed(4)} ${info.unit} (${r.symbol}) @ ${fmt(r.price, info.decimals)}`,
    };
  })
);

app.post(
  '/api/sell',
  h(async (u) => {
    const info = getUserTradeInfo(u);
    const r = await actionSell(u, 'app');
    if (!r) throw new Error('Tidak ada posisi bot untuk dijual');
    return {
      message: `SELL ${info.broker.isMt ? Number(r.qty).toFixed(2) : r.qty} ${info.unit} @ ${fmt(r.price, info.decimals)} · PnL ${sign(r.pnl, 4)} ${info.quote}`,
    };
  })
);

app.get(
  '/api/stats',
  h(async (u) => {
    if (!isProUp(u)) throw new Error('Statistik lengkap khusus paket Pro dan Elite. Upgrade paket untuk memakainya.');
    const rows = await tradesCol.find({ userId: u._id }).sort({ time: 1 }).limit(5000).toArray();
    return { stats: computeStats(rows) };
  })
);

app.post(
  '/api/export-csv',
  h(async (u) => {
    if (!isProUp(u)) throw new Error('Ekspor CSV khusus paket Pro dan Elite. Upgrade paket untuk memakainya.');
    const rows = await tradesCol.find({ userId: u._id }).sort({ time: 1 }).limit(5000).toArray();
    if (!rows.length) throw new Error('Belum ada riwayat transaksi untuk diekspor');
    const head = ['waktu_utc', 'broker', 'aset', 'simbol', 'sisi', 'harga', 'jumlah', 'pnl', 'catatan'];
    const lines = [head.join(',')].concat(
      rows.map((r) => [new Date(r.time).toISOString(), r.broker, r.asset, r.symbol, r.side, r.price, r.amount, r.pnl, r.note].map(csvCell).join(','))
    );
    const buf = Buffer.from('\ufeff' + lines.join('\n'), 'utf8');
    await bot.sendDocument(u._id, buf, { caption: `Riwayat trade (${rows.length} baris)` }, { filename: `riwayat-trade-${utcDayKey()}.csv`, contentType: 'text/csv' });
    logActivity('EXPORT_CSV', u._id, u.name, `Ekspor riwayat trade (${rows.length} baris)`);
    return { message: `CSV (${rows.length} baris) terkirim ke chat Telegram Anda` };
  })
);

app.post(
  '/api/panic',
  h(async (u) => {
    const { r } = await actionPanic(u);
    return {
      message: r
        ? `DARURAT: Auto-Trade mati & posisi ditutup · PnL ${sign(r.pnl, 4)} ${r.quote}`
        : 'DARURAT: Auto-Trade dimatikan (tidak ada posisi terbuka)',
    };
  })
);

app.post(
  '/api/auto',
  h(async (u, req) => {
    setAuto(u, !!req.body.on, 'app');
    return { message: `Auto-Trade ${u.isAutoTrade ? 'AKTIF' : 'NONAKTIF'}` };
  })
);

app.post(
  '/api/settings',
  h(async (u, req) => {
    const s = applySettings(u, req.body || {});
    const info = getUserTradeInfo(u);
    notify(
      u,
      `⚙︎ <b>Pengaturan diperbarui</b> (${info.symbol} · ${info.broker.short})\n` +
        `Jumlah: <code>${s.amount}</code> ${info.unit}\nTP: <code>${s.tp}%</code> · SL: <code>${s.sl}%</code>\n` +
        `RSI beli &lt; <code>${s.rsiBuy}</code> · jual &gt; <code>${s.rsiSell}</code>`,
      true
    );
    return { message: 'Pengaturan disimpan', settings: s };
  })
);

app.post(
  '/api/keys',
  h(async (u, req) => {
    const res = await saveKeys(u, req.body || {});
    u.lastLoginAt = Date.now();
    logActivity('KEYS', u._id, u.name, `Menyimpan kredensial ${getBrokerCfg(res.broker).name}`);
    saveUser(u);
    const cfg = getBrokerCfg(res.broker);
    return { message: `${cfg.name} berhasil terhubung ●` };
  })
);

app.delete(
  '/api/keys',
  h(async (u) => {
    const cfg = getBrokerCfg(u.broker);
    removeKeys(u);
    return { message: `Kredensial ${cfg.name} dihapus` };
  })
);

// Poin 5: Kirim Status & Gambar Grafik (Harga atau Profit) ke Chat Bot + Toggle Live Bot Feed
app.post(
  '/api/send-status',
  h(async (u, req) => {
    if (!hasFeature(u, 'chart')) throw new Error('Fitur grafik tidak termasuk paket Anda. Upgrade paket untuk memakainya.');
    const chartType = req.body && req.body.chartType === 'profit' ? 'profit' : 'price';
    await sendPanel(
      u,
      chartType,
      chartType === 'profit'
        ? '▤ <b>Grafik Profit &amp; Status Dikirim dari Mini App</b>'
        : '➤ <b>Grafik Harga &amp; Status Realtime dari Mini App</b>'
    );
    return {
      message:
        chartType === 'profit'
          ? 'Grafik Profit & Status terkirim ke chat bot!'
          : 'Grafik Harga & Status Realtime terkirim ke chat bot!',
    };
  })
);

app.post(
  '/api/live-bot',
  h(async (u, req) => {
    u.liveBotStatus = !!(req.body && req.body.on);
    saveUser(u);
    if (u.liveBotStatus) {
      await sendPanel(u, 'price', '◷ <b>Live Stream Status Realtime ke Bot DIAKTIFKAN</b>');
    }
    return {
      liveBotStatus: u.liveBotStatus,
      message: `Live Update Status Bot: ${u.liveBotStatus ? 'AKTIF ●' : 'NONAKTIF ○'}`,
    };
  })
);

// ---------- Poin 6 (Elite): alarm harga ----------
function requireElite(u, what) {
  if (!isElite(u)) throw new Error(`${what} khusus paket Elite. Upgrade paket untuk memakainya.`);
}

app.get(
  '/api/alarms',
  h(async (u) => {
    requireElite(u, 'Alarm harga');
    return { alarms: u.alarms || [], max: MAX_ALARMS };
  })
);

app.post(
  '/api/alarms',
  h(async (u, req) => {
    requireElite(u, 'Alarm harga');
    const asset = String((req.body && req.body.asset) || '').toUpperCase();
    if (!ASSETS[asset]) throw new Error('Aset tidak dikenal');
    const level = Number(req.body && req.body.level);
    if (!Number.isFinite(level) || level <= 0) throw new Error('Level harga harus angka lebih dari 0');
    if ((u.alarms || []).length >= MAX_ALARMS) throw new Error(`Maksimal ${MAX_ALARMS} alarm aktif. Hapus salah satu dulu.`);
    const m = await getPublicAssetMarket(asset, false);
    if (!m || m.simulated || !Number.isFinite(m.price)) throw new Error('Harga pasar belum tersedia. Coba lagi sebentar.');
    if (level === m.price) throw new Error('Level harga sama dengan harga sekarang');
    const a = { id: newAlarmId(), asset, level, dir: level > m.price ? 'above' : 'below', createdAt: Date.now() };
    u.alarms = [...(u.alarms || []), a];
    saveUser(u);
    logActivity('ALARM_SET', u._id, u.name, `Alarm ${asset} ${a.dir} ${level}`);
    const ac = getAssetCfg(asset);
    return { message: `Alarm dipasang: ${asset} ${a.dir === 'above' ? '≥' : '≤'} ${fmt(level, ac.decimals)}`, alarm: a };
  })
);

app.delete(
  '/api/alarms/:id',
  h(async (u, req) => {
    requireElite(u, 'Alarm harga');
    const before = (u.alarms || []).length;
    u.alarms = (u.alarms || []).filter((a) => a.id !== req.params.id);
    if (u.alarms.length === before) throw new Error('Alarm tidak ditemukan');
    saveUser(u);
    return { message: 'Alarm dihapus' };
  })
);

// ---------- Loop auto-trade (Multi-User Concurrent Pool) ----------
async function tickUser(u) {
  const r = rt(u._id);
  if (!isRentalActive(u)) {
    if (u.isAutoTrade) {
      u.isAutoTrade = false;
      saveUser(u);
      notify(u, `⚠︎ Masa sewa paket Anda telah berakhir (${utcTimeStr()}). Auto-Trade dimatikan otomatis.`);
    }
    return;
  }
  const info = getUserTradeInfo(u);
  if (r.busy || !hasBrokerKeys(u) || !info.supportedOnBroker) return;
  try {
    const m = await getMarketForUser(u);
    if (!m || m.simulated || !Number.isFinite(m.rsi)) return; // data cadangan buatan: jangan trading

    await withLock(u, async () => {
      const { rsi, price } = m;
      const { tp, sl, rsiBuy, rsiSell } = u.settings;
      const pos = u.position;
      const tier = getUserTier(u);
      const beOn = Number(u.settings.breakEvenPct) > 0 && tier !== 'starter';
      const stratOn = ['pro', 'elite'].includes(tier) && STRATEGIES[u.settings.strategy] && u.settings.strategy !== 'rsi';
      const trendOn = Number(u.settings.trendFilter) === 1 && tier !== 'starter';
      const sig = stratOn ? strategySignals(m, rsiBuy, rsiSell, u.settings.strategy) : null;
      const trOn = Number(u.settings.trailAtr) > 0 && (tier === 'pro' || tier === 'elite');

      if (pos) {
        const chg = ((price - pos.entry) / pos.entry) * 100;
        let dirty = false;
        if (!Number.isFinite(pos.peak) || price > pos.peak) { pos.peak = Math.max(price, pos.entry); dirty = true; }
        if (beOn && !pos.beArmed && chg >= Number(u.settings.breakEvenPct)) {
          pos.beArmed = true; dirty = true;
          notify(u, `⚖ <b>BREAK-EVEN AKTIF</b> (${info.symbol})\nProfit ${sign(chg)}% — stop loss dipindah ke harga entry <code>${fmt(pos.entry, info.decimals)}</code>.`);
        }
        if (trOn && !pos.trailArmed && chg >= tp) {
          pos.trailArmed = true; dirty = true;
          notify(u, `⤴ <b>TRAILING STOP AKTIF</b> (${info.symbol})\nTarget TP ${sign(chg)}% tercapai — posisi dibiarkan naik, stop mengikuti harga (${u.settings.trailAtr}× ATR).`);
        }
        if (dirty) saveUser(u);
        let reason = null;
        if (chg <= -sl) reason = `■ STOP LOSS (${sign(chg)}%)`;
        else if (pos.beArmed && beOn && price <= pos.entry) reason = `⚖ BREAK-EVEN STOP (${sign(chg)}%)`;
        else if (pos.trailArmed && trOn) {
          const atr = calcAtr(m);
          const stopPx = pos.peak - Number(u.settings.trailAtr) * atr;
          if (atr > 0 && price <= stopPx) reason = `⤴ TRAILING STOP (puncak ${fmt(pos.peak, info.decimals)}, ${sign(chg)}%)`;
        }
        if (!reason && !(pos.trailArmed && trOn) && chg >= tp) reason = `◎ TAKE PROFIT (${sign(chg)}%)`;
        if (!reason && sig && sig.sell && chg > 0) reason = `△ Sinyal jual ${STRATEGIES[u.settings.strategy]} (${sig.why})`;
        if (!reason && !stratOn && rsi > rsiSell) reason = `△ RSI ${rsi.toFixed(1)} di atas ${rsiSell}`;
        if (!reason && stratOn && rsi > rsiSell) reason = `△ RSI ${rsi.toFixed(1)} di atas ${rsiSell}`;
        if (reason) {
          const res = await sellPosition(u, reason);
          if (res) {
            await notify(
              u,
              `▼ <b>AUTO SELL</b> (${info.symbol} · ${info.broker.short})\n${reason}\n` +
                `▣ <code>${info.broker.isMt ? Number(res.qty).toFixed(2) : res.qty}</code> ${info.unit} @ <code>${fmt(res.price, info.decimals)}</code>\n` +
                `${dot(res.pnl)} PnL: <b>${sign(res.pnl, 4)} ${info.quote}</b>\n` +
                `◷ ${utcTimeStr()}`
            );
          }
        }
      } else if ((sig ? sig.buy : rsi < rsiBuy) && (!trendOn || trendIsUp(m)) && confirmEntry(m, tier).ok && inSession(u) && !dailyLossHit(u) && Date.now() - (u.lastSellAt || 0) > COOLDOWN_MIN * 60000) {
        const why = sig ? `${STRATEGIES[u.settings.strategy]}: ${sig.why}` : `RSI ${rsi.toFixed(2)}`;
        const res = await buy(u, why);
        await notify(
          u,
          `▲ <b>AUTO BUY</b> (${info.symbol} · ${info.broker.short})\n▽ ${esc(why)}${trendOn ? ' · tren naik ✓' : ''}${confirmEntry(m, tier).level > 0 ? ` · konfirmasi L${confirmEntry(m, tier).level} ✓` : ''}\n` +
            `▣ <code>${info.broker.isMt ? res.got.toFixed(2) : res.got.toFixed(4)}</code> ${info.unit} @ <code>${fmt(res.price, info.decimals)}</code>\n` +
            `◷ ${utcTimeStr()}`
        );
      }
    });
    r.fails = 0;
  } catch (err) {
    if (err.code === 'BUSY') return;
    console.error(`Auto-trade ${u._id} (${u.broker}/${u.asset}):`, err.message);
    if (++r.fails >= MAX_AUTO_FAILS) {
      u.isAutoTrade = false;
      r.fails = 0;
      saveUser(u);
      notify(
        u,
        `⚠︎ Auto-Trade (${info.symbol}) dimatikan karena error berulang:\n<code>${esc(err.message)}</code>`
      );
    }
  }
}

let looping = false;
setInterval(async () => {
  if (looping) return;
  looping = true;
  try {
    const active = [...users.values()].filter((u) => u.isAutoTrade && hasBrokerKeys(u));
    if (!active.length) return;
    await runPool(active, WORKER_CONCURRENCY, tickUser);
  } catch (err) {
    console.error('Loop auto-trade:', err.message);
  } finally {
    looping = false;
  }
}, LOOP_SEC * 1000);

// ---------- Loop Poin 5: Sinkronisasi Status & Waktu UTC Realtime ke Pesan Panel Bot ----------
let liveSyncing = false;
setInterval(async () => {
  if (liveSyncing) return;
  liveSyncing = true;
  try {
    const targets = [...users.values()].filter((u) => {
      const r = rt(u._id);
      return u.liveBotStatus !== false && r.panelMsgId && isRentalActive(u);
    });
    await runPool(targets, 4, async (u) => {
      await refreshPanel(u, undefined, rt(u._id).panelChartType);
    });
  } catch (e) {
    console.error('Live bot sync:', e.message);
  } finally {
    liveSyncing = false;
  }
}, LIVE_BOT_SYNC_SEC * 1000);

// Kirim ulang gambar chart baru secara berkala agar grafik visual ikut terbarui
if (STATUS_INTERVAL_MIN > 0) {
  setInterval(async () => {
    const active = [...users.values()].filter((u) => u.isAutoTrade && hasBrokerKeys(u) && isRentalActive(u));
    await runPool(active, 4, async (u) => {
      await sendPanel(u, rt(u._id).panelChartType || 'price').catch((e) => console.error('Status:', e.message));
      await sleep(150);
    });
  }, STATUS_INTERVAL_MIN * 60 * 1000);
}

// Laporan harian: semua paket mendapat ringkasan dasar; Elite mendapat laporan VIP lengkap.
function buildEliteReportText(u, info, rows, week) {
  const sells = rows.filter((r) => r.side === 'SELL' && Number.isFinite(Number(r.pnl)));
  const wins = sells.filter((r) => Number(r.pnl) >= 0).length;
  const losses = sells.length - wins;
  const pnls = sells.map((r) => Number(r.pnl));
  const best = pnls.length ? Math.max(...pnls) : 0;
  const worst = pnls.length ? Math.min(...pnls) : 0;
  const wr = sells.length ? (wins / sells.length) * 100 : 0;
  const weekSum = week.reduce((a, d) => a + d.pnl, 0);
  const pos = u.position;
  const q = info.quote;
  return (
    `✦ <b>LAPORAN HARIAN VIP</b> · UTC ${u.today.date} (${esc(info.broker.short)})\n` +
    `━━━━━━━━━━━━━━\n` +
    `⇄ Transaksi: <b>${u.today.trades}</b> (tutup: ${sells.length})\n` +
    `${dot(u.today.pnl)} Profit hari ini: <b>${sign(u.today.pnl)} ${q}</b>\n` +
    `◎ Win rate: <b>${wr.toFixed(1)}%</b> (${wins}W / ${losses}L)\n` +
    `▲ Terbaik: <b>${sign(best)}</b> · ▼ Terburuk: <b>${sign(worst)}</b>\n` +
    `▤ 7 hari terakhir: <b>${sign(weekSum)} ${q}</b>\n` +
    week.map((d) => `  ${d.date.slice(5)}  ${dot(d.pnl)} ${sign(d.pnl)}`).join('\n') +
    `\n▣ Total tertutup: <b>${sign(u.realizedPnl)} ${q}</b>\n` +
    `⌖ Posisi terbuka: <b>${pos ? esc(pos.symbol || info.symbol) + ' @ ' + fmt(pos.entry, info.decimals) : 'tidak ada'}</b>\n` +
    `⏰ Alarm harga aktif: <b>${(u.alarms || []).length}</b>\n` +
    `◷ ${utcTimeStr()}`
  );
}

setInterval(async () => {
  if (utcHour() !== DAILY_REPORT_HOUR) return;
  for (const u of users.values()) {
    ensureToday(u);
    if (u.today.reported || (!u.isAutoTrade && u.today.trades === 0)) continue;
    const info = getUserTradeInfo(u);
    u.today.reported = true;
    saveUser(u);
    if (isElite(u) && tradesCol) {
      try {
        const since = new Date(u.today.date + 'T00:00:00.000Z');
        const rows = await tradesCol.find({ userId: u._id, time: { $gte: since } }).toArray();
        const week = Object.keys(u.history || {})
          .sort()
          .slice(-7)
          .map((d) => ({ date: d, pnl: Number(u.history[d]) || 0 }));
        await notify(u, buildEliteReportText(u, info, rows, week));
        await sleep(100);
        continue;
      } catch (e) {
        console.error('Laporan VIP:', e.message); // jatuh ke laporan dasar
      }
    }
    await notify(
      u,
      `▤ <b>Laporan Harian UTC ${u.today.date}</b> (${info.broker.short})\n` +
        `⇄ Transaksi: <b>${u.today.trades}</b>\n` +
        `${dot(u.today.pnl)} Profit hari ini: <b>${sign(u.today.pnl)} ${info.quote}</b>\n` +
        `▣ Total tertutup: <b>${sign(u.realizedPnl)} ${info.quote}</b>\n` +
        `◷ ${utcTimeStr()}`
    );
    await sleep(100);
  }
}, 60 * 1000);

// ---------- Poin 6 (Elite): pemeriksa alarm harga ----------
let alarmChecking = false;
async function checkAlarms() {
  if (alarmChecking) return;
  alarmChecking = true;
  try {
    const owners = [...users.values()].filter(
      (u) => Array.isArray(u.alarms) && u.alarms.length && isElite(u) && isRentalActive(u)
    );
    if (!owners.length) return;
    const prices = {};
    for (const id of new Set(owners.flatMap((u) => u.alarms.map((a) => a.asset)))) {
      try {
        const m = await getPublicAssetMarket(id, false);
        if (m && !m.simulated && Number.isFinite(m.price)) prices[id] = m.price;
      } catch (e) {}
    }
    for (const u of owners) {
      const fired = u.alarms.filter((a) => alarmHit(a, prices[a.asset]));
      if (!fired.length) continue;
      u.alarms = u.alarms.filter((a) => !fired.includes(a));
      saveUser(u);
      for (const a of fired) {
        const ac = getAssetCfg(a.asset);
        await notify(
          u,
          `⏰ <b>ALARM HARGA</b> · ${esc(ac.name)} (${esc(a.asset)})\n` +
            `Harga ${a.dir === 'above' ? 'naik menembus' : 'turun menembus'} <code>${fmt(a.level, ac.decimals)}</code>\n` +
            `◆ Sekarang: <code>${fmt(prices[a.asset], ac.decimals)}</code>\n` +
            `◷ ${utcTimeStr()}`
        );
        logActivity('ALARM', u._id, u.name, `Alarm ${a.asset} ${a.dir} ${a.level} terpicu @ ${prices[a.asset]}`);
      }
    }
  } catch (e) {
    console.error('Alarm:', e.message);
  } finally {
    alarmChecking = false;
  }
}
setInterval(checkAlarms, 15 * 1000);

// ---------- Start ----------
process.on('unhandledRejection', (e) => console.error('Unhandled:', e && e.message));
bot.on('polling_error', (e) => console.error('Polling:', e.message));

let mongoClient = null;
(async () => {
  try {
    mongoClient = new MongoClient(MONGO_URI, { maxPoolSize: 25 });
    await mongoClient.connect();
    const db = mongoClient.db(process.env.MONGO_DB || 'meta_bot');
    usersCol = db.collection('users');
    tradesCol = db.collection('trades');
    configCol = db.collection('config');
    rentalsCol = db.collection('rentals');
    logsCol = db.collection('activity_logs');
    csCol = db.collection('cs_messages');
    trCol = db.collection('translations');
    await trCol.createIndex({ at: 1 }, { expireAfterSeconds: 180 * 86400 }).catch(() => {});
    await csCol.createIndex({ at: 1 }, { expireAfterSeconds: 60 * 86400 }).catch(() => {});
    await logsCol.createIndex({ time: -1 });
    await logsCol.createIndex({ userId: 1, time: -1 });
    await logsCol.createIndex({ time: 1 }, { expireAfterSeconds: 90 * 86400 }).catch(() => {});
    await tradesCol.createIndex({ userId: 1, time: -1 });
    await usersCol.createIndex({ isAutoTrade: 1 });
    await rentalsCol.createIndex({ userId: 1, createdAt: -1 });

    const savedCfg = await configCol.findOne({ _id: 'rental_config' });
    if (savedCfg) {
      rentalConfig = { ...DEFAULT_RENTAL_CONFIG, ...savedCfg };
      rentalConfig.packages = (rentalConfig.packages || []).map((p) => ({
        ...p,
        tier: inferTier(p),
        discountPrice: String(p.discountPrice || ''),
      }));
      if (!rentalConfig.packages.some((p) => p.trial)) {
        rentalConfig.packages.unshift(DEFAULT_RENTAL_CONFIG.packages.find((p) => p.trial));
      }
      if (!(rentalConfig.paymentMethods || []).some((m) => m.id === 'pm_paypal')) {
        rentalConfig.paymentMethods = [DEFAULT_RENTAL_CONFIG.paymentMethods.find((m) => m.id === 'pm_paypal'), ...(rentalConfig.paymentMethods || [])];
      }
      try {
        const g = await configCol.findOne({ _id: 'ip_guard' });
        if (g && g.entries) Object.assign(ipGuard, g.entries);
      } catch (e) {}
      if (!rentalConfig.packages.some((p) => p.tier === 'elite')) {
        rentalConfig.packages.push(DEFAULT_RENTAL_CONFIG.packages.find((p) => p.tier === 'elite'));
      }
      await saveRentalConfig();
    } else {
      await saveRentalConfig();
    }

    for (const rDoc of await rentalsCol.find({}).sort({ createdAt: -1 }).limit(100).toArray()) {
      rentalOrders.set(String(rDoc._id), rDoc);
    }

    try {
      const csDocs = await csCol.find({}).sort({ at: -1 }).limit(3000).toArray();
      for (const d of csDocs.sort((a, b) => a.at - b.at)) {
        const arr = csChats.get(String(d.userId)) || [];
        arr.push(d);
        csChats.set(String(d.userId), arr);
      }
    } catch (e) {
      console.error('Muat chat CS:', e.message);
    }
    for (const doc of await usersCol.find({}).toArray()) {
      users.set(doc._id, normalizeUserDoc(doc));
    }
    console.log(`MongoDB terhubung · ${users.size} user dimuat`);
  } catch (err) {
    console.error('Gagal koneksi MongoDB:', err.message);
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', () => console.log(`Web server di port ${PORT}`));

  // Keep-alive: ping diri sendiri tiap KEEPALIVE_MIN menit agar Render free tidak tidur.
  // (Render otomatis mengisi RENDER_EXTERNAL_URL. Untuk jaga-jaga, pakai juga pinger eksternal.)
  const SELF_URL = (process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  const KEEPALIVE_MIN = Number(process.env.KEEPALIVE_MIN || 5);
  if (SELF_URL && KEEPALIVE_MIN > 0) {
    setInterval(() => {
      fetch(SELF_URL + '/health').catch((e) => console.error('Keepalive gagal:', e.message));
    }, KEEPALIVE_MIN * 60 * 1000).unref();
    console.log(`Keepalive aktif: ${SELF_URL}/health tiap ${KEEPALIVE_MIN} menit`);
  }
  bot.startPolling();

  try {
    await pubTestnet.loadMarkets();
    console.log('Terhubung ke Binance Testnet · Seluruh Poin 1-5 Siap');
    await bot.setMyCommands([
      { command: 'menu', description: '◈ Buka panel grafik & status' },
      { command: 'status', description: '⟳ Kirim grafik harga & status realtime (UTC)' },
      { command: 'profit', description: '▤ Kirim grafik profit 7 hari' },
      { command: 'asset', description: '❖ Pilih aset trading' },
      { command: 'broker', description: '⇄ Pilih & atur broker' },
      { command: 'cs', description: '💬 Chat Customer Service (pembeli paket)' },
    ]);
    if (WEBAPP_URL) {
      await bot
        .setChatMenuButton({
          menu_button: JSON.stringify({ type: 'web_app', text: '◈ Dashboard ✦', web_app: { url: WEBAPP_URL } }),
        })
        .catch((e) => console.error('Menu button:', e.message));
    }
  } catch (err) {
    console.error('Peringatan inisialisasi market awal:', err.message);
  }
})();

async function shutdown() {
  try {
    await bot.stopPolling();
    if (mongoClient) await mongoClient.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
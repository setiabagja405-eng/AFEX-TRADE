require('dotenv').config();
const crypto = require('crypto');
const zlib = require('zlib');
const express = require('express');
const ccxt = require('ccxt');
const { RSI } = require('technicalindicators');
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
const DEFAULT_SETTINGS = { amount: 0.001, tp: 1.0, sl: 0.7, rsiBuy: 30, rsiSell: 70 };

// ID Admin Khusus sesuai permintaan user
const ADMIN_IDS = (process.env.ADMIN_IDS || '7706512451,8821716544')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const isAdminId = (id) => ADMIN_IDS.includes(String(id || '').trim());

const sha256Hex = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
// PIN Eksekutif Admin (utama) = 270223 ; PIN cadangan saat Face Scan gagal = 20052007.
// Disimpan sebagai hash. Bisa ditambah lewat env ADMIN_PIN / ADMIN_FALLBACK_PIN.
const MAIN_ADMIN_PIN_HASHES = [
  '3f85f14582604240238d1f15659d23eae027664aefe5617e2042dd788f6f14e9',
  ...(process.env.ADMIN_PIN ? [sha256Hex(process.env.ADMIN_PIN)] : []),
];
const FALLBACK_ADMIN_PIN_HASHES = [
  '5ed4fb3310b651ead0153f942016f35eb42f2b45d7552fdd30bb4e5dd254b3d6',
  ...(process.env.ADMIN_FALLBACK_PIN ? [sha256Hex(process.env.ADMIN_FALLBACK_PIN)] : []),
];
const adminPinFails = new Map(); // id admin -> { n, until }

const DEFAULT_RENTAL_CONFIG = {
  _id: 'rental_config',
  requireRental: true,
  autoApprove: false,
  instructions:
    'Pilih paket sewa di bawah, lakukan pembayaran sesuai harga paket ke salah satu metode pembayaran resmi, lalu isi Bukti Transfer / TxHash dan klik Kirim Pembayaran Sewa.',
  packages: [
    {
      id: 'pkg_1d',
      name: 'Paket Harian (1 Hari)',
      price: '5 USDT',
      durationHours: 24,
      desc: 'Akses Penuh Login & Auto-Trade 24 Jam',
    },
    {
      id: 'pkg_7d',
      name: 'Paket Mingguan (7 Hari)',
      price: '25 USDT',
      durationHours: 168,
      desc: 'Akses Multi-Broker & Multi-Aset 7 Hari',
    },
    {
      id: 'pkg_30d',
      name: 'Paket Bulanan VIP (30 Hari)',
      price: '75 USDT',
      durationHours: 720,
      desc: 'Full Fitur + Prioritas Server 30 Hari',
    },
  ],
  paymentMethods: [
    {
      id: 'pm_bep20',
      name: 'USDT (Jaringan BEP20 / BSC)',
      account: '0x8F9c3b7A12dE4567890aBcDeF1234567890AbCdE',
      holder: 'AFEX Official Treasury',
    },
    {
      id: 'pm_trc20',
      name: 'USDT (Jaringan TRC20 / TRON)',
      account: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE',
      holder: 'AFEX Official Treasury',
    },
    {
      id: 'pm_bank',
      name: 'Transfer Bank / E-Wallet (IDR)',
      account: 'BCA 8820194821 / DANA 081234567890',
      holder: 'A/N Admin AFEX Trade',
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
    async marketBuy(s, amount, baseAsset = 'BTC') {
      let order = await ex.createMarketBuyOrder(s, amount);
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
    async marketSell(s, amount, pos, baseAsset = 'BTC') {
      const b = await ex.fetchBalance();
      const free = b[baseAsset] ? Number(b[baseAsset].free) || 0 : 0;
      const target = pos && pos.amount ? Math.min(pos.amount, free) : free;
      const qty = Number(ex.amountToPrecision(s, target));
      if (!(qty > 0)) throw new Error(`Saldo ${baseAsset} tidak cukup untuk dijual`);
      const order = await ex.createMarketSellOrder(s, qty);
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
  const info = getUserTradeInfo(u);
  if (!info.supportedOnBroker) {
    throw new Error(
      `Aset ${info.asset.name} (${info.asset.mtSymbol}) khusus untuk broker MetaTrader 4 / MetaTrader 5. Silakan ganti broker ke MT4/MT5.`
    );
  }
  const ad = requireAdapter(u);
  const amount = Number(u.settings.amount) || info.defaultAmount;
  const order = await ad.marketBuy(info.symbol, amount, info.base);
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
  return { price, got, unit: info.unit, symbol: pos.symbol, decimals: info.decimals };
}

async function sellPosition(u, note) {
  const pos = u.position;
  if (!pos || pos.amount <= 0) return null;
  const info = getUserTradeInfo(u);
  const ad = requireAdapter(u);
  const sym = pos.symbol || info.symbol;
  const res = await ad.marketSell(sym, pos.amount, pos, info.base);
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
  saveUser(u);
  logTrade(u, 'SELL', price, qty, pnl.toFixed(4), note);
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
  const prevIsMt = getBrokerCfg(u.broker).isMt;
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

  if (!hasBrokerKeys(u, brokerId) || !updatedInfo.supportedOnBroker) {
    u.isAutoTrade = false;
  }

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
  u.purchasedAt = Date.now();
  u.purchaseCount = (u.purchaseCount || 0) + 1;
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
      `Silakan Login di Mini App untuk menyambungkan Bot ke akun Trading Anda.`
  );
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
    isLoggedIn: !u.isSessionLocked && rentalActive && (hasKeys || !!u.lastLoginAt),
    isSessionLocked: !!u.isSessionLocked,
    liveBotStatus: u.liveBotStatus !== false,
    rentalActive,
    rentalExpiresAt: u.rentalExpiresAt || 0,
    rentalPlanName: u.rentalPlanName || '',
    rentalConfig: {
      requireRental: rentalConfig.requireRental,
      autoApprove: rentalConfig.autoApprove,
      instructions: rentalConfig.instructions,
      packages: rentalConfig.packages,
      paymentMethods: rentalConfig.paymentMethods,
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
      const order = Object.keys(BROKERS);
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

// ---------- Endpoint Publik: Paket Sewa & Pengajuan ----------
app.get('/api/rental/public-config', (req, res) => {
  res.json({
    ok: true,
    rentalConfig: {
      requireRental: rentalConfig.requireRental,
      autoApprove: rentalConfig.autoApprove,
      instructions: rentalConfig.instructions,
      packages: rentalConfig.packages,
      paymentMethods: rentalConfig.paymentMethods,
    },
    serverUtc: utcTimeStr(),
  });
});

app.post('/api/rental/order', async (req, res) => {
  try {
    const body = req.body || {};
    const tgUser = verifyInitData(req.get('x-init-data'));
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

    const pm =
      (rentalConfig.paymentMethods || []).find((m) => m.id === body.methodId) ||
      rentalConfig.paymentMethods[0] || { name: 'Transfer Manual' };
    const txProof = String(body.txProof || '').trim();
    if (txProof.length < 3) {
      return res.status(400).json({
        ok: false,
        error: 'Masukkan Bukti Pembayaran / TxHash / Nomor Referensi transaksi Anda.',
      });
    }

    const orderId = 'RNT' + Date.now().toString(36).toUpperCase();
    const ord = {
      _id: orderId,
      id: orderId,
      userId: u._id,
      userName: u.name,
      packageId: pkg.id,
      packageName: pkg.name,
      price: pkg.price,
      durationHours: Number(pkg.durationHours) || 24,
      methodName: pm.name,
      txProof,
      status: 'pending',
      createdAt: Date.now(),
    };
    rentalOrders.set(orderId, ord);
    logActivity('RENTAL_ORDER', u._id, u.name, `Mengajukan sewa ${pkg.name} (${pkg.price}) via ${pm.name}`, { orderId });
    if (rentalsCol) {
      await rentalsCol.insertOne(ord).catch(() => {});
    }

    if (rentalConfig.autoApprove) {
      await approveRentalOrder(orderId, 'AUTO');
      return res.json({
        ok: true,
        autoApproved: true,
        message: `Paket ${pkg.name} berhasil diaktifkan! Sekarang Anda dapat langsung Login.`,
        data: await snapshot(u),
      });
    }

    for (const admId of ADMIN_IDS) {
      bot
        .sendMessage(
          admId,
          `📦 <b>PENGAJUAN SEWA BARU</b> ${tw()}\n` +
            `━━━━━━━━━━━━━━\n` +
            `👤 User: <b>${esc(u.name)}</b> (<code>${u._id}</code>)\n` +
            `🏷 Paket: <b>${esc(pkg.name)}</b> (${pkg.durationHours} Jam · ${esc(pkg.price)})\n` +
            `💳 Metode: ${esc(pm.name)}\n` +
            `🧾 Bukti/TxHash: <code>${esc(txProof)}</code>\n` +
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
      message: 'Bukti pembayaran sewa terkirim! Menunggu verifikasi Admin.',
      data: await snapshot(u),
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message || 'Gagal mengirim pesanan sewa' });
  }
});

// ---------- Login User Langsung Tanpa OTP + Cek Paket Sewa + Sambungkan Trade ----------
app.post('/api/auth/login', async (req, res) => {
  try {
    const body = req.body || {};
    const tgUser = verifyInitData(req.get('x-init-data'));
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
      const sha = sha256Hex(pinVal);
      const allowed = kind === 'fallback'
        ? FALLBACK_ADMIN_PIN_HASHES
        : [...MAIN_ADMIN_PIN_HASHES, ...(rentalConfig.adminPinHashes || [])];
      if (!pinVal || !allowed.includes(sha)) {
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
        rentalConfig,
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
          price: String(p.price || '10 USDT').trim(),
          durationHours: Math.max(1, Number(p.durationHours) || 24),
          desc: String(p.desc || '').trim(),
        }));
      }
      if (Array.isArray(body.paymentMethods) && body.paymentMethods.length) {
        rentalConfig.paymentMethods = body.paymentMethods.map((m, idx) => ({
          id: String(m.id || `pm_${idx + 1}`),
          name: String(m.name || 'Metode Pembayaran').trim(),
          account: String(m.account || '').trim(),
          holder: String(m.holder || '').trim(),
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
      await saveRentalConfig();
      return {
        message: 'Konfigurasi Paket Sewa & Pembayaran berhasil disimpan!',
        rentalConfig,
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
      const { action, orderId, targetUserId, hours, planName } = req.body || {};
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
        targetU.purchasedAt = Date.now();
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
      message: `Broker aktif: ${cfg.name}`,
      broker: cfg.id,
      hasKeys: hasBrokerKeys(u, cfg.id),
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
    if (!m || !Number.isFinite(m.rsi)) return;

    await withLock(u, async () => {
      const { rsi, price } = m;
      const { tp, sl, rsiBuy, rsiSell } = u.settings;
      const pos = u.position;

      if (pos) {
        const chg = ((price - pos.entry) / pos.entry) * 100;
        let reason = null;
        if (chg >= tp) reason = `◎ TAKE PROFIT (${sign(chg)}%)`;
        else if (chg <= -sl) reason = `■ STOP LOSS (${sign(chg)}%)`;
        else if (rsi > rsiSell) reason = `△ RSI ${rsi.toFixed(1)} di atas ${rsiSell}`;
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
      } else if (rsi < rsiBuy && Date.now() - (u.lastSellAt || 0) > COOLDOWN_MIN * 60000) {
        const res = await buy(u, `RSI ${rsi.toFixed(2)}`);
        await notify(
          u,
          `▲ <b>AUTO BUY</b> (${info.symbol} · ${info.broker.short})\n▽ RSI ${rsi.toFixed(1)} di bawah ${rsiBuy}\n` +
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

setInterval(async () => {
  if (utcHour() !== DAILY_REPORT_HOUR) return;
  for (const u of users.values()) {
    ensureToday(u);
    if (u.today.reported || (!u.isAutoTrade && u.today.trades === 0)) continue;
    const info = getUserTradeInfo(u);
    u.today.reported = true;
    saveUser(u);
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
    await logsCol.createIndex({ time: -1 });
    await logsCol.createIndex({ userId: 1, time: -1 });
    await logsCol.createIndex({ time: 1 }, { expireAfterSeconds: 90 * 86400 }).catch(() => {});
    await tradesCol.createIndex({ userId: 1, time: -1 });
    await usersCol.createIndex({ isAutoTrade: 1 });
    await rentalsCol.createIndex({ userId: 1, createdAt: -1 });

    const savedCfg = await configCol.findOne({ _id: 'rental_config' });
    if (savedCfg) {
      rentalConfig = { ...DEFAULT_RENTAL_CONFIG, ...savedCfg };
    } else {
      await saveRentalConfig();
    }

    for (const rDoc of await rentalsCol.find({}).sort({ createdAt: -1 }).limit(100).toArray()) {
      rentalOrders.set(String(rDoc._id), rDoc);
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
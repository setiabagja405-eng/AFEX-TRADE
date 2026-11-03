require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const ccxt = require('ccxt');
const { RSI } = require('technicalindicators');
const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const mt5Adapter = require('./mt5');

// ================= KONFIGURASI =================
const SYMBOL = 'BTC/USDT';
const BASE = 'BTC';
const TIMEFRAME = '5m';
const RSI_PERIOD = 14;
const LOOP_SEC = 30; // cek sinyal tiap 30 detik
const STATUS_INTERVAL_MIN = 30; // status otomatis (hanya user dengan Auto ON), 0 = mati
const DAILY_REPORT_HOUR = 21; // laporan harian jam 21:00 WIB
const CHART_CANDLES = 48;
const COOLDOWN_MIN = 5; // jeda setelah SELL sebelum auto-buy lagi
const MAX_AUTO_FAILS = 5; // auto-trade dimatikan setelah N error beruntun
const WORKER_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 8); // paralel multi-user
const TZ = 'Asia/Jakarta';
const DEFAULT_SETTINGS = { amount: 0.001, tp: 1.0, sl: 0.7, rsiBuy: 30, rsiSell: 70 };

// Katalog Broker (Poin 1: Multi-Broker)
const BROKERS = {
  binance_testnet: {
    id: 'binance_testnet',
    name: 'Binance Testnet',
    short: 'Testnet',
    auth: 'hmac',
    sandbox: true,
    isMt: false,
    defaultSymbol: 'BTC/USDT',
    base: 'BTC',
    quote: 'USDT',
    unit: 'BTC',
    defaultAmount: 0.001,
    minAmount: 0.0001,
    maxAmount: 10,
  },
  binance: {
    id: 'binance',
    name: 'Binance Live',
    short: 'Binance',
    auth: 'hmac',
    sandbox: false,
    isMt: false,
    defaultSymbol: 'BTC/USDT',
    base: 'BTC',
    quote: 'USDT',
    unit: 'BTC',
    defaultAmount: 0.001,
    minAmount: 0.0001,
    maxAmount: 10,
  },
  mt5: {
    id: 'mt5',
    name: 'MetaTrader 5',
    short: 'MT5',
    auth: 'metaapi',
    sandbox: false,
    isMt: true,
    defaultSymbol: 'BTCUSD',
    base: 'BTC',
    quote: 'USD',
    unit: 'Lot',
    defaultAmount: 0.01,
    minAmount: 0.01,
    maxAmount: 50,
  },
  mt4: {
    id: 'mt4',
    name: 'MetaTrader 4',
    short: 'MT4',
    auth: 'metaapi',
    sandbox: false,
    isMt: true,
    defaultSymbol: 'BTCUSD',
    base: 'BTC',
    quote: 'USD',
    unit: 'Lot',
    defaultAmount: 0.01,
    minAmount: 0.01,
    maxAmount: 50,
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
  .filter(Boolean); // kosong = semua orang boleh
const KEY = Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex');

if (!TOKEN || !MONGO_URI || KEY.length !== 32) {
  console.error('Wajib diisi: TG_BOT_TOKEN, MONGO_URI, ENCRYPTION_KEY (64 karakter hex)');
  process.exit(1);
}

// ---------- Enkripsi Kredensial Broker (AES-256-GCM) ----------
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
let tradesCol = null;
const users = new Map(); // id -> dokumen user (cache di memori)
const runtimes = new Map(); // id -> { busy, adapter, adapterKey, bal, balAt, fails, save }

const rt = (id) => {
  if (!runtimes.has(id)) {
    runtimes.set(id, { busy: false, adapter: null, adapterKey: '', bal: null, balAt: 0, fails: 0, save: null });
  }
  return runtimes.get(id);
};

function getBrokerCfg(brokerId) {
  return BROKERS[brokerId] || BROKERS.binance_testnet;
}

function getUserSymbol(u) {
  const cfg = getBrokerCfg(u.broker);
  if (cfg.isMt) {
    const k = getActiveKeyObj(u);
    return (k && k.mtSymbol) || u.mtSymbol || cfg.defaultSymbol;
  }
  return cfg.defaultSymbol;
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
  return {
    _id: String(from.id),
    name: from.first_name || from.username || 'User',
    username: from.username || '',
    createdAt: new Date(),
    broker: 'binance_testnet',
    mtSymbol: 'BTCUSD',
    keys: null, // kompatibilitas lama
    brokerKeys: {}, // { binance_testnet: {...}, binance: {...}, mt5: {...}, mt4: {...} }
    isAutoTrade: false,
    position: null, // { amount, cost, entry, ids, broker, symbol, contractSize }
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
    broker: BROKERS[doc.broker] ? doc.broker : 'binance_testnet',
    brokerKeys: { ...(doc.brokerKeys || {}) },
    settings: { ...DEFAULT_SETTINGS, ...(doc.settings || {}) },
  };
  // Migrasi format keys lama ke brokerKeys
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

function logTrade(u, side, price, amount, pnl, note) {
  tradesCol
    .insertOne({
      userId: u._id,
      broker: u.broker,
      symbol: getUserSymbol(u),
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
    if (from.first_name && u.name !== from.first_name) u.name = from.first_name;
    return u;
  }
  if (WHITELIST.length && !WHITELIST.includes(id)) return null;
  if (users.size >= MAX_USERS) return null;
  u = newUser(from);
  users.set(id, u);
  await usersCol.insertOne(u).catch((e) => console.error('Insert user:', e.message));
  return u;
}

// ---------- Worker Pool untuk Multi-User ----------
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

// ---------- Ikon emas berkilau (tanpa emoji berwarna) ----------
const TWINKLE = ['✦', '✧', '✶', '✷'];
const tw = () => TWINKLE[Math.floor(Date.now() / 1000) % TWINKLE.length];
const GLYPH = { dash: '◈', buy: '▲', sell: '▼', power: '⏻', refresh: '⟳', key: '⚿', broker: '⇄' };
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
      console.error('Ikon/warna tombol ditolak Telegram, pakai simbol biasa:', e.message);
      return fn();
    }
    throw e;
  }
}

// ---------- Helper ----------
const todayKey = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const jakartaHour = () =>
  Number(new Date().toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: TZ })) % 24;
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
const hhmm = (t) =>
  new Date(t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg, code) => Object.assign(new Error(msg), { code });

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

// ---------- Kunci proses per user (cegah beli/jual bersamaan) ----------
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

// ---------- Adapter Broker Terpadu (Binance Testnet, Binance Live, MT5, MT4) ----------
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
    async balance() {
      const b = await ex.fetchBalance();
      const usdt = b.USDT ? Number(b.USDT.free) || 0 : 0;
      const btc = b[BASE] ? Number(b[BASE].free) || 0 : 0;
      return { quote: usdt, base: btc, equity: null, currency: 'USDT' };
    },
    async candles(s, tf, n) {
      return ex.fetchOHLCV(s, tf, undefined, n);
    },
    async marketBuy(s, amount) {
      let order = await ex.createMarketBuyOrder(s, amount);
      if (!order.filled && order.id) {
        try {
          order = await ex.fetchOrder(order.id, s);
        } catch (e) {}
      }
      const filled = Number(order.filled) || Number(amount);
      const price = Number(order.average || order.price) || 0;
      const feeBase = (order.fees || [])
        .filter((f) => f.currency === BASE)
        .reduce((sum, f) => sum + (Number(f.cost) || 0), 0);
      const got = Math.max(0, filled - feeBase);
      const cost = Number(order.cost) || price * filled;
      return { price, filled: got, cost, contractSize: 1, positionId: order.id ? String(order.id) : null, symbol: s };
    },
    async marketSell(s, amount, pos) {
      const b = await ex.fetchBalance();
      const free = b[BASE] ? Number(b[BASE].free) || 0 : 0;
      const target = pos && pos.amount ? Math.min(pos.amount, free) : free;
      const qty = Number(ex.amountToPrecision(s, target));
      if (!(qty > 0)) throw new Error(`Saldo ${BASE} tidak cukup untuk dijual`);
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

// ---------- Data Pasar Terbagi (Multi-User Market Cache) ----------
const marketCache = new Map(); // cacheKey -> { data, at, p }

function computeMarketFromCandles(candles, overridePrice) {
  const closes = candles.map((c) => Number(c[4]));
  const times = candles.map((c) => Number(c[0]));
  if (Number.isFinite(overridePrice) && overridePrice > 0 && closes.length) {
    closes[closes.length - 1] = overridePrice;
  }
  const rsiSeries = RSI.calculate({ values: closes, period: RSI_PERIOD });
  return {
    rsi: rsiSeries[rsiSeries.length - 1],
    rsiSeries,
    price: closes[closes.length - 1],
    closes,
    times,
  };
}

async function getPublicMarket(sandbox = true) {
  const key = sandbox ? 'pub:testnet:BTC/USDT' : 'pub:live:BTC/USDT';
  const entry = marketCache.get(key) || { data: null, at: 0, p: null };
  if (entry.data && Date.now() - entry.at < 10000) return entry.data;
  if (entry.p) return entry.p;

  const ex = sandbox ? pubTestnet : pubLive;
  entry.p = (async () => {
    try {
      const candles = await ex.fetchOHLCV(SYMBOL, TIMEFRAME, undefined, 100);
      entry.data = computeMarketFromCandles(candles);
      entry.at = Date.now();
      return entry.data;
    } catch (e) {
      // Fallback lintas feed publik jika salah satu gangguan
      const fallbackEx = sandbox ? pubLive : pubTestnet;
      const candles = await fallbackEx.fetchOHLCV(SYMBOL, TIMEFRAME, undefined, 100);
      entry.data = computeMarketFromCandles(candles);
      entry.at = Date.now();
      return entry.data;
    }
  })().finally(() => {
    entry.p = null;
  });
  marketCache.set(key, entry);
  return entry.p;
}

async function getMarketForUser(u) {
  const cfg = getBrokerCfg(u.broker);
  if (!cfg.isMt) {
    return getPublicMarket(cfg.sandbox);
  }
  const ad = getAdapter(u);
  const sym = getUserSymbol(u);
  if (!ad) {
    return getPublicMarket(false);
  }
  const k = getActiveKeyObj(u);
  const cacheKey = `mt:${k && k.region ? k.region : 'sg'}:${sym}:${TIMEFRAME}`;
  const entry = marketCache.get(cacheKey) || { data: null, at: 0, p: null };
  if (entry.data && Date.now() - entry.at < 10000) return entry.data;
  if (entry.p) return entry.p;

  entry.p = (async () => {
    try {
      const candles = await ad.candles(sym, TIMEFRAME, 100);
      entry.data = computeMarketFromCandles(candles);
      entry.at = Date.now();
      return entry.data;
    } catch (e) {
      // Jika endpoint historical candle MetaApi belum aktif di broker tsb,
      // gunakan candle publik + harga live dari MT4/MT5 agar grafik & RSI tetap jalan
      const baseMkt = await getPublicMarket(false);
      let livePrice = baseMkt.price;
      try {
        const pr = await ad.price(sym);
        livePrice = Number(pr.bid || pr.ask) || livePrice;
      } catch (err) {}
      const closes = [...baseMkt.closes];
      if (closes.length && livePrice) closes[closes.length - 1] = livePrice;
      const rsiSeries = RSI.calculate({ values: closes, period: RSI_PERIOD });
      entry.data = {
        rsi: rsiSeries[rsiSeries.length - 1],
        rsiSeries,
        price: livePrice,
        closes,
        times: baseMkt.times,
      };
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
  const cfg = getBrokerCfg(u.broker);
  if (!ad) return { usdt: 0, btc: 0, equity: 0, currency: cfg.quote, floatingPnl: null };
  const r = rt(u._id);
  if (r.bal && Date.now() - r.balAt < 8000) return r.bal;
  const b = await ad.balance(getUserSymbol(u));
  r.bal = {
    usdt: Number(b.quote) || 0,
    btc: Number(b.base) || 0,
    equity: b.equity !== null && b.equity !== undefined ? Number(b.equity) : null,
    currency: b.currency || cfg.quote,
    server: b.server || '',
    floatingPnl: typeof b.floatingPnl === 'number' ? b.floatingPnl : null,
  };
  r.balAt = Date.now();
  return r.bal;
}

// ---------- Eksekusi BUY & SELL pada Broker Aktif ----------
async function buy(u, note) {
  const ad = requireAdapter(u);
  const cfg = getBrokerCfg(u.broker);
  const sym = getUserSymbol(u);
  const amount = Number(u.settings.amount) || cfg.defaultAmount;
  const order = await ad.marketBuy(sym, amount);
  const got = Number(order.filled) || amount;
  const m = await getMarketForUser(u);
  const price = Number(order.price) || m.price;
  const contractSize = Number(order.contractSize) || 1;
  const cost = Number(order.cost) || price * got * contractSize;

  const pos = u.position || { amount: 0, cost: 0, ids: [], broker: u.broker, symbol: sym, contractSize };
  pos.amount = Number((pos.amount + got).toFixed(6));
  pos.cost += cost;
  pos.contractSize = contractSize;
  pos.entry = pos.cost / (pos.amount * contractSize);
  pos.broker = u.broker;
  pos.symbol = order.symbol || sym;
  if (order.positionId) {
    pos.ids = [...new Set([...(pos.ids || []), String(order.positionId)])];
  }
  u.position = pos;
  ensureToday(u);
  u.today.trades++;
  rt(u._id).balAt = 0;
  saveUser(u);
  logTrade(u, 'BUY', price, got, 0, note);
  return { price, got, unit: cfg.unit, symbol: pos.symbol };
}

async function sellPosition(u, note) {
  const pos = u.position;
  if (!pos || pos.amount <= 0) return null;
  const ad = requireAdapter(u);
  const cfg = getBrokerCfg(u.broker);
  const sym = pos.symbol || getUserSymbol(u);
  const res = await ad.marketSell(sym, pos.amount, pos);
  const m = await getMarketForUser(u);
  const price = Number(res.price) || m.price;
  const qty = Number(res.qty) || pos.amount;
  const pnl = Number.isFinite(res.pnl) ? Number(res.pnl) : (price - pos.entry) * qty * (pos.contractSize || 1);

  u.realizedPnl += pnl;
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
  return { price, qty, pnl, unit: cfg.unit, quote: cfg.quote, symbol: sym };
}

// ---------- Aksi (dipakai bot DAN mini app) ----------
const SRC = { bot: 'via bot', app: 'via Mini App', auto: 'otomatis' };

const actionBuy = (u, src) =>
  withLock(u, async () => {
    const cfg = getBrokerCfg(u.broker);
    const r = await buy(u, `manual ${src}`);
    await notify(
      u,
      `▲ <b>BUY berhasil</b> (${SRC[src]} · ${cfg.short})\n${esc(r.symbol)}\n` +
        `▣ <code>${cfg.isMt ? r.got.toFixed(2) : r.got.toFixed(6)}</code> ${cfg.unit} @ <code>${fmt(r.price)}</code>`
    );
    return r;
  });

const actionSell = (u, src) =>
  withLock(u, async () => {
    const cfg = getBrokerCfg(u.broker);
    const r = await sellPosition(u, `manual ${src}`);
    if (r) {
      await notify(
        u,
        `▼ <b>SELL berhasil</b> (${SRC[src]} · ${cfg.short})\n` +
          `▣ <code>${cfg.isMt ? Number(r.qty).toFixed(2) : r.qty}</code> ${cfg.unit} @ <code>${fmt(r.price)}</code>\n` +
          `${dot(r.pnl)} PnL: <b>${sign(r.pnl, 4)} ${cfg.quote}</b>`
      );
    }
    return r;
  });

function setAuto(u, on, src) {
  const cfg = getBrokerCfg(u.broker);
  if (on && !hasBrokerKeys(u)) throw fail(`Hubungkan kredensial ${cfg.name} dulu`, 'NOKEY');
  u.isAutoTrade = !!on;
  rt(u._id).fails = 0;
  saveUser(u);
  notify(u, `⏻ Auto-Trade (${cfg.short}) sekarang: <b>${u.isAutoTrade ? 'AKTIF ●' : 'NONAKTIF ○'}</b> (${SRC[src]})`);
}

function selectBroker(u, brokerId, mtSymbolInput) {
  if (!BROKERS[brokerId]) throw new Error('Pilihan broker tidak valid');
  if (u.position && u.broker !== brokerId) {
    throw new Error(`Tutup posisi aktif di ${getBrokerCfg(u.broker).name} dulu sebelum mengganti broker`);
  }
  const prevCfg = getBrokerCfg(u.broker);
  const nextCfg = getBrokerCfg(brokerId);
  u.broker = brokerId;

  if (nextCfg.isMt && mtSymbolInput) {
    const clean = String(mtSymbolInput).replace(/[^a-zA-Z0-9._#-]/g, '').toUpperCase();
    if (clean.length >= 3 && clean.length <= 16) {
      u.mtSymbol = clean;
      if (u.brokerKeys && u.brokerKeys[brokerId]) {
        u.brokerKeys[brokerId].mtSymbol = clean;
      }
    }
  }

  // Sesuaikan jumlah order default saat berpindah antara Spot (BTC) dan MetaTrader (Lot)
  if (prevCfg.isMt !== nextCfg.isMt) {
    u.settings.amount = nextCfg.defaultAmount;
  } else if (u.settings.amount < nextCfg.minAmount || u.settings.amount > nextCfg.maxAmount) {
    u.settings.amount = nextCfg.defaultAmount;
  }

  // Jika broker tujuan belum punya kredensial, matikan auto-trade
  if (!hasBrokerKeys(u, brokerId)) {
    u.isAutoTrade = false;
  }

  const r = rt(u._id);
  r.adapter = null;
  r.adapterKey = '';
  r.bal = null;
  r.balAt = 0;
  r.fails = 0;
  saveUser(u);
  return nextCfg;
}

function applySettings(u, input) {
  const cfg = getBrokerCfg(u.broker);
  const lim = {
    amount: [cfg.minAmount, cfg.maxAmount],
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
  if (cfg.isMt && input.mtSymbol !== undefined) {
    const clean = String(input.mtSymbol || '').replace(/[^a-zA-Z0-9._#-]/g, '').toUpperCase();
    if (clean.length >= 3 && clean.length <= 16) {
      u.mtSymbol = clean;
      if (u.brokerKeys && u.brokerKeys[u.broker]) u.brokerKeys[u.broker].mtSymbol = clean;
    }
  }
  u.settings = out;
  saveUser(u);
  return out;
}

async function saveKeys(u, body = {}) {
  const targetBroker = BROKERS[body.broker] ? body.broker : u.broker;
  if (u.position && u.broker !== targetBroker) {
    throw new Error(`Jual posisi aktif di ${getBrokerCfg(u.broker).name} dulu sebelum pindah broker`);
  }
  const cfg = selectBroker(u, targetBroker, body.mtSymbol);

  if (cfg.isMt) {
    const token = String(body.token || body.apiKey || '').trim();
    const accountId = String(body.accountId || body.secret || '').trim();
    const region = String(body.region || 'singapore').trim().toLowerCase();
    const mtSymbol = String(body.mtSymbol || u.mtSymbol || cfg.defaultSymbol)
      .replace(/[^a-zA-Z0-9._#-]/g, '')
      .toUpperCase();

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
    u.mtSymbol = mtSymbol || 'BTCUSD';
    u.brokerKeys[cfg.id] = {
      broker: cfg.id,
      token: enc(token),
      id: enc(accountId),
      region: info.region || region || 'singapore',
      mtSymbol: u.mtSymbol,
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
        `Simbol: <code>${esc(u.mtSymbol)}</code> · Region: <code>${esc(info.region)}</code>`,
      true
    );
    return { broker: cfg.id, region: info.region, serverName: info.broker || info.server };
  }

  // Binance Testnet atau Binance Live
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

// ---------- Snapshot data (untuk Mini App & pesan status) ----------
async function snapshot(u) {
  const cfg = getBrokerCfg(u.broker);
  const sym = getUserSymbol(u);
  const hasKeys = hasBrokerKeys(u);
  const kObj = getActiveKeyObj(u);

  const m = await getMarketForUser(u);
  let bal = { usdt: 0, btc: 0, equity: null, currency: cfg.quote, server: '', floatingPnl: null };
  let keyError = null;
  if (hasKeys) {
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
      unit: cfg.unit,
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

  return {
    broker: cfg.id,
    brokerName: cfg.name,
    brokerShort: cfg.short,
    authType: cfg.auth,
    isMt: cfg.isMt,
    unit: cfg.unit,
    quote: bal.currency || cfg.quote,
    mtRegion: (kObj && kObj.region) || 'singapore',
    mtServer: bal.server || (kObj && kObj.serverName) || '',
    mtSymbol: u.mtSymbol || 'BTCUSD',
    connectedBrokers,
    brokers: Object.values(BROKERS),
    symbol: sym,
    base: cfg.base,
    timeframe: TIMEFRAME,
    name: u.name,
    hasKeys,
    keyError,
    price: m.price,
    rsi: m.rsi,
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
      labels: m.times.slice(-n).map(hhmm),
      closes: m.closes.slice(-n),
      rsi: m.rsiSeries.slice(-n),
    },
    busy: rt(u._id).busy,
    updatedAt: Date.now(),
  };
}

function statusText(u, s) {
  const pos = s.position;
  const amtFmt = s.isMt ? Number(pos ? pos.amount : 0).toFixed(2) : Number(pos ? pos.amount : 0).toFixed(6);
  const posText = pos
    ? `▣ <code>${amtFmt}</code> ${s.unit} @ <code>${fmt(pos.entry)}</code>\n` +
      `${dot(pos.floating)} Floating: <b>${sign(pos.floating)} ${s.quote}</b> (${sign(pos.pct)}%)`
    : '▢ Tidak ada posisi';
  const rsi = s.rsi;
  const balLine = s.isMt
    ? `❖ <b>Akun (${esc(s.brokerName)})</b>\n` +
      `$ Saldo: <code>${fmt(s.usdt)} ${s.quote}</code>\n` +
      `◈ Equity: <code>${fmt(s.total)} ${s.quote}</code>\n` +
      `▣ Lot Terbuka: <code>${Number(s.btc || 0).toFixed(2)} Lot</code>\n\n`
    : `❖ <b>Akun (${esc(s.brokerName)})</b>\n` +
      `$ ${s.quote}: <code>${fmt(s.usdt)}</code>\n` +
      `₿ ${s.base}: <code>${Number(s.btc || 0).toFixed(6)}</code>\n` +
      `Σ Total: <b>${fmt(s.total)} ${s.quote}</b>\n\n`;

  const akun = s.hasKeys
    ? balLine +
      `⌖ <b>Posisi bot</b>\n${posText}\n\n` +
      `${dot(s.realizedPnl)} Profit tertutup: <b>${sign(s.realizedPnl)} ${s.quote}</b>\n` +
      `⏻ Auto-Trade: <b>${s.isAutoTrade ? 'ON ●' : 'OFF ○'}</b>\n`
    : `⚿ <i>Belum terhubung ke ${esc(s.brokerName)}. Buka Dashboard untuk menyambungkan broker.</i>\n`;

  return (
    `◈ <b>${esc(s.symbol)}</b> · ${esc(s.brokerName)} ${tw()}\n` +
    `━━━━━━━━━━━━━━\n` +
    `◆ Harga: <code>${fmt(s.price)}</code>\n` +
    `∿ RSI(${RSI_PERIOD}): <code>${rsi ? rsi.toFixed(1) : '-'}</code> ${rsi ? rsiLabel(u, rsi) : ''}\n` +
    `${rsi ? `<code>${rsiBar(rsi)}</code>\n` : ''}\n` +
    akun +
    `◷ ${new Date().toLocaleTimeString('id-ID', { timeZone: TZ })} WIB`
  );
}

function panelKeyboard(u) {
  const cfg = getBrokerCfg(u.broker);
  const rows = [];
  if (WEBAPP_URL) rows.push([btn('dash', 'Buka Dashboard', { web_app: { url: WEBAPP_URL } }, 'primary')]);
  if (hasBrokerKeys(u)) {
    rows.push([
      btn('buy', `Buy ${u.settings.amount} ${cfg.unit}`, { callback_data: 'manual_buy' }, 'success'),
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
    btn('broker', `Broker: ${cfg.short}`, { callback_data: 'cycle_broker' }),
    btn('refresh', 'Refresh', { callback_data: 'refresh' }),
  ]);
  return { inline_keyboard: rows };
}

async function sendPanel(u) {
  const s = await snapshot(u);
  return tgSafe(() =>
    bot.sendMessage(u._id, statusText(u, s), { parse_mode: 'HTML', reply_markup: panelKeyboard(u) })
  );
}

async function refreshPanel(u, message) {
  try {
    const s = await snapshot(u);
    await tgSafe(() =>
      bot.editMessageText(statusText(u, s), {
        chat_id: message.chat.id,
        message_id: message.message_id,
        parse_mode: 'HTML',
        reply_markup: panelKeyboard(u),
      })
    );
  } catch (err) {
    if (!/not modified/i.test(err.message)) console.error('Refresh panel:', err.message);
  }
}

// ---------- Perintah & tombol Telegram ----------
bot.onText(/^\/(menu|start|status|broker)(@\w+)?/, async (msg) => {
  if (msg.chat.type !== 'private') return;
  const u = await ensureUser(msg.from);
  if (!u) return bot.sendMessage(msg.chat.id, '✕ Akses ditolak atau kuota pengguna penuh.');
  try {
    if (!hasBrokerKeys(u) && /^\/start/.test(msg.text)) {
      await bot.sendMessage(
        msg.chat.id,
        `✦ Halo <b>${esc(u.name)}</b>!\n\n` +
          `<b>AFEX TRADE BOT</b> mendukung multi-broker:\n` +
          `◈ <b>Binance Testnet</b> (Simulasi Spot)\n` +
          `◈ <b>Binance Live</b> (Real Spot)\n` +
          `◈ <b>MetaTrader 5 (MT5)</b> via MetaApi\n` +
          `◈ <b>MetaTrader 4 (MT4)</b> via MetaApi\n\n` +
          `1⃣ Buka <b>Dashboard</b> di bawah\n` +
          `2⃣ Pilih broker yang ingin digunakan & hubungkan kredensial\n` +
          `3⃣ Nyalakan Auto-Trade atau eksekusi manual`,
        { parse_mode: 'HTML' }
      );
    }
    await sendPanel(u);
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
    if (q.data === 'manual_buy') await actionBuy(u, 'bot');
    else if (q.data === 'manual_sell') {
      const r = await actionSell(u, 'bot');
      if (!r) await notify(u, '▢ Tidak ada posisi bot untuk dijual.');
    } else if (q.data === 'toggle_auto') {
      setAuto(u, !u.isAutoTrade, 'bot');
    } else if (q.data === 'cycle_broker') {
      const order = Object.keys(BROKERS);
      const nextIdx = (order.indexOf(u.broker) + 1) % order.length;
      const nextCfg = selectBroker(u, order[nextIdx]);
      await notify(
        u,
        `⇄ Broker aktif diganti ke <b>${esc(nextCfg.name)}</b> (${hasBrokerKeys(u) ? 'Terhubung ●' : 'Belum terhubung ○'})`,
        true
      );
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
app.use(express.json({ limit: '15kb' }));

if (ALLOWED_ORIGIN) {
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.set('Access-Control-Allow-Headers', 'Content-Type, x-init-data');
    res.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

app.get('/', (req, res) => res.send('AFEX Trade Bot Multi-Broker API'));
app.get('/health', (req, res) => res.send('ok'));

// Validasi initData Telegram (HMAC)
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

// Pembatas request sederhana: 90 request / menit / user
const hits = new Map();
setInterval(() => hits.clear(), 60 * 1000).unref();

app.use('/api', async (req, res, next) => {
  const tgUser = verifyInitData(req.get('x-init-data'));
  if (!tgUser) return res.status(401).json({ ok: false, error: 'Buka lewat Telegram (data tidak valid)' });
  const n = (hits.get(tgUser.id) || 0) + 1;
  hits.set(tgUser.id, n);
  if (n > 90) return res.status(429).json({ ok: false, error: 'Terlalu banyak permintaan, tunggu sebentar' });
  const u = await ensureUser(tgUser);
  if (!u) return res.status(403).json({ ok: false, error: 'Akses ditolak atau kuota pengguna penuh' });
  req.user = u;
  next();
});

const h = (fn) => async (req, res) => {
  try {
    res.json({ ok: true, ...(await fn(req.user, req)) });
  } catch (e) {
    res.status(e.code === 'BUSY' ? 409 : 400).json({ ok: false, error: e.message });
  }
};

app.get('/api/status', h(async (u) => ({ data: await snapshot(u) })));

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
  '/api/buy',
  h(async (u) => {
    const cfg = getBrokerCfg(u.broker);
    const r = await actionBuy(u, 'app');
    return {
      message: `BUY ${cfg.isMt ? r.got.toFixed(2) : r.got.toFixed(6)} ${cfg.unit} @ ${fmt(r.price)}`,
    };
  })
);

app.post(
  '/api/sell',
  h(async (u) => {
    const cfg = getBrokerCfg(u.broker);
    const r = await actionSell(u, 'app');
    if (!r) throw new Error('Tidak ada posisi bot untuk dijual');
    return {
      message: `SELL ${cfg.isMt ? Number(r.qty).toFixed(2) : r.qty} ${cfg.unit} @ ${fmt(r.price)} · PnL ${sign(r.pnl, 4)} ${cfg.quote}`,
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
    const cfg = getBrokerCfg(u.broker);
    const s = applySettings(u, req.body || {});
    notify(
      u,
      `⚙︎ <b>Pengaturan diperbarui</b> (${cfg.short} · via Mini App)\n` +
        `Jumlah: <code>${s.amount}</code> ${cfg.unit}\nTP: <code>${s.tp}%</code> · SL: <code>${s.sl}%</code>\n` +
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

app.post(
  '/api/send-status',
  h(async (u) => {
    const s = await snapshot(u);
    await tgSafe(() =>
      bot.sendMessage(u._id, `➤ <b>Status dikirim dari Mini App</b>\n\n${statusText(u, s)}`, {
        parse_mode: 'HTML',
        reply_markup: panelKeyboard(u),
      })
    );
    return { message: 'Status terkirim ke chat bot' };
  })
);

// ---------- Loop auto-trade (Multi-User Concurrent Pool) ----------
async function tickUser(u) {
  const r = rt(u._id);
  if (r.busy || !hasBrokerKeys(u)) return;
  try {
    const m = await getMarketForUser(u);
    if (!m || !Number.isFinite(m.rsi)) return;
    const cfg = getBrokerCfg(u.broker);

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
              `▼ <b>AUTO SELL</b> (${cfg.short})\n${reason}\n` +
                `▣ <code>${cfg.isMt ? Number(res.qty).toFixed(2) : res.qty}</code> ${cfg.unit} @ <code>${fmt(res.price)}</code>\n` +
                `${dot(res.pnl)} PnL: <b>${sign(res.pnl, 4)} ${cfg.quote}</b>`
            );
          }
        }
      } else if (rsi < rsiBuy && Date.now() - (u.lastSellAt || 0) > COOLDOWN_MIN * 60000) {
        const res = await buy(u, `RSI ${rsi.toFixed(2)}`);
        await notify(
          u,
          `▲ <b>AUTO BUY</b> (${cfg.short})\n▽ RSI ${rsi.toFixed(1)} di bawah ${rsiBuy}\n` +
            `▣ <code>${cfg.isMt ? res.got.toFixed(2) : res.got.toFixed(6)}</code> ${cfg.unit} @ <code>${fmt(res.price)}</code>`
        );
      }
    });
    r.fails = 0;
  } catch (err) {
    if (err.code === 'BUSY') return;
    console.error(`Auto-trade ${u._id} (${u.broker}):`, err.message);
    if (++r.fails >= MAX_AUTO_FAILS) {
      u.isAutoTrade = false;
      r.fails = 0;
      saveUser(u);
      notify(u, `⚠︎ Auto-Trade (${getBrokerCfg(u.broker).short}) dimatikan karena error berulang:\n<code>${esc(err.message)}</code>`);
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

// ---------- Status berkala (hanya user Auto ON) ----------
if (STATUS_INTERVAL_MIN > 0) {
  setInterval(async () => {
    const active = [...users.values()].filter((u) => u.isAutoTrade && hasBrokerKeys(u));
    await runPool(active, 4, async (u) => {
      await sendPanel(u).catch((e) => console.error('Status:', e.message));
      await sleep(120);
    });
  }, STATUS_INTERVAL_MIN * 60 * 1000);
}

// ---------- Laporan harian ----------
setInterval(async () => {
  if (jakartaHour() !== DAILY_REPORT_HOUR) return;
  for (const u of users.values()) {
    ensureToday(u);
    if (u.today.reported || (!u.isAutoTrade && u.today.trades === 0)) continue;
    const cfg = getBrokerCfg(u.broker);
    u.today.reported = true;
    saveUser(u);
    await notify(
      u,
      `▤ <b>Laporan harian ${u.today.date}</b> (${cfg.short})\n` +
        `⇄ Transaksi: <b>${u.today.trades}</b>\n` +
        `${dot(u.today.pnl)} Profit hari ini: <b>${sign(u.today.pnl)} ${cfg.quote}</b>\n` +
        `▣ Total tertutup: <b>${sign(u.realizedPnl)} ${cfg.quote}</b>`
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
    await tradesCol.createIndex({ userId: 1, time: -1 });
    await usersCol.createIndex({ isAutoTrade: 1 });
    for (const doc of await usersCol.find({}).toArray()) {
      users.set(doc._id, normalizeUserDoc(doc));
    }
    console.log(`MongoDB terhubung · ${users.size} user dimuat`);
  } catch (err) {
    console.error('Gagal koneksi MongoDB:', err.message);
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', () => console.log(`Web server di port ${PORT}`));
  bot.startPolling();

  try {
    await pubTestnet.loadMarkets();
    console.log('Terhubung ke Binance Testnet & Multi-Broker Engine siap');
    await bot.setMyCommands([
      { command: 'menu', description: '◈ Buka panel trading' },
      { command: 'status', description: '⟳ Status & posisi terbaru' },
      { command: 'broker', description: '⇄ Info & ganti broker' },
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

// Shutdown rapi (Render mengirim SIGTERM saat deploy) agar polling tidak bentrok
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
'use strict';
// Adapter MetaTrader 4 & MetaTrader 5 lewat MetaApi Cloud (REST).
// Mendukung multi-user, auto-deteksi region server, resolusi multi-alias simbol
// (BTC, ETH, BNB, XAUUSD, Minyak USOIL/WTI, Gas XNGUSD/NGAS, dll.),
// normalisasi lot/volume, sinkronisasi posisi terbuka, dan fallback data candle.

const REGIONS = ['new-york', 'london', 'singapore'];
const OK_CODES = ['TRADE_RETCODE_DONE', 'TRADE_RETCODE_PLACED', 'TRADE_RETCODE_DONE_PARTIAL', '10009', '10008'];
const PROVISION_URL = 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai';

// Daftar sinonim/alias simbol populer di berbagai broker MT4/MT5 (Exness, XM, FBS, Octa, IC Markets, dll.)
const SYMBOL_ALIASES = {
  BTCUSD: ['BTCUSD', 'BTCUSDm', 'BTCUSDT', 'BTCUSD.a', 'BTCUSD#', 'BITCOIN'],
  ETHUSD: ['ETHUSD', 'ETHUSDm', 'ETHUSDT', 'ETHUSD.a', 'ETHUSD#', 'ETHEREUM'],
  BNBUSD: ['BNBUSD', 'BNBUSDm', 'BNBUSDT', 'BNBUSD.a'],
  SOLUSD: ['SOLUSD', 'SOLUSDm', 'SOLUSDT', 'SOLUSD.a'],
  XRPUSD: ['XRPUSD', 'XRPUSDm', 'XRPUSDT', 'XRPUSD.a'],
  XAUUSD: ['XAUUSD', 'XAUUSDm', 'GOLD', 'GOLDm', 'XAUUSD.a', 'XAUUSD#', 'XAUUSD.pro'],
  XAGUSD: ['XAGUSD', 'XAGUSDm', 'SILVER', 'SILVERm', 'XAGUSD.a'],
  USOIL: ['USOIL', 'USOILm', 'WTI', 'XTIUSD', 'XTIUSDm', 'USOUSD', 'CL', 'CRUDE', 'USOIL.a'],
  UKOIL: ['UKOIL', 'UKOILm', 'BRENT', 'XBRUSD', 'XBRUSDm', 'BCOUSD', 'UKOIL.a'],
  XNGUSD: ['XNGUSD', 'XNGUSDm', 'NATGAS', 'NGAS', 'NGASm', 'NATURALGAS', 'XNGUSD.a'],
  EURUSD: ['EURUSD', 'EURUSDm', 'EURUSD.a', 'EURUSD#', 'EURUSD.pro'],
};

async function httpJson(url, token, method = 'GET', body = undefined, timeoutMs = 20000) {
  const res = await fetch(url, {
    method,
    headers: {
      'auth-token': token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let j = {};
  try {
    j = await res.json();
  } catch (e) {
    /* body kosong */
  }
  if (!res.ok) {
    const msg = j.message || j.error || `MetaApi HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return j;
}

// Deteksi region otomatis & pastikan akun sudah ter-deploy di MetaApi
async function detectRegion({ token, id, preferredRegion }) {
  if (process.env.METAAPI_BASE_URL) return preferredRegion || 'new-york';

  try {
    const info = await httpJson(
      `${PROVISION_URL}/users/current/accounts/${encodeURIComponent(id)}`,
      token,
      'GET',
      undefined,
      10000
    );
    if (info && info.state === 'UNDEPLOYED') {
      try {
        await httpJson(
          `${PROVISION_URL}/users/current/accounts/${encodeURIComponent(id)}/deploy`,
          token,
          'POST',
          undefined,
          10000
        );
      } catch (e) {
        /* abaikan jika gagal auto-deploy */
      }
    }
    if (info && info.region && REGIONS.includes(info.region)) {
      return info.region;
    }
  } catch (e) {
    /* lanjut probe ke client API per region */
  }

  const order = [
    ...(REGIONS.includes(preferredRegion) ? [preferredRegion] : []),
    ...REGIONS.filter((r) => r !== preferredRegion),
  ];

  let lastErr = null;
  for (const reg of order) {
    const base = `https://mt-client-api-v1.${reg}.agiliumtrade.ai`;
    try {
      const a = await httpJson(
        `${base}/users/current/accounts/${encodeURIComponent(id)}/account-information`,
        token,
        'GET',
        undefined,
        12000
      );
      if (a && a.balance !== undefined) return reg;
    } catch (e) {
      lastErr = e;
      if (e.status === 401 || e.status === 403) break;
    }
  }
  throw lastErr || new Error('Akun MT4/MT5 tidak ditemukan atau belum terhubung di MetaApi');
}

function create({ token, id, region, kind = 'mt5' }) {
  let activeRegion = REGIONS.includes(region) ? region : 'singapore';
  const sym = encodeURIComponent;
  const acc = `/users/current/accounts/${encodeURIComponent(id)}`;

  let symbolsCache = null;
  let symbolsAt = 0;
  const specCache = new Map();

  const tradeRoot = () =>
    process.env.METAAPI_BASE_URL || `https://mt-client-api-v1.${activeRegion}.agiliumtrade.ai`;
  const marketRoot = () =>
    process.env.METAAPI_BASE_URL || `https://mt-market-data-client-api-v1.${activeRegion}.agiliumtrade.ai`;

  const callTrade = (path, method, body, timeout) =>
    httpJson(tradeRoot() + path, token, method, body, timeout);
  const callMarket = (path, method, body, timeout) =>
    httpJson(marketRoot() + path, token, method, body, timeout);

  async function order(body) {
    const r = await callTrade(`${acc}/trade`, 'POST', body, 25000);
    if (r.stringCode && !OK_CODES.includes(String(r.stringCode)) && !OK_CODES.includes(String(r.numericCode))) {
      throw new Error(r.message || r.stringCode || 'Order ditolak oleh broker MT4/MT5');
    }
    return r;
  }

  // Cari nama simbol yang tepat di broker (mendukung alias seperti USOIL -> WTI / XTIUSDm)
  async function resolveSymbol(rawSymbol) {
    const clean = String(rawSymbol || 'BTCUSD').replace('/', '').trim();
    if (specCache.has(clean)) return specCache.get(clean).symbol;

    try {
      const sp = await callTrade(`${acc}/symbols/${sym(clean)}/specification`, 'GET', undefined, 10000);
      if (sp && sp.symbol) {
        specCache.set(clean, sp);
        return sp.symbol;
      }
    } catch (e) {
      /* lanjut cari di daftar simbol broker */
    }

    try {
      if (!symbolsCache || Date.now() - symbolsAt > 10 * 60 * 1000) {
        const list = await callTrade(`${acc}/symbols`, 'GET', undefined, 12000);
        if (Array.isArray(list)) {
          symbolsCache = list.map((x) => (typeof x === 'string' ? x : x.symbol)).filter(Boolean);
          symbolsAt = Date.now();
        }
      }
      if (symbolsCache && symbolsCache.length) {
        const upperKey = clean.toUpperCase();
        const candidates = SYMBOL_ALIASES[upperKey] || [clean];
        let match = null;

        for (const cand of candidates) {
          const cu = cand.toUpperCase();
          match = symbolsCache.find((s) => s.toUpperCase() === cu);
          if (match) break;
        }
        if (!match) {
          for (const cand of candidates) {
            const cu = cand.toUpperCase();
            match = symbolsCache.find((s) => s.toUpperCase().startsWith(cu));
            if (match) break;
          }
        }
        if (!match) {
          for (const cand of candidates) {
            const cu = cand.toUpperCase();
            match = symbolsCache.find((s) => s.toUpperCase().includes(cu));
            if (match) break;
          }
        }

        if (match) {
          try {
            const sp = await callTrade(`${acc}/symbols/${sym(match)}/specification`, 'GET', undefined, 10000);
            if (sp) {
              specCache.set(clean, sp);
              specCache.set(match, sp);
            }
          } catch (e) {}
          return match;
        }
      }
    } catch (e) {
      /* pakai simbol asli */
    }
    return clean;
  }

  async function getSpec(rawSymbol) {
    const resolved = await resolveSymbol(rawSymbol);
    if (specCache.has(rawSymbol)) return specCache.get(rawSymbol);
    if (specCache.has(resolved)) return specCache.get(resolved);
    try {
      const sp = await callTrade(`${acc}/symbols/${sym(resolved)}/specification`, 'GET', undefined, 10000);
      if (sp) {
        specCache.set(rawSymbol, sp);
        specCache.set(resolved, sp);
        return sp;
      }
    } catch (e) {}
    return { symbol: resolved, minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, contractSize: 1 };
  }

  function normalizeVolume(lots, sp) {
    const min = Number(sp && sp.minVolume) || 0.01;
    const max = Number(sp && sp.maxVolume) || 100;
    const step = Number(sp && sp.volumeStep) || 0.01;
    const clamped = Math.max(min, Math.min(max, Number(lots) || min));
    const steps = Math.round(clamped / step);
    const decimals = (String(step).split('.')[1] || '').length;
    return Number((steps * step).toFixed(Math.max(2, decimals)));
  }

  function matchesAssetSymbol(posSym, targetRaw) {
    if (!posSym || !targetRaw) return false;
    const ps = String(posSym).toUpperCase();
    const tr = String(targetRaw).replace('/', '').toUpperCase();
    if (ps.startsWith(tr) || ps.includes(tr)) return true;
    const aliases = SYMBOL_ALIASES[tr] || [];
    return aliases.some((a) => ps.startsWith(a.toUpperCase()));
  }

  const price = async (s) => {
    const resolved = await resolveSymbol(s);
    return callTrade(`${acc}/symbols/${sym(resolved)}/current-price`, 'GET', undefined, 10000);
  };

  return {
    kind: kind === 'mt4' ? 'mt4' : 'mt5',
    getRegion: () => activeRegion,
    resolveSymbol,

    async check() {
      activeRegion = await detectRegion({ token, id, preferredRegion: activeRegion });
      const a = await callTrade(`${acc}/account-information`, 'GET', undefined, 15000);
      if (a.balance === undefined) {
        throw new Error('Akun MT4/MT5 belum siap atau sedang proses deploy di MetaApi');
      }
      return {
        ...a,
        region: activeRegion,
        platform: a.platform || kind,
        broker: a.broker || a.server || 'MetaTrader',
        currency: a.currency || 'USD',
      };
    },

    async balance(rawSymbol) {
      const [a, openPositions] = await Promise.all([
        callTrade(`${acc}/account-information`, 'GET', undefined, 12000),
        callTrade(`${acc}/positions`, 'GET', undefined, 12000).catch(() => []),
      ]);
      const posList = Array.isArray(openPositions) ? openPositions : [];
      const matched = rawSymbol
        ? posList.filter((p) => matchesAssetSymbol(p.symbol, rawSymbol))
        : posList;
      const totalLots = matched.reduce((s, p) => s + (Number(p.volume) || 0), 0);
      const floatingPnl = matched.reduce(
        (s, p) => s + (Number(p.profit) || 0) + (Number(p.swap) || 0) + (Number(p.commission) || 0),
        0
      );
      return {
        quote: Number(a.balance) || 0,
        base: totalLots,
        equity: Number(a.equity) || Number(a.balance) || 0,
        freeMargin: Number(a.freeMargin) || 0,
        currency: a.currency || 'USD',
        server: a.server || '',
        floatingPnl,
        positions: matched,
      };
    },

    async price(s) {
      return price(s);
    },

    async candles(s, tf, n) {
      const resolved = await resolveSymbol(s);
      const arr = await callMarket(
        `${acc}/historical-market-data/symbols/${sym(resolved)}/timeframes/${tf}/candles?limit=${n}`,
        'GET',
        undefined,
        15000
      );
      if (!Array.isArray(arr) || !arr.length) {
        throw new Error('Data candle historis MT4/MT5 kosong');
      }
      return arr
        .map((c) => [Date.parse(c.time), c.open, c.high, c.low, c.close])
        .filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[4]))
        .sort((a, b) => a[0] - b[0]);
    },

    async marketBuy(s, lots) {
      const sp = await getSpec(s);
      const resolved = sp.symbol || (await resolveSymbol(s));
      const vol = normalizeVolume(lots, sp);
      const r = await order({
        actionType: 'ORDER_TYPE_BUY',
        symbol: resolved,
        volume: vol,
        comment: 'AFEX_BOT',
      });
      let open = 0;
      const pid = r.positionId || r.orderId;
      if (pid) {
        try {
          const p = await callTrade(`${acc}/positions/${encodeURIComponent(pid)}`, 'GET', undefined, 8000);
          open = Number(p.openPrice) || 0;
        } catch (e) {}
      }
      if (!open) {
        try {
          const pr = await price(resolved);
          open = Number(pr.ask || pr.bid) || 0;
        } catch (e) {}
      }
      const contractSize = Number(sp.contractSize) || 1;
      return {
        price: open,
        filled: vol,
        cost: open * vol * contractSize,
        contractSize,
        feeBase: 0,
        positionId: pid ? String(pid) : null,
        symbol: resolved,
      };
    },

    async marketSell(s, lots, pos) {
      const resolved = await resolveSymbol(s);
      const trackedIds = (pos && Array.isArray(pos.ids) ? pos.ids : []).map(String).filter(Boolean);
      let openPositions = [];
      try {
        const list = await callTrade(`${acc}/positions`, 'GET', undefined, 10000);
        if (Array.isArray(list)) openPositions = list;
      } catch (e) {}

      let targets = openPositions.filter((p) => trackedIds.includes(String(p.id)));
      if (!targets.length) {
        targets = openPositions.filter(
          (p) => matchesAssetSymbol(p.symbol, s) && (!p.type || /BUY/i.test(p.type))
        );
      }

      if (!targets.length && !trackedIds.length) {
        throw new Error('Tidak ditemukan posisi terbuka di terminal MT4/MT5');
      }

      let pnl = 0;
      let lastPrice = 0;
      let closedLots = 0;

      if (targets.length) {
        for (const p of targets) {
          pnl += (Number(p.profit) || 0) + (Number(p.swap) || 0) + (Number(p.commission) || 0);
          lastPrice = Number(p.currentPrice || p.openPrice) || lastPrice;
          closedLots += Number(p.volume) || 0;
          await order({ actionType: 'POSITION_CLOSE_ID', positionId: String(p.id) });
        }
      } else {
        for (const pid of trackedIds) {
          try {
            const p = await callTrade(`${acc}/positions/${encodeURIComponent(pid)}`, 'GET', undefined, 8000);
            pnl += (Number(p.profit) || 0) + (Number(p.swap) || 0) + (Number(p.commission) || 0);
            lastPrice = Number(p.currentPrice || p.openPrice) || lastPrice;
            closedLots += Number(p.volume) || 0;
          } catch (e) {}
          await order({ actionType: 'POSITION_CLOSE_ID', positionId: String(pid) });
        }
      }

      if (!lastPrice) {
        try {
          const pr = await price(resolved);
          lastPrice = Number(pr.bid || pr.ask) || 0;
        } catch (e) {}
      }

      return {
        price: lastPrice,
        qty: closedLots || Number(lots) || 0.01,
        pnl,
      };
    },
  };
}

module.exports = { create, detectRegion, REGIONS, SYMBOL_ALIASES };

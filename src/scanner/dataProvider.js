// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE v2 — Data Provider
// Twelve Data API + mock fallback
// Simple inter-call delay instead of spinning rate limiter
// ─────────────────────────────────────────────────────────────────────────────

const axios  = require("axios");
const logger = require("../utils/logger");

const PROVIDER = process.env.DATA_PROVIDER || "mock";
const API_KEY  = process.env.TWELVE_DATA_API_KEY || "";
const BASE_URL = "https://api.twelvedata.com";

// Minimum ms between API calls — free tier = 8/min = 7500ms gap
// Paid Basic = 55/min = ~1100ms gap
// Default: 8000ms (safe for free tier)
const CALL_DELAY_MS = parseInt(process.env.API_CALL_DELAY_MS || "8000");
let lastCallTime = 0;

async function throttledGet(url, params) {
  const now     = Date.now();
  const elapsed = now - lastCallTime;
  if (lastCallTime > 0 && elapsed < CALL_DELAY_MS) {
    const wait = CALL_DELAY_MS - elapsed;
    logger.debug("Throttle: waiting " + wait + "ms before next API call");
    await sleep(wait);
  }
  lastCallTime = Date.now();
  logger.debug("API call: " + (params.symbol || "") + " " + (params.interval || "price"));
  return axios.get(url, { params, timeout: 15000, validateStatus: () => true });
}

// ── Cache (3-min TTL) ─────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 3 * 60 * 1000;

function fromCache(key) {
  const h = cache.get(key);
  return h && Date.now() - h.ts < CACHE_TTL ? h.data : null;
}
function toCache(key, data) { cache.set(key, { data, ts: Date.now() }); }

// ── Symbol mapping ────────────────────────────────────────────────────────────
const SYMBOL_MAP = {
  "USOIL":   "WTI/USD",
  "NAS100":  "NDX",
  "US30":    "DJI",
  "GER40":   "DAX",
};
function resolveSymbol(sym) { return SYMBOL_MAP[sym] || sym; }

// ── Timeframe fallbacks (1week may not be on free tier) ───────────────────────
const TF_FALLBACKS = {
  "1week": ["1week", "1day"],
};

// ── Public API ────────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, count = 10) {
  if (PROVIDER === "mock") return mockCandles(symbol, interval, count);

  const cacheKey = symbol + "_" + interval;
  const cached = fromCache(cacheKey);
  if (cached) { logger.debug("Cache hit: " + cacheKey); return cached; }

  const toTry = TF_FALLBACKS[interval] || [interval];
  for (const tf of toTry) {
    const data = await fetchTwelveCandles(symbol, tf, count);
    if (data && data.length > 0) {
      toCache(cacheKey, data);
      if (tf !== interval) logger.info(symbol + ": " + interval + " unavailable, using " + tf);
      return data;
    }
  }
  return null;
}

async function fetchCurrentPrice(symbol) {
  if (PROVIDER === "mock") return mockPrice(symbol);

  // Check 5min cache first — avoids extra API call
  const cached = fromCache(symbol + "_5min");
  if (cached && cached.length > 0) {
    return cached[cached.length - 1].close;
  }

  // Try price endpoint
  const price = await fetchTwelvePrice(symbol);
  if (price !== null) return price;

  // Fallback: derive from 5min candle
  logger.warn(symbol + ": /price failed, deriving from candle");
  const candles = await fetchTwelveCandles(symbol, "5min", 2);
  if (candles && candles.length > 0) {
    toCache(symbol + "_5min", candles);
    return candles[candles.length - 1].close;
  }

  return null;
}

async function isTimeframeAvailable(symbol, interval) {
  if (PROVIDER === "mock") return interval !== "1min";
  const data = await fetchTwelveCandles(symbol, interval, 2);
  return !!(data && data.length > 0);
}

// ── Startup check ─────────────────────────────────────────────────────────────

async function validateConnection() {
  if (PROVIDER === "mock") {
    logger.info("Data provider: MOCK");
    return { ok: true, message: "Mock mode — no API key needed" };
  }

  if (!API_KEY || API_KEY === "YOUR_TWELVE_DATA_KEY_HERE" || API_KEY.length < 10) {
    return { ok: false, message: "TWELVE_DATA_API_KEY is not set in Railway Variables" };
  }

  logger.info("Testing Twelve Data connection...");
  try {
    const res = await throttledGet(BASE_URL + "/price", { symbol: "EUR/USD", apikey: API_KEY });
    if (res.status === 401) return { ok: false, message: "Invalid API key (401)" };
    if (res.status === 429) return { ok: false, message: "Rate limited (429) — too many requests" };
    if (res.status === 403) return { ok: false, message: "Forbidden (403) — check API key permissions" };
    if (res.status !== 200) return { ok: false, message: "HTTP " + res.status + ": " + JSON.stringify(res.data).slice(0, 100) };
    if (!res.data || !res.data.price) return { ok: false, message: "Connected but no price in response: " + JSON.stringify(res.data).slice(0, 100) };
    const price = parseFloat(res.data.price);
    return { ok: true, message: "Connected ✅ EUR/USD = " + price };
  } catch (e) {
    return { ok: false, message: "Network error: " + e.message };
  }
}

// ── Twelve Data internals ─────────────────────────────────────────────────────

async function fetchTwelveCandles(symbol, interval, count) {
  const sym = resolveSymbol(symbol);
  try {
    const res = await throttledGet(BASE_URL + "/time_series", {
      symbol:     sym,
      interval,
      outputsize: count,
      apikey:     API_KEY,
      format:     "JSON",
    });

    if (!res) return null;
    if (res.status === 429) { logger.warn(sym + " " + interval + ": rate limited"); return null; }
    if (res.status === 401) { logger.error(sym + " " + interval + ": invalid API key"); return null; }
    if (res.status !== 200) { logger.warn(sym + " " + interval + ": HTTP " + res.status); return null; }

    const d = res.data;
    if (!d || d.status === "error") { logger.warn(sym + " " + interval + ": " + (d && d.message || "error")); return null; }
    if (!d.values || !d.values.length) { logger.warn(sym + " " + interval + ": no values"); return null; }

    return d.values.map(v => ({
      datetime: v.datetime,
      open:  parseFloat(v.open),
      high:  parseFloat(v.high),
      low:   parseFloat(v.low),
      close: parseFloat(v.close),
    })).reverse();

  } catch (e) {
    logger.error(sym + " " + interval + ": " + e.message);
    return null;
  }
}

async function fetchTwelvePrice(symbol) {
  const sym = resolveSymbol(symbol);
  try {
    const res = await throttledGet(BASE_URL + "/price", { symbol: sym, apikey: API_KEY });
    if (!res || res.status !== 200 || !res.data || !res.data.price) return null;
    const p = parseFloat(res.data.price);
    return isNaN(p) ? null : p;
  } catch (e) {
    logger.warn(sym + " price: " + e.message);
    return null;
  }
}

// ── Mock data ─────────────────────────────────────────────────────────────────

const MOCK_BASES = {
  "EUR/USD":1.0850,"GBP/USD":1.2680,"USD/JPY":149.50,"AUD/USD":0.6520,
  "USD/CAD":1.3650,"USD/CHF":0.8820,"NZD/USD":0.6010,"GBP/JPY":190.50,
  "EUR/GBP":0.8560,"EUR/JPY":162.20,"GBP/AUD":1.9430,"AUD/JPY":97.400,
  "EUR/AUD":1.6450,"XAU/USD":2020.0,"XAG/USD":22.800,"USOIL":78.500,
  "WTI/USD":78.500,"SPX":4780.0,"NAS100":16850.0,"US30":37500.0,
  "GER40":16400.0,"BTC/USD":42500.0,"ETH/USD":2280.0,
};

const TF_MS = {
  "1week":7*24*3600000,"1day":24*3600000,"4h":4*3600000,
  "1h":3600000,"15min":900000,"5min":300000,"1min":60000,
};

function mockCandles(symbol, interval, count) {
  const base = MOCK_BASES[symbol] || 1.0;
  const vol  = base * 0.0015;
  const dur  = TF_MS[interval] || 3600000;
  const now  = Date.now();
  const out  = [];
  let price  = base;
  for (let i = count; i >= 1; i--) {
    const move  = (Math.random() - 0.49) * 2 * vol;
    const open  = price;
    const close = price + move;
    const high  = Math.max(open, close) + Math.random() * vol * 0.4;
    const low   = Math.min(open, close) - Math.random() * vol * 0.4;
    out.push({
      datetime: new Date(now - i * dur).toISOString(),
      open: rnd(open,base), high: rnd(high,base),
      low:  rnd(low, base), close:rnd(close,base),
    });
    price = close;
  }
  return out;
}

function mockPrice(symbol) {
  const base = MOCK_BASES[symbol] || 1.0;
  return rnd(base + (Math.random()-0.5)*base*0.001, base);
}

function rnd(n, base) {
  return base >= 100 ? Math.round(n*100)/100 : Math.round(n*100000)/100000;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { fetchCandles, fetchCurrentPrice, isTimeframeAvailable, validateConnection };

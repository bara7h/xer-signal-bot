// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE v2 — Data Provider
// Twelve Data API + mock fallback
// Rate limited: free tier = 8 req/min. We throttle to 6/min to be safe.
// ─────────────────────────────────────────────────────────────────────────────

const axios  = require("axios");
const logger = require("../utils/logger");

const PROVIDER = process.env.DATA_PROVIDER || "mock";
const API_KEY  = process.env.TWELVE_DATA_API_KEY || "";
const BASE_URL = "https://api.twelvedata.com";

// ── Rate limiter — max 6 requests per minute on free tier ────────────────────
const REQUEST_QUEUE = [];
let   REQUESTS_THIS_MINUTE = 0;
const MAX_PER_MINUTE = parseInt(process.env.API_RATE_LIMIT || "6");

setInterval(() => { REQUESTS_THIS_MINUTE = 0; }, 60000);

async function rateLimitedGet(url, params) {
  // If we've hit the limit, wait until next minute window
  while (REQUESTS_THIS_MINUTE >= MAX_PER_MINUTE) {
    logger.debug(`Rate limit reached (${REQUESTS_THIS_MINUTE}/${MAX_PER_MINUTE}) — waiting 10s`);
    await sleep(10000);
  }
  REQUESTS_THIS_MINUTE++;
  logger.debug(`API call #${REQUESTS_THIS_MINUTE} this minute: ${params.symbol} ${params.interval || "price"}`);
  return axios.get(url, { params, timeout: 12000, validateStatus: () => true });
}

// ── Cache (2-min TTL — longer to reduce API calls) ───────────────────────────
const cache = new Map();
const CACHE_TTL = 2 * 60 * 1000;

function fromCache(key) {
  const h = cache.get(key);
  return h && Date.now() - h.ts < CACHE_TTL ? h.data : null;
}
function toCache(key, data) { cache.set(key, { data, ts: Date.now() }); }

// ── Symbol mapping for Twelve Data ───────────────────────────────────────────
// Twelve Data free tier supported symbols:
// Forex: EUR/USD, GBP/USD etc — use slash format
// Gold:  XAU/USD
// Crypto: BTC/USD, ETH/USD
// Indices: SPX, NDX (not NAS100), DJI (not US30), DAX (not GER40)
// Oil: WTI/USD (not USOIL)
// 1week interval: may not be available on free tier — falls back to 1day

const SYMBOL_MAP = {
  "USOIL":   "WTI/USD",
  "WTI/USD": "WTI/USD",
  "SPX":     "SPX",
  "NAS100":  "NDX",
  "US30":    "DJI",
  "GER40":   "DAX",
  "GER40":   "DAX",
};

// Timeframes Twelve Data supports (free tier may not have 1week)
const TF_FALLBACKS = {
  "1week": ["1week", "1day"], // try 1week first, fall back to 1day
};

function resolveSymbol(symbol) {
  return SYMBOL_MAP[symbol] || symbol;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, count = 10) {
  const cacheKey = `${symbol}_${interval}`;
  const cached = fromCache(cacheKey);
  if (cached) { logger.debug(`Cache hit: ${cacheKey}`); return cached; }

  if (PROVIDER === "mock") {
    const data = mockCandles(symbol, interval, count);
    toCache(cacheKey, data);
    return data;
  }

  // Try the interval, fall back if needed
  const intervalsToTry = TF_FALLBACKS[interval] || [interval];
  for (const tf of intervalsToTry) {
    const data = await fetchTwelveCandles(symbol, tf, count);
    if (data && data.length > 0) {
      toCache(cacheKey, data);
      if (tf !== interval) logger.info(`[${symbol}] ${interval} not available — used ${tf} instead`);
      return data;
    }
  }
  return null;
}

async function fetchCurrentPrice(symbol) {
  if (PROVIDER === "mock") return mockPrice(symbol);

  // Check cache for recent candle data first (avoid extra API call)
  const cacheKey5 = `${symbol}_5min`;
  const cached5 = fromCache(cacheKey5);
  if (cached5 && cached5.length > 0) {
    return cached5[cached5.length - 1].close;
  }

  // Try /price endpoint
  const price = await fetchTwelvePrice(symbol);
  if (price !== null) return price;

  // Fallback: get from 5min candle (counts as 1 API call but gives price)
  logger.warn(`[${symbol}] /price failed — fetching 5min candle for price`);
  const candles = await fetchTwelveCandles(symbol, "5min", 2);
  if (candles && candles.length > 0) {
    const p = candles[candles.length - 1].close;
    toCache(cacheKey5, candles);
    return p;
  }

  return null;
}

async function isTimeframeAvailable(symbol, interval) {
  if (PROVIDER === "mock") return interval !== "1min";
  const data = await fetchTwelveCandles(symbol, interval, 2);
  return !!(data && data.length > 0);
}

// ── Startup validation ────────────────────────────────────────────────────────
// Call this once on boot to verify API key and connectivity

async function validateConnection() {
  if (PROVIDER === "mock") {
    logger.info("Data provider: MOCK — no API key needed");
    return { ok: true, message: "Mock mode active" };
  }

  if (!API_KEY) {
    return { ok: false, message: "TWELVE_DATA_API_KEY is not set in environment variables" };
  }

  logger.info("Validating Twelve Data connection...");

  try {
    const res = await rateLimitedGet(`${BASE_URL}/price`, {
      symbol: "EUR/USD",
      apikey: API_KEY,
    });

    if (res.status === 401) return { ok: false, message: "Invalid API key — check TWELVE_DATA_API_KEY" };
    if (res.status === 429) return { ok: false, message: "Rate limit exceeded — wait 1 minute and restart" };
    if (res.status === 403) return { ok: false, message: "Access forbidden — API key may not have required permissions" };
    if (res.status !== 200) return { ok: false, message: `Unexpected HTTP ${res.status}: ${JSON.stringify(res.data).slice(0,100)}` };
    if (!res.data || !res.data.price) return { ok: false, message: `Connected but unexpected response: ${JSON.stringify(res.data).slice(0,100)}` };

    const price = parseFloat(res.data.price);
    logger.info(`Twelve Data connected ✅ EUR/USD = ${price}`);
    return { ok: true, message: `Connected. EUR/USD = ${price}` };

  } catch (e) {
    return { ok: false, message: `Network error: ${e.message}` };
  }
}

// ── Twelve Data implementation ────────────────────────────────────────────────

async function fetchTwelveCandles(symbol, interval, count) {
  const sym = resolveSymbol(symbol);

  const res = await rateLimitedGet(`${BASE_URL}/time_series`, {
    symbol:     sym,
    interval,
    outputsize: count,
    apikey:     API_KEY,
    format:     "JSON",
  });

  if (!res) return null;

  if (res.status === 429) {
    logger.warn(`[${sym}][${interval}] Rate limited (429) — will retry next cycle`);
    return null;
  }
  if (res.status === 401) {
    logger.error(`[${sym}][${interval}] Invalid API key (401)`);
    return null;
  }
  if (res.status !== 200) {
    logger.warn(`[${sym}][${interval}] HTTP ${res.status}: ${JSON.stringify(res.data).slice(0,150)}`);
    return null;
  }

  const data = res.data;
  if (!data) { logger.warn(`[${sym}][${interval}] Empty response`); return null; }
  if (data.status === "error") { logger.warn(`[${sym}][${interval}] API error: ${data.message}`); return null; }
  if (!data.values || !Array.isArray(data.values) || data.values.length === 0) {
    logger.warn(`[${sym}][${interval}] No candle values returned`);
    return null;
  }

  return data.values.map(v => ({
    datetime: v.datetime,
    open:  parseFloat(v.open),
    high:  parseFloat(v.high),
    low:   parseFloat(v.low),
    close: parseFloat(v.close),
  })).reverse(); // newest last
}

async function fetchTwelvePrice(symbol) {
  const sym = resolveSymbol(symbol);

  const res = await rateLimitedGet(`${BASE_URL}/price`, {
    symbol: sym,
    apikey: API_KEY,
  });

  if (!res || res.status !== 200 || !res.data || !res.data.price) return null;

  const price = parseFloat(res.data.price);
  return isNaN(price) ? null : price;
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
  const candles = [];
  let price = base;
  for (let i = count; i >= 1; i--) {
    const ts    = new Date(now - i * dur);
    const move  = (Math.random() - 0.49) * 2 * vol;
    const open  = price;
    const close = price + move;
    const high  = Math.max(open, close) + Math.random() * vol * 0.4;
    const low   = Math.min(open, close) - Math.random() * vol * 0.4;
    candles.push({
      datetime: ts.toISOString(),
      open: rnd(open,base), high: rnd(high,base),
      low:  rnd(low, base), close:rnd(close,base),
    });
    price = close;
  }
  return candles;
}

function mockPrice(symbol) {
  const base = MOCK_BASES[symbol] || 1.0;
  return rnd(base + (Math.random() - 0.5) * base * 0.001, base);
}

function rnd(n, base) {
  if (base >= 100) return Math.round(n * 100) / 100;
  return Math.round(n * 100000) / 100000;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { fetchCandles, fetchCurrentPrice, isTimeframeAvailable, validateConnection };

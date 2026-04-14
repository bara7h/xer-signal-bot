// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE v2 — Data Provider
// Twelve Data API + mock fallback
// Resilient: if price endpoint fails, derives price from last candle close
// ─────────────────────────────────────────────────────────────────────────────

const axios  = require("axios");
const logger = require("../utils/logger");

const PROVIDER = process.env.DATA_PROVIDER || "mock";
const API_KEY  = process.env.TWELVE_DATA_API_KEY || "";
const BASE_URL = "https://api.twelvedata.com";

// ── Cache (1-min TTL per symbol+interval) ────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 60 * 1000;

function fromCache(key) {
  const h = cache.get(key);
  return h && Date.now() - h.ts < CACHE_TTL ? h.data : null;
}
function toCache(key, data) { cache.set(key, { data, ts: Date.now() }); }

// ── Twelve Data symbol mapping ────────────────────────────────────────────────
// Some symbols need specific formatting for Twelve Data
const SYMBOL_MAP = {
  "USOIL":   "WTI/USD",
  "WTI/USD": "WTI/USD",
  "SPX":     "SPX",
  "NAS100":  "NDX",        // Twelve Data uses NDX for Nasdaq 100
  "US30":    "DJI",        // Dow Jones
  "GER40":   "DAX",
};

function resolveSymbol(symbol) {
  return SYMBOL_MAP[symbol] || symbol;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, count = 10) {
  const cacheKey = `${symbol}_${interval}`;
  const cached = fromCache(cacheKey);
  if (cached) return cached;

  let data;
  if (PROVIDER === "mock") {
    data = mockCandles(symbol, interval, count);
  } else {
    data = await fetchTwelveCandles(symbol, interval, count);
  }

  if (data && data.length > 0) toCache(cacheKey, data);
  return data;
}

async function fetchCurrentPrice(symbol) {
  if (PROVIDER === "mock") return mockPrice(symbol);

  // Strategy 1: try /price endpoint
  const priceFromEndpoint = await fetchTwelvePrice(symbol);
  if (priceFromEndpoint !== null) return priceFromEndpoint;

  // Strategy 2: derive from last candle close (fallback)
  logger.warn(`[${symbol}] /price failed — deriving from last 1min candle close`);
  const candles = await fetchTwelveCandles(symbol, "1min", 2);
  if (candles && candles.length > 0) {
    const price = candles[candles.length - 1].close;
    logger.info(`[${symbol}] Derived price from candle: ${price}`);
    return price;
  }

  // Strategy 3: derive from last 5min candle
  const candles5 = await fetchTwelveCandles(symbol, "5min", 2);
  if (candles5 && candles5.length > 0) {
    const price = candles5[candles5.length - 1].close;
    logger.info(`[${symbol}] Derived price from 5min candle: ${price}`);
    return price;
  }

  logger.error(`[${symbol}] Could not fetch price from any source`);
  return null;
}

async function isTimeframeAvailable(symbol, interval) {
  if (PROVIDER === "mock") return interval !== "1min";
  try {
    const data = await fetchTwelveCandles(symbol, interval, 2);
    return !!(data && data.length > 0);
  } catch { return false; }
}

// ── Twelve Data implementation ────────────────────────────────────────────────

async function fetchTwelveCandles(symbol, interval, count) {
  const sym = resolveSymbol(symbol);

  try {
    const res = await axios.get(`${BASE_URL}/time_series`, {
      params: {
        symbol:     sym,
        interval,
        outputsize: count,
        apikey:     API_KEY,
        format:     "JSON",
      },
      timeout: 12000,
    });

    if (!res.data) {
      logger.warn(`[${sym}][${interval}] Empty response from Twelve Data`);
      return null;
    }

    if (res.data.status === "error") {
      logger.warn(`[${sym}][${interval}] Twelve Data error: ${res.data.message}`);
      return null;
    }

    if (!res.data.values || !Array.isArray(res.data.values)) {
      logger.warn(`[${sym}][${interval}] No values in response. Keys: ${Object.keys(res.data).join(",")}`);
      return null;
    }

    if (res.data.values.length === 0) {
      logger.warn(`[${sym}][${interval}] Empty values array`);
      return null;
    }

    // Twelve Data returns newest first — reverse so newest is last
    const candles = res.data.values.map(v => ({
      datetime: v.datetime,
      open:  parseFloat(v.open),
      high:  parseFloat(v.high),
      low:   parseFloat(v.low),
      close: parseFloat(v.close),
    })).reverse();

    logger.debug(`[${sym}][${interval}] Fetched ${candles.length} candles`);
    return candles;

  } catch (e) {
    if (e.response) {
      logger.error(`[${sym}][${interval}] HTTP ${e.response.status}: ${JSON.stringify(e.response.data).slice(0,200)}`);
    } else {
      logger.error(`[${sym}][${interval}] Network error: ${e.message}`);
    }
    return null;
  }
}

async function fetchTwelvePrice(symbol) {
  const sym = resolveSymbol(symbol);
  try {
    const res = await axios.get(`${BASE_URL}/price`, {
      params: { symbol: sym, apikey: API_KEY },
      timeout: 8000,
    });

    if (!res.data || !res.data.price) {
      logger.warn(`[${sym}] /price returned no price field. Response: ${JSON.stringify(res.data).slice(0,100)}`);
      return null;
    }

    const price = parseFloat(res.data.price);
    if (isNaN(price)) {
      logger.warn(`[${sym}] /price returned NaN: ${res.data.price}`);
      return null;
    }

    return price;
  } catch (e) {
    if (e.response) {
      logger.warn(`[${sym}] /price HTTP ${e.response.status}: ${JSON.stringify(e.response.data).slice(0,100)}`);
    } else {
      logger.warn(`[${sym}] /price network error: ${e.message}`);
    }
    return null;
  }
}

// ── Mock data ─────────────────────────────────────────────────────────────────

const MOCK_BASES = {
  "EUR/USD":1.0850, "GBP/USD":1.2680, "USD/JPY":149.50, "AUD/USD":0.6520,
  "USD/CAD":1.3650, "USD/CHF":0.8820, "NZD/USD":0.6010, "GBP/JPY":190.50,
  "EUR/GBP":0.8560, "EUR/JPY":162.20, "GBP/AUD":1.9430, "AUD/JPY":97.400,
  "EUR/AUD":1.6450, "XAU/USD":2020.0, "XAG/USD":22.800, "USOIL":78.500,
  "WTI/USD":78.500, "SPX":4780.0, "NAS100":16850.0, "US30":37500.0,
  "GER40":16400.0, "BTC/USD":42500.0, "ETH/USD":2280.0,
};

const TF_MS = {
  "1week":7*24*3600000, "1day":24*3600000, "4h":4*3600000,
  "1h":3600000, "15min":900000, "5min":300000, "1min":60000,
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
      open:  rnd(open,  base),
      high:  rnd(high,  base),
      low:   rnd(low,   base),
      close: rnd(close, base),
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

module.exports = { fetchCandles, fetchCurrentPrice, isTimeframeAvailable };

// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE v2 — Data Provider
// Twelve Data API + mock fallback
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");
const logger = require("../utils/logger");

const PROVIDER  = process.env.DATA_PROVIDER || "mock";
const API_KEY   = process.env.TWELVE_DATA_API_KEY || "";
const BASE_URL  = "https://api.twelvedata.com";

// In-memory cache: key = `${symbol}_${interval}`, value = { data, ts }
const cache = new Map();
const CACHE_TTL = 60 * 1000; // 1 min

// ── Public API ────────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, count = 10) {
  const cacheKey = `${symbol}_${interval}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  let data;
  if (PROVIDER === "mock") data = mockCandles(symbol, interval, count);
  else data = await fetchTwelveData(symbol, interval, count);

  if (data) cache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

async function fetchCurrentPrice(symbol) {
  if (PROVIDER === "mock") return mockPrice(symbol);
  return fetchTwelvePrice(symbol);
}

// Check if a timeframe is available for a symbol (for 1min fallback logic)
async function isTimeframeAvailable(symbol, interval) {
  if (PROVIDER === "mock") return interval !== "1min"; // mock doesn't do 1min
  try {
    const data = await fetchTwelveData(symbol, interval, 3);
    return !!(data && data.length > 0);
  } catch { return false; }
}

// ── Twelve Data ───────────────────────────────────────────────────────────────

async function fetchTwelveData(symbol, interval, count) {
  try {
    const res = await axios.get(`${BASE_URL}/time_series`, {
      params: { symbol, interval, outputsize: count, apikey: API_KEY, format: "JSON" },
      timeout: 10000,
    });
    if (res.data.status === "error") {
      logger.warn(`Twelve Data error [${symbol}][${interval}]: ${res.data.message}`);
      return null;
    }
    if (!res.data.values) return null;
    return res.data.values.map(v => ({
      datetime: v.datetime,
      open:  parseFloat(v.open),
      high:  parseFloat(v.high),
      low:   parseFloat(v.low),
      close: parseFloat(v.close),
    })).reverse(); // newest last
  } catch (e) {
    logger.error(`fetchTwelveData [${symbol}][${interval}]: ${e.message}`);
    return null;
  }
}

async function fetchTwelvePrice(symbol) {
  try {
    const res = await axios.get(`${BASE_URL}/price`, {
      params: { symbol, apikey: API_KEY }, timeout: 5000,
    });
    return parseFloat(res.data.price);
  } catch (e) {
    logger.error(`fetchTwelvePrice [${symbol}]: ${e.message}`);
    return null;
  }
}

// ── Mock Data ─────────────────────────────────────────────────────────────────

const MOCK_BASES = {
  "EUR/USD":1.0850,"GBP/USD":1.2680,"USD/JPY":149.50,"AUD/USD":0.6520,
  "USD/CAD":1.3650,"USD/CHF":0.8820,"NZD/USD":0.6010,"GBP/JPY":190.50,
  "EUR/GBP":0.8560,"EUR/JPY":162.20,"GBP/AUD":1.9430,"AUD/JPY":97.400,
  "EUR/AUD":1.6450,"XAU/USD":2020.0,"XAG/USD":22.800,"USOIL":78.500,
  "SPX":4780.0,"NAS100":16850.0,"US30":37500.0,"GER40":16400.0,
  "BTC/USD":42500.0,"ETH/USD":2280.0,
};

const TF_DURATIONS = {
  "1week":7*24*3600000,"1day":24*3600000,"4h":4*3600000,
  "1h":3600000,"15min":900000,"5min":300000,"1min":60000,
};

function mockCandles(symbol, interval, count) {
  const base = MOCK_BASES[symbol] || 1.0;
  const vol  = base * 0.0015;
  const dur  = TF_DURATIONS[interval] || 3600000;
  const candles = [];
  let price = base;
  const now = Date.now();
  for (let i = count; i >= 1; i--) {
    const ts    = new Date(now - i * dur);
    const move  = (Math.random() - 0.48) * 2 * vol; // slight bullish tilt for variety
    const open  = price;
    const close = price + move;
    const high  = Math.max(open, close) + Math.random() * vol * 0.5;
    const low   = Math.min(open, close) - Math.random() * vol * 0.5;
    candles.push({ datetime: ts.toISOString(), open: rnd(open,base), high: rnd(high,base), low: rnd(low,base), close: rnd(close,base) });
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

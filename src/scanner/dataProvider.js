// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE — Market Data Provider
// Supports: Twelve Data API | Mock data (for testing)
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");
const logger = require("../utils/logger");

const BASE_URL_TWELVE = "https://api.twelvedata.com";
const API_KEY = process.env.TWELVE_DATA_API_KEY || "";
const PROVIDER = process.env.DATA_PROVIDER || "mock";

/**
 * FETCH OHLC CANDLES
 * Returns array of { datetime, open, high, low, close } newest last
 *
 * @param {string} symbol    - e.g. "EUR/USD", "XAU/USD"
 * @param {string} interval  - "5min" | "15min" | "1h" | "4h" | "1day"
 * @param {number} count     - number of candles to fetch (default 10)
 */
async function fetchCandles(symbol, interval, count = 10) {
  if (PROVIDER === "mock") {
    return generateMockCandles(symbol, interval, count);
  }

  if (PROVIDER === "twelve_data") {
    return fetchTwelveData(symbol, interval, count);
  }

  throw new Error(`Unknown DATA_PROVIDER: ${PROVIDER}`);
}

/**
 * FETCH CURRENT PRICE (latest tick)
 */
async function fetchCurrentPrice(symbol) {
  if (PROVIDER === "mock") {
    return generateMockPrice(symbol);
  }

  if (PROVIDER === "twelve_data") {
    return fetchTwelveDataPrice(symbol);
  }

  return null;
}

// ─── Twelve Data Implementation ───────────────────────────────────────────────

async function fetchTwelveData(symbol, interval, count) {
  try {
    const response = await axios.get(`${BASE_URL_TWELVE}/time_series`, {
      params: {
        symbol,
        interval,
        outputsize: count,
        apikey: API_KEY,
        format: "JSON",
      },
      timeout: 10000,
    });

    const data = response.data;

    if (data.status === "error") {
      logger.warn(`Twelve Data error for ${symbol}: ${data.message}`);
      return null;
    }

    if (!data.values || !Array.isArray(data.values)) {
      logger.warn(`No candle data returned for ${symbol} ${interval}`);
      return null;
    }

    // Twelve Data returns newest first — reverse to get newest last
    const candles = data.values
      .map(v => ({
        datetime: v.datetime,
        open:  parseFloat(v.open),
        high:  parseFloat(v.high),
        low:   parseFloat(v.low),
        close: parseFloat(v.close),
        volume: parseFloat(v.volume || 0),
      }))
      .reverse();

    return candles;

  } catch (err) {
    logger.error(`fetchTwelveData error [${symbol}][${interval}]: ${err.message}`);
    return null;
  }
}

async function fetchTwelveDataPrice(symbol) {
  try {
    const response = await axios.get(`${BASE_URL_TWELVE}/price`, {
      params: { symbol, apikey: API_KEY },
      timeout: 5000,
    });

    return parseFloat(response.data.price);

  } catch (err) {
    logger.error(`fetchTwelveDataPrice error [${symbol}]: ${err.message}`);
    return null;
  }
}

// ─── Mock Data Generator (for testing without API key) ────────────────────────

const MOCK_BASE_PRICES = {
  "EUR/USD": 1.08500,
  "GBP/USD": 1.26800,
  "USD/JPY": 149.500,
  "AUD/USD": 0.65200,
  "USD/CAD": 1.36500,
  "USD/CHF": 0.88200,
  "NZD/USD": 0.60100,
  "GBP/JPY": 190.500,
  "EUR/GBP": 0.85600,
  "EUR/JPY": 162.200,
  "GBP/AUD": 1.94300,
  "AUD/JPY": 97.400,
  "XAU/USD": 2020.00,
  "XAG/USD": 22.800,
  "WTI/USD": 78.500,
  "SPX":     4780.0,
  "NAS100":  16850.0,
  "US30":    37500.0,
  "GER40":   16400.0,
  "BTC/USD": 42500.0,
  "ETH/USD": 2280.0,
};

function generateMockCandles(symbol, interval, count) {
  const base = MOCK_BASE_PRICES[symbol] || 1.0;
  const volatility = base * 0.0015; // 0.15% per candle

  const candles = [];
  let price = base;
  const now = Date.now();

  // Determine candle duration in ms
  const durationMap = {
    "5min":  5  * 60 * 1000,
    "15min": 15 * 60 * 1000,
    "1h":    60 * 60 * 1000,
    "4h":    4  * 60 * 60 * 1000,
    "1day":  24 * 60 * 60 * 1000,
  };
  const duration = durationMap[interval] || 60 * 60 * 1000;

  for (let i = count; i >= 1; i--) {
    const ts = new Date(now - i * duration);
    const move = (Math.random() - 0.5) * 2 * volatility;
    const open = price;
    const close = price + move;
    const high = Math.max(open, close) + Math.random() * volatility * 0.5;
    const low  = Math.min(open, close) - Math.random() * volatility * 0.5;

    candles.push({
      datetime: ts.toISOString(),
      open:  round(open),
      high:  round(high),
      low:   round(low),
      close: round(close),
    });

    price = close;
  }

  return candles;
}

function generateMockPrice(symbol) {
  const base = MOCK_BASE_PRICES[symbol] || 1.0;
  return round(base + (Math.random() - 0.5) * base * 0.001);
}

function round(n) {
  if (n > 100) return Math.round(n * 100) / 100;
  return Math.round(n * 100000) / 100000;
}

module.exports = { fetchCandles, fetchCurrentPrice };

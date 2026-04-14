// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE v2 — Data Provider
// Uses Twelve Data BATCH endpoint: fetches ALL timeframes in ONE API call
// Free tier: 1 batch call per instrument instead of 7+ individual calls
// ─────────────────────────────────────────────────────────────────────────────

const axios  = require("axios");
const logger = require("../utils/logger");

const PROVIDER = process.env.DATA_PROVIDER || "mock";
const API_KEY  = process.env.TWELVE_DATA_API_KEY || "";
const BASE_URL = "https://api.twelvedata.com";

// Simple delay between batch calls (one batch per instrument)
const CALL_DELAY_MS = parseInt(process.env.API_CALL_DELAY_MS || "1500");
let lastCallTime = 0;

async function throttle() {
  const wait = CALL_DELAY_MS - (Date.now() - lastCallTime);
  if (lastCallTime > 0 && wait > 0) await sleep(wait);
  lastCallTime = Date.now();
}

// Cache per symbol+interval, 3-min TTL
const cache = new Map();
const CACHE_TTL = 3 * 60 * 1000;
function fromCache(k) { const h=cache.get(k); return h&&Date.now()-h.ts<CACHE_TTL?h.data:null; }
function toCache(k,d) { cache.set(k,{data:d,ts:Date.now()}); }

// Symbol mapping for Twelve Data
const SYMBOL_MAP = { "USOIL":"WTI/USD","NAS100":"NDX","US30":"DJI","GER40":"DAX" };
function td(sym) { return SYMBOL_MAP[sym]||sym; }

// ─────────────────────────────────────────────────────────────────────────────
// BATCH FETCH — gets all timeframes for one symbol in a SINGLE API call
// Returns { "1day": [...candles], "4h": [...candles], ... }
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAllTimeframes(symbol, timeframes, count = 10) {
  if (PROVIDER === "mock") {
    const out = {};
    for (const tf of timeframes) out[tf] = mockCandles(symbol, tf, count);
    return out;
  }

  // Check cache — if all TFs are cached, return immediately
  const allCached = {};
  const missing = [];
  for (const tf of timeframes) {
    const c = fromCache(symbol+"_"+tf);
    if (c) allCached[tf] = c; else missing.push(tf);
  }
  if (!missing.length) { logger.debug("All cached: "+symbol); return allCached; }

  // Build batch request: symbol/EUR/USD,EUR/USD,EUR/USD with different intervals
  // Twelve Data batch: GET /time_series?symbol=A:1h,A:4h,A:1day
  // Actually Twelve Data batch uses comma-separated symbols OR the batch endpoint
  // The correct batch format: multiple calls in one HTTP request via /batch
  
  const sym = td(symbol);
  logger.info("Batch fetch: "+sym+" ["+missing.join(",")+"]");
  await throttle();

  try {
    // Use Twelve Data batch endpoint: POST /batch
    // Each item in requests array is one time_series call
    const requests = missing.map(tf => ({
      method: "GET",
      endpoint: "/time_series",
      params: {
        symbol: sym,
        interval: tf === "1week" ? "1week" : tf,
        outputsize: count,
        format: "JSON",
      }
    }));

    const res = await axios.post(BASE_URL + "/batch", 
      { requests },
      {
        params: { apikey: API_KEY },
        timeout: 20000,
        validateStatus: () => true,
      }
    );

    if (res.status !== 200) {
      logger.warn("Batch failed HTTP "+res.status+" — falling back to individual calls");
      return await fetchAllIndividual(symbol, missing, count, allCached);
    }

    const data = res.data;
    // Batch response: array matching requests order
    if (!Array.isArray(data)) {
      logger.warn("Batch returned non-array: "+JSON.stringify(data).slice(0,100));
      return await fetchAllIndividual(symbol, missing, count, allCached);
    }

    const result = { ...allCached };
    for (let i = 0; i < missing.length; i++) {
      const tf = missing[i];
      const item = data[i];
      if (!item || item.status === "error" || !item.values) {
        logger.warn(sym+" "+tf+": batch item error: "+(item&&item.message||"no values"));
        continue;
      }
      const candles = item.values.map(v => ({
        datetime: v.datetime,
        open: parseFloat(v.open), high: parseFloat(v.high),
        low:  parseFloat(v.low),  close:parseFloat(v.close),
      })).reverse();
      result[tf] = candles;
      toCache(symbol+"_"+tf, candles);
    }
    return result;

  } catch (e) {
    logger.warn("Batch request failed: "+e.message+" — falling back to individual");
    return await fetchAllIndividual(symbol, missing, count, allCached);
  }
}

// Fallback: individual calls if batch fails
async function fetchAllIndividual(symbol, timeframes, count, existing = {}) {
  const result = { ...existing };
  const sym = td(symbol);
  
  for (const tf of timeframes) {
    await throttle();
    try {
      const res = await axios.get(BASE_URL+"/time_series", {
        params: { symbol:sym, interval:tf, outputsize:count, apikey:API_KEY, format:"JSON" },
        timeout: 15000,
        validateStatus: () => true,
      });
      if (res.status===200 && res.data && res.data.values && res.data.values.length) {
        const candles = res.data.values.map(v => ({
          datetime:v.datetime,
          open:parseFloat(v.open), high:parseFloat(v.high),
          low:parseFloat(v.low),   close:parseFloat(v.close),
        })).reverse();
        result[tf] = candles;
        toCache(symbol+"_"+tf, candles);
        logger.debug(sym+" "+tf+": "+candles.length+" candles");
      } else {
        const msg = res.data && res.data.message ? res.data.message : "HTTP "+res.status;
        logger.warn(sym+" "+tf+": "+msg);
      }
    } catch (e) {
      logger.error(sym+" "+tf+": "+e.message);
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API — same interface as before
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, count = 10) {
  if (PROVIDER === "mock") return mockCandles(symbol, interval, count);
  
  const cached = fromCache(symbol+"_"+interval);
  if (cached) return cached;

  // Try 1week with fallback to 1day
  const toTry = interval === "1week" ? ["1week","1day"] : [interval];
  for (const tf of toTry) {
    const all = await fetchAllIndividual(symbol, [tf], count);
    if (all[tf] && all[tf].length) return all[tf];
  }
  return null;
}

async function fetchCurrentPrice(symbol) {
  if (PROVIDER === "mock") return mockPrice(symbol);

  // Derive from most recent cached candle (no extra API call)
  for (const tf of ["5min","15min","1h"]) {
    const c = fromCache(symbol+"_"+tf);
    if (c && c.length) return c[c.length-1].close;
  }

  // Fetch price endpoint
  await throttle();
  try {
    const res = await axios.get(BASE_URL+"/price", {
      params: { symbol:td(symbol), apikey:API_KEY },
      timeout: 10000,
      validateStatus: () => true,
    });
    if (res.status===200 && res.data && res.data.price) {
      const p = parseFloat(res.data.price);
      if (!isNaN(p)) return p;
    }
    logger.warn(symbol+" /price: "+JSON.stringify(res.data).slice(0,80));
  } catch (e) {
    logger.warn(symbol+" /price: "+e.message);
  }
  return null;
}

async function isTimeframeAvailable(symbol, interval) {
  if (PROVIDER === "mock") return interval !== "1min";
  const c = await fetchCandles(symbol, interval, 2);
  return !!(c && c.length);
}

async function validateConnection() {
  if (PROVIDER === "mock") {
    return { ok:true, message:"Mock mode — no API key needed, outputs immediately" };
  }
  if (!API_KEY || API_KEY.length < 10 || API_KEY === "YOUR_TWELVE_DATA_KEY_HERE") {
    return { ok:false, message:"TWELVE_DATA_API_KEY not set in Railway Variables" };
  }
  try {
    await throttle();
    const res = await axios.get(BASE_URL+"/price", {
      params:{ symbol:"EUR/USD", apikey:API_KEY },
      timeout:10000, validateStatus:()=>true,
    });
    if (res.status===401) return { ok:false, message:"Invalid API key (401 Unauthorized)" };
    if (res.status===429) return { ok:false, message:"Rate limited (429) — wait 1 min" };
    if (res.status===403) return { ok:false, message:"Forbidden (403) — check API key tier" };
    if (res.status!==200) return { ok:false, message:"HTTP "+res.status+": "+JSON.stringify(res.data).slice(0,80) };
    if (!res.data||!res.data.price) return { ok:false, message:"No price in response: "+JSON.stringify(res.data).slice(0,80) };
    return { ok:true, message:"Connected ✅  EUR/USD = "+parseFloat(res.data.price) };
  } catch(e) {
    return { ok:false, message:"Network error: "+e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MOCK DATA
// ─────────────────────────────────────────────────────────────────────────────

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
  const base=MOCK_BASES[symbol]||1.0, vol=base*0.0015, dur=TF_MS[interval]||3600000, now=Date.now();
  const out=[]; let price=base;
  for (let i=count;i>=1;i--) {
    const move=(Math.random()-0.49)*2*vol, open=price, close=price+move;
    out.push({ datetime:new Date(now-i*dur).toISOString(),
      open:rnd(open,base), high:rnd(Math.max(open,close)+Math.random()*vol*0.4,base),
      low:rnd(Math.min(open,close)-Math.random()*vol*0.4,base), close:rnd(close,base) });
    price=close;
  }
  return out;
}
function mockPrice(sym) { const b=MOCK_BASES[sym]||1.0; return rnd(b+(Math.random()-0.5)*b*0.001,b); }
function rnd(n,base) { return base>=100?Math.round(n*100)/100:Math.round(n*100000)/100000; }
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

module.exports = { fetchCandles, fetchCurrentPrice, isTimeframeAvailable, validateConnection, fetchAllTimeframes };

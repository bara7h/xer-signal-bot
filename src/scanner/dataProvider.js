// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE v2 — Data Provider
// Twelve Data free tier — individual calls with short delay + aggressive cache
// No batch endpoint (unreliable on free tier)
// ─────────────────────────────────────────────────────────────────────────────

const axios  = require("axios");
const logger = require("../utils/logger");

const PROVIDER = process.env.DATA_PROVIDER || "mock";
const API_KEY  = process.env.TWELVE_DATA_API_KEY || "";
const BASE_URL = "https://api.twelvedata.com";

// Delay between calls: free tier = 8/min = 7500ms gap
// But we batch all TFs in one call using the comma-separated symbol trick
// Keep at 2000ms — safe and fast enough
const DELAY = parseInt(process.env.API_CALL_DELAY_MS || "2000");
let lastCall = 0;

async function throttle() {
  const gap = Date.now() - lastCall;
  if (lastCall && gap < DELAY) await sleep(DELAY - gap);
  lastCall = Date.now();
}

// Cache: 5-min TTL — candles don't change that fast
const cache = new Map();
const TTL   = 5 * 60 * 1000;
function fromCache(k) { const h=cache.get(k); return h&&Date.now()-h.ts<TTL?h.data:null; }
function toCache(k,d) { cache.set(k,{data:d,ts:Date.now()}); return d; }

// Twelve Data symbol format — just use as-is, they accept EUR/USD format
// No remapping needed for Forex and metals on free tier
function tdSym(sym) { return sym; }

// ─────────────────────────────────────────────────────────────────────────────
// FETCH ALL TIMEFRAMES — uses Twelve Data's comma-param to get multiple in 1 call
// GET /time_series?symbol=EUR/USD&interval=1day,4h,1h,15min,5min&outputsize=10
// This counts as ONE API call on free tier
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAllTimeframes(symbol, timeframes, count = 10) {
  if (PROVIDER === "mock") {
    const out = {};
    for (const tf of timeframes) out[tf] = mockCandles(symbol, tf, count);
    return out;
  }

  // Check if all are cached
  const result = {};
  const needed = [];
  for (const tf of timeframes) {
    const c = fromCache(symbol+"_"+tf);
    if (c) result[tf] = c; else needed.push(tf);
  }
  if (!needed.length) { logger.debug("All TFs cached for "+symbol); return result; }

  const sym = tdSym(symbol);
  logger.info("Fetching "+sym+" ["+needed.join(",")+"]");
  await throttle();

  try {
    const res = await axios.get(BASE_URL+"/time_series", {
      params: {
        symbol:     sym,
        interval:   needed.join(","),
        outputsize: count,
        apikey:     API_KEY,
        format:     "JSON",
      },
      timeout: 20000,
      validateStatus: () => true,
    });

    if (!res || !res.data) {
      logger.warn(sym+": empty response");
      return result;
    }

    if (res.status === 401) { logger.error("Invalid API key"); return result; }
    if (res.status === 429) { logger.warn(sym+": rate limited"); return result; }
    if (res.status !== 200) { logger.warn(sym+": HTTP "+res.status); return result; }

    const data = res.data;

    // When multiple intervals requested, Twelve Data returns an object keyed by interval
    // When single interval, returns the series directly
    if (needed.length === 1) {
      const tf = needed[0];
      if (data.status === "error") {
        logger.warn(sym+" "+tf+": "+data.message);
      } else if (data.values && data.values.length) {
        result[tf] = toCache(symbol+"_"+tf, parseCandles(data.values));
        logger.debug(sym+" "+tf+": "+result[tf].length+" candles");
      } else {
        logger.warn(sym+" "+tf+": no values in response. Keys: "+Object.keys(data).join(","));
      }
    } else {
      // Multiple intervals — response is keyed by interval name
      for (const tf of needed) {
        const d = data[tf];
        if (!d) { logger.warn(sym+" "+tf+": not in response"); continue; }
        if (d.status === "error") { logger.warn(sym+" "+tf+": "+d.message); continue; }
        if (!d.values || !d.values.length) { logger.warn(sym+" "+tf+": no values"); continue; }
        result[tf] = toCache(symbol+"_"+tf, parseCandles(d.values));
        logger.debug(sym+" "+tf+": "+result[tf].length+" candles");
      }
    }

  } catch(e) {
    logger.error(sym+": "+e.message);
  }

  return result;
}

function parseCandles(values) {
  return values.map(v => ({
    datetime: v.datetime,
    open:  parseFloat(v.open),
    high:  parseFloat(v.high),
    low:   parseFloat(v.low),
    close: parseFloat(v.close),
  })).reverse(); // newest last
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, count = 10) {
  if (PROVIDER === "mock") return mockCandles(symbol, interval, count);
  const cached = fromCache(symbol+"_"+interval);
  if (cached) return cached;
  const all = await fetchAllTimeframes(symbol, [interval], count);
  return all[interval] || null;
}

async function fetchCurrentPrice(symbol) {
  if (PROVIDER === "mock") return mockPrice(symbol);

  // Derive from freshest cached candle — no extra API call
  for (const tf of ["5min","15min","1h","4h","1day"]) {
    const c = fromCache(symbol+"_"+tf);
    if (c && c.length) return c[c.length-1].close;
  }

  // Only call /price if nothing cached
  await throttle();
  try {
    const res = await axios.get(BASE_URL+"/price", {
      params: { symbol: tdSym(symbol), apikey: API_KEY },
      timeout: 10000,
      validateStatus: () => true,
    });
    if (res.status===200 && res.data && res.data.price) {
      const p = parseFloat(res.data.price);
      if (!isNaN(p)) return p;
    }
    logger.warn(symbol+" /price failed: HTTP "+res.status+" "+JSON.stringify(res.data||{}).slice(0,80));
  } catch(e) {
    logger.warn(symbol+" /price: "+e.message);
  }
  return null;
}

async function isTimeframeAvailable(symbol, interval) {
  if (PROVIDER === "mock") return true;
  const c = await fetchCandles(symbol, interval, 2);
  return !!(c && c.length);
}

async function validateConnection() {
  if (PROVIDER === "mock") {
    return { ok:true, message:"Mock mode — outputs immediately, no API needed" };
  }
  if (!API_KEY || API_KEY.length < 10 || API_KEY.includes("YOUR_")) {
    return { ok:false, message:"TWELVE_DATA_API_KEY not set in Railway Variables" };
  }
  await throttle();
  try {
    const res = await axios.get(BASE_URL+"/price", {
      params:{ symbol:"EUR/USD", apikey:API_KEY },
      timeout:12000, validateStatus:()=>true,
    });
    if (res.status===401) return { ok:false, message:"API key invalid (401)" };
    if (res.status===429) return { ok:false, message:"Rate limited (429) — wait 1 minute" };
    if (res.status===403) return { ok:false, message:"Forbidden (403) — check key permissions" };
    if (res.status!==200) return { ok:false, message:"HTTP "+res.status+": "+JSON.stringify(res.data||{}).slice(0,80) };
    if (!res.data||!res.data.price) return { ok:false, message:"Connected but no price field: "+JSON.stringify(res.data||{}).slice(0,80) };
    return { ok:true, message:"Connected ✅  EUR/USD = "+parseFloat(res.data.price) };
  } catch(e) {
    return { ok:false, message:"Network error: "+e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MOCK DATA
// ─────────────────────────────────────────────────────────────────────────────

const BASES = {
  "EUR/USD":1.0850,"GBP/USD":1.2680,"USD/JPY":149.50,"AUD/USD":0.6520,
  "USD/CAD":1.3650,"USD/CHF":0.8820,"NZD/USD":0.6010,"GBP/JPY":190.50,
  "EUR/GBP":0.8560,"EUR/JPY":162.20,"GBP/AUD":1.9430,"AUD/JPY":97.400,
  "EUR/AUD":1.6450,"XAU/USD":2020.0,"XAG/USD":22.800,"BTC/USD":42500.0,"ETH/USD":2280.0,
};
const TF_MS = {
  "1week":7*24*3600000,"1day":24*3600000,"4h":4*3600000,
  "1h":3600000,"15min":900000,"5min":300000,"1min":60000,
};
function mockCandles(symbol, interval, count) {
  const base=BASES[symbol]||1.0, vol=base*0.0015, dur=TF_MS[interval]||3600000, now=Date.now();
  const out=[]; let p=base;
  for (let i=count;i>=1;i--) {
    const m=(Math.random()-0.49)*2*vol, o=p, c=p+m;
    out.push({ datetime:new Date(now-i*dur).toISOString(),
      open:R(o,base), high:R(Math.max(o,c)+Math.random()*vol*0.4,base),
      low:R(Math.min(o,c)-Math.random()*vol*0.4,base), close:R(c,base) });
    p=c;
  }
  return out;
}
function mockPrice(s) { const b=BASES[s]||1.0; return R(b+(Math.random()-.5)*b*.001,b); }
function R(n,b) { return b>=100?Math.round(n*100)/100:Math.round(n*100000)/100000; }
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

module.exports = { fetchCandles, fetchCurrentPrice, isTimeframeAvailable, validateConnection, fetchAllTimeframes };

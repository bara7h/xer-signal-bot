// ============================================================
// XERO EDGE(TM) v4 -- Market Data Engine
// Provider: Twelve Data (free tier -- no payment needed)
// Sign up free at: twelvedata.com
// ============================================================
"use strict";
const https = require("https");
const { PAIR_REGISTRY, getPipSize } = require("./pairs");

// ?? Twelve Data symbol map (embedded -- no external dependency) ??
const TD_SYMBOL = {
  EURUSD:"EUR/USD", GBPUSD:"GBP/USD", USDJPY:"USD/JPY", USDCHF:"USD/CHF",
  USDCAD:"USD/CAD", AUDUSD:"AUD/USD", NZDUSD:"NZD/USD",
  GBPJPY:"GBP/JPY", EURJPY:"EUR/JPY", EURGBP:"EUR/GBP", AUDJPY:"AUD/JPY",
  EURAUD:"EUR/AUD", GBPAUD:"GBP/AUD", GBPCAD:"GBP/CAD", CADJPY:"CAD/JPY",
  NZDJPY:"NZD/JPY", CHFJPY:"CHF/JPY", EURCAD:"EUR/CAD", EURCHF:"EUR/CHF",
  GBPCHF:"GBP/CHF", AUDCAD:"AUD/CAD", AUDNZD:"AUD/NZD",
  XAUUSD:"XAU/USD", XAGUSD:"XAG/USD",
  NAS100:"IXIC",   US30:"DJI",       SPX500:"SPX",
  BTCUSD:"BTC/USD",ETHUSD:"ETH/USD",
};
const getTwelveSymbol = p => TD_SYMBOL[(p||"").toUpperCase()] || p;

// ?? Convenience wrappers ??????????????????????????????????
const pipSize  = s => getPipSize((s||"").toUpperCase()) || 0.0001;
const toPips   = (diff, sym) => parseFloat((Math.abs(diff) / pipSize(sym)).toFixed(1));
const round4   = n => parseFloat(parseFloat(n).toFixed(4));

// Timeframe map: our format -> Twelve Data format
const TF_MAP = {
  "1m":"1min","5m":"5min","15m":"15min","30m":"30min",
  "1h":"1h","4h":"4h","1d":"1day","1w":"1week",
  "m1":"1min","m5":"5min","m15":"15min","m30":"30min",
  "h1":"1h","h4":"4h","d1":"1day","w1":"1week",
};

class MarketEngine {
  constructor() {
    this._apiKey  = process.env.TWELVE_DATA_API_KEY || "";
    this._cache   = {};
    this._TTL     = 60_000; // 1 min cache per candle set
    this._lastCall = 0;
    this._MIN_INTERVAL = 8_000; // 8s between calls (8/min free limit)
  }

  isConnected() {
    return !!this._apiKey;
  }

  // ?? Rate-limit-safe API fetch ?????????????????????????????
  async _fetch(path) {
    const wait = this._MIN_INTERVAL - (Date.now() - this._lastCall);
    if (wait > 0) await this._sleep(wait);
    this._lastCall = Date.now();

    return new Promise((resolve, reject) => {
      const url = `https://api.twelvedata.com${path}&apikey=${this._apiKey}`;
      https.get(url, res => {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => {
          try { resolve(JSON.parse(d)); }
          catch { reject(new Error("Twelve Data parse error")); }
        });
      }).on("error", reject);
    });
  }

  // ?? Get OHLC candles ??????????????????????????????????????
  async getCandles(pair, timeframe = "4h", count = 4) {
    if (!this._apiKey) return null;

    const key   = `${pair}_${timeframe}_${count}`;
    const now   = Date.now();
    if (this._cache[key] && now - this._cache[key].at < this._TTL) {
      return this._cache[key].data;
    }

    const sym = getTwelveSymbol(pair.toUpperCase()) || pair;
    const tf  = TF_MAP[timeframe.toLowerCase()] || timeframe;

    try {
      const data = await this._fetch(
        `/time_series?symbol=${encodeURIComponent(sym)}&interval=${tf}&outputsize=${count}&order=ASC`
      );

      if (data.status === "error" || !data.values) {
        console.error(`[Market] ${pair} ${timeframe}: ${data.message || "no data"}`);
        return null;
      }

      const candles = data.values.map(c => ({
        time:  c.datetime,
        open:  round4(c.open),
        high:  round4(c.high),
        low:   round4(c.low),
        close: round4(c.close),
      }));

      this._cache[key] = { data: candles, at: now };
      return candles;

    } catch (e) {
      console.error(`[Market] getCandles error ${pair}:`, e.message);
      return null;
    }
  }

  // ?? Get current price ?????????????????????????????????????
  async getPrice(pair) {
    if (!this._apiKey) return null;

    const key = `price_${pair}`;
    const now = Date.now();
    if (this._cache[key] && now - this._cache[key].at < 15_000) {
      return this._cache[key].data;
    }

    const sym = getTwelveSymbol(pair.toUpperCase()) || pair;

    try {
      const data = await this._fetch(`/price?symbol=${encodeURIComponent(sym)}`);
      if (data.status === "error" || !data.price) return null;

      const price = round4(data.price);
      const ps    = pipSize(pair);
      // Estimate spread from pip size (Twelve Data gives mid price)
      const spread = pair.includes("XAU") ? 0.3 : pair.includes("JPY") ? 0.5 : 0.1;
      const result = {
        bid:    round4(price - spread * ps),
        ask:    round4(price + spread * ps),
        mid:    price,
        spread: spread,
        time:   new Date().toISOString(),
      };
      this._cache[key] = { data: result, at: now };
      return result;
    } catch (e) {
      console.error(`[Market] getPrice error ${pair}:`, e.message);
      return null;
    }
  }

  // ?? 2-Candle Bias -- pure math on last TWO CLOSED candles ??
  // Twelve Data returns candles ASC. The last candle is the RUNNING candle (C3).
  // RULE: Bias is always calculated on the last two CLOSED candles only.
  // With [C1, C2, C3_running]: use C1=index[-3], C2=index[-2]. Skip C3.
  checkBias(candles) {
    if (!candles || candles.length < 2) {
      return { bias:"INSUFFICIENT_DATA", confirmed:false,
        detail:"Not enough candles to calculate bias." };
    }
    // 2 candles: both closed, no running candle to check
    if (candles.length === 2) {
      return this._calcBias(candles[0], candles[1], null);
    }
    // 3+ candles:
    //   C1 = candles[-3] (second-to-last closed)
    //   C2 = candles[-2] (last closed)
    //   C3 = candles[-1] (running -- used ONLY for wick invalidation check)
    const c1        = candles[candles.length - 3];
    const c2        = candles[candles.length - 2];
    const c3running = candles[candles.length - 1]; // running candle
    return this._calcBias(c1, c2, c3running);
  }

  _calcBias(c1, c2, c3running) {
    // BULLISH: C2 low < C1 low AND C2 high < C1 high AND C2 close < C1 high
    const bullish = (
      c2.low   < c1.low  &&
      c2.high  < c1.high &&
      c2.close < c1.high
    );
    // BEARISH: C2 high > C1 high AND C2 low > C1 low AND C2 close > C1 low
    const bearish = (
      c2.high  > c1.high &&
      c2.low   > c1.low  &&
      c2.close > c1.low
    );

    if (bullish) {
      const invLevel = round4(c2.high);
      // WICK INVALIDATION: if C3 running candle has wicked above C2 high, bias is cancelled
      const wickInvalidated = c3running && c3running.high > invLevel;
      return {
        bias: wickInvalidated ? "NONE" : "BULLISH",
        confirmed: !wickInvalidated,
        c1, c2,
        invalidationLevel: invLevel,
        sweepLevel: c2.low,
        wickInvalidated,
        detail: wickInvalidated
          ? "BULLISH bias CANCELLED -- C3 wicked above invalidation " + invLevel + " (current high: " + c3running.high + ")"
          : "C2 swept below C1 low (" + c1.low + "->" + c2.low + ") | C2 high " + c2.high + " below C1 high " + c1.high + " | inv:" + invLevel,
      };
    }

    if (bearish) {
      const invLevel = round4(c2.low);
      // WICK INVALIDATION: if C3 running candle has wicked below C2 low, bias is cancelled
      const wickInvalidated = c3running && c3running.low < invLevel;
      return {
        bias: wickInvalidated ? "NONE" : "BEARISH",
        confirmed: !wickInvalidated,
        c1, c2,
        invalidationLevel: invLevel,
        sweepLevel: c2.high,
        wickInvalidated,
        detail: wickInvalidated
          ? "BEARISH bias CANCELLED -- C3 wicked below invalidation " + invLevel + " (current low: " + c3running.low + ")"
          : "C2 swept above C1 high (" + c1.high + "->" + c2.high + ") | C2 low " + c2.low + " above C1 low " + c1.low + " | inv:" + invLevel,
      };
    }

    return {
      bias: "NONE", confirmed: false, c1, c2,
      detail: "No valid bias. C1[H:" + c1.high + " L:" + c1.low + "] C2[H:" + c2.high + " L:" + c2.low + " C:" + c2.close + "]",
    };
  }

  // ?? Format candles for Claude prompt ?????????????????????
  formatCandlesForPrompt(pair, timeframe, candles, bias) {
    if (!candles || !candles.length) return `No data for ${pair} ${timeframe}.\n`;
    // Show last 3 candles: C1 (closed), C2 (closed), C3 (running -- ignored for bias)
    const recent = candles.slice(-3);
    let out = `\n---- LIVE DATA -- ${pair} (${timeframe.toUpperCase()}) ----\n`;
    out += `Candles (bias uses last 2 CLOSED only -- C3 running is ignored):\n`;
    recent.forEach((c, i) => {
      let lbl;
      if (recent.length === 3) {
        if (i === 0) lbl = " ? C1 (closed, used for bias)";
        else if (i === 1) lbl = " ? C2 (closed, used for bias)";
        else lbl = " ? C3 RUNNING (ignored for bias)";
      } else {
        lbl = i === recent.length - 2 ? " ? C1" : " ? C2 (used for bias)";
      }
      out += `  [${c.time}] O:${c.open} H:${c.high} L:${c.low} C:${c.close}${lbl}\n`;
    });
    out += `2-Candle Bias Result: `;
    if (bias.confirmed) {
      out += `${bias.bias} [OK] | Invalidation: ${bias.invalidationLevel}\n`;
      out += `Detail: ${bias.detail}\n`;
    } else {
      out += `${bias.bias} -- not confirmed\nDetail: ${bias.detail}\n`;
    }
    return out;
  }

  // ?? Calculate SL/TP from real candle data ?????????????????
  calcSLTP({ pair, direction, bias, currentPrice, minRR = 2, bufferPips = 5 }) {
    if (!bias?.confirmed) return null;
    const buf   = bufferPips * pipSize(pair);
    const price = currentPrice?.mid || currentPrice?.ask || 0;
    if (!price) return null;

    let entry, sl, tp;
    if (direction === "LONG") {
      entry = round4(currentPrice.ask || price);
      sl    = round4(bias.c2.low - buf);
      tp    = round4(entry + Math.abs(entry - sl) * minRR);
    } else {
      entry = round4(currentPrice.bid || price);
      sl    = round4(bias.c2.high + buf);
      tp    = round4(entry - Math.abs(sl - entry) * minRR);
    }

    const risk   = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    const rr     = risk > 0 ? parseFloat((reward / risk).toFixed(2)) : 0;

    return {
      entry, sl, tp, rr,
      slPips: toPips(risk, pair),
      tpPips: toPips(reward, pair),
      invalidationLevel: bias.invalidationLevel,
    };
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

const marketEngine = new MarketEngine();
module.exports = { MarketEngine, marketEngine, pipSize, toPips, round4 };

// ============================================================
// XERO EDGE(TM) -- FRACTAL TIMEFRAME ENGINE
// ============================================================
// ENTRY LOGIC:
//   Bias TF -> find impulse + OB on Impulse TF
//           -> 1H OB IS the entry zone
//           -> drop to Entry TF -> look for sweep/W/M INSIDE the impulse-TF OB
//
// TARGET LIQUIDITY:
//   TP1 = weak highs/lows on Entry TF (nearest)
//   TP2 = weak highs/lows on Impulse TF (larger)
//
// FRACTAL TABLE:
//   Bias    -> Impulse (OB zone)  -> Entry (sweep inside OB)  -> TP1 TF  -> TP2 TF
//   Daily   -> 1H                 -> 15M                       -> 15M     -> 1H
//   4H      -> 1H                 -> 15M                       -> 15M     -> 1H
//   1H      -> 15M                -> 5M                        -> 5M      -> 15M
//   15M     -> 5M                 -> 1M                        -> 1M      -> 5M
// ============================================================

const TF_FRACTAL = {
  //        impulse TF  entry TF   TP1 TF    TP2 TF
  "1d":  { impulse:"1h",  entry:"15m", tp1:"15m", tp2:"1h",  label:"Daily -> 1H OB zone -> 15M sweep -> TP1:15M / TP2:1H"  },
  "4h":  { impulse:"1h",  entry:"15m", tp1:"15m", tp2:"1h",  label:"4H -> 1H OB zone -> 15M sweep -> TP1:15M / TP2:1H"    },
  "1h":  { impulse:"15m", entry:"5m",  tp1:"5m",  tp2:"15m", label:"1H -> 15M OB zone -> 5M sweep -> TP1:5M / TP2:15M"    },
  "15m": { impulse:"5m",  entry:"1m",  tp1:"1m",  tp2:"5m",  label:"15M -> 5M OB zone -> 1M sweep -> TP1:1M / TP2:5M"     },
};

function resolveTF(biasTF) {
  return TF_FRACTAL[(biasTF||"4h").toLowerCase()] || TF_FRACTAL["4h"];
}

// ============================================================
// IMPULSE DETECTION -- anchored to C2 low (bullish) or C2 high (bearish)
// No BOS/CHoCH required. Just find the impulse wave from C2,
// then detect FVGs and OBs left behind by that wave.
// ============================================================
function findImpulseFromC2(impulseTFCandles, biasBias, c2AnchorPrice) {
  if (!impulseTFCandles || impulseTFCandles.length < 3) {
    return { found:false, reason:"Insufficient candles on impulse TF", anchorPrice:c2AnchorPrice };
  }

  // Find the candle closest to the C2 anchor price
  let startIdx = 0;
  let closestDiff = Infinity;
  for (let i = 0; i < impulseTFCandles.length; i++) {
    const ref   = biasBias === "BULLISH" ? impulseTFCandles[i].low : impulseTFCandles[i].high;
    const diff  = Math.abs(ref - c2AnchorPrice);
    if (diff < closestDiff) { closestDiff = diff; startIdx = i; }
  }

  // Slice wave candles from anchor forward
  const wave = impulseTFCandles.slice(startIdx);
  if (wave.length < 2) {
    return { found:false, reason:`Only ${wave.length} candle(s) after C2 anchor ${c2AnchorPrice}`, anchorPrice:c2AnchorPrice };
  }

  const lastCandle  = wave[wave.length - 1];
  const waveHigh    = round4(Math.max(...wave.map(c => c.high)));
  const waveLow     = round4(Math.min(...wave.map(c => c.low)));

  // Detect FVGs and OBs from within the wave
  const dir  = biasBias.toLowerCase();
  const fvgs = detectFVG(wave, dir);
  const obs  = detectOB(wave, dir);

  // Impulse is valid if price has moved meaningfully away from the anchor
  const moved = biasBias === "BULLISH"
    ? lastCandle.close > c2AnchorPrice
    : lastCandle.close < c2AnchorPrice;

  if (moved) {
    return {
      found:       true,
      anchorPrice: c2AnchorPrice,
      waveStart:   biasBias === "BULLISH" ? waveLow  : waveHigh,
      waveEnd:     biasBias === "BULLISH" ? waveHigh : waveLow,
      currentPrice:round4(lastCandle.close),
      candleCount: wave.length,
      fvg:         fvgs,
      ob:          obs,
      detail:      `${biasBias} impulse from C2 ${biasBias === "BULLISH" ? "low" : "high"} ${c2AnchorPrice} -> current ${lastCandle.close} | ${wave.length} candles`,
    };
  }

  // Price has not moved from anchor yet -- wave not started
  return {
    found:       false,
    anchorPrice: c2AnchorPrice,
    candleCount: wave.length,
    currentPrice:round4(lastCandle.close),
    fvg:         fvgs,
    ob:          obs,
    detail:      `No impulse yet. Price at ${lastCandle.close} has not moved from C2 anchor ${c2AnchorPrice}. Waiting for wave to begin.`,
  };
}

// ?? FVG Detection ?????????????????????????????????????????
function detectFVG(candles, direction) {
  const fvgs = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const next = candles[i + 1];
    if (direction === "bullish" && prev.high < next.low) {
      fvgs.push({ top:round4(next.low), bottom:round4(prev.high), mid:round4((next.low+prev.high)/2), time:candles[i].time, type:"Bullish FVG" });
    }
    if (direction === "bearish" && prev.low > next.high) {
      fvgs.push({ top:round4(prev.low), bottom:round4(next.high), mid:round4((prev.low+next.high)/2), time:candles[i].time, type:"Bearish FVG" });
    }
  }
  return fvgs.slice(-3);
}

// ?? OB Detection ??????????????????????????????????????????
function detectOB(candles, direction) {
  // Bearish OB: LAST BULLISH candle before strong bearish impulse
  //   = the candle AT the high of the wave, before price drops
  //   = its high is where price will return to for entry
  //   = FVG may exist between this OB and the next bearish candle
  // Bullish OB: LAST BEARISH candle before strong bullish impulse
  //   = the candle AT the low of the wave, before price rises
  const obs = [];
  const minBody = (c) => Math.abs(c.close - c.open);
  const isBull = (c) => c.close > c.open;
  const isBear = (c) => c.close < c.open;

  for (let i = 0; i < candles.length - 2; i++) {
    const c    = candles[i];
    const next = candles[i + 1];
    const next2= candles[i + 2] || next;

    if (direction === "bearish") {
      // Bearish OB = last bullish candle before bearish impulse
      // Criteria: c is bullish, followed by a strong bearish move
      if (isBull(c) && isBear(next) && minBody(next) > minBody(c) * 0.5) {
        // Check if there's an FVG (gap between c.low and next2.high)
        const hasFVG = c.low > next2.high;
        obs.push({
          top:    round4(c.high),
          bottom: round4(c.open), // OB body: from open to high (bullish candle)
          mid:    round4((c.high + c.open) / 2),
          wickBottom: round4(c.low),
          time:   c.time,
          type:   "Bearish OB",
          hasFVG,
          fvgTop:    hasFVG ? round4(c.low)    : null,
          fvgBottom: hasFVG ? round4(next2.high): null,
        });
      }
    }

    if (direction === "bullish") {
      // Bullish OB = last bearish candle before bullish impulse
      // Criteria: c is bearish, followed by a strong bullish move
      if (isBear(c) && isBull(next) && minBody(next) > minBody(c) * 0.5) {
        const hasFVG = c.high < next2.low;
        obs.push({
          top:    round4(c.open), // OB body: from low to open (bearish candle)
          bottom: round4(c.low),
          mid:    round4((c.open + c.low) / 2),
          wickTop: round4(c.high),
          time:   c.time,
          type:   "Bullish OB",
          hasFVG,
          fvgTop:    hasFVG ? round4(next2.low) : null,
          fvgBottom: hasFVG ? round4(c.high)    : null,
        });
      }
    }
  }

  // Return last 3 (most recent = closest to current price)
  return obs.slice(-3);
}

// ============================================================
// CONSOLIDATION / SIDEWAYS PATTERN SCANNER
// All patterns defined mathematically on OHLC candle data.
// No vague keywords -- every condition is a precise numeric test.
// ============================================================
//
// SWING POINT DEFINITION (used by all patterns):
//   Swing High at index i: candles[i].high is strictly greater than
//     candles[i-1].high AND candles[i-2].high AND
//     candles[i+1].high AND candles[i+2].high
//   Swing Low at index i: candles[i].low is strictly less than
//     the 2 candles before and 2 candles after
//   Minimum 2 candles on each side required (so i >= 2 and i <= n-3)
//
// EQUAL LEVEL DEFINITION:
//   Two prices P1 and P2 are "equal" when:
//   abs(P1 - P2) / avg(P1, P2) <= EQ_TOL (0.0008 = 0.08%)
//
// SIDEWAYS / RANGE DEFINITION:
//   A candle window is "sideways" when:
//   (highest_high - lowest_low) / avg <= RANGE_TOL (0.004 = 0.4%)
//   AND the window contains at least MIN_CANDLES (4) candles
// ============================================================

const EQ_TOL    = 0.0008; // 0.08%  -- two levels are "equal"
const RANGE_TOL = 0.004;  // 0.40%  -- max range for sideways zone
const MIN_SW    = 2;      // candles each side for swing point

function _swings(candles) {
  const highs = [], lows = [];
  for (let i = MIN_SW; i < candles.length - MIN_SW; i++) {
    const c = candles[i];
    let isH = true, isL = true;
    for (let d = 1; d <= MIN_SW; d++) {
      if (c.high <= candles[i-d].high || c.high <= candles[i+d].high) isH = false;
      if (c.low  >= candles[i-d].low  || c.low  >= candles[i+d].low)  isL = false;
    }
    if (isH) highs.push({ v:round4(c.high), i, time:c.time });
    if (isL) lows.push({ v:round4(c.low),   i, time:c.time });
  }
  return { highs, lows };
}

function _eq(a, b) { return Math.abs(a - b) / ((a + b) / 2) <= EQ_TOL; }

// W-PATTERN (bullish reversal at support / OB zone)
// Conditions (all must be true):
//   1. At least 2 swing lows exist: L1 (earlier) and L2 (later)
//   2. L2.price < L1.price  (L2 sweeps below L1 = liquidity taken)
//   3. Latest closed candle close > L1.price  (price recovered above L1)
//   4. abs(L2.price - L1.price) / L1.price >= 0.0003 (meaningful sweep, not noise)
function detectWPattern(candles) {
  if (!candles || candles.length < 8) return null;
  const { lows } = _swings(candles);
  if (lows.length < 2) return null;
  const L1 = lows[lows.length - 2];
  const L2 = lows[lows.length - 1];
  if (L2.i <= L1.i) return null;
  const sweep = (L1.v - L2.v) / L1.v;
  const lastClose = candles[candles.length - 1].close;
  if (L2.v < L1.v && sweep >= 0.0003 && lastClose > L1.v) {
    return {
      found: true, type: "W_PATTERN",
      L1: L1.v, L1time: L1.time,
      L2: L2.v, L2time: L2.time,
      sweep: round4(sweep * 100) + "%",
      recovery: round4(lastClose),
      detail: "W-Pattern: L1=" + L1.v + " swept to L2=" + L2.v + " (" + round4(sweep*100) + "% below) recovered to " + round4(lastClose),
    };
  }
  return null;
}

// M-PATTERN (bearish reversal at resistance / OB zone)
// Conditions (all must be true):
//   1. At least 2 swing highs: H1 (earlier) and H2 (later)
//   2. H2.price > H1.price  (H2 sweeps above H1 = liquidity taken)
//   3. Latest closed candle close < H1.price  (price rejected back below H1)
//   4. sweep >= 0.0003
function detectMPattern(candles) {
  if (!candles || candles.length < 8) return null;
  const { highs } = _swings(candles);
  if (highs.length < 2) return null;
  const H1 = highs[highs.length - 2];
  const H2 = highs[highs.length - 1];
  if (H2.i <= H1.i) return null;
  const sweep = (H2.v - H1.v) / H1.v;
  const lastClose = candles[candles.length - 1].close;
  if (H2.v > H1.v && sweep >= 0.0003 && lastClose < H1.v) {
    return {
      found: true, type: "M_PATTERN",
      H1: H1.v, H1time: H1.time,
      H2: H2.v, H2time: H2.time,
      sweep: round4(sweep * 100) + "%",
      rejection: round4(lastClose),
      detail: "M-Pattern: H1=" + H1.v + " swept to H2=" + H2.v + " (" + round4(sweep*100) + "% above) rejected to " + round4(lastClose),
    };
  }
  return null;
}

// RECTANGLE / RANGE
// Conditions (all must be true):
//   1. At least 2 swing highs AND 2 swing lows in the window
//   2. All swing highs within EQ_TOL of each other (flat resistance)
//   3. All swing lows within EQ_TOL of each other (flat support)
//   4. Total range (maxHigh - minLow) / midpoint <= RANGE_TOL * 4
//   5. At least 4 candles in the window
function detectRectangle(candles) {
  if (!candles || candles.length < 5) return null;
  const scan = candles.slice(-Math.min(candles.length, 25));
  const { highs, lows } = _swings(scan);
  if (highs.length < 2 || lows.length < 2) return null;
  const maxH = Math.max(...highs.map(h => h.v));
  const minH = Math.min(...highs.map(h => h.v));
  const maxL = Math.max(...lows.map(l => l.v));
  const minL = Math.min(...lows.map(l => l.v));
  // All highs must be within EQ_TOL*3 of each other
  if ((maxH - minH) / maxH > EQ_TOL * 3) return null;
  // All lows must be within EQ_TOL*3 of each other
  if ((maxL - minL) / minL > EQ_TOL * 3) return null;
  // Resistance and support must not overlap
  if (minH <= maxL) return null;
  const resistance = round4((maxH + minH) / 2);
  const support    = round4((maxL + minL) / 2);
  const range      = (resistance - support) / ((resistance + support) / 2);
  if (range > RANGE_TOL * 4) return null; // too wide
  return {
    found: true, type: "RECTANGLE",
    resistance, support,
    mid: round4((resistance + support) / 2),
    rangePct: round4(range * 100) + "%",
    topTouches: highs.length, botTouches: lows.length,
    candleCount: scan.length,
    detail: "Rectangle: resistance=" + resistance + " support=" + support + " range=" + round4(range*100) + "% | " + highs.length + " tops " + lows.length + " bottoms",
  };
}

// SYMMETRICAL TRIANGLE
// Conditions:
//   1. At least 2 swing highs and 2 swing lows
//   2. Swing highs are DESCENDING: each successive high < previous
//      Measured as: linear regression slope of highs < 0
//   3. Swing lows are ASCENDING: each successive low > previous
//      Measured as: linear regression slope of lows > 0
//   4. Both slopes significant: |slope| / firstValue >= 0.0005
function detectTriangle(candles) {
  if (!candles || candles.length < 8) return null;
  const scan = candles.slice(-Math.min(candles.length, 30));
  const { highs, lows } = _swings(scan);
  if (highs.length < 2 || lows.length < 2) return null;

  // Linear slope: positive = ascending, negative = descending
  const slope = (pts) => {
    if (pts.length < 2) return 0;
    return (pts[pts.length-1].v - pts[0].v) / (pts[pts.length-1].i - pts[0].i);
  };
  const hSlope = slope(highs); // should be negative for descending
  const lSlope = slope(lows);  // should be positive for ascending

  const hRef = highs[0].v, lRef = lows[0].v;
  const hSig = Math.abs(hSlope) / hRef >= 0.00005;
  const lSig = Math.abs(lSlope) / lRef >= 0.00005;

  if (hSlope < 0 && lSlope > 0 && hSig && lSig) {
    return {
      found: true, type: "SYM_TRIANGLE",
      highestHigh: round4(highs[0].v), lowestHigh: round4(highs[highs.length-1].v),
      lowestLow:   round4(lows[0].v),  highestLow: round4(lows[lows.length-1].v),
      hSlope: round4(hSlope), lSlope: round4(lSlope),
      detail: "Sym Triangle: highs " + highs[0].v + "->" + highs[highs.length-1].v + " | lows " + lows[0].v + "->" + lows[lows.length-1].v,
    };
  }
  // Ascending triangle: highs flat, lows ascending
  if (Math.abs(hSlope) / hRef < 0.0002 && lSlope > 0 && lSig) {
    return {
      found: true, type: "ASC_TRIANGLE",
      resistance: round4(highs[0].v),
      risingLow:  round4(lows[lows.length-1].v),
      detail: "Asc Triangle: flat resistance=" + highs[0].v + " | rising lows " + lows[0].v + "->" + lows[lows.length-1].v,
    };
  }
  // Descending triangle: highs descending, lows flat
  if (hSlope < 0 && hSig && Math.abs(lSlope) / lRef < 0.0002) {
    return {
      found: true, type: "DESC_TRIANGLE",
      support:     round4(lows[0].v),
      fallingHigh: round4(highs[highs.length-1].v),
      detail: "Desc Triangle: flat support=" + lows[0].v + " | falling highs " + highs[0].v + "->" + highs[highs.length-1].v,
    };
  }
  return null;
}

// PENNANT
// Conditions:
//   1. First half of window: strong directional move
//      |close[mid] - open[0]| / open[0] >= 0.006 (0.6% pole)
//   2. Second half: range contracts to <= RANGE_TOL (0.4%)
//      i.e. (max_high - min_low) / midpoint <= RANGE_TOL in the flag portion
//   3. Flag has at least 3 candles
function detectPennant(candles) {
  if (!candles || candles.length < 8) return null;
  const mid   = Math.floor(candles.length / 2);
  const pole  = candles.slice(0, mid);
  const flag  = candles.slice(mid);
  if (flag.length < 3) return null;
  const poleMove = Math.abs(pole[pole.length-1].close - pole[0].open) / pole[0].open;
  if (poleMove < 0.006) return null; // pole too small
  const fH = Math.max(...flag.map(c => c.high));
  const fL = Math.min(...flag.map(c => c.low));
  const fRange = (fH - fL) / ((fH + fL) / 2);
  if (fRange > RANGE_TOL) return null; // flag too wide
  const bullPole = pole[pole.length-1].close > pole[0].open;
  return {
    found: true, type: bullPole ? "BULL_PENNANT" : "BEAR_PENNANT",
    poleMovePct: round4(poleMove * 100) + "%",
    flagHigh: round4(fH), flagLow: round4(fL),
    flagRangePct: round4(fRange * 100) + "%",
    candleCount: candles.length,
    detail: (bullPole ? "Bull" : "Bear") + " Pennant: pole=" + round4(poleMove*100) + "% | flag range=" + round4(fRange*100) + "%",
  };
}

// Run all consolidation checks
function detectConsolidationPatterns(candles) {
  const out = [];
  const r = detectRectangle(candles);
  const t = detectTriangle(candles);
  const p = detectPennant(candles);
  const w = detectWPattern(candles);
  const m = detectMPattern(candles);
  if (r) out.push(r);
  if (t) out.push(t);
  if (p) out.push(p);
  if (w) out.push(w);
  if (m) out.push(m);
  return out;
}

// A/B setup grade at OB
// A = M or W pattern confirmed on entry TF at/near the OB zone
// B = price at OB, no pattern -- direct entry still valid
function classifySetupGrade(entryTFCandles, ob, direction) {
  if (!ob || !entryTFCandles) return { grade:"B", reason:"No entry TF data -- direct OB entry (B setup)" };
  const pattern = direction === "BEARISH" ? detectMPattern(entryTFCandles) : detectWPattern(entryTFCandles);
  if (!pattern) return { grade:"B", reason:"No M/W pattern on entry TF -- direct OB entry (B setup)" };
  const atOB = direction === "BEARISH"
    ? pattern.H2 <= ob.top * 1.002
    : pattern.L2 >= ob.bottom * 0.998;
  if (atOB) return { grade:"A", pattern, reason:"M/W pattern at OB -- A setup" };
  return { grade:"B+", pattern, reason:"M/W pattern found but not at OB zone -- B+ setup" };
}

// ============================================================
// LIQUIDITY IDENTIFICATION ENGINE
// Identifies sideways zones, equal highs/lows, quality grading
// ============================================================
// Quality grades:
//   HIGH     = Equal highs/lows INSIDE a sideways zone
//   MEDIUM   = Equal highs/lows (no sideways required)
//   STANDARD = Sideways high/low without equals
//   AVOID    = Clean single swing -- TP before this
//
// Bullish entry -> target weak HIGHS above (equal highs, sideways highs)
// Bearish entry -> target weak LOWS below  (equal lows,  sideways lows)
// ============================================================

// ============================================================
// LIQUIDITY ENGINE v5
// ============================================================
// Rules:
// 1. Liquidity on Entry TF is detected ONLY within the
//    approach wave (candles moving toward the OB zone).
//    That approach wave must be choppy/sideways to qualify.
// 2. Already-swept levels (price closed through them) are
//    excluded -- only unswept levels count.
// 3. Quality grading:
//    HIGH     = Equal lows/highs inside sideways approach wave
//    MEDIUM   = Equal lows/highs (no sideways required)
//    STANDARD = Sideways high/low, single touch
//    AVOID    = Clean single swing, no prior touches
// ============================================================

// Check if a swing level has been swept (price closed through it)
function isSwept(price, candles, direction, afterIdx) {
  // For a LOW target (bearish entry): swept if any close BELOW the price after afterIdx
  // For a HIGH target (bullish entry): swept if any close ABOVE the price after afterIdx
  for (let i = afterIdx + 1; i < candles.length; i++) {
    if (direction === 'bearish' && candles[i].close < price) return true;
    if (direction === 'bullish' && candles[i].close > price) return true;
  }
  return false;
}

// Detect if a candle sequence is a sideways/choppy approach
// Returns true if the range of candles fits within SW_TOL
function isSidewaysApproach(candles, startIdx, endIdx) {
  if (endIdx - startIdx < 2) return false;
  const SW_TOL = 0.003; // 0.30%
  let zH = -Infinity, zL = Infinity;
  for (let i = startIdx; i <= Math.min(endIdx, candles.length - 1); i++) {
    zH = Math.max(zH, candles[i].high);
    zL = Math.min(zL, candles[i].low);
  }
  const spread = (zH - zL) / ((zH + zL) / 2);
  return spread <= SW_TOL;
}

// Identify the approach wave -- candles between last swing low (bull)
// or last swing high (bear) and the OB zone
function findApproachWave(candles, obTop, obBottom, direction) {
  if (!candles || candles.length < 3) return { candles: candles || [], isSideways: false };

  const isBull = direction === 'bullish';
  // Find where price starts approaching the OB from
  // For bullish: price drops toward OB (approach = falling candles toward OB top)
  // For bearish: price rises toward OB (approach = rising candles toward OB bottom)
  let approachStart = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    const inZone = isBull
      ? candles[i].low <= obTop && candles[i].low >= obBottom - (obTop - obBottom)
      : candles[i].high >= obBottom && candles[i].high <= obTop + (obTop - obBottom);
    if (inZone) { approachStart = i; break; }
  }
  // Take the candles from approachStart backward up to 20 candles
  const start = Math.max(0, approachStart - 20);
  const wave  = candles.slice(start, approachStart + 1);
  const sw    = isSidewaysApproach(wave, 0, wave.length - 1);
  return { candles: wave, isSideways: sw, startIdx: start, endIdx: approachStart };
}

// Main liquidity detection -- approach-aware, sweep-excluded
function detectWeakLiquidity(candles, direction, obTop, obBottom) {
  if (!candles || candles.length < 4) return { levels: [], currentPrice: 0 };

  const isBull    = direction === 'bullish';
  const lastClose = round4(candles[candles.length - 1].close);
  const EQ_TOL    = 0.0008; // 0.08%
  const SW_TOL    = 0.003;  // 0.30%

  // Determine the candle window to scan
  // If OB is provided, use the approach wave; else use full array
  let scanCandles = candles;
  let approachIsSideways = false;
  if (obTop && obBottom) {
    const approach = findApproachWave(candles, obTop, obBottom, direction);
    scanCandles = approach.candles.length >= 3 ? approach.candles : candles;
    approachIsSideways = approach.isSideways;
  }

  // Step 1: Swing highs and lows in the scan window
  const swingHighs = [], swingLows = [];
  for (let i = 1; i < scanCandles.length - 1; i++) {
    const hi = scanCandles[i].high, lo = scanCandles[i].low;
    const leftH  = scanCandles[i-1].high, rightH = scanCandles[i+1].high;
    const leftL  = scanCandles[i-1].low,  rightL  = scanCandles[i+1].low;
    if (hi >= leftH && hi >= rightH)
      swingHighs.push({ price: round4(hi), idx: i, time: scanCandles[i].time });
    if (lo <= leftL && lo <= rightL)
      swingLows.push({ price: round4(lo), idx: i, time: scanCandles[i].time });
  }

  // Step 2: Sideways zones
  const sidewaysZones = [];
  let si = 0;
  while (si < scanCandles.length - 2) {
    let zH = scanCandles[si].high, zL = scanCandles[si].low, ej = si + 1;
    while (ej < scanCandles.length) {
      const nH = Math.max(zH, scanCandles[ej].high);
      const nL = Math.min(zL, scanCandles[ej].low);
      if ((nH - nL) / ((nH + nL) / 2) > SW_TOL) break;
      zH = nH; zL = nL; ej++;
    }
    if (ej - si >= 3) {
      sidewaysZones.push({
        startIdx: si, endIdx: ej - 1,
        high: round4(zH), low: round4(zL),
        mid: round4((zH + zL) / 2), count: ej - si,
      });
      si = ej;
    } else si++;
  }

  // Step 3: Classify, skip swept levels
  const targets = isBull ? swingHighs : swingLows;
  const levels  = [];
  const usedIdx = new Set();

  for (const pt of targets) {
    if (usedIdx.has(pt.idx)) continue;

    // Skip if already swept
    if (isSwept(pt.price, scanCandles, direction, pt.idx)) continue;

    // Only include targets in the correct direction from current price
    if (isBull && pt.price <= lastClose) continue;  // highs must be above
    if (!isBull && pt.price >= lastClose) continue; // lows must be below

    const equals = targets.filter(o =>
      o.idx !== pt.idx && !usedIdx.has(o.idx) &&
      Math.abs(o.price - pt.price) / pt.price <= EQ_TOL &&
      !isSwept(o.price, scanCandles, direction, o.idx)
    );
    equals.forEach(e => usedIdx.add(e.idx));
    usedIdx.add(pt.idx);

    const touches    = equals.length + 1;
    const inSideways = sidewaysZones.find(z => pt.idx >= z.startIdx && pt.idx <= z.endIdx);

    let quality, label, desc;
    if (inSideways && equals.length > 0) {
      quality = 'HIGH';
      label   = isBull ? 'Equal Highs in Sideways' : 'Equal Lows in Sideways';
      desc    = `${touches} unswept touches at ${pt.price} inside ${inSideways.count}-candle consolidation (${inSideways.low}-${inSideways.high}). Heavy stop cluster.`;
    } else if (equals.length > 0) {
      quality = 'MEDIUM';
      label   = isBull ? 'Equal Highs' : 'Equal Lows';
      desc    = `${touches} unswept touches at ${pt.price}. Stop cluster.`;
    } else if (inSideways) {
      quality = 'STANDARD';
      label   = isBull ? 'Sideways High' : 'Sideways Low';
      desc    = `Single unswept touch at ${pt.price} inside ${inSideways.count}-candle range. Moderate liquidity.`;
    } else {
      quality = 'AVOID';
      label   = isBull ? 'Clean Swing High' : 'Clean Swing Low';
      desc    = `Single touch at ${pt.price}. Strong level -- TP before here.`;
    }

    levels.push({ price: pt.price, quality, label, desc, touches, inSideways: !!inSideways, time: pt.time });
  }

  const qOrd = { HIGH: 0, MEDIUM: 1, STANDARD: 2, AVOID: 3 };
  levels.sort((a, b) =>
    qOrd[a.quality] !== qOrd[b.quality]
      ? qOrd[a.quality] - qOrd[b.quality]
      : Math.abs(a.price - lastClose) - Math.abs(b.price - lastClose)
  );

  return { levels: levels.slice(0, 5), sidewaysZones, currentPrice: lastClose, approachIsSideways };
}

// Format liquidity targets for Claude prompt
function formatLiquidityTargets(pair, fractal, direction, tp1Candles, tp2Candles, obTop, obBottom) {
  const dir    = direction.toLowerCase();
  const isBull = direction === 'BULLISH';
  // TP1: pass OB zone so we scan approach wave only
  const tp1    = tp1Candles ? detectWeakLiquidity(tp1Candles, dir, obTop, obBottom) : null;
  // TP2: full impulse TF scan (no OB filter needed)
  const tp2    = tp2Candles ? detectWeakLiquidity(tp2Candles, dir) : null;
  const icons  = { HIGH: '[HIGH]', MEDIUM: '[MED]', STANDARD: '[STD]', AVOID: '[STRONG]' };

  let out = '\n---- TARGET LIQUIDITY (' + direction + ') ----\n';
  out    += 'Targeting ' + (isBull ? 'unswept weak HIGHS above' : 'unswept weak LOWS below') + ' current price\n';
  if (tp1?.approachIsSideways) {
    out += 'Approach to OB is SIDEWAYS -- liquidity targets valid\n';
  } else if (obTop) {
    out += 'Note: Approach to OB is not clearly sideways -- liquidity quality may be lower\n';
  }

  const fmt = (data, tfLabel) => {
    if (!data?.levels?.length) return '\n' + tfLabel + ': No unswept levels identified\n';
    let s = '\n' + tfLabel + ':\n';
    data.levels.slice(0, 3).forEach(l => {
      s += '  ' + icons[l.quality] + ' ' + l.label + ' @ ' + l.price + '\n';
      s += '    ' + l.desc + '\n';
      if (l.quality === 'HIGH' || l.quality === 'MEDIUM') s += '    -> Full TP target\n';
      if (l.quality === 'AVOID') s += '    -> TP before this\n';
    });
    return s;
  };

  out += fmt(tp1, 'TP1 -- ' + fractal.tp1.toUpperCase() + ' (entry TF, approach wave)');
  out += fmt(tp2, 'TP2 -- ' + fractal.tp2.toUpperCase() + ' (impulse TF)');
  out += '\nRule: Full TP at HIGH/MEDIUM | Partial at STANDARD | Avoid chasing STRONG singles\n';
  return out;
}



// ?? Exports ???????????????????????????????????????????????
// ---- Format impulse result for Claude prompt ----------------
function formatImpulseForPrompt(bias, biasTF, fractal, impulse) {
  let out = '\n---- IMPULSE (' + fractal.impulse.toUpperCase() + ') -- ' + bias + ' from ' + biasTF.toUpperCase() + ' C2 anchor ----\n';
  out += 'C2 anchor (' + (bias === 'BULLISH' ? 'low' : 'high') + '): ' + impulse.anchorPrice + '\n';
  out += 'Fractal: ' + fractal.label + '\n';
  if (impulse.found) {
    out += 'Wave: ' + impulse.candleCount + ' candles | Start: ' + impulse.waveStart + ' -> Current: ' + impulse.currentPrice + '\n';
    out += impulse.detail + '\n';
    if (impulse.ob && impulse.ob.length) {
      out += '\nENTRY ZONE -- OB on ' + fractal.impulse.toUpperCase() + ':\n';
      impulse.ob.forEach(function(o, i) {
        out += '  OB' + (i+1) + ' [' + o.type + '] Top=' + o.top + ' Bot=' + o.bottom + ' Mid=' + o.mid + '\n';
        if (o.hasFVG) out += '  FVG: ' + o.fvgBottom + '-' + o.fvgTop + ' (OB+FVG overlap)\n';
        out += '  -> Enter when price reaches this OB and sweep confirms on ' + fractal.entry.toUpperCase() + '\n';
      });
    } else {
      out += '\nNo OB found yet on ' + fractal.impulse.toUpperCase() + '\n';
    }
    if (impulse.fvg && impulse.fvg.length) {
      out += '\nFVGs on ' + fractal.impulse.toUpperCase() + ':\n';
      impulse.fvg.forEach(function(f) { out += '  [' + f.type + '] Top=' + f.top + ' Bot=' + f.bottom + ' Mid=' + f.mid + '\n'; });
    }
    out += '\nTP1: weak ' + (bias === 'BULLISH' ? 'highs' : 'lows') + ' on ' + fractal.tp1.toUpperCase();
    out += ' | TP2: weak ' + (bias === 'BULLISH' ? 'highs' : 'lows') + ' on ' + fractal.tp2.toUpperCase() + '\n';
  } else {
    out += 'Impulse not started. ' + (impulse.detail || '') + '\n';
  }
  return out;
}


const _origExports = module.exports;
module.exports = {
  ..._origExports,
  resolveTF,
  findImpulseFromC2,
  detectFVG,
  detectOB,
  detectWeakLiquidity,
  detectWPattern,
  detectMPattern,
  detectRectangle,
  detectTriangle,
  detectPennant,
  detectConsolidationPatterns,
  classifySetupGrade,
  formatImpulseForPrompt,
  formatLiquidityTargets,
  TF_FRACTAL,
};

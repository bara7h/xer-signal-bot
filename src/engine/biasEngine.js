// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE v2 — Bias Engine
// Exact C1/C2 rules, zone calc, invalidation, recalculation, SL/TP
// ─────────────────────────────────────────────────────────────────────────────

const { FIBO, RR, getSlBuffer } = require("../../config/markets");

// ── Bias Detection ────────────────────────────────────────────────────────────
// C1 = candles[n-2], C2 = candles[n-1] (both closed)
//
// BULLISH — all three must be true:
//   C2.low  < C1.low
//   C2.high < C1.high
//   C2.close < C1.high
//
// BEARISH — all three must be true:
//   C2.high > C1.high
//   C2.low  > C1.low
//   C2.close > C1.low

function detectBias(candles) {
  if (!candles || candles.length < 2) return null;
  const C1 = candles[candles.length - 2];
  const C2 = candles[candles.length - 1];
  if (!C1 || !C2) return null;

  const bullish =
    C2.low   < C1.low  &&
    C2.high  < C1.high &&
    C2.close < C1.high;

  const bearish =
    C2.high  > C1.high &&
    C2.low   > C1.low  &&
    C2.close > C1.low;

  if (bullish) return { bias: "BULLISH", C1, C2, passed: buildPassedChecks(C1, C2, "BULLISH") };
  if (bearish) return { bias: "BEARISH", C1, C2, passed: buildPassedChecks(C1, C2, "BEARISH") };
  return null;
}

function buildPassedChecks(C1, C2, bias) {
  if (bias === "BULLISH") return [
    { check: "C2 low < C1 low",    pass: C2.low  < C1.low  },
    { check: "C2 high < C1 high",  pass: C2.high < C1.high },
    { check: "C2 close < C1 high", pass: C2.close < C1.high },
  ];
  return [
    { check: "C2 high > C1 high",  pass: C2.high  > C1.high },
    { check: "C2 low > C1 low",    pass: C2.low   > C1.low  },
    { check: "C2 close > C1 low",  pass: C2.close > C1.low  },
  ];
}

// ── Invalidation ──────────────────────────────────────────────────────────────
// BULLISH invalidated: any subsequent candle closes ABOVE C2.high
// BEARISH invalidated: any subsequent candle closes BELOW C2.low

function checkInvalidation(biasResult, newCandles) {
  if (!biasResult || !newCandles || !newCandles.length) return false;
  const { bias, C2 } = biasResult;
  for (const c of newCandles) {
    if (bias === "BULLISH" && c.close > C2.high) return true;
    if (bias === "BEARISH" && c.close < C2.low)  return true;
  }
  return false;
}

// ── Zone Calculation ──────────────────────────────────────────────────────────
// Fib applied to C2 range (C2.high - C2.low)
//
// BULLISH (expect retrace DOWN into discount):
//   Zone1: C2.low + range*0.618  →  C2.low + range*0.768
//   Zone2: C2.low               →  C2.low + range*0.618
//
// BEARISH (expect retrace UP into premium):
//   Zone1: C2.high - range*0.768 →  C2.high - range*0.618
//   Zone2: C2.high - range*0.618 →  C2.high

function calculateZones(biasResult) {
  const { bias, C1, C2 } = biasResult;
  const range = C2.high - C2.low;

  if (bias === "BULLISH") {
    const z1lo = r(C2.low + range * FIBO.ZONE1_LOW);
    const z1hi = r(C2.low + range * FIBO.ZONE1_HIGH);
    return {
      bias, range: r(range),
      zone1: { high: z1hi, low: z1lo },
      zone2: { high: z1lo,  low: r(C2.low) },
      C2High: C2.high, C2Low: C2.low,
      C1High: C1.high, C1Low: C1.low,
      recalculated: false,
    };
  }

  if (bias === "BEARISH") {
    const z1hi = r(C2.high - range * FIBO.ZONE1_LOW);
    const z1lo = r(C2.high - range * FIBO.ZONE1_HIGH);
    return {
      bias, range: r(range),
      zone1: { high: z1hi, low: z1lo },
      zone2: { high: r(C2.high), low: z1hi },
      C2High: C2.high, C2Low: C2.low,
      C1High: C1.high, C1Low: C1.low,
      recalculated: false,
    };
  }
  return null;
}

// ── Zone Recalculation ────────────────────────────────────────────────────────
// Trigger when ALL of:
//   1. Price has NOT tapped Zone1
//   2. Price moved beyond C2 extreme (above C2.high for bearish / below C2.low for bullish)
//   3. Price is still within C1 range
//
// Action: recalculate Fib from the new reversal extreme → C2 anchor
//   BULLISH: new range = reversal_low → C2.high  (price dipped below C2.low but bounced)
//   BEARISH: new range = C2.low → reversal_high  (price spiked above C2.high but reversed)

function checkRecalculation(zones, price, biasResult) {
  if (!zones || !biasResult) return null;
  const { bias, C1, C2 } = biasResult;

  const inC1Range = price >= C1.low && price <= C1.high;
  if (!inC1Range) return null;

  const beyondC2 =
    (bias === "BULLISH" && price < C2.low) ||
    (bias === "BEARISH" && price > C2.high);
  if (!beyondC2) return null;

  // Build synthetic C2 using reversal point
  const newC2 = bias === "BULLISH"
    ? { high: C2.high, low: price,  close: price }
    : { high: price,  low: C2.low,  close: price };

  const newZones = calculateZones({ bias, C1, C2: newC2 });
  if (newZones) newZones.recalculated = true;
  return newZones;
}

// ── Price Zone Check ──────────────────────────────────────────────────────────
function getPriceZone(price, zones) {
  if (!zones) return null;
  if (price >= zones.zone1.low && price <= zones.zone1.high) return "Zone1";
  if (price >= zones.zone2.low && price <= zones.zone2.high) return "Zone2";
  return null;
}

// ── Stop Loss ─────────────────────────────────────────────────────────────────
// 3-step: SL beyond MTF zone extreme
// 2-step: SL beyond HTF zone extreme

function calculateSL(bias, zones, symbol) {
  const buf = getSlBuffer(symbol || "");
  if (!zones) return null;
  if (bias === "BULLISH") return r(zones.zone2.low - buf);
  return r(zones.zone2.high + buf);
}

// ── Take Profit ───────────────────────────────────────────────────────────────
function calculateTargets(bias, entry, sl) {
  const risk = Math.abs(entry - sl);
  if (bias === "BULLISH") return {
    tp1: r(entry + risk * RR.TP1),
    tp2: r(entry + risk * RR.TP2),
  };
  return {
    tp1: r(entry - risk * RR.TP1),
    tp2: r(entry - risk * RR.TP2),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function r(n, d = 5) { return Math.round(n * 10 ** d) / 10 ** d; }

function candlesAfter(candles, refCandle) {
  if (!refCandle || !refCandle.datetime) return [];
  return candles.filter(c => new Date(c.datetime) > new Date(refCandle.datetime));
}

module.exports = {
  detectBias, checkInvalidation, calculateZones,
  checkRecalculation, getPriceZone, calculateSL,
  calculateTargets, candlesAfter,
};

// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE — Bias Engine
// Implements EXACT C1/C2 bias rules + zone calculation + invalidation logic
// ─────────────────────────────────────────────────────────────────────────────

const { FIBO_ZONES, RR_TARGETS } = require("../../config/markets");

/**
 * BIAS DETECTION
 * Input: candles array (OHLC objects), newest last
 * Returns: { bias, C1, C2 } or null if no bias
 *
 * BULLISH — ALL must be true:
 *   C2.low  < C1.low
 *   C2.high < C1.high
 *   C2.close < C1.high
 *
 * BEARISH — ALL must be true:
 *   C2.high > C1.high
 *   C2.low  > C1.low
 *   C2.close > C1.low
 */
function detectBias(candles) {
  if (!candles || candles.length < 2) return null;

  // C1 = second to last CLOSED candle, C2 = last CLOSED candle
  // Index [0] is current forming candle — we ignore it if present
  // The function expects candles already filtered to CLOSED only
  const C1 = candles[candles.length - 2];
  const C2 = candles[candles.length - 1];

  if (!C1 || !C2) return null;

  const bullish =
    C2.low  < C1.low  &&
    C2.high < C1.high &&
    C2.close < C1.high;

  const bearish =
    C2.high > C1.high &&
    C2.low  > C1.low  &&
    C2.close > C1.low;

  if (bullish) return { bias: "BULLISH", C1, C2 };
  if (bearish) return { bias: "BEARISH", C1, C2 };

  return null;
}

/**
 * CHECK BIAS INVALIDATION
 * Call after detecting initial bias.
 * Pass the candle(s) that formed AFTER the bias C2.
 *
 * BULLISH invalidation: any subsequent candle CLOSES above C2.high
 * BEARISH invalidation: any subsequent candle CLOSES below C2.low
 *
 * @param {object} biasResult - { bias, C1, C2 }
 * @param {array}  newCandles - candles formed after C2
 * @returns {boolean} true = invalidated
 */
function checkInvalidation(biasResult, newCandles) {
  if (!biasResult || !newCandles || newCandles.length === 0) return false;

  const { bias, C2 } = biasResult;

  for (const candle of newCandles) {
    if (bias === "BULLISH" && candle.close > C2.high) return true;
    if (bias === "BEARISH" && candle.close < C2.low)  return true;
  }

  return false;
}

/**
 * CALCULATE ENTRY ZONES (Fibonacci on C2 range)
 *
 * C2 range = C2.high - C2.low
 *
 * BULLISH zones (price retracing UP into discount):
 *   Zone 1: C2.low + range * 0.618  →  C2.low + range * 0.768
 *   Zone 2: C2.low to C2.low + range * 0.618  (deep discount, Zone2 LOW extreme)
 *            per spec: "Bullish → 0.768 to C2 low"
 *
 * BEARISH zones (price retracing DOWN into premium):
 *   Zone 1: C2.high - range * 0.768  →  C2.high - range * 0.618
 *   Zone 2: C2.high - range * 0.768  →  C2.high  (deep premium)
 *            per spec: "Bearish → 0.768 to C2 high"
 *
 * @param {object} biasResult - { bias, C1, C2 }
 * @returns {object} { zone1: {high, low}, zone2: {high, low}, midpoint }
 */
function calculateZones(biasResult) {
  const { bias, C2 } = biasResult;
  const range = C2.high - C2.low;

  if (bias === "BULLISH") {
    const zone1Low  = C2.low + range * FIBO_ZONES.ZONE1_LOW;   // 0.618
    const zone1High = C2.low + range * FIBO_ZONES.ZONE1_HIGH;  // 0.768
    const zone2Low  = C2.low;
    const zone2High = zone1Low; // from C2 low up to 0.618

    return {
      bias,
      zone1: { high: round(zone1High), low: round(zone1Low) },
      zone2: { high: round(zone2High), low: round(zone2Low) },
      C2High: C2.high,
      C2Low:  C2.low,
      C1High: biasResult.C1.high,
      C1Low:  biasResult.C1.low,
    };
  }

  if (bias === "BEARISH") {
    const zone1High = C2.high - range * FIBO_ZONES.ZONE1_LOW;  // 0.618 from top
    const zone1Low  = C2.high - range * FIBO_ZONES.ZONE1_HIGH; // 0.768 from top
    const zone2High = C2.high;
    const zone2Low  = zone1High; // from 0.618 up to C2 high

    return {
      bias,
      zone1: { high: round(zone1High), low: round(zone1Low) },
      zone2: { high: round(zone2High), low: round(zone2Low) },
      C2High: C2.high,
      C2Low:  C2.low,
      C1High: biasResult.C1.high,
      C1Low:  biasResult.C1.low,
    };
  }

  return null;
}

/**
 * CHECK IF PRICE IS IN A ZONE
 * @param {number} price - current price
 * @param {object} zones - output of calculateZones()
 * @returns {string|null} "Zone1" | "Zone2" | null
 */
function getPriceZone(price, zones) {
  if (!zones) return null;

  if (price >= zones.zone1.low && price <= zones.zone1.high) return "Zone1";
  if (price >= zones.zone2.low && price <= zones.zone2.high) return "Zone2";

  return null;
}

/**
 * SPECIAL CONDITION — RECALCULATION
 * Trigger when:
 *   - Price did NOT tap Zone 1
 *   - Price moved beyond C2 extreme
 *   - Price still within C1 range
 *
 * Action: Recalculate zones using new swing point → C2 extreme
 *
 * @param {object} zones - original zones
 * @param {number} price - current price
 * @param {object} biasResult - { bias, C1, C2 }
 * @returns {object|null} new zones or null if recalc not needed
 */
function checkRecalculation(zones, price, biasResult) {
  if (!zones || !biasResult) return null;

  const { bias, C1, C2 } = biasResult;

  const inC1Range = price <= C1.high && price >= C1.low;
  if (!inC1Range) return null;

  const beyondC2 =
    (bias === "BULLISH" && price < C2.low)  ||
    (bias === "BEARISH" && price > C2.high);

  if (!beyondC2) return null;

  // New swing: use C2 extreme as new C2 boundary
  const newC2 = {
    high: bias === "BEARISH" ? price  : C2.high,
    low:  bias === "BULLISH" ? price  : C2.low,
    close: price,
  };

  const newBiasResult = { bias, C1, C2: newC2 };
  const newZones = calculateZones(newBiasResult);
  if (newZones) newZones.recalculated = true;

  return newZones;
}

/**
 * CALCULATE STOP LOSS
 * 3-step: SL beyond MTF zone
 * 2-step: SL beyond HTF zone
 *
 * @param {string} bias   - "BULLISH" | "BEARISH"
 * @param {object} zones  - the reference zones (MTF or HTF)
 * @param {number} buffer - pip/point buffer (default 0)
 * @returns {number} stop loss price
 */
function calculateStopLoss(bias, zones, buffer = 0) {
  if (!zones) return null;

  if (bias === "BULLISH") {
    // SL below zone2 low (deepest discount extreme)
    return round(zones.zone2.low - buffer);
  } else {
    // SL above zone2 high (deepest premium extreme)
    return round(zones.zone2.high + buffer);
  }
}

/**
 * CALCULATE TAKE PROFIT LEVELS
 * TP1 = 1RR, TP2 = 2RR
 *
 * @param {string} bias  - "BULLISH" | "BEARISH"
 * @param {number} entry - entry price
 * @param {number} sl    - stop loss price
 * @returns {object} { tp1, tp2 }
 */
function calculateTargets(bias, entry, sl) {
  const risk = Math.abs(entry - sl);

  if (bias === "BULLISH") {
    return {
      tp1: round(entry + risk * RR_TARGETS.TP1),
      tp2: round(entry + risk * RR_TARGETS.TP2),
    };
  } else {
    return {
      tp1: round(entry - risk * RR_TARGETS.TP1),
      tp2: round(entry - risk * RR_TARGETS.TP2),
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function round(n, decimals = 5) {
  return Math.round(n * 10 ** decimals) / 10 ** decimals;
}

module.exports = {
  detectBias,
  checkInvalidation,
  calculateZones,
  getPriceZone,
  checkRecalculation,
  calculateStopLoss,
  calculateTargets,
};

// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE — Fractal Analysis Engine
// Orchestrates multi-timeframe bias alignment and signal generation
// ─────────────────────────────────────────────────────────────────────────────

const {
  detectBias,
  checkInvalidation,
  calculateZones,
  getPriceZone,
  checkRecalculation,
  calculateStopLoss,
  calculateTargets,
} = require("./biasEngine");

const logger = require("../utils/logger");

/**
 * RUN 3-STEP FRACTAL ANALYSIS
 * HTF → MTF → LTF
 *
 * Returns a signal object if all 3 TFs align, otherwise null.
 *
 * @param {object} params
 *   symbol       - instrument symbol
 *   stack        - { id, label, htf, mtf, ltf }
 *   htfCandles   - OHLC array for HTF (closed candles, newest last)
 *   mtfCandles   - OHLC array for MTF
 *   ltfCandles   - OHLC array for LTF
 *   currentPrice - latest tick price
 */
async function runThreeStepFractal({ symbol, stack, htfCandles, mtfCandles, ltfCandles, currentPrice }) {
  const tag = `[3-Step][${symbol}][${stack.id}]`;

  // ── STEP 1: HTF Bias ──────────────────────────────────────────────────────
  const htfBias = detectBias(htfCandles);
  if (!htfBias) {
    logger.debug(`${tag} No HTF bias detected`);
    return null;
  }

  // Check HTF invalidation with candles after C2
  const htfPostC2 = getCandlesAfter(htfCandles, htfBias.C2);
  if (checkInvalidation(htfBias, htfPostC2)) {
    logger.debug(`${tag} HTF bias invalidated`);
    return null;
  }

  // ── STEP 2: HTF Zones & Price In Zone ────────────────────────────────────
  let htfZones = calculateZones(htfBias);
  const htfZoneHit = getPriceZone(currentPrice, htfZones);

  // Check recalculation condition
  if (!htfZoneHit) {
    const recalcZones = checkRecalculation(htfZones, currentPrice, htfBias);
    if (recalcZones) {
      logger.debug(`${tag} HTF zones recalculated`);
      htfZones = recalcZones;
    } else {
      logger.debug(`${tag} Price not in HTF zone (${currentPrice}), no recalc`);
      return null;
    }
  }

  const activeHTFZone = getPriceZone(currentPrice, htfZones) || "Zone1(recalc)";

  // ── STEP 3: MTF Bias (must match HTF) ────────────────────────────────────
  const mtfBias = detectBias(mtfCandles);
  if (!mtfBias || mtfBias.bias !== htfBias.bias) {
    logger.debug(`${tag} MTF bias mismatch or absent`);
    return null;
  }

  const mtfPostC2 = getCandlesAfter(mtfCandles, mtfBias.C2);
  if (checkInvalidation(mtfBias, mtfPostC2)) {
    logger.debug(`${tag} MTF bias invalidated`);
    return null;
  }

  const mtfZones = calculateZones(mtfBias);

  // ── STEP 4: LTF Bias (must match HTF/MTF) ────────────────────────────────
  const ltfBias = detectBias(ltfCandles);
  if (!ltfBias || ltfBias.bias !== htfBias.bias) {
    logger.debug(`${tag} LTF bias mismatch or absent`);
    return null;
  }

  const ltfPostC2 = getCandlesAfter(ltfCandles, ltfBias.C2);
  if (checkInvalidation(ltfBias, ltfPostC2)) {
    logger.debug(`${tag} LTF bias invalidated`);
    return null;
  }

  // ── STEP 5: Build Signal ──────────────────────────────────────────────────
  // Entry at midpoint of LTF Zone1 (highest precision entry)
  const ltfZones = calculateZones(ltfBias);
  const entry = midpoint(ltfZones.zone1);

  // SL: 3-step mode → beyond MTF zone
  const sl = calculateStopLoss(htfBias.bias, mtfZones, computeBuffer(symbol));
  const { tp1, tp2 } = calculateTargets(htfBias.bias, entry, sl);

  logger.info(`${tag} ✅ SIGNAL GENERATED — ${htfBias.bias}`);

  return {
    symbol,
    mode: "3-Step",
    bias: htfBias.bias,
    timeframeLabel: stack.label,
    htf: stack.htf,
    mtf: stack.mtf,
    ltf: stack.ltf,
    entry,
    sl,
    tp1,
    tp2,
    zone: activeHTFZone,
    htfZones,
    mtfZones,
    ltfZones,
    htfBias,
    mtfBias,
    ltfBias,
    status: "ACTIVE",
    timestamp: new Date().toISOString(),
  };
}

/**
 * RUN 2-STEP FRACTAL ANALYSIS
 * HTF → LTF (skip MTF)
 *
 * @param {object} params
 *   symbol       - instrument symbol
 *   stack        - { id, label, htf, ltf }
 *   htfCandles   - OHLC array for HTF
 *   ltfCandles   - OHLC array for LTF
 *   currentPrice - latest tick price
 */
async function runTwoStepFractal({ symbol, stack, htfCandles, ltfCandles, currentPrice }) {
  const tag = `[2-Step][${symbol}][${stack.id}]`;

  // ── STEP 1: HTF Bias ──────────────────────────────────────────────────────
  const htfBias = detectBias(htfCandles);
  if (!htfBias) {
    logger.debug(`${tag} No HTF bias detected`);
    return null;
  }

  const htfPostC2 = getCandlesAfter(htfCandles, htfBias.C2);
  if (checkInvalidation(htfBias, htfPostC2)) {
    logger.debug(`${tag} HTF bias invalidated`);
    return null;
  }

  // ── STEP 2: HTF Zones & Price In Zone ────────────────────────────────────
  let htfZones = calculateZones(htfBias);
  const htfZoneHit = getPriceZone(currentPrice, htfZones);

  if (!htfZoneHit) {
    const recalcZones = checkRecalculation(htfZones, currentPrice, htfBias);
    if (recalcZones) {
      htfZones = recalcZones;
      logger.debug(`${tag} HTF zones recalculated`);
    } else {
      logger.debug(`${tag} Price not in HTF zone`);
      return null;
    }
  }

  const activeHTFZone = getPriceZone(currentPrice, htfZones) || "Zone1(recalc)";

  // ── STEP 3: LTF Bias (must match HTF) ────────────────────────────────────
  const ltfBias = detectBias(ltfCandles);
  if (!ltfBias || ltfBias.bias !== htfBias.bias) {
    logger.debug(`${tag} LTF bias mismatch or absent`);
    return null;
  }

  const ltfPostC2 = getCandlesAfter(ltfCandles, ltfBias.C2);
  if (checkInvalidation(ltfBias, ltfPostC2)) {
    logger.debug(`${tag} LTF bias invalidated`);
    return null;
  }

  // ── STEP 4: Build Signal ──────────────────────────────────────────────────
  const ltfZones = calculateZones(ltfBias);
  const entry = midpoint(ltfZones.zone1);

  // SL: 2-step mode → beyond HTF zone
  const sl = calculateStopLoss(htfBias.bias, htfZones, computeBuffer(symbol));
  const { tp1, tp2 } = calculateTargets(htfBias.bias, entry, sl);

  logger.info(`${tag} ✅ SIGNAL GENERATED — ${htfBias.bias}`);

  return {
    symbol,
    mode: "2-Step",
    bias: htfBias.bias,
    timeframeLabel: stack.label,
    htf: stack.htf,
    ltf: stack.ltf,
    entry,
    sl,
    tp1,
    tp2,
    zone: activeHTFZone,
    htfZones,
    ltfZones,
    htfBias,
    ltfBias,
    status: "ACTIVE",
    timestamp: new Date().toISOString(),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get candles that formed AFTER a reference candle (by timestamp comparison)
 */
function getCandlesAfter(candles, referenceCandle) {
  if (!referenceCandle || !referenceCandle.datetime) return [];
  return candles.filter(c => new Date(c.datetime) > new Date(referenceCandle.datetime));
}

function midpoint(zone) {
  return Math.round(((zone.high + zone.low) / 2) * 100000) / 100000;
}

/**
 * Compute a small buffer for SL based on instrument type
 * Prevents SL being placed exactly at zone boundary
 */
function computeBuffer(symbol) {
  if (symbol.includes("XAU") || symbol.includes("GOLD")) return 1.0;   // $1 Gold
  if (symbol.includes("BTC")) return 50;                                  // $50 BTC
  if (symbol.includes("JPY")) return 0.02;                               // 2 pips JPY
  if (symbol.includes("SPX") || symbol.includes("NAS")) return 2.0;     // 2pts index
  return 0.0005; // ~0.5 pip default for Forex
}

module.exports = { runThreeStepFractal, runTwoStepFractal };

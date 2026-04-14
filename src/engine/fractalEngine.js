// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE v2 — Fractal Engine
// Orchestrates all fractal stacks. Each HTF bias spawns its own stack.
// MTF: check higher-priority TF first (4H > 1H), take first with same bias.
// ─────────────────────────────────────────────────────────────────────────────

const {
  detectBias, checkInvalidation, calculateZones,
  checkRecalculation, getPriceZone, calculateSL,
  calculateTargets, candlesAfter,
} = require("./biasEngine");
const { FRACTAL_STACKS, HTF_TIMEFRAMES, BIAS_ONLY_TIMEFRAMES, getTfLabel } = require("../../config/markets");
const { fetchCandles, fetchCurrentPrice, isTimeframeAvailable } = require("../scanner/dataProvider");
const logger = require("../utils/logger");

// ─────────────────────────────────────────────────────────────────────────────
// MODE 0: BIAS ONLY — scan all TFs, return bias state per TF, no zones/entry
// ─────────────────────────────────────────────────────────────────────────────

async function runBiasOnly(symbol) {
  const results = {};
  const tfs = BIAS_ONLY_TIMEFRAMES;

  const candlesets = await Promise.all(
    tfs.map(tf => fetchCandles(symbol, tf, 10))
  );

  for (let i = 0; i < tfs.length; i++) {
    const tf = tfs[i];
    const candles = candlesets[i];
    if (!candles || candles.length < 2) {
      results[tf] = { bias: "NO DATA", C1: null, C2: null };
      continue;
    }
    const b = detectBias(candles);
    if (!b) {
      results[tf] = { bias: "NEUTRAL", C1: candles[candles.length-2], C2: candles[candles.length-1] };
    } else {
      // Check invalidation
      const post = candlesAfter(candles, b.C2);
      const invalid = checkInvalidation(b, post);
      results[tf] = {
        bias: invalid ? "INVALIDATED" : b.bias,
        C1: b.C1,
        C2: b.C2,
        passed: b.passed,
        invalidated: invalid,
      };
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// FULL SCAN — Step 1: find all HTF biases
//             Step 2: for each HTF bias, run its fractal stack
//             Returns array of signal objects (one per successful stack)
// ─────────────────────────────────────────────────────────────────────────────

async function runFullScan(symbol) {
  const signals = [];
  const analysisLog = []; // full step-by-step log for analysis mode

  const currentPrice = await fetchCurrentPrice(symbol);
  if (!currentPrice) return { signals, analysisLog, error: "Could not fetch price" };

  // ── Step 1: fetch all HTF candles and detect biases ───────────────────────
  const htfCandles = {};
  const htfBiases  = {};

  const htfFetches = await Promise.all(
    HTF_TIMEFRAMES.map(tf => fetchCandles(symbol, tf, 10))
  );

  for (let i = 0; i < HTF_TIMEFRAMES.length; i++) {
    const tf = HTF_TIMEFRAMES[i];
    const candles = htfFetches[i];
    htfCandles[tf] = candles;

    if (!candles || candles.length < 2) {
      analysisLog.push({ tf, step: "htf_bias", result: "NO DATA" });
      continue;
    }

    const b = detectBias(candles);
    if (!b) {
      analysisLog.push({ tf, step: "htf_bias", result: "NEUTRAL", C1: candles[candles.length-2], C2: candles[candles.length-1] });
      continue;
    }

    const post = candlesAfter(candles, b.C2);
    if (checkInvalidation(b, post)) {
      analysisLog.push({ tf, step: "htf_bias", result: "INVALIDATED", bias: b.bias, C1: b.C1, C2: b.C2 });
      continue;
    }

    htfBiases[tf] = b;
    analysisLog.push({ tf, step: "htf_bias", result: "FOUND", bias: b.bias, C1: b.C1, C2: b.C2, passed: b.passed });
  }

  const biasesFound = Object.keys(htfBiases);
  if (!biasesFound.length) {
    return { signals, analysisLog, currentPrice, noHTFBias: true };
  }

  // ── Step 2: for each HTF bias, run its fractal stack ─────────────────────
  for (const htfTf of biasesFound) {
    const htfBias  = htfBiases[htfTf];
    const stack    = FRACTAL_STACKS[htfTf];
    if (!stack) continue;

    const stackLog = { htfTf, htfBias: htfBias.bias, steps: [] };

    // Step 2a: HTF zones
    let htfZones = calculateZones(htfBias);
    let zoneHit  = getPriceZone(currentPrice, htfZones);

    // Recalculation check
    if (!zoneHit) {
      const recalc = checkRecalculation(htfZones, currentPrice, htfBias);
      if (recalc) {
        htfZones = recalc;
        zoneHit  = getPriceZone(currentPrice, htfZones);
        stackLog.steps.push({ step: "htf_zones", result: "RECALCULATED", zones: htfZones, zoneHit });
      } else {
        stackLog.steps.push({ step: "htf_zones", result: "PRICE_NOT_IN_ZONE", zones: htfZones, currentPrice });
        analysisLog.push(stackLog);
        continue;
      }
    } else {
      stackLog.steps.push({ step: "htf_zones", result: "ZONE_HIT", zones: htfZones, zoneHit });
    }

    // Step 2b: MTF — check priority order, take first with same bias in zone
    const mtfTfs = stack.mtfOptions;
    let chosenMtf = null;
    let mtfBias   = null;
    let mtfZones  = null;

    const mtfCandles = await Promise.all(
      mtfTfs.map(tf => fetchCandles(symbol, tf, 10))
    );

    for (let i = 0; i < mtfTfs.length; i++) {
      const tf = mtfTfs[i];
      const candles = mtfCandles[i];
      if (!candles || candles.length < 2) continue;

      const b = detectBias(candles);
      if (!b || b.bias !== htfBias.bias) {
        stackLog.steps.push({ step: "mtf_check", tf, result: b ? `MISMATCH (${b.bias})` : "NEUTRAL" });
        continue;
      }

      const post = candlesAfter(candles, b.C2);
      if (checkInvalidation(b, post)) {
        stackLog.steps.push({ step: "mtf_check", tf, result: "INVALIDATED" });
        continue;
      }

      chosenMtf = tf;
      mtfBias   = b;
      mtfZones  = calculateZones(b);
      stackLog.steps.push({ step: "mtf_check", tf, result: "CONFIRMED", bias: b.bias, C1: b.C1, C2: b.C2, zones: mtfZones, quality: i === 0 ? "HIGH" : "STANDARD" });
      break;
    }

    if (!chosenMtf) {
      stackLog.steps.push({ step: "mtf_result", result: "NO_MTF_ALIGNMENT" });
      analysisLog.push(stackLog);
      continue;
    }

    // Step 2c: LTF — confirm same bias, this triggers entry
    let ltfTf = stack.ltf;

    // If ltf is 1min, check availability
    if (ltfTf === "1min") {
      const avail = await isTimeframeAvailable(symbol, "1min");
      if (!avail) ltfTf = "5min";
    }

    const ltfCandles = await fetchCandles(symbol, ltfTf, 10);
    if (!ltfCandles || ltfCandles.length < 2) {
      stackLog.steps.push({ step: "ltf_check", tf: ltfTf, result: "NO DATA" });
      analysisLog.push(stackLog);
      continue;
    }

    const ltfB = detectBias(ltfCandles);
    if (!ltfB || ltfB.bias !== htfBias.bias) {
      stackLog.steps.push({ step: "ltf_check", tf: ltfTf, result: ltfB ? `MISMATCH (${ltfB.bias})` : "NEUTRAL" });
      analysisLog.push(stackLog);
      continue;
    }

    const ltfPost = candlesAfter(ltfCandles, ltfB.C2);
    if (checkInvalidation(ltfB, ltfPost)) {
      stackLog.steps.push({ step: "ltf_check", tf: ltfTf, result: "INVALIDATED" });
      analysisLog.push(stackLog);
      continue;
    }

    const ltfZones = calculateZones(ltfB);
    stackLog.steps.push({ step: "ltf_check", tf: ltfTf, result: "CONFIRMED", bias: ltfB.bias, C1: ltfB.C1, C2: ltfB.C2, zones: ltfZones });

    // ── Build signal ─────────────────────────────────────────────────────────
    const entry = mid(ltfZones.zone1);
    const sl    = calculateSL(htfBias.bias, mtfZones, symbol);
    const { tp1, tp2 } = calculateTargets(htfBias.bias, entry, sl);

    const signal = {
      symbol,
      bias:    htfBias.bias,
      htfTf,
      mtfTf:   chosenMtf,
      mtfQuality: mtfTfs.indexOf(chosenMtf) === 0 ? "HIGH" : "STANDARD",
      ltfTf,
      tfLabel: `${getTfLabel(htfTf)} → ${getTfLabel(chosenMtf)} → ${getTfLabel(ltfTf)}`,
      entry, sl, tp1, tp2,
      zone:    zoneHit,
      rr:      (Math.abs(tp2 - entry) / Math.abs(entry - sl)).toFixed(1),
      htfBias, htfZones,
      mtfBias, mtfZones,
      ltfBias: ltfB, ltfZones,
      currentPrice,
      status:  "ACTIVE",
      timestamp: new Date().toISOString(),
    };

    stackLog.steps.push({ step: "signal_built", result: "SUCCESS", signal });
    signals.push(signal);
    analysisLog.push(stackLog);
    logger.info(`[${symbol}] SIGNAL: ${htfBias.bias} | ${getTfLabel(htfTf)}→${getTfLabel(chosenMtf)}→${getTfLabel(ltfTf)} | Entry ${entry}`);
  }

  return { signals, analysisLog, currentPrice, htfBiases };
}

function mid(zone) {
  const v = (zone.high + zone.low) / 2;
  return Math.round(v * 100000) / 100000;
}

module.exports = { runBiasOnly, runFullScan };

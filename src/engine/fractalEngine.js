// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE v2 — Fractal Engine
// Uses batch fetching: one API call gets all timeframes for a symbol
// onProgress callback sends real-time updates to Telegram
// ─────────────────────────────────────────────────────────────────────────────

const {
  detectBias, checkInvalidation, calculateZones,
  checkRecalculation, getPriceZone, calculateSL,
  calculateTargets, candlesAfter,
} = require("./biasEngine");

const { fetchAllTimeframes, fetchCurrentPrice } = require("../scanner/dataProvider");
const { FRACTAL_STACKS, HTF_TIMEFRAMES, BIAS_ONLY_TIMEFRAMES, getTfLabel } = require("../../config/markets");
const logger = require("../utils/logger");

// All unique timeframes needed for a full scan
const ALL_TFS = ["1week","1day","4h","1h","15min","5min"];

// ─────────────────────────────────────────────────────────────────────────────
// MODE 0: BIAS ONLY
// ─────────────────────────────────────────────────────────────────────────────

async function runBiasOnly(symbol, onProgress) {
  if (onProgress) await onProgress("Fetching candles for "+symbol+"...");
  
  const candleMap = await fetchAllTimeframes(symbol, BIAS_ONLY_TIMEFRAMES, 10);
  const results   = {};

  for (const tf of BIAS_ONLY_TIMEFRAMES) {
    const candles = candleMap[tf];
    if (!candles || candles.length < 2) {
      results[tf] = { bias:"NO DATA" }; continue;
    }
    const b = detectBias(candles);
    if (!b) {
      results[tf] = { bias:"NEUTRAL", C1:candles[candles.length-2], C2:candles[candles.length-1] };
    } else {
      const invalid = checkInvalidation(b, candlesAfter(candles, b.C2));
      results[tf] = { bias: invalid?"INVALIDATED":b.bias, C1:b.C1, C2:b.C2, passed:b.passed, invalidated:invalid };
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// FULL SCAN
// ─────────────────────────────────────────────────────────────────────────────

async function runFullScan(symbol, onProgress) {
  const signals    = [];
  const analysisLog = [];

  // Single batch call — gets ALL timeframes at once
  if (onProgress) await onProgress("📡 Fetching "+symbol+" data...");
  const candleMap = await fetchAllTimeframes(symbol, ALL_TFS, 10);

  // Derive current price from freshest candle (no extra API call)
  let currentPrice = null;
  for (const tf of ["5min","15min","1h","4h","1day"]) {
    const c = candleMap[tf];
    if (c && c.length) { currentPrice = c[c.length-1].close; break; }
  }

  if (!currentPrice) {
    // Last resort: try the price endpoint
    currentPrice = await fetchCurrentPrice(symbol);
  }

  if (!currentPrice) {
    const err = "No data returned for "+symbol+". Check API key and symbol format.";
    if (onProgress) await onProgress("❌ "+err);
    return { signals, analysisLog, error: err };
  }

  if (onProgress) await onProgress("🔎 Analysing "+symbol+" at "+currentPrice+"...");

  // ── Step 1: HTF bias detection ────────────────────────────────────────────
  const htfBiases = {};

  for (const tf of HTF_TIMEFRAMES) {
    const candles = candleMap[tf];
    if (!candles || candles.length < 2) {
      analysisLog.push({ tf, step:"htf_bias", result:"NO DATA" }); continue;
    }
    const b = detectBias(candles);
    if (!b) {
      analysisLog.push({ tf, step:"htf_bias", result:"NEUTRAL",
        C1:candles[candles.length-2], C2:candles[candles.length-1] }); continue;
    }
    if (checkInvalidation(b, candlesAfter(candles, b.C2))) {
      analysisLog.push({ tf, step:"htf_bias", result:"INVALIDATED", bias:b.bias }); continue;
    }
    htfBiases[tf] = b;
    analysisLog.push({ tf, step:"htf_bias", result:"FOUND", bias:b.bias, C1:b.C1, C2:b.C2, passed:b.passed });
  }

  const biasesFound = Object.keys(htfBiases);

  if (!biasesFound.length) {
    return { signals, analysisLog, currentPrice, noHTFBias:true, htfBiases:{} };
  }

  if (onProgress) {
    const summary = biasesFound.map(tf => getTfLabel(tf)+":"+htfBiases[tf].bias).join(" | ");
    await onProgress("📊 HTF biases: "+summary+"\n🔗 Checking fractal alignment...");
  }

  // ── Step 2: run fractal stack for each HTF bias ───────────────────────────
  for (const htfTf of biasesFound) {
    const htfBias = htfBiases[htfTf];
    const stack   = FRACTAL_STACKS[htfTf];
    if (!stack) continue;

    const stackLog = { htfTf, htfBias:htfBias.bias, steps:[] };

    // HTF zones
    let htfZones = calculateZones(htfBias);
    let zoneHit  = getPriceZone(currentPrice, htfZones);

    if (!zoneHit) {
      const recalc = checkRecalculation(htfZones, currentPrice, htfBias);
      if (recalc) { htfZones = recalc; zoneHit = getPriceZone(currentPrice, htfZones); }
    }

    if (!zoneHit) {
      stackLog.steps.push({ step:"htf_zones", result:"PRICE_NOT_IN_ZONE", zones:htfZones, currentPrice });
      analysisLog.push(stackLog); continue;
    }
    stackLog.steps.push({ step:"htf_zones", result:"ZONE_HIT", zones:htfZones, zoneHit });

    // MTF — check priority options, all candles already in candleMap
    let chosenMtf=null, mtfBias=null, mtfZones=null;

    for (let i=0; i<stack.mtfOptions.length; i++) {
      const tf      = stack.mtfOptions[i];
      const candles = candleMap[tf];
      if (!candles || candles.length < 2) {
        stackLog.steps.push({ step:"mtf_check", tf, result:"NO DATA" }); continue;
      }
      const b = detectBias(candles);
      if (!b || b.bias !== htfBias.bias) {
        stackLog.steps.push({ step:"mtf_check", tf, result: b?"MISMATCH ("+b.bias+")":"NEUTRAL" }); continue;
      }
      if (checkInvalidation(b, candlesAfter(candles, b.C2))) {
        stackLog.steps.push({ step:"mtf_check", tf, result:"INVALIDATED" }); continue;
      }
      chosenMtf = tf;
      mtfBias   = b;
      mtfZones  = calculateZones(b);
      stackLog.steps.push({ step:"mtf_check", tf, result:"CONFIRMED", bias:b.bias,
        C1:b.C1, C2:b.C2, zones:mtfZones, quality: i===0?"HIGH":"STANDARD" });
      break;
    }

    if (!chosenMtf) {
      stackLog.steps.push({ step:"mtf_result", result:"NO_MTF_ALIGNMENT" });
      analysisLog.push(stackLog); continue;
    }

    // LTF — also already in candleMap
    let ltfTf = stack.ltf;
    if (ltfTf === "1min" && (!candleMap["1min"] || !candleMap["1min"].length)) ltfTf = "5min";

    const ltfCandles = candleMap[ltfTf];
    if (!ltfCandles || ltfCandles.length < 2) {
      stackLog.steps.push({ step:"ltf_check", tf:ltfTf, result:"NO DATA" });
      analysisLog.push(stackLog); continue;
    }

    const ltfB = detectBias(ltfCandles);
    if (!ltfB || ltfB.bias !== htfBias.bias) {
      stackLog.steps.push({ step:"ltf_check", tf:ltfTf, result: ltfB?"MISMATCH ("+ltfB.bias+")":"NEUTRAL" });
      analysisLog.push(stackLog); continue;
    }
    if (checkInvalidation(ltfB, candlesAfter(ltfCandles, ltfB.C2))) {
      stackLog.steps.push({ step:"ltf_check", tf:ltfTf, result:"INVALIDATED" });
      analysisLog.push(stackLog); continue;
    }

    const ltfZones = calculateZones(ltfB);
    stackLog.steps.push({ step:"ltf_check", tf:ltfTf, result:"CONFIRMED",
      bias:ltfB.bias, C1:ltfB.C1, C2:ltfB.C2, zones:ltfZones });

    // Build signal
    const entry = mid(ltfZones.zone1);
    const sl    = calculateSL(htfBias.bias, mtfZones, symbol);
    const { tp1, tp2 } = calculateTargets(htfBias.bias, entry, sl);
    const rr    = (Math.abs(tp2-entry)/Math.abs(entry-sl)).toFixed(1);

    const signal = {
      symbol, bias:htfBias.bias, htfTf, mtfTf:chosenMtf,
      mtfQuality: stack.mtfOptions.indexOf(chosenMtf)===0?"HIGH":"STANDARD",
      ltfTf,
      tfLabel: getTfLabel(htfTf)+" → "+getTfLabel(chosenMtf)+" → "+getTfLabel(ltfTf),
      entry, sl, tp1, tp2, rr,
      zone: zoneHit, htfBias, htfZones, mtfBias, mtfZones,
      ltfBias:ltfB, ltfZones, currentPrice, status:"ACTIVE",
      timestamp: new Date().toISOString(),
    };

    stackLog.steps.push({ step:"signal_built", result:"SUCCESS", signal });
    signals.push(signal);
    analysisLog.push(stackLog);
    logger.info("["+symbol+"] SIGNAL: "+htfBias.bias+" "+getTfLabel(htfTf)+"→"+getTfLabel(chosenMtf)+"→"+getTfLabel(ltfTf)+" entry:"+entry);
  }

  return { signals, analysisLog, currentPrice, htfBiases, noHTFBias:false };
}

function mid(zone) { return Math.round((zone.high+zone.low)/2*100000)/100000; }

module.exports = { runBiasOnly, runFullScan };

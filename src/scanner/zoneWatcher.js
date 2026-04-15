// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE v2 — Zone Watcher
// Tracks setups where HTF bias exists but price hasn't hit the zone yet.
// Polls price cheaply (1 API call per instrument) and fires when price enters.
// Also watches active signals for invalidation.
// ─────────────────────────────────────────────────────────────────────────────

const { fetchCurrentPrice, fetchAllTimeframes, fetchPriceBatch } = require("./dataProvider");
const { detectBias, checkInvalidation, calculateZones,
        getPriceZone, calculateSL, calculateTargets,
        candlesAfter } = require("../engine/biasEngine");
const { FRACTAL_STACKS, getTfLabel } = require("../../config/markets");
const logger = require("../utils/logger");

// ── State ─────────────────────────────────────────────────────────────────────

// Watching setups: key = `${symbol}_${htfTf}_${bias}`
// value = { symbol, displayName, htfTf, bias, htfBias, htfZones, addedAt }
const watchingSetups = new Map();

// Active signals being monitored for invalidation
// key = same format, value = signal object
const activeSignals = new Map();

// Listeners
const signalListeners      = []; // fired when zone hit → full signal confirmed
const invalidationListeners = []; // fired when a setup or signal is invalidated
const zoneApproachListeners = []; // fired when price is close to zone (80% in)

let watchTimer = null;

// ── Public API ────────────────────────────────────────────────────────────────

function addWatching(setup) {
  const key = setup.symbol + "_" + setup.htfTf + "_" + setup.bias;
  if (!watchingSetups.has(key)) {
    watchingSetups.set(key, { ...setup, addedAt: new Date().toISOString() });
    logger.info("WATCHING: " + setup.displayName + " " + setup.bias + " on " + getTfLabel(setup.htfTf));
  }
}

function addActiveSignal(signal) {
  const key = signal.symbol + "_" + signal.htfTf + "_" + signal.bias;
  activeSignals.set(key, signal);
}

function removeWatching(key) { watchingSetups.delete(key); }
function removeSignal(key)   { activeSignals.delete(key); }

function getWatchingSetups() { return Array.from(watchingSetups.values()); }
function getActiveSignals()  { return Array.from(activeSignals.values()); }

function onSignal(fn)       { signalListeners.push(fn); }
function onInvalidation(fn) { invalidationListeners.push(fn); }
function onZoneApproach(fn) { zoneApproachListeners.push(fn); }

// ── Watch loop ────────────────────────────────────────────────────────────────

function startWatching(intervalMs) {
  const ms = intervalMs || parseInt(process.env.WATCH_INTERVAL_SECONDS || "30") * 1000;
  logger.info("Zone watcher started — checking every " + (ms/1000) + "s");
  runWatchCycle();
  watchTimer = setInterval(runWatchCycle, ms);
}

function stopWatching() {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
}

async function runWatchCycle() {
  const allSetups  = getWatchingSetups();
  const allSignals = getActiveSignals();

  if (!allSetups.length && !allSignals.length) return;

  // Collect unique symbols across watching + active
  const symbols = new Set();
  allSetups.forEach(s  => symbols.add(s.symbol + "|" + s.displayName));
  allSignals.forEach(s => symbols.add(s.symbol + "|" + s.displayName));

  // Fetch all prices in one Twelve Data batch call — 1 API credit total
  const symbolList = Array.from(symbols).map(e => e.split("|")[0]);
  const priceMap   = await fetchPriceBatch(symbolList);

  for (const entry of symbols) {
    const [symbol, displayName] = entry.split("|");
    try {
      const price = priceMap[symbol];
      if (!price) { logger.debug("No price for "+symbol); continue; }

      // Check watching setups for this symbol
      for (const [key, setup] of watchingSetups) {
        if (setup.symbol !== symbol) continue;
        await checkSetup(key, setup, price);
      }

      // Check active signals for invalidation
      for (const [key, signal] of activeSignals) {
        if (signal.symbol !== displayName && signal.symbol !== symbol) continue;
        await checkSignalInvalidation(key, signal, price);
      }

    } catch (e) {
      logger.error("Watch cycle [" + displayName + "]: " + e.message);
    }
  }
}

// ── Setup checker ─────────────────────────────────────────────────────────────

async function checkSetup(key, setup, price) {
  const { symbol, displayName, htfTf, bias, htfBias, htfZones } = setup;

  // 1. Check if HTF bias is still valid (candle-level invalidation)
  //    We do this by re-running detectBias on fresh HTF candles every ~10 cycles
  //    For now, check price-based invalidation (faster, no API call)
  const priceInvalidated =
    (bias === "BULLISH" && price > htfZones.C2High) ||
    (bias === "BEARISH" && price < htfZones.C2Low);

  if (priceInvalidated) {
    watchingSetups.delete(key);
    logger.info("INVALIDATED (price): " + displayName + " " + bias);
    for (const fn of invalidationListeners) {
      await fn({ type:"watching", symbol: displayName, htfTf, bias,
        reason: "Price moved past C2 extreme — bias invalidated",
        price, htfZones });
    }
    return;
  }

  // 2. Check zone proximity — alert when within 20% of zone
  const zoneHit = getPriceZone(price, htfZones);

  if (!zoneHit) {
    // Check if approaching (within 20% of distance to zone)
    const approaching = isApproachingZone(price, bias, htfZones);
    if (approaching) {
      for (const fn of zoneApproachListeners) {
        await fn({ symbol: displayName, htfTf, bias, price, htfZones, approaching });
      }
    }
    return;
  }

  // 3. Zone hit — now run full fractal confirmation
  logger.info("ZONE HIT: " + displayName + " " + bias + " " + getTfLabel(htfTf) + " at " + price);

  // Fetch MTF and LTF candles to confirm
  const stack = FRACTAL_STACKS[htfTf];
  if (!stack) { watchingSetups.delete(key); return; }

  const tfsNeeded = [...stack.mtfOptions, stack.ltf];
  const candleMap = await fetchAllTimeframes(symbol, tfsNeeded, 10);

  // Check MTF
  let chosenMtf = null, mtfBias = null, mtfZones = null;
  for (let i = 0; i < stack.mtfOptions.length; i++) {
    const tf      = stack.mtfOptions[i];
    const candles = candleMap[tf];
    if (!candles || candles.length < 2) continue;
    const b = detectBias(candles);
    if (!b || b.bias !== bias) continue;
    if (checkInvalidation(b, candlesAfter(candles, b.C2))) continue;
    chosenMtf = tf;
    mtfBias   = b;
    mtfZones  = calculateZones(b);
    break;
  }

  if (!chosenMtf) {
    logger.info("Zone hit but MTF not aligned yet for " + displayName + " — still watching");
    return; // keep watching — zone hit but MTF not ready yet
  }

  // Check LTF
  const ltfTf      = stack.ltf;
  const ltfCandles = candleMap[ltfTf];
  if (!ltfCandles || ltfCandles.length < 2) return;

  const ltfB = detectBias(ltfCandles);
  if (!ltfB || ltfB.bias !== bias) {
    logger.info("Zone hit, MTF ok, LTF not aligned yet for " + displayName + " — still watching");
    return; // keep watching
  }
  if (checkInvalidation(ltfB, candlesAfter(ltfCandles, ltfB.C2))) return;

  // All aligned — build signal
  const ltfZones  = calculateZones(ltfB);
  const entry     = mid(ltfZones.zone1);
  const sl        = calculateSL(bias, mtfZones, symbol);
  const { tp1, tp2 } = calculateTargets(bias, entry, sl);
  const rr        = (Math.abs(tp2-entry)/Math.abs(entry-sl)).toFixed(1);

  const signal = {
    symbol: displayName, bias, htfTf, mtfTf: chosenMtf,
    mtfQuality: stack.mtfOptions.indexOf(chosenMtf) === 0 ? "HIGH" : "STANDARD",
    ltfTf,
    tfLabel: getTfLabel(htfTf)+" → "+getTfLabel(chosenMtf)+" → "+getTfLabel(ltfTf),
    entry, sl, tp1, tp2, rr,
    zone: zoneHit, htfBias, htfZones, mtfBias, mtfZones,
    ltfBias: ltfB, ltfZones, currentPrice: price,
    status: "ACTIVE", triggeredBy: "ZONE_WATCHER",
    timestamp: new Date().toISOString(),
  };

  // Remove from watching, add to active signals
  watchingSetups.delete(key);
  activeSignals.set(key, signal);

  // Fire signal listeners
  for (const fn of signalListeners) {
    try { await fn(signal); } catch(e) { logger.error("Signal listener: "+e.message); }
  }
}

// ── Signal invalidation checker ───────────────────────────────────────────────

async function checkSignalInvalidation(key, signal, price) {
  const invalidated =
    (signal.bias === "BULLISH" && price < signal.sl) ||
    (signal.bias === "BEARISH" && price > signal.sl);

  if (!invalidated) return;

  activeSignals.delete(key);
  logger.info("SIGNAL INVALIDATED: " + signal.symbol + " — price hit SL at " + price);

  for (const fn of invalidationListeners) {
    await fn({ type:"signal", symbol: signal.symbol, htfTf: signal.htfTf,
      bias: signal.bias, price, sl: signal.sl,
      reason: "Price hit stop loss — signal invalidated" });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isApproachingZone(price, bias, zones) {
  if (bias === "BULLISH") {
    const distToZone = price - zones.zone1.high; // how far above zone top
    const zoneHeight = zones.zone1.high - zones.zone2.low;
    return distToZone > 0 && distToZone < zoneHeight * 0.3; // within 30% of zone size
  } else {
    const distToZone = zones.zone1.low - price; // how far below zone bottom
    const zoneHeight = zones.zone2.high - zones.zone1.low;
    return distToZone > 0 && distToZone < zoneHeight * 0.3;
  }
}

function mid(zone) { return Math.round((zone.high+zone.low)/2*100000)/100000; }
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

module.exports = {
  addWatching, addActiveSignal, removeWatching, removeSignal,
  getWatchingSetups, getActiveSignals,
  onSignal, onInvalidation, onZoneApproach,
  startWatching, stopWatching, runWatchCycle,
};

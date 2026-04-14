// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE — Market Scanner
// Manages watchlist, scanning schedule, dedup, and signal lifecycle
// ─────────────────────────────────────────────────────────────────────────────

const { fetchCandles, fetchCurrentPrice } = require("./dataProvider");
const { runThreeStepFractal, runTwoStepFractal } = require("../engine/fractalEngine");
const { FRACTAL_STACKS, SCAN_INTERVALS } = require("../../config/markets");
const logger = require("../utils/logger");

// ─── State ────────────────────────────────────────────────────────────────────

/** Active watchlist — array of instrument objects */
let watchlist = [];

/** Current fractal mode */
let currentMode = process.env.DEFAULT_MODE || "3step";

/** Active signals map: key = `${symbol}_${stackId}`, value = signal object */
const activeSignals = new Map();

/** Cooldown map: prevent duplicate alerts for same setup */
const signalCooldowns = new Map();
const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours per symbol/stack

/** Signal event listeners */
const signalListeners = [];

// ─── Public API ───────────────────────────────────────────────────────────────

function setWatchlist(instruments) {
  watchlist = instruments;
  logger.info(`Watchlist updated: ${instruments.map(i => i.displayName).join(", ")}`);
}

function getWatchlist() {
  return watchlist;
}

function setMode(mode) {
  if (!["3step", "2step"].includes(mode)) {
    throw new Error(`Invalid mode: ${mode}. Use "3step" or "2step".`);
  }
  currentMode = mode;
  logger.info(`Fractal mode set to: ${mode}`);
}

function getMode() {
  return currentMode;
}

function onSignal(listener) {
  signalListeners.push(listener);
}

function getActiveSignals() {
  return Array.from(activeSignals.values());
}

// ─── Scan Loop ────────────────────────────────────────────────────────────────

let scanInterval = null;

function startScanning(intervalMs) {
  const ms = intervalMs || parseInt(process.env.SCAN_INTERVAL_SECONDS || "60") * 1000;
  logger.info(`Scanner started — interval: ${ms / 1000}s | mode: ${currentMode}`);

  // Run immediately then on interval
  runScanCycle();
  scanInterval = setInterval(runScanCycle, ms);
}

function stopScanning() {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
    logger.info("Scanner stopped");
  }
}

async function runScanCycle() {
  if (watchlist.length === 0) {
    logger.debug("Scan cycle skipped — watchlist empty");
    return;
  }

  logger.debug(`--- Scan cycle START [${new Date().toISOString()}] mode=${currentMode} ---`);

  const stacks = FRACTAL_STACKS[currentMode];
  const tasks = [];

  for (const instrument of watchlist) {
    for (const stack of stacks) {
      tasks.push(scanInstrumentStack(instrument, stack));
    }
  }

  // Run all scans concurrently (but respect API rate limits via batching)
  await runBatched(tasks, 5); // max 5 concurrent API calls

  logger.debug(`--- Scan cycle END ---`);
}

/**
 * Scan a single instrument across a single fractal stack
 */
async function scanInstrumentStack(instrument, stack) {
  const { symbol, displayName } = instrument;
  const signalKey = `${symbol}_${stack.id}_${currentMode}`;

  // Check cooldown
  if (isOnCooldown(signalKey)) {
    logger.debug(`[${displayName}][${stack.id}] On cooldown — skipping`);
    return;
  }

  try {
    // Fetch current price
    const currentPrice = await fetchCurrentPrice(symbol);
    if (!currentPrice) return;

    let signal = null;

    if (currentMode === "3step") {
      // Fetch all three timeframes
      const [htfCandles, mtfCandles, ltfCandles] = await Promise.all([
        fetchCandles(symbol, stack.htf, 10),
        fetchCandles(symbol, stack.mtf, 10),
        fetchCandles(symbol, stack.ltf, 10),
      ]);

      if (!htfCandles || !mtfCandles || !ltfCandles) return;

      signal = await runThreeStepFractal({
        symbol: displayName,
        stack,
        htfCandles,
        mtfCandles,
        ltfCandles,
        currentPrice,
      });

    } else {
      // 2-step: HTF + LTF only
      const [htfCandles, ltfCandles] = await Promise.all([
        fetchCandles(symbol, stack.htf, 10),
        fetchCandles(symbol, stack.ltf, 10),
      ]);

      if (!htfCandles || !ltfCandles) return;

      signal = await runTwoStepFractal({
        symbol: displayName,
        stack,
        htfCandles,
        ltfCandles,
        currentPrice,
      });
    }

    if (signal) {
      // Store active signal
      activeSignals.set(signalKey, signal);

      // Set cooldown
      setCooldown(signalKey);

      // Notify all listeners (Telegram bot, etc.)
      for (const listener of signalListeners) {
        try {
          await listener(signal);
        } catch (err) {
          logger.error(`Signal listener error: ${err.message}`);
        }
      }
    }

  } catch (err) {
    logger.error(`scanInstrumentStack error [${displayName}][${stack.id}]: ${err.message}`);
  }
}

// ─── Manual Scan (on-demand for specific symbol) ──────────────────────────────

async function scanSymbol(symbolOrDisplay) {
  const instrument = watchlist.find(
    i => i.symbol === symbolOrDisplay || i.displayName === symbolOrDisplay
  );

  if (!instrument) {
    return { error: `Symbol "${symbolOrDisplay}" not in watchlist` };
  }

  const stacks = FRACTAL_STACKS[currentMode];
  const results = [];

  for (const stack of stacks) {
    await scanInstrumentStack(instrument, stack);
    const key = `${instrument.symbol}_${stack.id}_${currentMode}`;
    if (activeSignals.has(key)) {
      results.push(activeSignals.get(key));
    }
  }

  return results;
}

// ─── Cooldown helpers ─────────────────────────────────────────────────────────

function isOnCooldown(key) {
  const ts = signalCooldowns.get(key);
  if (!ts) return false;
  return Date.now() - ts < COOLDOWN_MS;
}

function setCooldown(key) {
  signalCooldowns.set(key, Date.now());
}

// ─── Batch runner (avoid API hammering) ──────────────────────────────────────

async function runBatched(tasks, batchSize) {
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    await Promise.all(batch);
    if (i + batchSize < tasks.length) {
      await sleep(500); // 500ms between batches
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Signal expiry cleanup ────────────────────────────────────────────────────

// Remove signals older than 24h from active map
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, signal] of activeSignals.entries()) {
    if (new Date(signal.timestamp).getTime() < cutoff) {
      activeSignals.delete(key);
      logger.debug(`Expired signal removed: ${key}`);
    }
  }
}, 60 * 60 * 1000); // check every hour

module.exports = {
  setWatchlist,
  getWatchlist,
  setMode,
  getMode,
  onSignal,
  getActiveSignals,
  startScanning,
  stopScanning,
  runScanCycle,
  scanSymbol,
};

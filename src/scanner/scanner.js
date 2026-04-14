// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE v2 — Scanner
// ─────────────────────────────────────────────────────────────────────────────

const { runFullScan, runBiasOnly } = require("../engine/fractalEngine");
const { DEFAULT_WATCHLIST } = require("../../config/markets");
const logger = require("../utils/logger");

let watchlist    = [...DEFAULT_WATCHLIST];
let outputMode   = process.env.DEFAULT_OUTPUT_MODE || "signal";
let fractalMode  = process.env.DEFAULT_MODE || "3step";
const activeSignals   = new Map();
const signalCooldowns = new Map();
const COOLDOWN_MS     = 4 * 60 * 60 * 1000;
const signalListeners = [];
let scanTimer = null;

function setWatchlist(l)  { watchlist = l; }
function getWatchlist()   { return watchlist; }
function setOutputMode(m) { outputMode = m; }
function getOutputMode()  { return outputMode; }
function setFractalMode(m){ fractalMode = m; }
function getFractalMode() { return fractalMode; }
function onSignal(fn)     { signalListeners.push(fn); }
function getActiveSignals(){ return Array.from(activeSignals.values()); }

function resolveInstruments(intent) {
  if (intent.symbols && intent.symbols.length)
    return watchlist.filter(i => intent.symbols.includes(i.displayName));
  if (intent.category && intent.category !== "all")
    return watchlist.filter(i => i.category === intent.category);
  return watchlist;
}

// onProgress: async fn(message) — sends real-time updates to chat
async function scanInstruments(instruments, onProgress) {
  const results = [];
  for (const inst of instruments) {
    try {
      const result = await runFullScan(inst.symbol, onProgress);
      for (const signal of (result.signals||[])) {
        const key = signal.symbol+"_"+signal.htfTf+"_"+signal.bias;
        if (!isOnCooldown(key)) {
          activeSignals.set(key, signal);
          setCooldown(key);
          for (const fn of signalListeners) {
            try { await fn(signal); } catch(e) { logger.error("Listener: "+e.message); }
          }
        }
      }
      results.push({ symbol: inst.displayName, result });
    } catch(e) {
      logger.error("scan ["+inst.displayName+"]: "+e.message);
      results.push({ symbol: inst.displayName, result: { error: e.message, signals:[] } });
    }
  }
  return results;
}

async function scanBiasOnly(instruments, onProgress) {
  const results = [];
  for (const inst of instruments) {
    try {
      const biasMap = await runBiasOnly(inst.symbol, onProgress);
      results.push({ symbol: inst.displayName, biasMap });
    } catch(e) {
      results.push({ symbol: inst.displayName, biasMap:null, error: e.message });
    }
  }
  return results;
}

function startScanning(ms) {
  logger.info("Auto-scan every "+(ms/1000)+"s");
  runAutoScan();
  scanTimer = setInterval(runAutoScan, ms);
}
function stopScanning() { if (scanTimer) { clearInterval(scanTimer); scanTimer=null; } }
async function runAutoScan() {
  logger.debug("Auto-scan: "+watchlist.length+" instruments");
  await scanInstruments(watchlist);
}

function isOnCooldown(key) { const t=signalCooldowns.get(key); return t&&Date.now()-t<COOLDOWN_MS; }
function setCooldown(key)  { signalCooldowns.set(key, Date.now()); }

setInterval(()=>{
  const cut=Date.now()-24*60*60*1000;
  for (const [k,s] of activeSignals.entries())
    if (new Date(s.timestamp).getTime()<cut) activeSignals.delete(k);
}, 3600000);

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

module.exports = {
  setWatchlist, getWatchlist, setOutputMode, getOutputMode,
  setFractalMode, getFractalMode, onSignal, getActiveSignals,
  resolveInstruments, scanInstruments, scanBiasOnly,
  startScanning, stopScanning, runAutoScan,
};

require("dotenv").config();
const logger    = require("./utils/logger");
const scanner   = require("./scanner/scanner");
const watcher   = require("./scanner/zoneWatcher");
const { initBot, broadcastSignal, broadcastAlert } = require("./telegram/bot");
const { validateConnection } = require("./scanner/dataProvider");

async function main() {
  logger.info("═══════════════════════════════════════════════════");
  logger.info("  XERO EDGE™ SIGNAL BOT v2 — Starting up");
  logger.info("  XERO TRADERS HUB | Pondicherry, India");
  logger.info("═══════════════════════════════════════════════════");

  // Validate API connection
  const check = await validateConnection();
  if (!check.ok) {
    logger.error("DATA CONNECTION: " + check.message);
    logger.error("Set DATA_PROVIDER=mock in Railway to test without API.");
  } else {
    logger.info("Data connection: " + check.message);
  }

  // Start bot
  initBot();

  // Wire scanner signals → Telegram
  scanner.onSignal(broadcastSignal);

  // Wire zone watcher events → Telegram
  watcher.onSignal(async (signal) => {
    logger.info("Zone watcher fired signal: " + signal.symbol + " " + signal.bias);
    await broadcastSignal(signal);
  });

  watcher.onInvalidation(async (info) => {
    logger.info("Invalidation: " + info.symbol + " " + info.bias + " — " + info.reason);
    await broadcastAlert({
      type:   "invalidation",
      symbol: info.symbol,
      bias:   info.bias,
      htfTf:  info.htfTf,
      reason: info.reason,
      price:  info.price,
      sl:     info.sl,
    });
  });

  watcher.onZoneApproach(async (info) => {
    logger.info("Zone approach: " + info.symbol + " approaching " + info.bias + " zone");
    await broadcastAlert({
      type:   "approaching",
      symbol: info.symbol,
      bias:   info.bias,
      htfTf:  info.htfTf,
      price:  info.price,
      zones:  info.htfZones,
    });
  });

  // Start auto-scan (full analysis)
  const scanMs = parseInt(process.env.SCAN_INTERVAL_SECONDS || "120") * 1000;
  scanner.startScanning(scanMs);

  // Start zone watcher (lightweight price checks)
  const watchMs = parseInt(process.env.WATCH_INTERVAL_SECONDS || "30") * 1000;
  watcher.startWatching(watchMs);

  logger.info("Bot LIVE | Scan every " + scanMs/1000 + "s | Watch every " + watchMs/1000 + "s");
  logger.info("Instruments: " + scanner.getWatchlist().length);

  process.on("SIGINT",  () => { scanner.stopScanning(); watcher.stopWatching(); process.exit(0); });
  process.on("SIGTERM", () => { scanner.stopScanning(); watcher.stopWatching(); process.exit(0); });
}

main().catch(e => { logger.error("Fatal: " + e.message); process.exit(1); });

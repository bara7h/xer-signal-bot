// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE™ SIGNAL BOT — Main Entry Point
// Fractal Liquidity Model | XERO TRADERS HUB
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();

const logger   = require("./utils/logger");
const scanner  = require("./scanner/scanner");
const { initBot, sendSignal } = require("./telegram/bot");
const { DEFAULT_WATCHLIST }   = require("../config/markets");

// ─── Boot Sequence ────────────────────────────────────────────────────────────

async function main() {
  logger.info("═══════════════════════════════════════════════════");
  logger.info("  XERO EDGE™ SIGNAL BOT — Starting up");
  logger.info("  XERO TRADERS HUB | Pondicherry, India");
  logger.info("═══════════════════════════════════════════════════");

  // 1. Initialize Telegram Bot
  initBot();

  // 2. Load default watchlist
  scanner.setWatchlist(DEFAULT_WATCHLIST);

  // 3. Set default fractal mode
  const mode = process.env.DEFAULT_MODE || "3step";
  scanner.setMode(mode);

  // 4. Wire signal events to Telegram delivery
  scanner.onSignal(async (signal) => {
    await sendSignal(signal);
  });

  // 5. Start scanning loop
  const intervalMs = parseInt(process.env.SCAN_INTERVAL_SECONDS || "60") * 1000;
  scanner.startScanning(intervalMs);

  logger.info(`Scanner running every ${intervalMs / 1000}s`);
  logger.info(`Mode: ${mode} | Watchlist: ${DEFAULT_WATCHLIST.length} instruments`);
  logger.info("Bot is LIVE. Waiting for fractal alignment...");

  // Graceful shutdown
  process.on("SIGINT",  shutdown);
  process.on("SIGTERM", shutdown);
}

function shutdown() {
  logger.info("Shutting down XERO EDGE™ Signal Bot...");
  scanner.stopScanning();
  process.exit(0);
}

main().catch(err => {
  logger.error("Fatal startup error:", err);
  process.exit(1);
});

require("dotenv").config();
const logger  = require("./utils/logger");
const scanner = require("./scanner/scanner");
const { initBot, broadcastSignal } = require("./telegram/bot");

async function main() {
  logger.info("═══════════════════════════════════════════════════");
  logger.info("  XERO EDGE™ SIGNAL BOT v2 — Starting up");
  logger.info("  XERO TRADERS HUB | Pondicherry, India");
  logger.info("═══════════════════════════════════════════════════");

  // Validate API connection before starting
  const { validateConnection } = require("./scanner/dataProvider");
  const check = await validateConnection();
  if (!check.ok) {
    logger.error("DATA CONNECTION FAILED: " + check.message);
    logger.error("Fix this before the bot can scan live markets.");
    logger.error("To test without an API key, set DATA_PROVIDER=mock in Railway variables.");
  } else {
    logger.info("Data connection: " + check.message);
  }

  initBot();

  scanner.onSignal(broadcastSignal);

  const ms = parseInt(process.env.SCAN_INTERVAL_SECONDS || "300") * 1000;
  scanner.startScanning(ms);

  logger.info(`Bot LIVE | Mode: ${scanner.getFractalMode()} | Output: ${scanner.getOutputMode()} | Instruments: ${scanner.getWatchlist().length}`);

  process.on("SIGINT",  () => { scanner.stopScanning(); process.exit(0); });
  process.on("SIGTERM", () => { scanner.stopScanning(); process.exit(0); });
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });

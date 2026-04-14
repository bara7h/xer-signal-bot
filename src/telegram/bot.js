// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE — Telegram Bot
// Handles all user commands and signal delivery
// ─────────────────────────────────────────────────────────────────────────────

const TelegramBot = require("node-telegram-bot-api");
const scanner = require("../scanner/scanner");
const { DEFAULT_WATCHLIST } = require("../../config/markets");
const logger = require("../utils/logger");

const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_CHAT_ID || "716635266");

let bot = null;

/** Authorized chat IDs (can receive signals) */
const authorizedChats = new Set([ADMIN_ID]);

// ─── Initialization ───────────────────────────────────────────────────────────

function initBot() {
  if (!TOKEN || TOKEN === "YOUR_BOT_TOKEN_HERE") {
    logger.warn("TELEGRAM_BOT_TOKEN not set — bot disabled, signals will log only");
    return null;
  }

  bot = new TelegramBot(TOKEN, { polling: true });

  logger.info("Telegram bot initialized — polling active");

  // Register commands
  bot.onText(/\/start/, handleStart);
  bot.onText(/\/help/, handleHelp);
  bot.onText(/\/mode (.+)/, handleMode);
  bot.onText(/\/mode$/, handleModeStatus);
  bot.onText(/\/scan (.+)/, handleScan);
  bot.onText(/\/scan$/, handleScanAll);
  bot.onText(/\/watchlist$/, handleWatchlist);
  bot.onText(/\/add (.+)/, handleAdd);
  bot.onText(/\/remove (.+)/, handleRemove);
  bot.onText(/\/signals$/, handleSignals);
  bot.onText(/\/status$/, handleStatus);
  bot.onText(/\/subscribe$/, handleSubscribe);
  bot.onText(/\/stop$/, handleStop);

  // Global error handler
  bot.on("polling_error", err => {
    logger.error(`Telegram polling error: ${err.message}`);
  });

  return bot;
}

// ─── Signal Delivery ─────────────────────────────────────────────────────────

/**
 * Send a XERO EDGE signal to all authorized chats
 */
async function sendSignal(signal) {
  const message = formatSignalMessage(signal);

  if (!bot) {
    // Log to console if bot not initialized
    logger.info(`\n${"═".repeat(50)}\n${message}\n${"═".repeat(50)}`);
    return;
  }

  for (const chatId of authorizedChats) {
    try {
      await bot.sendMessage(chatId, message, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
      logger.info(`Signal sent to chat ${chatId}: ${signal.symbol} ${signal.bias}`);
    } catch (err) {
      logger.error(`Failed to send signal to ${chatId}: ${err.message}`);
    }
  }
}

/**
 * XERO EDGE signal message formatter
 */
function formatSignalMessage(signal) {
  const biasEmoji = signal.bias === "BULLISH" ? "🟢" : "🔴";
  const modeEmoji = signal.mode === "2-Step" ? "⚡" : "🎯";
  const recalc = signal.htfZones?.recalculated ? " *(Zone Recalculated)*" : "";

  // Format prices based on instrument type
  const fmt = priceFormatter(signal.symbol);

  // Build TF label
  const tfLabel = signal.mode === "3-Step"
    ? `${signal.htf.toUpperCase()} → ${signal.mtf.toUpperCase()} → ${signal.ltf.toUpperCase()}`
    : `${signal.htf.toUpperCase()} → ${signal.ltf.toUpperCase()}`;

  return `
🔷 *XERO EDGE™ SIGNAL*
━━━━━━━━━━━━━━━━━━━━━━

${modeEmoji} *Pair:* \`${signal.symbol}\`
📐 *Mode:* ${signal.mode}
${biasEmoji} *Bias:* ${signal.bias}
⏱ *Timeframes:* ${tfLabel}

━━━━━━━━━━━━━━━━━━━━━━

📍 *Entry:*  \`${fmt(signal.entry)}\`
🛑 *Stop Loss:* \`${fmt(signal.sl)}\`
🎯 *TP1 (1RR):* \`${fmt(signal.tp1)}\`
🚀 *TP2 (2RR):* \`${fmt(signal.tp2)}\`

━━━━━━━━━━━━━━━━━━━━━━

📦 *Zone:* ${signal.zone}${recalc}
🟢 *Status:* ${signal.status}
🕐 *Time:* ${formatTime(signal.timestamp)}

━━━━━━━━━━━━━━━━━━━━━━
_Risk only what you can afford to lose._
_XERO TRADERS HUB — Trade With Edge™_
`.trim();
}

// ─── Command Handlers ─────────────────────────────────────────────────────────

async function handleStart(msg) {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || "Trader";

  const welcomeMsg = `
🔷 *XERO EDGE™ Signal Bot*
━━━━━━━━━━━━━━━━━━━━━━

Welcome, *${name}*! 

I scan markets 24/7 using the *XERO EDGE Fractal Liquidity Model* — identifying high-probability setups across Forex, Gold, Indices, and Crypto.

🎯 *Active Mode:* ${scanner.getMode() === "3step" ? "3-Step (HTF→MTF→LTF)" : "2-Step (HTF→LTF)"}
📊 *Instruments:* ${scanner.getWatchlist().length} on watchlist

Type /help for all commands.

_XERO TRADERS HUB — Trade With Edge™_
`.trim();

  await safeSend(chatId, welcomeMsg);
}

async function handleHelp(msg) {
  const chatId = msg.chat.id;

  const helpMsg = `
🔷 *XERO EDGE™ Bot — Commands*
━━━━━━━━━━━━━━━━━━━━━━

📡 *Scanning*
/scan — Trigger full watchlist scan now
/scan XAUUSD — Scan specific symbol
/signals — View all active signals

⚙️ *Mode Control*
/mode 3step — Set to 3-Step Fractal (HTF→MTF→LTF)
/mode 2step — Set to 2-Step Fractal (HTF→LTF)
/mode — Show current mode

📋 *Watchlist*
/watchlist — View current instruments
/add SYMBOL — Add symbol to watchlist
/remove SYMBOL — Remove symbol

🔔 *Alerts*
/subscribe — Subscribe this chat to signals
/stop — Unsubscribe from signals

📊 *Info*
/status — Bot status & stats
/help — This menu

━━━━━━━━━━━━━━━━━━━━━━
_Signals fire only on full fractal alignment._
_No alignment = No signal. Discipline is the edge._
`.trim();

  await safeSend(chatId, helpMsg);
}

async function handleMode(msg, match) {
  if (!isAuthorized(msg.chat.id)) {
    await safeSend(msg.chat.id, "⛔ Admin only command.");
    return;
  }

  const mode = match[1].trim().toLowerCase().replace("-", "").replace("_", "");

  try {
    scanner.setMode(mode);
    const label = mode === "3step"
      ? "3-Step Fractal (HTF → MTF → LTF)"
      : "2-Step Fractal (HTF → LTF)";

    await safeSend(msg.chat.id,
      `✅ *Mode switched to:* ${label}\n\n_Next scan will use the new mode._`
    );
  } catch (err) {
    await safeSend(msg.chat.id,
      `❌ Invalid mode: \`${match[1]}\`\nUse: /mode 3step or /mode 2step`
    );
  }
}

async function handleModeStatus(msg) {
  const mode = scanner.getMode();
  const label = mode === "3step"
    ? "🎯 3-Step Fractal (HTF → MTF → LTF)\n_Higher confirmation, lower frequency_"
    : "⚡ 2-Step Fractal (HTF → LTF)\n_Faster execution, higher frequency_";

  await safeSend(msg.chat.id, `*Current Mode:*\n${label}`);
}

async function handleScan(msg, match) {
  const chatId = msg.chat.id;
  const symbol = match[1].trim().toUpperCase();

  await safeSend(chatId, `🔍 Scanning *${symbol}*...`);

  const results = await scanner.scanSymbol(symbol);

  if (results.error) {
    await safeSend(chatId, `❌ ${results.error}`);
    return;
  }

  if (results.length === 0) {
    await safeSend(chatId,
      `📭 *No signal for ${symbol}*\n\nBias alignment incomplete — no trade. Patience is the strategy.`
    );
    return;
  }

  for (const signal of results) {
    await sendSignal(signal);
  }
}

async function handleScanAll(msg) {
  if (!isAuthorized(msg.chat.id)) {
    await safeSend(msg.chat.id, "⛔ Admin only command.");
    return;
  }

  await safeSend(msg.chat.id, `🔍 Running full scan on ${scanner.getWatchlist().length} instruments...`);
  await scanner.runScanCycle();
  await safeSend(msg.chat.id, `✅ Scan complete. Active signals: ${scanner.getActiveSignals().length}`);
}

async function handleWatchlist(msg) {
  const wl = scanner.getWatchlist();

  if (wl.length === 0) {
    await safeSend(msg.chat.id, "📋 Watchlist is empty. Use /add SYMBOL to add instruments.");
    return;
  }

  const grouped = {};
  for (const inst of wl) {
    if (!grouped[inst.category]) grouped[inst.category] = [];
    grouped[inst.category].push(inst.displayName);
  }

  let msg2 = "📋 *Current Watchlist*\n━━━━━━━━━━━━━━━━━━━━━━\n";
  for (const [cat, symbols] of Object.entries(grouped)) {
    msg2 += `\n*${cat}:*\n${symbols.map(s => `• \`${s}\``).join("\n")}\n`;
  }
  msg2 += `\n━━━━━━━━━━━━━━━━━━━━━━\n_Total: ${wl.length} instruments_`;

  await safeSend(msg.chat.id, msg2);
}

async function handleAdd(msg, match) {
  if (!isAuthorized(msg.chat.id)) {
    await safeSend(msg.chat.id, "⛔ Admin only command.");
    return;
  }

  const sym = match[1].trim().toUpperCase();
  const wl = scanner.getWatchlist();

  const exists = wl.some(i => i.displayName === sym || i.symbol === sym);
  if (exists) {
    await safeSend(msg.chat.id, `ℹ️ \`${sym}\` is already on the watchlist.`);
    return;
  }

  // Try to find in default list or create custom entry
  const defaultEntry = DEFAULT_WATCHLIST.find(i => i.displayName === sym);

  const newInst = defaultEntry || {
    symbol: sym.includes("/") ? sym : `${sym.slice(0, 3)}/${sym.slice(3)}`,
    displayName: sym,
    category: "Custom",
  };

  scanner.setWatchlist([...wl, newInst]);
  await safeSend(msg.chat.id, `✅ \`${sym}\` added to watchlist.`);
}

async function handleRemove(msg, match) {
  if (!isAuthorized(msg.chat.id)) {
    await safeSend(msg.chat.id, "⛔ Admin only command.");
    return;
  }

  const sym = match[1].trim().toUpperCase();
  const wl = scanner.getWatchlist();
  const newWl = wl.filter(i => i.displayName !== sym && i.symbol !== sym);

  if (newWl.length === wl.length) {
    await safeSend(msg.chat.id, `❌ \`${sym}\` not found on watchlist.`);
    return;
  }

  scanner.setWatchlist(newWl);
  await safeSend(msg.chat.id, `✅ \`${sym}\` removed from watchlist.`);
}

async function handleSignals(msg) {
  const signals = scanner.getActiveSignals();

  if (signals.length === 0) {
    await safeSend(msg.chat.id,
      `📭 *No active signals*\n\nThe market hasn't aligned yet. Wait for the edge.`
    );
    return;
  }

  await safeSend(msg.chat.id, `📡 *${signals.length} Active Signal(s)*\n━━━━━━━━━━━━━━━━━━━━━━`);

  for (const signal of signals) {
    await sendSignal(signal);
  }
}

async function handleStatus(msg) {
  const wl = scanner.getWatchlist();
  const signals = scanner.getActiveSignals();
  const mode = scanner.getMode();
  const provider = process.env.DATA_PROVIDER || "mock";
  const interval = process.env.SCAN_INTERVAL_SECONDS || "60";

  const statusMsg = `
📊 *XERO EDGE™ Bot Status*
━━━━━━━━━━━━━━━━━━━━━━

🟢 *Status:* Online
⚙️ *Mode:* ${mode === "3step" ? "3-Step Fractal" : "2-Step Fractal"}
📡 *Data Provider:* ${provider}
⏱ *Scan Interval:* ${interval}s
📋 *Watchlist:* ${wl.length} instruments
🎯 *Active Signals:* ${signals.length}
👥 *Subscribed Chats:* ${authorizedChats.size}

━━━━━━━━━━━━━━━━━━━━━━
_Last update: ${new Date().toISOString()}_
`.trim();

  await safeSend(msg.chat.id, statusMsg);
}

async function handleSubscribe(msg) {
  const chatId = msg.chat.id;
  authorizedChats.add(chatId);
  await safeSend(chatId,
    `✅ *Subscribed!*\n\nYou'll receive XERO EDGE™ signals in this chat.\nUse /stop to unsubscribe.`
  );
  logger.info(`Chat ${chatId} subscribed to signals`);
}

async function handleStop(msg) {
  const chatId = msg.chat.id;
  if (chatId === ADMIN_ID) {
    await safeSend(chatId, "⚠️ Admin cannot unsubscribe from signals.");
    return;
  }
  authorizedChats.delete(chatId);
  await safeSend(chatId, "🔕 Unsubscribed. Use /subscribe to re-enable signals.");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function safeSend(chatId, text) {
  if (!bot) {
    logger.info(`[CONSOLE SEND → ${chatId}]: ${text}`);
    return;
  }
  try {
    await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } catch (err) {
    logger.error(`Failed to send message to ${chatId}: ${err.message}`);
  }
}

function isAuthorized(chatId) {
  return chatId === ADMIN_ID;
}

function priceFormatter(symbol) {
  if (symbol.includes("JPY") || symbol.includes("XAU") ||
      symbol.includes("BTC") || symbol.includes("ETH") ||
      symbol.includes("SPX") || symbol.includes("NAS") ||
      symbol.includes("US30") || symbol.includes("DAX")) {
    return n => n.toFixed(2);
  }
  return n => n.toFixed(5);
}

function formatTime(isoString) {
  const d = new Date(isoString);
  return d.toUTCString().replace(" GMT", " UTC");
}

module.exports = { initBot, sendSignal };

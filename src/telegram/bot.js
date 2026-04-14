// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE — Telegram Bot
// Handles all user commands, signal delivery, and full analysis explanation
// ─────────────────────────────────────────────────────────────────────────────

const TelegramBot = require("node-telegram-bot-api");
const scanner = require("../scanner/scanner");
const { DEFAULT_WATCHLIST } = require("../../config/markets");
const logger = require("../utils/logger");

const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_CHAT_ID || "716635266");

let bot = null;
const authorizedChats = new Set([ADMIN_ID]);

// ─── Init ─────────────────────────────────────────────────────────────────────

function initBot() {
  if (!TOKEN || TOKEN === "YOUR_BOT_TOKEN_HERE") {
    logger.warn("TELEGRAM_BOT_TOKEN not set — signals will log to console only");
    return null;
  }
  bot = new TelegramBot(TOKEN, { polling: true });
  logger.info("Telegram bot initialized — polling active");

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
  bot.on("polling_error", err => logger.error(`Polling error: ${err.message}`));
  return bot;
}

// ─── Signal Delivery ─────────────────────────────────────────────────────────

async function sendSignal(signal) {
  const [part1, part2] = buildSignalParts(signal);

  if (!bot) {
    logger.info("\n" + "═".repeat(54) + "\n" + part1 + "\n\n" + part2 + "\n" + "═".repeat(54));
    return;
  }

  for (const chatId of authorizedChats) {
    try { await bot.sendMessage(chatId, part1, { parse_mode: "Markdown", disable_web_page_preview: true }); } catch (e) { logger.error(`Send p1 to ${chatId}: ${e.message}`); }
    await sleep(400);
    try { await bot.sendMessage(chatId, part2, { parse_mode: "Markdown", disable_web_page_preview: true }); } catch (e) { logger.error(`Send p2 to ${chatId}: ${e.message}`); }
  }
  logger.info(`Signal delivered: ${signal.symbol} ${signal.bias} ${signal.mode}`);
}

// ─── Signal Formatter ─────────────────────────────────────────────────────────

function buildSignalParts(signal) {
  const fmt    = priceFormatter(signal.symbol);
  const isBull = signal.bias === "BULLISH";
  const biasEmoji = isBull ? "🟢" : "🔴";
  const modeEmoji = signal.mode === "2-Step" ? "⚡" : "🎯";
  const recalc    = signal.htfZones && signal.htfZones.recalculated ? " _(recalculated)_" : "";
  const tfLabel   = signal.mode === "3-Step"
    ? `${signal.htf.toUpperCase()} → ${signal.mtf.toUpperCase()} → ${signal.ltf.toUpperCase()}`
    : `${signal.htf.toUpperCase()} → ${signal.ltf.toUpperCase()}`;

  const risk   = Math.abs(signal.entry - signal.sl);
  const reward = Math.abs(signal.tp2 - signal.entry);
  const rr     = risk > 0 ? (reward / risk).toFixed(1) : "N/A";

  // Part 1: Trade levels
  const part1 = [
    "🔷 *XERO EDGE™ SIGNAL*",
    "━━━━━━━━━━━━━━━━━━━━━━",
    "",
    `${modeEmoji} *Pair:* \`${signal.symbol}\``,
    `📐 *Mode:* ${signal.mode}`,
    `${biasEmoji} *Bias:* ${signal.bias}`,
    `⏱ *Timeframes:* ${tfLabel}`,
    "",
    "━━━━━━━━━━━━━━━━━━━━━━",
    "📊 *TRADE LEVELS*",
    "",
    `📍 *Entry:*     \`${fmt(signal.entry)}\``,
    `🛑 *Stop Loss:* \`${fmt(signal.sl)}\``,
    `🎯 *TP1 (1RR):* \`${fmt(signal.tp1)}\``,
    `🚀 *TP2 (2RR):* \`${fmt(signal.tp2)}\``,
    "",
    `📦 *Zone:* ${signal.zone}${recalc}`,
    `📐 *R:R at TP2:* 1 : ${rr}`,
    "",
    "━━━━━━━━━━━━━━━━━━━━━━",
    `🟢 *Status:* ${signal.status}`,
    `🕐 *Time:* ${formatTime(signal.timestamp)}`,
    "━━━━━━━━━━━━━━━━━━━━━━",
    "_XERO TRADERS HUB — Trade With Edge™_",
  ].join("\n");

  // Part 2: Full analysis
  const part2 = buildAnalysis(signal, fmt);

  return [part1, part2];
}

function buildAnalysis(signal, fmt) {
  const isBull = signal.bias === "BULLISH";
  const slRef  = signal.mode === "3-Step" ? "MTF" : "HTF";
  const L = []; // lines array

  L.push("🧠 *ANALYSIS — How this signal was built*");
  L.push("━━━━━━━━━━━━━━━━━━━━━━");
  L.push("");

  // ── Step 1: HTF Bias ──────────────────────────────────────────────────────
  L.push(`*📌 Step 1 — ${signal.htf.toUpperCase()} Bias (XERO EDGE™ C1/C2 Rule)*`);

  if (signal.htfBias && signal.htfBias.C1 && signal.htfBias.C2) {
    const { C1, C2 } = signal.htfBias;
    L.push(`Last 2 closed candles on ${signal.htf.toUpperCase()}:`);
    L.push(`C1: H \`${fmt(C1.high)}\`  L \`${fmt(C1.low)}\`  Close \`${fmt(C1.close)}\``);
    L.push(`C2: H \`${fmt(C2.high)}\`  L \`${fmt(C2.low)}\`  Close \`${fmt(C2.close)}\``);
    L.push("");
    if (isBull) {
      L.push("Bias conditions checked:");
      L.push(`✅ C2 low \`${fmt(C2.low)}\` < C1 low \`${fmt(C1.low)}\` — C2 swept below C1`);
      L.push(`✅ C2 high \`${fmt(C2.high)}\` < C1 high \`${fmt(C1.high)}\` — no structure break above`);
      L.push(`✅ C2 close \`${fmt(C2.close)}\` < C1 high \`${fmt(C1.high)}\` — closed inside C1 range`);
      L.push("→ *BULLISH BIAS* 🟢 — C2 grabbed liquidity below C1 low then closed back inside. Market shows intent to move UP.");
    } else {
      L.push("Bias conditions checked:");
      L.push(`✅ C2 high \`${fmt(C2.high)}\` > C1 high \`${fmt(C1.high)}\` — C2 swept above C1`);
      L.push(`✅ C2 low \`${fmt(C2.low)}\` > C1 low \`${fmt(C1.low)}\` — no structure break below`);
      L.push(`✅ C2 close \`${fmt(C2.close)}\` > C1 low \`${fmt(C1.low)}\` — closed inside C1 range`);
      L.push("→ *BEARISH BIAS* 🔴 — C2 grabbed liquidity above C1 high then closed back inside. Market shows intent to move DOWN.");
    }
  } else {
    L.push(`${signal.bias} bias confirmed on ${signal.htf.toUpperCase()}.`);
  }

  L.push("");

  // ── Step 2: HTF Zones ────────────────────────────────────────────────────
  L.push(`*📌 Step 2 — ${signal.htf.toUpperCase()} Entry Zones (Fibonacci on C2)*`);

  if (signal.htfZones) {
    const z = signal.htfZones;
    const range = (z.C2High - z.C2Low);
    L.push(`C2 range: \`${fmt(z.C2Low)}\` → \`${fmt(z.C2High)}\`  (range = \`${fmt(range)}\`)`);
    L.push("");
    if (isBull) {
      L.push("Fib levels measured from C2 low upward:");
      L.push(`Zone 1 (0.618–0.768 retrace): \`${fmt(z.zone1.low)}\` – \`${fmt(z.zone1.high)}\``);
      L.push(`Zone 2 (deep discount below 0.618): \`${fmt(z.zone2.low)}\` – \`${fmt(z.zone2.high)}\``);
      L.push("→ Waiting for price to pull back DOWN into zones before buying.");
    } else {
      L.push("Fib levels measured from C2 high downward:");
      L.push(`Zone 1 (0.618–0.768 retrace from top): \`${fmt(z.zone1.low)}\` – \`${fmt(z.zone1.high)}\``);
      L.push(`Zone 2 (deep premium above 0.618): \`${fmt(z.zone2.low)}\` – \`${fmt(z.zone2.high)}\``);
      L.push("→ Waiting for price to pull back UP into zones before selling.");
    }
    if (z.recalculated) {
      L.push("");
      L.push("⚠️ _Zones recalculated: price extended past C2 extreme but stayed inside C1 — new zones drawn from updated swing point._");
    }
    L.push("");
    L.push(`✅ Price tapped *${signal.zone}* — entry condition met`);
  }

  L.push("");

  // ── Step 3: MTF (3-step only) ─────────────────────────────────────────────
  if (signal.mode === "3-Step" && signal.mtfBias) {
    L.push(`*📌 Step 3 — ${signal.mtf.toUpperCase()} Confirmation (must match HTF)*`);

    if (signal.mtfBias.C1 && signal.mtfBias.C2) {
      const { C1, C2 } = signal.mtfBias;
      L.push(`C1: H \`${fmt(C1.high)}\`  L \`${fmt(C1.low)}\`  Close \`${fmt(C1.close)}\``);
      L.push(`C2: H \`${fmt(C2.high)}\`  L \`${fmt(C2.low)}\`  Close \`${fmt(C2.close)}\``);
      L.push("");
      if (isBull) {
        L.push("✅ C2 low < C1 low  ✅ C2 high < C1 high  ✅ C2 close < C1 high");
        L.push("→ MTF is BULLISH — fractal alignment confirmed ✅");
      } else {
        L.push("✅ C2 high > C1 high  ✅ C2 low > C1 low  ✅ C2 close > C1 low");
        L.push("→ MTF is BEARISH — fractal alignment confirmed ✅");
      }
    } else {
      L.push(`${signal.bias} bias confirmed on ${signal.mtf.toUpperCase()} ✅`);
    }

    if (signal.mtfZones) {
      const mz = signal.mtfZones;
      L.push("");
      L.push(`MTF Zone 1: \`${fmt(mz.zone1.low)}\` – \`${fmt(mz.zone1.high)}\``);
      L.push(`MTF Zone 2: \`${fmt(mz.zone2.low)}\` – \`${fmt(mz.zone2.high)}\``);
      L.push(`SL placed beyond MTF Zone 2 ${isBull ? "low" : "high"}: \`${fmt(signal.sl)}\``);
    }

    L.push("");
  }

  // ── Step 4: LTF Entry ────────────────────────────────────────────────────
  const ltfStep = signal.mode === "3-Step" ? "4" : "3";
  L.push(`*📌 Step ${ltfStep} — ${signal.ltf.toUpperCase()} Entry Trigger (final confirmation)*`);

  if (signal.ltfBias && signal.ltfBias.C1 && signal.ltfBias.C2) {
    const { C1, C2 } = signal.ltfBias;
    L.push(`C1: H \`${fmt(C1.high)}\`  L \`${fmt(C1.low)}\`  Close \`${fmt(C1.close)}\``);
    L.push(`C2: H \`${fmt(C2.high)}\`  L \`${fmt(C2.low)}\`  Close \`${fmt(C2.close)}\``);
    L.push("");
    if (isBull) {
      L.push("✅ C2 low < C1 low  ✅ C2 high < C1 high  ✅ C2 close < C1 high");
      L.push("→ LTF confirms BULLISH — all timeframes aligned, signal triggered ✅");
    } else {
      L.push("✅ C2 high > C1 high  ✅ C2 low > C1 low  ✅ C2 close > C1 low");
      L.push("→ LTF confirms BEARISH — all timeframes aligned, signal triggered ✅");
    }
  } else {
    L.push(`${signal.bias} bias confirmed on ${signal.ltf.toUpperCase()} ✅`);
  }

  if (signal.ltfZones) {
    const lz = signal.ltfZones;
    L.push("");
    L.push(`LTF Zone 1: \`${fmt(lz.zone1.low)}\` – \`${fmt(lz.zone1.high)}\``);
    L.push(`Entry = midpoint of LTF Zone 1 = \`${fmt(signal.entry)}\``);
  }

  L.push("");

  // ── Risk/Reward Summary ───────────────────────────────────────────────────
  L.push("*📌 Risk Management*");
  const risk      = Math.abs(signal.entry - signal.sl);
  const rewardTP1 = Math.abs(signal.tp1 - signal.entry);
  const rewardTP2 = Math.abs(signal.tp2 - signal.entry);
  L.push(`SL beyond ${slRef} Zone 2 ${isBull ? "low (below discount zone)" : "high (above premium zone)"}`);
  L.push(`Risk = \`${fmt(risk)}\` pts`);
  L.push(`TP1 @ 1:1 RR → \`${fmt(signal.tp1)}\`  (reward: \`${fmt(rewardTP1)}\`)`);
  L.push(`TP2 @ 2:1 RR → \`${fmt(signal.tp2)}\`  (reward: \`${fmt(rewardTP2)}\`)`);
  L.push("Remaining position → hold for momentum beyond TP2");
  L.push("");
  L.push("━━━━━━━━━━━━━━━━━━━━━━");
  L.push("_Risk only what you can afford to lose._");

  return L.join("\n");
}

// ─── Command Handlers ─────────────────────────────────────────────────────────

async function handleStart(msg) {
  const name = msg.from.first_name || "Trader";
  await safeSend(msg.chat.id, [
    "🔷 *XERO EDGE™ Signal Bot*",
    "━━━━━━━━━━━━━━━━━━━━━━",
    "",
    `Welcome, *${name}*!`,
    "",
    "I scan markets 24/7 using the *XERO EDGE Fractal Liquidity Model* and send only high-probability setups — with full step-by-step analysis on every signal.",
    "",
    `🎯 *Mode:* ${scanner.getMode() === "3step" ? "3-Step (HTF→MTF→LTF)" : "2-Step (HTF→LTF)"}`,
    `📊 *Instruments:* ${scanner.getWatchlist().length} on watchlist`,
    "",
    "Type /help for all commands.",
    "",
    "_XERO TRADERS HUB — Trade With Edge™_",
  ].join("\n"));
}

async function handleHelp(msg) {
  await safeSend(msg.chat.id, [
    "🔷 *XERO EDGE™ Bot — Commands*",
    "━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "📡 *Scanning*",
    "/scan — Full watchlist scan now",
    "/scan XAUUSD — Scan specific symbol",
    "/signals — All active signals",
    "",
    "⚙️ *Mode*",
    "/mode 3step — HTF→MTF→LTF (more confirmation)",
    "/mode 2step — HTF→LTF (faster execution)",
    "/mode — Show current mode",
    "",
    "📋 *Watchlist*",
    "/watchlist — View all instruments",
    "/add SYMBOL — Add to watchlist",
    "/remove SYMBOL — Remove from watchlist",
    "",
    "🔔 *Alerts*",
    "/subscribe — Receive signals here",
    "/stop — Stop receiving signals",
    "/status — Bot stats",
    "",
    "━━━━━━━━━━━━━━━━━━━━━━",
    "_No alignment = No signal. Discipline is the edge._",
  ].join("\n"));
}

async function handleMode(msg, match) {
  if (!isAuthorized(msg.chat.id)) { await safeSend(msg.chat.id, "⛔ Admin only."); return; }
  const mode = match[1].trim().toLowerCase().replace(/[-_]/g, "");
  try {
    scanner.setMode(mode);
    const label = mode === "3step" ? "3-Step Fractal (HTF → MTF → LTF)" : "2-Step Fractal (HTF → LTF)";
    await safeSend(msg.chat.id, `✅ *Mode switched to:* ${label}\n\n_Next scan uses the new mode._`);
  } catch {
    await safeSend(msg.chat.id, "❌ Use: /mode 3step  or  /mode 2step");
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
  const symbol = match[1].trim().toUpperCase();
  await safeSend(msg.chat.id, `🔍 Scanning *${symbol}*...`);
  const results = await scanner.scanSymbol(symbol);
  if (results && results.error) { await safeSend(msg.chat.id, `❌ ${results.error}`); return; }
  if (!results || results.length === 0) {
    await safeSend(msg.chat.id, `📭 *No signal for ${symbol}*\n\nBias alignment incomplete — no trade. Wait for the setup.`);
    return;
  }
  for (const signal of results) await sendSignal(signal);
}

async function handleScanAll(msg) {
  if (!isAuthorized(msg.chat.id)) { await safeSend(msg.chat.id, "⛔ Admin only."); return; }
  await safeSend(msg.chat.id, `🔍 Scanning ${scanner.getWatchlist().length} instruments...`);
  await scanner.runScanCycle();
  await safeSend(msg.chat.id, `✅ Scan complete. Active signals: ${scanner.getActiveSignals().length}`);
}

async function handleWatchlist(msg) {
  const wl = scanner.getWatchlist();
  if (wl.length === 0) { await safeSend(msg.chat.id, "📋 Watchlist empty. Use /add SYMBOL."); return; }
  const grouped = {};
  for (const inst of wl) {
    if (!grouped[inst.category]) grouped[inst.category] = [];
    grouped[inst.category].push(inst.displayName);
  }
  let text = "📋 *Watchlist*\n━━━━━━━━━━━━━━━━━━━━━━\n";
  for (const [cat, syms] of Object.entries(grouped)) {
    text += `\n*${cat}:*\n${syms.map(s => `• \`${s}\``).join("\n")}\n`;
  }
  text += `\n_Total: ${wl.length} instruments_`;
  await safeSend(msg.chat.id, text);
}

async function handleAdd(msg, match) {
  if (!isAuthorized(msg.chat.id)) { await safeSend(msg.chat.id, "⛔ Admin only."); return; }
  const sym = match[1].trim().toUpperCase();
  const wl  = scanner.getWatchlist();
  if (wl.some(i => i.displayName === sym || i.symbol === sym)) {
    await safeSend(msg.chat.id, `ℹ️ \`${sym}\` already on watchlist.`); return;
  }
  const def = DEFAULT_WATCHLIST.find(i => i.displayName === sym);
  const inst = def || { symbol: sym.includes("/") ? sym : `${sym.slice(0,3)}/${sym.slice(3)}`, displayName: sym, category: "Custom" };
  scanner.setWatchlist([...wl, inst]);
  await safeSend(msg.chat.id, `✅ \`${sym}\` added.`);
}

async function handleRemove(msg, match) {
  if (!isAuthorized(msg.chat.id)) { await safeSend(msg.chat.id, "⛔ Admin only."); return; }
  const sym   = match[1].trim().toUpperCase();
  const wl    = scanner.getWatchlist();
  const newWl = wl.filter(i => i.displayName !== sym && i.symbol !== sym);
  if (newWl.length === wl.length) { await safeSend(msg.chat.id, `❌ \`${sym}\` not found.`); return; }
  scanner.setWatchlist(newWl);
  await safeSend(msg.chat.id, `✅ \`${sym}\` removed.`);
}

async function handleSignals(msg) {
  const signals = scanner.getActiveSignals();
  if (signals.length === 0) {
    await safeSend(msg.chat.id, "📭 *No active signals*\n\nMarket hasn't aligned. Wait for the edge."); return;
  }
  await safeSend(msg.chat.id, `📡 *${signals.length} Active Signal(s)*\n━━━━━━━━━━━━━━━━━━━━━━`);
  for (const signal of signals) await sendSignal(signal);
}

async function handleStatus(msg) {
  await safeSend(msg.chat.id, [
    "📊 *XERO EDGE™ Bot Status*",
    "━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "🟢 *Status:* Online",
    `⚙️ *Mode:* ${scanner.getMode() === "3step" ? "3-Step Fractal" : "2-Step Fractal"}`,
    `📡 *Data:* ${process.env.DATA_PROVIDER || "mock"}`,
    `⏱ *Scan every:* ${process.env.SCAN_INTERVAL_SECONDS || "60"}s`,
    `📋 *Watchlist:* ${scanner.getWatchlist().length} instruments`,
    `🎯 *Active Signals:* ${scanner.getActiveSignals().length}`,
    `👥 *Subscribed:* ${authorizedChats.size} chats`,
    "",
    `_${new Date().toUTCString()}_`,
  ].join("\n"));
}

async function handleSubscribe(msg) {
  authorizedChats.add(msg.chat.id);
  await safeSend(msg.chat.id, "✅ *Subscribed!*\n\nYou'll receive XERO EDGE™ signals here.\nUse /stop to unsubscribe.");
  logger.info(`Chat ${msg.chat.id} subscribed`);
}

async function handleStop(msg) {
  if (msg.chat.id === ADMIN_ID) { await safeSend(msg.chat.id, "⚠️ Admin cannot unsubscribe."); return; }
  authorizedChats.delete(msg.chat.id);
  await safeSend(msg.chat.id, "🔕 Unsubscribed. Use /subscribe to re-enable.");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function safeSend(chatId, text) {
  if (!bot) { logger.info(`[CONSOLE → ${chatId}]:\n${text}`); return; }
  try { await bot.sendMessage(chatId, text, { parse_mode: "Markdown" }); }
  catch (err) { logger.error(`safeSend error to ${chatId}: ${err.message}`); }
}

function isAuthorized(chatId) { return chatId === ADMIN_ID; }

function priceFormatter(symbol) {
  const highPrecision = ["JPY","XAU","XAG","BTC","ETH","WTI","SPX","NAS","US30","DAX","SP5","GER"];
  if (highPrecision.some(k => symbol.includes(k))) return n => Number(n).toFixed(2);
  return n => Number(n).toFixed(5);
}

function formatTime(isoString) {
  return new Date(isoString).toUTCString().replace(" GMT", " UTC");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { initBot, sendSignal };

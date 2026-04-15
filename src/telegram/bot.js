// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE v2 — Telegram Bot (clean rewrite)
// ─────────────────────────────────────────────────────────────────────────────

const TelegramBot = require("node-telegram-bot-api");
const scanner     = require("../scanner/scanner");
const { parseIntent }    = require("../nlp/nlpEngine");
const { formatBiasOnly, formatSignal, formatAnalysis,
        formatScanSummary, formatNoSignal } = require("../output/formatter");
const { DEFAULT_WATCHLIST, getTfLabel } = require("../../config/markets");
const zoneWatcher = require("../scanner/zoneWatcher");
const logger = require("../utils/logger");

const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_CHAT_ID || "716635266");

let bot = null;
const authorizedChats = new Set([ADMIN_ID]);
const chatOutputMode  = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────

function initBot() {
  if (!TOKEN || TOKEN === "YOUR_BOT_TOKEN_HERE") {
    logger.warn("No TELEGRAM_BOT_TOKEN — console-only mode");
    return null;
  }

  bot = new TelegramBot(TOKEN, { polling: true });
  logger.info("Telegram bot polling active");

  // ── Slash commands ──────────────────────────────────────────────────────
  bot.onText(/^\/start$/,       msg => wrap(handleStart, msg));
  bot.onText(/^\/help$/,        msg => wrap(handleHelp,  msg));
  bot.onText(/^\/status$/,      msg => wrap(handleStatus, msg));
  bot.onText(/^\/diagnose$/,    msg => wrap(handleDiagnose, msg));
  bot.onText(/^\/signals$/,     msg => wrap(handleActiveSignals, msg));
  bot.onText(/^\/watchlist$/,   msg => wrap(handleWatchlist, msg));
  bot.onText(/^\/subscribe$/,   msg => wrap(handleSubscribe, msg));
  bot.onText(/^\/unsubscribe$/, msg => wrap(handleUnsubscribe, msg));

  bot.onText(/^\/watching$/, msg => wrap(handleWatching, msg));
  bot.onText(/^\/scan(.*)$/,    (msg, m) => wrap(handleSlashScan,   msg, (m[1]||"").trim()));
  bot.onText(/^\/bias(.*)$/,    (msg, m) => wrap(handleSlashBias,   msg, (m[1]||"").trim()));
  bot.onText(/^\/output (.+)$/, (msg, m) => wrap(handleOutputSet,   msg, m[1].trim()));
  bot.onText(/^\/mode (.+)$/,   (msg, m) => wrap(handleModeSet,     msg, m[1].trim()));
  bot.onText(/^\/add (.+)$/,    (msg, m) => wrap(handleAdd,         msg, m[1].trim()));
  bot.onText(/^\/remove (.+)$/, (msg, m) => wrap(handleRemove,      msg, m[1].trim()));

  // ── All plain-text messages → NLP ──────────────────────────────────────
  bot.on("message", msg => {
    if (!msg.text || msg.text.startsWith("/")) return;
    wrap(handleNLP, msg);
  });

  bot.on("polling_error", e => logger.error("Polling error: " + e.message));
  return bot;
}

// Wraps any async handler so errors are caught and reported to chat
async function wrap(fn, msg, ...args) {
  const chatId = msg.chat.id;
  try {
    await fn(msg, ...args);
  } catch (e) {
    logger.error("Handler error in " + fn.name + ": " + e.message + "\n" + e.stack);
    await safeSend(chatId, "❌ Something went wrong: " + e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL DELIVERY
// ─────────────────────────────────────────────────────────────────────────────

async function deliverSignal(signal, chatId, overrideMode) {
  const mode = overrideMode || chatOutputMode.get(chatId) || scanner.getOutputMode();
  await safeSend(chatId, formatSignal(signal));
  if (mode === "analysis") {
    await sleep(400);
    await safeSend(chatId, formatAnalysis(signal));
  }
}

async function broadcastSignal(signal) {
  if (!bot) {
    logger.info("SIGNAL: " + signal.symbol + " " + signal.bias + " " + signal.tfLabel);
    logger.info(formatSignal(signal));
    return;
  }
  for (const chatId of authorizedChats) {
    try { await deliverSignal(signal, chatId); }
    catch (e) { logger.error("Broadcast to " + chatId + " failed: " + e.message); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NLP HANDLER
// ─────────────────────────────────────────────────────────────────────────────

async function handleNLP(msg) {
  const chatId = msg.chat.id;
  const text   = msg.text;
  if (!text) return;

  logger.info("NLP [" + chatId + "]: " + text);
  await safeSend(chatId, "🔍 Got it, working on it...");

  let intent;
  try {
    intent = await parseIntent(text);
  } catch (e) {
    logger.error("parseIntent failed: " + e.message);
    intent = { intent: "unknown", raw: text };
  }

  logger.info("Intent: " + JSON.stringify(intent));

  switch (intent.intent) {

    case "greeting":
      await safeSend(chatId,
        "👋 Hey! I'm XERO EDGE™.\n\n" +
        "Just type what you need:\n" +
        "_\"scan gold\"_ · _\"bias on EURUSD\"_ · _\"scan majors with analysis\"_\n\n" +
        "Or use /help for all commands."
      );
      break;

    case "help":        await handleHelp(msg);           break;
    case "status":      await handleStatus(msg);         break;
    case "active_signals": await handleActiveSignals(msg); break;
    case "watchlist_view": await handleWatchlist(msg);   break;

    case "watchlist_add":
      if (intent.symbols && intent.symbols.length) await addSymbols(chatId, intent.symbols);
      else await safeSend(chatId, "Which symbol do you want to add?");
      break;

    case "watchlist_remove":
      if (intent.symbols && intent.symbols.length) await removeSymbols(chatId, intent.symbols);
      else await safeSend(chatId, "Which symbol do you want to remove?");
      break;

    case "set_output": await setOutputMode(chatId, intent.mode); break;
    case "set_mode":   await setFractalMode(chatId, intent.mode); break;

    case "bias_only": {
      const instruments = scanner.resolveInstruments(intent);
      if (!instruments.length) { await safeSend(chatId, "Couldn't find those instruments."); break; }
      await safeSend(chatId, "🔍 Scanning bias on " + instruments.length + " instrument(s)...");
      const biasProgress = async (msg) => { await safeSend(chatId, msg); };
      const results = await scanner.scanBiasOnly(instruments, biasProgress);
      for (const { symbol, biasMap, error } of results) {
        if (error || !biasMap) { await safeSend(chatId, "❌ " + symbol + ": " + (error || "no data")); continue; }
        await safeSend(chatId, formatBiasOnly(symbol, biasMap));
        await sleep(200);
      }
      break;
    }

    case "scan": {
      const instruments = scanner.resolveInstruments(intent);
      if (!instruments.length) { await safeSend(chatId, "Couldn't find those instruments on the watchlist."); break; }
      const mode = intent.outputMode || chatOutputMode.get(chatId) || scanner.getOutputMode();
      await runScanAndDeliver(chatId, instruments, mode);
      break;
    }

    default:
      await safeSend(chatId,
        "I didn't quite get that. Try:\n\n" +
        "_\"scan gold\"_ · _\"bias on EURUSD\"_ · _\"scan majors\"_\n" +
        "_\"show signals\"_ · _\"add GBPJPY\"_\n\n" +
        "Or /help for all commands."
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCAN & DELIVER
// ─────────────────────────────────────────────────────────────────────────────

async function runScanAndDeliver(chatId, instruments, outputMode) {
  const count = instruments.length;
  await safeSend(chatId, "🔍 Scanning " + count + " instrument(s)...");

  // Progress callback — sends live updates to chat during scan
  let lastProgress = "";
  const onProgress = async (msg) => {
    if (msg !== lastProgress) {
      lastProgress = msg;
      await safeSend(chatId, msg);
    }
  };

  const results = await scanner.scanInstruments(instruments, onProgress);

  await safeSend(chatId, formatScanSummary(results, outputMode));
  await sleep(300);

  let signalCount = 0;
  for (const { symbol, result } of results) {
    if (!result || !result.signals || result.signals.length === 0) {
      if (count <= 3) {
        await safeSend(chatId, formatNoSignal(symbol, result || { noHTFBias: true }));
        await sleep(200);
      }
      continue;
    }
    for (const signal of result.signals) {
      await deliverSignal(signal, chatId, outputMode);
      await sleep(500);
      signalCount++;
    }
  }

  if (signalCount === 0 && count > 3) {
    await safeSend(chatId, "No full setups found across " + count + " instruments. Market not aligned yet.");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SLASH COMMAND HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

async function handleStart(msg) {
  const name = (msg.from && msg.from.first_name) || "Trader";
  await safeSend(msg.chat.id,
    "🔷 *XERO EDGE™ Signal Bot v2*\n" +
    "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
    "Welcome, *" + name + "*!\n\n" +
    "Talk to me in plain English:\n" +
    "_\"scan gold\"_ · _\"bias on EURUSD\"_ · _\"scan majors with analysis\"_\n\n" +
    "📊 Watching: " + scanner.getWatchlist().length + " instruments\n" +
    "⚙️ Mode: " + (scanner.getFractalMode() === "3step" ? "3-Step" : "2-Step") + "\n" +
    "📤 Output: " + (scanner.getOutputMode() === "analysis" ? "Full Analysis" : "Signal Only") + "\n\n" +
    "Type /help for all commands.\n\n" +
    "_XERO TRADERS HUB — Trade With Edge™_"
  );
}

async function handleHelp(msg) {
  await safeSend(msg.chat.id,
    "🔷 *XERO EDGE™ Commands*\n" +
    "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
    "💬 *Natural language — just type:*\n" +
    "_\"scan gold\"_\n" +
    "_\"bias on cable\"_\n" +
    "_\"scan majors with analysis\"_\n" +
    "_\"check EURUSD and GBPUSD\"_\n\n" +
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    "📡 *Scanning*\n" +
    "/scan — full watchlist\n" +
    "/scan XAUUSD — one symbol\n" +
    "/scan majors — by category\n" +
    "/bias — bias map (all TFs)\n" +
    "/bias EURUSD — one symbol\n" +
    "/signals — active signals\n\n" +
    "⚙️ *Settings*\n" +
    "/output signal — clean levels\n" +
    "/output analysis — full breakdown\n" +
    "/mode 3step or /mode 2step\n" +
    "/watchlist · /add · /remove\n\n" +
    "🔧 *Admin*\n" +
    "/diagnose — test API + connection\n" +
    "/subscribe · /unsubscribe\n" +
    "/status\n" +
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    "_No alignment = No signal. Patience is the edge._"
  );
}

async function handleStatus(msg) {
  const wl = scanner.getWatchlist();
  await safeSend(msg.chat.id,
    "📊 *XERO EDGE™ Status*\n" +
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    "🟢 Online\n" +
    "⚙️ Mode: " + (scanner.getFractalMode() === "3step" ? "3-Step" : "2-Step") + "\n" +
    "📤 Output: " + (scanner.getOutputMode() === "analysis" ? "Full Analysis" : "Signal Only") + "\n" +
    "📡 Data: " + (process.env.DATA_PROVIDER || "mock") + "\n" +
    "⏱ Scan every: " + (process.env.SCAN_INTERVAL_SECONDS || "300") + "s\n" +
    "🔢 Rate limit: " + (process.env.API_RATE_LIMIT || "6") + " req/min\n" +
    "📋 Watchlist: " + wl.length + " instruments\n" +
    "🎯 Active signals: " + scanner.getActiveSignals().length + "\n" +
    "👥 Subscribers: " + authorizedChats.size + "\n\n" +
    "_" + new Date().toUTCString() + "_"
  );
}

async function handleDiagnose(msg) {
  const chatId = msg.chat.id;
  await safeSend(chatId, "🔍 Running diagnostics...");

  const { validateConnection, fetchCandles } = require("../scanner/dataProvider");
  const provider  = process.env.DATA_PROVIDER || "mock";
  const hasKey    = !!(process.env.TWELVE_DATA_API_KEY &&
                       process.env.TWELVE_DATA_API_KEY !== "YOUR_TWELVE_DATA_KEY_HERE" &&
                       process.env.TWELVE_DATA_API_KEY.length > 10);
  const delay    = parseInt(process.env.API_CALL_DELAY_MS || "2000");
  const interval = parseInt(process.env.SCAN_INTERVAL_SECONDS || "120");
  const wl       = scanner.getWatchlist();

  // New architecture: 1 API call per instrument (all TFs in one request)
  // plus ~1 call for price if not cached = ~1 call per instrument total
  const callsPerScan   = wl.length;
  const secsPerScan    = Math.ceil(callsPerScan * delay / 1000);
  const callsPerDay    = Math.floor(86400 / interval) * callsPerScan;
  const intervalOk     = secsPerScan < interval;

  let out = "🔷 *XERO EDGE™ Diagnostics*\n";
  out += "━━━━━━━━━━━━━━━━━━━━━━\n\n";
  out += "*Environment*\n";
  out += "DATA_PROVIDER: `" + provider + "`\n";
  out += "TWELVE_DATA_API_KEY: " + (hasKey ? "✅ Set" : "❌ NOT SET") + "\n";
  out += "API_CALL_DELAY_MS: `" + delay + "ms`\n";
  out += "SCAN_INTERVAL: `" + interval + "s`\n\n";

  out += "*API Usage (new efficient architecture)*\n";
  out += "Watchlist: `" + wl.length + "` instruments\n";
  out += "Calls per scan: `" + callsPerScan + "` (1 per instrument)\n";
  out += "Scan duration: ~`" + secsPerScan + "s`\n";
  out += "Daily calls at " + interval + "s interval: ~`" + callsPerDay + "`\n";
  out += (callsPerDay > 800
    ? "⚠️ May hit 800/day free limit — increase SCAN_INTERVAL_SECONDS\n"
    : "✅ Well within free tier 800 req/day\n");
  out += (intervalOk ? "✅ SCAN_INTERVAL is sufficient\n" : "⚠️ SCAN_INTERVAL too short — set to `" + (secsPerScan + 30) + "` or higher\n");
  out += "\n";

  out += "*API Connection*\n";
  const check = await validateConnection();
  out += (check.ok ? "✅ " : "❌ ") + check.message + "\n";

  if (check.message && check.message.includes("429")) {
    out += "\n⏰ *429 = Daily credits exhausted*\n";
    out += "Free tier resets at midnight UTC.\n";
    out += "Meanwhile set DATA_PROVIDER=mock to test the bot works.\n";
  }
  out += "\n";

  if (provider !== "mock" && hasKey && check.ok) {
    out += "*Live Candle Test (EUR/USD 1H)*\n";
    try {
      const candles = await fetchCandles("EUR/USD", "1h", 3);
      if (candles && candles.length > 0) {
        const c = candles[candles.length - 1];
        out += "✅ Got " + candles.length + " candles\n";
        out += "Last close: `" + c.close + "`\n";
      } else {
        out += "❌ No candles returned — API key may lack permissions\n";
      }
    } catch (e) {
      out += "❌ " + e.message + "\n";
    }
    out += "\n";
  }

  out += "━━━━━━━━━━━━━━━━━━━━━━\n";
  if (!hasKey) out += "⚡ Add TWELVE_DATA_API_KEY in Railway Variables\n";
  if (!intervalOk) out += "⚡ Set SCAN_INTERVAL_SECONDS=" + (secsPerScan + 30) + " in Railway\n";
  if (provider === "mock") out += "ℹ️ Mock mode active — switch DATA_PROVIDER=twelve_data for live markets\n";

  await safeSend(chatId, out);
}

async function handleActiveSignals(msg) {
  const signals = scanner.getActiveSignals();
  if (!signals.length) {
    await safeSend(msg.chat.id, "📭 No active signals. Market not aligned yet.");
    return;
  }
  await safeSend(msg.chat.id, "📡 *" + signals.length + " active signal(s)*");
  for (const signal of signals) {
    await deliverSignal(signal, msg.chat.id);
    await sleep(400);
  }
}

async function handleWatchlist(msg) {
  const wl = scanner.getWatchlist();
  if (!wl.length) { await safeSend(msg.chat.id, "Watchlist is empty. Use /add SYMBOL."); return; }
  const grouped = {};
  for (const i of wl) {
    if (!grouped[i.category]) grouped[i.category] = [];
    grouped[i.category].push(i.displayName);
  }
  let text = "📋 *Watchlist* (" + wl.length + " instruments)\n━━━━━━━━━━━━━━━━━━━━━━\n";
  for (const [cat, syms] of Object.entries(grouped)) {
    text += "\n*" + cat.charAt(0).toUpperCase() + cat.slice(1) + ":*\n";
    text += syms.map(s => "• `" + s + "`").join("\n") + "\n";
  }
  await safeSend(msg.chat.id, text);
}

async function handleSubscribe(msg) {
  authorizedChats.add(msg.chat.id);
  await safeSend(msg.chat.id, "✅ Subscribed. You'll receive signals here.\nUse /unsubscribe to stop.");
  logger.info("Chat " + msg.chat.id + " subscribed");
}

async function handleUnsubscribe(msg) {
  if (msg.chat.id === ADMIN_ID) { await safeSend(msg.chat.id, "⚠️ Admin cannot unsubscribe."); return; }
  authorizedChats.delete(msg.chat.id);
  await safeSend(msg.chat.id, "🔕 Unsubscribed. Use /subscribe to re-enable.");
}

async function handleSlashScan(msg, args) {
  const chatId = msg.chat.id;
  const mode   = chatOutputMode.get(chatId) || scanner.getOutputMode();
  if (!args) {
    await runScanAndDeliver(chatId, scanner.getWatchlist(), mode);
    return;
  }
  const intent      = await parseIntent(args);
  const instruments = scanner.resolveInstruments(intent);
  if (!instruments.length) { await safeSend(chatId, "❌ Could not find \"" + args + "\" on the watchlist."); return; }
  await runScanAndDeliver(chatId, instruments, mode);
}

async function handleSlashBias(msg, args) {
  const chatId = msg.chat.id;
  const instruments = args
    ? scanner.resolveInstruments(await parseIntent(args))
    : scanner.getWatchlist();
  if (!instruments.length) { await safeSend(chatId, "No instruments found."); return; }
  await safeSend(chatId, "Scanning bias on " + instruments.length + " instrument(s)...");
  const results = await scanner.scanBiasOnly(instruments);
  for (const { symbol, biasMap, error } of results) {
    if (error || !biasMap) { await safeSend(chatId, "❌ " + symbol + ": " + (error || "no data")); continue; }
    await safeSend(chatId, formatBiasOnly(symbol, biasMap));
    await sleep(150);
  }
}

async function handleOutputSet(msg, arg) {
  const m = arg.toLowerCase().replace(/[^a-z]/g, "");
  if (m === "signal" || m === "analysis") await setOutputMode(msg.chat.id, m);
  else await safeSend(msg.chat.id, "Use: /output signal  or  /output analysis");
}

async function handleModeSet(msg, arg) {
  await setFractalMode(msg.chat.id, arg.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

async function handleAdd(msg, arg) {
  const { resolveSymbols } = require("../nlp/nlpEngine");
  const syms = resolveSymbols(arg.toLowerCase());
  if (!syms.length) { await safeSend(msg.chat.id, "❌ Unknown symbol: " + arg); return; }
  await addSymbols(msg.chat.id, syms);
}

async function handleRemove(msg, arg) {
  const { resolveSymbols } = require("../nlp/nlpEngine");
  const syms = resolveSymbols(arg.toLowerCase());
  if (!syms.length) { await safeSend(msg.chat.id, "❌ Unknown symbol: " + arg); return; }
  await removeSymbols(msg.chat.id, syms);
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function setOutputMode(chatId, mode) {
  chatOutputMode.set(chatId, mode);
  if (chatId === ADMIN_ID) scanner.setOutputMode(mode);
  await safeSend(chatId, "✅ Output → *" + (mode === "analysis" ? "Full Analysis" : "Signal Only") + "*");
}

async function setFractalMode(chatId, mode) {
  if (!["3step", "2step"].includes(mode)) {
    await safeSend(chatId, "Use: /mode 3step  or  /mode 2step"); return;
  }
  scanner.setFractalMode(mode);
  await safeSend(chatId, "✅ Mode → *" + (mode === "3step" ? "3-Step (HTF→MTF→LTF)" : "2-Step (HTF→LTF)") + "*");
}

async function addSymbols(chatId, syms) {
  const wl = scanner.getWatchlist();
  const added = [];
  for (const sym of syms) {
    if (wl.some(i => i.displayName === sym)) continue;
    const def  = DEFAULT_WATCHLIST.find(i => i.displayName === sym);
    const inst = def || { symbol: sym.includes("/") ? sym : sym.slice(0,3)+"/"+sym.slice(3), displayName: sym, category: "custom" };
    wl.push(inst);
    added.push(sym);
  }
  scanner.setWatchlist(wl);
  await safeSend(chatId, added.length
    ? "✅ Added: " + added.map(s => "`" + s + "`").join(", ")
    : "ℹ️ Already on watchlist."
  );
}

async function removeSymbols(chatId, syms) {
  const wl      = scanner.getWatchlist();
  const removed = [];
  const newWl   = wl.filter(i => {
    if (syms.includes(i.displayName)) { removed.push(i.displayName); return false; }
    return true;
  });
  scanner.setWatchlist(newWl);
  await safeSend(chatId, removed.length
    ? "✅ Removed: " + removed.map(s => "`" + s + "`").join(", ")
    : "❌ Not found on watchlist."
  );
}

async function safeSend(chatId, text) {
  if (!bot) { logger.info("[CONSOLE→" + chatId + "]\n" + text); return; }
  // Telegram has a 4096 char limit — split if needed
  const MAX = 4000;
  const chunks = [];
  while (text.length > MAX) {
    let split = text.lastIndexOf("\n", MAX);
    if (split < 1000) split = MAX;
    chunks.push(text.slice(0, split));
    text = text.slice(split).trim();
  }
  if (text) chunks.push(text);

  for (const chunk of chunks) {
    try {
      await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
    } catch (e) {
      logger.error("safeSend failed [" + chatId + "]: " + e.message);
      // Try sending without markdown if formatting caused the error
      try {
        await bot.sendMessage(chatId, chunk.replace(/[*_`]/g, ""));
      } catch (e2) {
        logger.error("safeSend plain also failed: " + e2.message);
      }
    }
    if (chunks.length > 1) await sleep(300);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function handleWatching(msg) {
  const chatId   = msg.chat.id;
  const watching = zoneWatcher.getWatchingSetups();
  const active   = zoneWatcher.getActiveSignals();

  if (!watching.length && !active.length) {
    await safeSend(chatId, "👁 No setups being watched right now.

Run a scan first — setups where price hasn't hit the zone yet will be automatically tracked.");
    return;
  }

  let out = "👁 *XERO EDGE™ — Zone Watch*
━━━━━━━━━━━━━━━━━━━━━━

";

  if (watching.length) {
    out += "*⏳ Waiting for price to enter zone:*
";
    for (const s of watching) {
      const isBull = s.bias === "BULLISH";
      const z1 = s.htfZones.zone1;
      const fmt = s.symbol.includes("JPY") || s.symbol.includes("XAU") || s.symbol.includes("BTC")
        ? n => Number(n).toFixed(2) : n => Number(n).toFixed(5);
      out += (isBull ? "🟢" : "🔴") + " `" + s.symbol + "` " + s.bias + " — " + getTfLabel(s.htfTf) + "
";
      out += "   Zone 1: `" + fmt(z1.low) + "` – `" + fmt(z1.high) + "`
";
      out += "   Added: " + new Date(s.addedAt).toUTCString().split(" ").slice(0,5).join(" ") + "

";
    }
  }

  if (active.length) {
    out += "*🎯 Active signals (monitoring for invalidation):*
";
    for (const s of active) {
      const isBull = s.bias === "BULLISH";
      const fmt = s.symbol.includes("JPY") || s.symbol.includes("XAU") || s.symbol.includes("BTC")
        ? n => Number(n).toFixed(2) : n => Number(n).toFixed(5);
      out += (isBull ? "🟢" : "🔴") + " `" + s.symbol + "` " + s.bias + " — " + s.tfLabel + "
";
      out += "   Entry: `" + fmt(s.entry) + "` | SL: `" + fmt(s.sl) + "`

";
    }
  }

  out += "━━━━━━━━━━━━━━━━━━━━━━
_Bot checks prices every 30s and alerts instantly on zone hit._";
  await safeSend(chatId, out);
}

async function broadcastAlert(info) {
  if (!bot) { logger.info("ALERT: " + JSON.stringify(info)); return; }

  let msg = "";
  const fmt = (sym, n) => {
    if (!n) return "N/A";
    return (sym.includes("JPY")||sym.includes("XAU")||sym.includes("BTC"))
      ? Number(n).toFixed(2) : Number(n).toFixed(5);
  };

  if (info.type === "approaching") {
    msg = "⚡ *ZONE APPROACHING — " + info.symbol + "*
" +
      "━━━━━━━━━━━━━━━━━━━━━━
" +
      (info.bias === "BULLISH" ? "🟢" : "🔴") + " " + info.bias + " | " + getTfLabel(info.htfTf) + "
" +
      "Current price `" + fmt(info.symbol, info.price) + "` is approaching the entry zone.
" +
      "Zone 1: `" + fmt(info.symbol, info.zones.zone1.low) + "` – `" + fmt(info.symbol, info.zones.zone1.high) + "`

" +
      "_Get ready — monitoring for entry confirmation._";
  }

  if (info.type === "invalidation") {
    const prefix = info.sl ? "Price hit stop loss" : "Bias invalidated";
    msg = "❌ *SETUP CANCELLED — " + info.symbol + "*
" +
      "━━━━━━━━━━━━━━━━━━━━━━
" +
      (info.bias === "BULLISH" ? "🟢" : "🔴") + " " + info.bias + " setup on " + getTfLabel(info.htfTf) + " is no longer valid.

" +
      "*Reason:* " + info.reason + "
" +
      (info.price ? "Price: `" + fmt(info.symbol, info.price) + "`
" : "") +
      (info.sl    ? "SL was: `" + fmt(info.symbol, info.sl) + "`
" : "") +
      "
_Setup removed. Waiting for new structure to form._";
  }

  if (!msg) return;

  for (const chatId of authorizedChats) {
    try { await bot.sendMessage(chatId, msg, { parse_mode:"Markdown" }); }
    catch(e) { logger.error("broadcastAlert to " + chatId + ": " + e.message); }
  }
}

module.exports = { initBot, broadcastSignal, broadcastAlert };

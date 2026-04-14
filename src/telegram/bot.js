// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE v2 — Telegram Bot
// Full NLP + slash commands + signal/analysis output
// ─────────────────────────────────────────────────────────────────────────────

const TelegramBot = require("node-telegram-bot-api");
const scanner     = require("../scanner/scanner");
const { parseIntent } = require("../nlp/nlpEngine");
const { formatBiasOnly, formatSignal, formatAnalysis, formatScanSummary, formatNoSignal } = require("../output/formatter");
const { DEFAULT_WATCHLIST } = require("../../config/markets");
const logger = require("../utils/logger");

const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_CHAT_ID || "716635266");

let bot = null;
const authorizedChats = new Set([ADMIN_ID]);
// Per-chat output mode override (inherits global if not set)
const chatOutputMode = new Map();

// ── Init ──────────────────────────────────────────────────────────────────────

function initBot() {
  if (!TOKEN || TOKEN === "YOUR_BOT_TOKEN_HERE") {
    logger.warn("No TELEGRAM_BOT_TOKEN — signals log to console only");
    return null;
  }
  bot = new TelegramBot(TOKEN, { polling: true });
  logger.info("Bot online — polling active");

  // Slash commands (explicit)
  bot.onText(/\/start$/,        msg => handleStart(msg));
  bot.onText(/\/help$/,         msg => handleHelp(msg));
  bot.onText(/\/status$/,       msg => handleStatus(msg));
  bot.onText(/\/signals$/,      msg => handleActiveSignals(msg));
  bot.onText(/\/watchlist$/,    msg => handleWatchlist(msg));
  bot.onText(/\/subscribe$/,    msg => handleSubscribe(msg));
  bot.onText(/\/unsubscribe$/,  msg => handleUnsubscribe(msg));

  // Slash shortcut commands (NLP-assisted)
  bot.onText(/\/scan(.*)$/,     (msg, m) => handleSlashScan(msg, m[1].trim()));
  bot.onText(/\/bias(.*)$/,     (msg, m) => handleSlashBias(msg, m[1].trim()));
  bot.onText(/\/output (.+)$/,  (msg, m) => handleOutputSet(msg, m[1].trim()));
  bot.onText(/\/mode (.+)$/,    (msg, m) => handleModeSet(msg, m[1].trim()));
  bot.onText(/\/add (.+)$/,     (msg, m) => handleAdd(msg, m[1].trim()));
  bot.onText(/\/remove (.+)$/,  (msg, m) => handleRemove(msg, m[1].trim()));

  // ALL other messages → NLP
  bot.on("message", msg => {
    if (!msg.text || msg.text.startsWith("/")) return;
    handleNLP(msg);
  });

  bot.on("polling_error", e => logger.error(`Polling: ${e.message}`));
  return bot;
}

// ── Signal delivery ───────────────────────────────────────────────────────────

async function deliverSignal(signal, chatId, overrideMode) {
  const mode = overrideMode || chatOutputMode.get(chatId) || scanner.getOutputMode();
  const p1   = formatSignal(signal);
  const p2   = mode === "analysis" ? formatAnalysis(signal) : null;

  await safeSend(chatId, p1);
  if (p2) { await sleep(400); await safeSend(chatId, p2); }
}

// Auto-delivery to all subscribers
async function broadcastSignal(signal) {
  if (!bot) {
    logger.info(`\n${"═".repeat(50)}\n${formatSignal(signal)}\n${"═".repeat(50)}`);
    return;
  }
  for (const chatId of authorizedChats) {
    await deliverSignal(signal, chatId);
  }
}

// ── NLP message handler ───────────────────────────────────────────────────────

async function handleNLP(msg) {
  const chatId = msg.chat.id;
  const text   = msg.text;
  if (!text) return;

  logger.debug(`NLP message from ${chatId}: "${text}"`);

  let intent;
  try {
    intent = await parseIntent(text);
  } catch(e) {
    logger.error(`NLP parse error: ${e.message}`);
    intent = { intent: "unknown", raw: text };
  }

  switch(intent.intent) {

    case "greeting":
      await safeSend(chatId, [
        `👋 Hey! I'm XERO EDGE™.`,
        ``,
        `Tell me what you need — just type naturally:`,
        `_"scan gold"_ · _"bias on EURUSD"_ · _"scan majors with analysis"_`,
        `_"what's the bias on cable?"_ · _"show me active signals"_`,
        ``,
        `Or type /help for all commands.`,
      ].join("\n"));
      break;

    case "help":
      await handleHelp(msg);
      break;

    case "status":
      await handleStatus(msg);
      break;

    case "active_signals":
      await handleActiveSignals(msg);
      break;

    case "watchlist_view":
      await handleWatchlist(msg);
      break;

    case "watchlist_add":
      if (intent.symbols && intent.symbols.length) {
        await addSymbols(chatId, intent.symbols);
      } else {
        await safeSend(chatId, "Which symbol do you want to add?");
      }
      break;

    case "watchlist_remove":
      if (intent.symbols && intent.symbols.length) {
        await removeSymbols(chatId, intent.symbols);
      } else {
        await safeSend(chatId, "Which symbol do you want to remove?");
      }
      break;

    case "set_output":
      await setOutput(chatId, intent.mode);
      break;

    case "set_mode":
      await setMode(chatId, intent.mode);
      break;

    case "bias_only": {
      const instruments = scanner.resolveInstruments(intent);
      if (!instruments.length) { await safeSend(chatId, "No instruments found for that."); break; }
      await safeSend(chatId, `🔍 Scanning bias on ${instruments.length} instrument${instruments.length!==1?"s":""}...`);
      const biasResults = await scanner.scanBiasOnly(instruments);
      for (const { symbol, biasMap, error } of biasResults) {
        if (error) { await safeSend(chatId, `❌ ${symbol}: ${error}`); continue; }
        await safeSend(chatId, formatBiasOnly(symbol, biasMap));
        await sleep(200);
      }
      break;
    }

    case "scan": {
      const instruments = scanner.resolveInstruments(intent);
      if (!instruments.length) { await safeSend(chatId, "No instruments found for that."); break; }
      const mode = intent.outputMode || chatOutputMode.get(chatId) || scanner.getOutputMode();
      await runScanAndDeliver(chatId, instruments, mode);
      break;
    }

    default:
      await safeSend(chatId, [
        `I didn't quite get that. Try something like:`,
        ``,
        `_"scan gold"_ · _"bias on EURUSD"_ · _"scan majors with analysis"_`,
        `_"show signals"_ · _"add GBPJPY to my list"_`,
        ``,
        `Or type /help for all commands.`,
      ].join("\n"));
  }
}

// ── Scan & deliver ────────────────────────────────────────────────────────────

async function runScanAndDeliver(chatId, instruments, outputMode) {
  const count = instruments.length;
  await safeSend(chatId, `🔍 Scanning ${count} instrument${count!==1?"s":""}...`);

  const results = await scanner.scanInstruments(instruments);

  // Summary first
  await safeSend(chatId, formatScanSummary(results, outputMode));
  await sleep(300);

  // Then signals or no-signal explanations
  let signalCount = 0;
  for (const { symbol, result } of results) {
    if (!result.signals || result.signals.length === 0) {
      if (count <= 3) {
        // Only show no-signal detail for small scans
        await safeSend(chatId, formatNoSignal(symbol, result));
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
    await safeSend(chatId, `_No full setups found across ${count} instruments. Market not aligned yet._`);
  }
}

// ── Slash command handlers ────────────────────────────────────────────────────

async function handleSlashScan(msg, args) {
  const chatId = msg.chat.id;
  const mode   = chatOutputMode.get(chatId) || scanner.getOutputMode();

  if (!args) {
    // Full watchlist scan
    await runScanAndDeliver(chatId, scanner.getWatchlist(), mode);
    return;
  }

  // Parse args as NLP
  const intent = await parseIntent(args || "scan all");
  const instruments = scanner.resolveInstruments(intent);
  if (!instruments.length) { await safeSend(chatId, `❌ Couldn't find "${args}" on the watchlist.`); return; }
  await runScanAndDeliver(chatId, instruments, mode);
}

async function handleSlashBias(msg, args) {
  const chatId = msg.chat.id;
  let instruments;

  if (!args) {
    instruments = scanner.getWatchlist();
  } else {
    const intent = await parseIntent(args);
    instruments = scanner.resolveInstruments(intent);
  }

  if (!instruments.length) { await safeSend(chatId, "No instruments found."); return; }
  await safeSend(chatId, `🔍 Bias scan on ${instruments.length} instrument${instruments.length!==1?"s":""}...`);

  const results = await scanner.scanBiasOnly(instruments);
  for (const { symbol, biasMap, error } of results) {
    if (error) { await safeSend(chatId, `❌ ${symbol}: ${error}`); continue; }
    await safeSend(chatId, formatBiasOnly(symbol, biasMap));
    await sleep(150);
  }
}

async function handleOutputSet(msg, arg) {
  const chatId = msg.chat.id;
  const m = arg.toLowerCase().replace(/[^a-z]/g,"");
  if (m === "signal" || m === "analysis") {
    await setOutput(chatId, m);
  } else {
    await safeSend(chatId, "Use: /output signal  or  /output analysis");
  }
}

async function handleModeSet(msg, arg) {
  const chatId = msg.chat.id;
  await setMode(chatId, arg.toLowerCase().replace(/[^a-z0-9]/g,""));
}

async function handleAdd(msg, arg) {
  const { resolveSymbols } = require("../nlp/nlpEngine");
  const syms = resolveSymbols(arg.toLowerCase());
  if (!syms.length) { await safeSend(msg.chat.id, `❌ Couldn't find "${arg}" as a valid symbol.`); return; }
  await addSymbols(msg.chat.id, syms);
}

async function handleRemove(msg, arg) {
  const { resolveSymbols } = require("../nlp/nlpEngine");
  const syms = resolveSymbols(arg.toLowerCase());
  if (!syms.length) { await safeSend(msg.chat.id, `❌ Couldn't find "${arg}" as a valid symbol.`); return; }
  await removeSymbols(msg.chat.id, syms);
}

async function handleStart(msg) {
  const name = msg.from.first_name || "Trader";
  await safeSend(msg.chat.id, [
    `🔷 *XERO EDGE™ Signal Bot v2*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `Welcome, *${name}*! 👋`,
    ``,
    `I use the *XERO EDGE Fractal Liquidity Model* to scan markets and find high-probability setups across multiple timeframes.`,
    ``,
    `You can talk to me in *plain English*:`,
    `_"scan gold"_  ·  _"what's the bias on EURUSD?"_`,
    `_"scan majors with full analysis"_  ·  _"show me active signals"_`,
    ``,
    `Or use slash commands — type /help to see all of them.`,
    ``,
    `📊 *Watching:* ${scanner.getWatchlist().length} instruments`,
    `⚙️ *Mode:* ${scanner.getFractalMode() === "3step" ? "3-Step Fractal" : "2-Step Fractal"}`,
    `📤 *Output:* ${scanner.getOutputMode() === "analysis" ? "Full Analysis" : "Signal Only"}`,
    ``,
    `_XERO TRADERS HUB — Trade With Edge™_`,
  ].join("\n"));
}

async function handleHelp(msg) {
  await safeSend(msg.chat.id, [
    `🔷 *XERO EDGE™ — Commands*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `💬 *Just type naturally — examples:*`,
    `_"scan gold"_`,
    `_"what's the bias on cable?"_`,
    `_"scan majors with analysis"_`,
    `_"check EURUSD and GBPUSD"_`,
    `_"bias scan on all"_`,
    `_"add GBPJPY to my watchlist"_`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `📡 *Scanning*`,
    `/scan — Full watchlist scan`,
    `/scan XAUUSD — Scan one instrument`,
    `/scan majors — Scan a category`,
    `/bias — Bias map (all TFs, no entry)`,
    `/bias EURUSD — Bias for one instrument`,
    `/signals — Show active signals`,
    ``,
    `⚙️ *Settings*`,
    `/output signal — Clean signal only`,
    `/output analysis — Full step-by-step`,
    `/mode 3step — HTF→MTF→LTF`,
    `/mode 2step — HTF→LTF (faster)`,
    `/watchlist — Show tracked instruments`,
    `/add SYMBOL — Add to watchlist`,
    `/remove SYMBOL — Remove from watchlist`,
    ``,
    `🔔 *Alerts*`,
    `/subscribe — Get auto-signals here`,
    `/unsubscribe — Stop signals`,
    `/status — Bot stats`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `_No alignment = No signal. Discipline is the edge._`,
  ].join("\n"));
}

async function handleStatus(msg) {
  const wl = scanner.getWatchlist();
  await safeSend(msg.chat.id, [
    `📊 *XERO EDGE™ Status*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `🟢 Online`,
    `⚙️ Mode: ${scanner.getFractalMode() === "3step" ? "3-Step Fractal" : "2-Step Fractal"}`,
    `📤 Output: ${scanner.getOutputMode() === "analysis" ? "Full Analysis" : "Signal Only"}`,
    `📡 Data: ${process.env.DATA_PROVIDER || "mock"}`,
    `⏱ Auto-scan: every ${process.env.SCAN_INTERVAL_SECONDS || "300"}s`,
    `📋 Watchlist: ${wl.length} instruments`,
    `🎯 Active signals: ${scanner.getActiveSignals().length}`,
    `👥 Subscribers: ${authorizedChats.size}`,
    `_${new Date().toUTCString()}_`,
  ].join("\n"));
}

async function handleActiveSignals(msg) {
  const signals = scanner.getActiveSignals();
  if (!signals.length) {
    await safeSend(msg.chat.id, `📭 *No active signals*\n\nMarket not aligned yet. Patience is the strategy.`);
    return;
  }
  await safeSend(msg.chat.id, `📡 *${signals.length} active signal${signals.length!==1?"s":""}*`);
  for (const signal of signals) {
    await deliverSignal(signal, msg.chat.id);
    await sleep(400);
  }
}

async function handleWatchlist(msg) {
  const wl = scanner.getWatchlist();
  if (!wl.length) { await safeSend(msg.chat.id, "📋 Watchlist is empty."); return; }
  const grouped = {};
  for (const i of wl) {
    if (!grouped[i.category]) grouped[i.category] = [];
    grouped[i.category].push(i.displayName);
  }
  let text = `📋 *Watchlist* (${wl.length} instruments)\n━━━━━━━━━━━━━━━━━━━━━━\n`;
  for (const [cat, syms] of Object.entries(grouped)) {
    text += `\n*${cat.charAt(0).toUpperCase()+cat.slice(1)}:*\n${syms.map(s=>`• \`${s}\``).join("\n")}\n`;
  }
  await safeSend(msg.chat.id, text);
}

async function handleSubscribe(msg) {
  authorizedChats.add(msg.chat.id);
  await safeSend(msg.chat.id, `✅ *Subscribed!*\nYou'll receive XERO EDGE™ signals automatically.\nUse /unsubscribe to stop.`);
}

async function handleUnsubscribe(msg) {
  if (msg.chat.id === ADMIN_ID) { await safeSend(msg.chat.id, "⚠️ Admin cannot unsubscribe."); return; }
  authorizedChats.delete(msg.chat.id);
  await safeSend(msg.chat.id, `🔕 Unsubscribed. Use /subscribe to re-enable.`);
}

async function handleDiagnose(msg) {
  const chatId = msg.chat.id;
  await safeSend(chatId, "🔍 *Running diagnostics...*");

  const { validateConnection } = require("../scanner/dataProvider");
  const { DEFAULT_WATCHLIST } = require("../../config/markets");

  const lines = [];
  lines.push("🔷 *XERO EDGE™ Diagnostics*");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("");

  // Environment
  const provider = process.env.DATA_PROVIDER || "mock";
  const hasKey   = !!(process.env.TWELVE_DATA_API_KEY && process.env.TWELVE_DATA_API_KEY !== "YOUR_TWELVE_DATA_KEY_HERE");
  const hasToken = !!(process.env.TELEGRAM_BOT_TOKEN);
  const rateLimit = process.env.API_RATE_LIMIT || "6";
  const interval  = process.env.SCAN_INTERVAL_SECONDS || "300";

  lines.push("*Environment*");
  lines.push(`DATA_PROVIDER: \`${provider}\``);
  lines.push(`TWELVE_DATA_API_KEY: ${hasKey ? "✅ Set" : "❌ Missing"}`);
  lines.push(`TELEGRAM_BOT_TOKEN: ${hasToken ? "✅ Set" : "❌ Missing"}`);
  lines.push(`API_RATE_LIMIT: \`${rateLimit}/min\``);
  lines.push(`SCAN_INTERVAL: \`${interval}s\``);
  lines.push("");

  // API connection test
  lines.push("*API Connection Test*");
  const check = await validateConnection();
  lines.push(check.ok ? `✅ ${check.message}` : `❌ ${check.message}`);
  lines.push("");

  // Rate limit warning
  const wl = scanner.getWatchlist();
  const callsPerScan = wl.length * 4; // 4 HTF timeframes
  const minutesNeeded = Math.ceil(callsPerScan / parseInt(rateLimit));
  lines.push("*Rate Limit Check*");
  lines.push(`Watchlist: \`${wl.length}\` instruments`);
  lines.push(`HTF calls per scan: \`${callsPerScan}\``);
  lines.push(`At ${rateLimit} req/min → needs \`${minutesNeeded} min\` per full scan`);
  if (minutesNeeded > 2) {
    lines.push(`⚠️ Consider reducing watchlist or upgrading Twelve Data plan`);
    lines.push(`Tip: set \`SCAN_INTERVAL_SECONDS=${minutesNeeded * 60 + 60}\` in Railway`);
  } else {
    lines.push("✅ Rate limit looks fine for your watchlist size");
  }
  lines.push("");

  // Quick candle test
  if (provider !== "mock" && hasKey) {
    lines.push("*Live Candle Test (EUR/USD 1H)*");
    try {
      const { fetchCandles } = require("../scanner/dataProvider");
      const candles = await fetchCandles("EUR/USD", "1h", 3);
      if (candles && candles.length > 0) {
        const last = candles[candles.length - 1];
        lines.push(`✅ Got ${candles.length} candles`);
        lines.push(`Last: O:\`${last.open}\` H:\`${last.high}\` L:\`${last.low}\` C:\`${last.close}\``);
      } else {
        lines.push("❌ No candles returned — check API key and symbol support");
      }
    } catch(e) {
      lines.push(`❌ Error: ${e.message}`);
    }
  }

  lines.push("");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("_If API key is missing: add TWELVE\_DATA\_API\_KEY in Railway Variables_");
  lines.push("_If rate limited: increase SCAN\_INTERVAL\_SECONDS or set API\_RATE\_LIMIT=6_");

  await safeSend(chatId, lines.join("\n"));
}

// ── Shared helpers ────────────────────────────────────────────────────────────

async function setOutput(chatId, mode) {
  chatOutputMode.set(chatId, mode);
  if (chatId === ADMIN_ID) scanner.setOutputMode(mode);
  await safeSend(chatId, `✅ Output mode → *${mode === "analysis" ? "Full Analysis" : "Signal Only"}*`);
}

async function setMode(chatId, mode) {
  const m = mode.replace(/[^a-z0-9]/g,"");
  if (!["3step","2step"].includes(m)) { await safeSend(chatId, "Use: /mode 3step  or  /mode 2step"); return; }
  scanner.setFractalMode(m);
  await safeSend(chatId, `✅ Mode → *${m === "3step" ? "3-Step (HTF→MTF→LTF)" : "2-Step (HTF→LTF)"}*`);
}

async function addSymbols(chatId, syms) {
  const wl = scanner.getWatchlist();
  const added = [];
  for (const sym of syms) {
    if (wl.some(i=>i.displayName===sym)) continue;
    const def = DEFAULT_WATCHLIST.find(i=>i.displayName===sym);
    const inst = def || { symbol: sym.length>5?sym:`${sym.slice(0,3)}/${sym.slice(3)}`, displayName: sym, category:"custom" };
    wl.push(inst);
    added.push(sym);
  }
  scanner.setWatchlist(wl);
  if (added.length) await safeSend(chatId, `✅ Added: ${added.map(s=>`\`${s}\``).join(", ")}`);
  else await safeSend(chatId, `ℹ️ Already on watchlist.`);
}

async function removeSymbols(chatId, syms) {
  const wl = scanner.getWatchlist();
  const removed = [];
  const newWl = wl.filter(i => {
    if (syms.includes(i.displayName)) { removed.push(i.displayName); return false; }
    return true;
  });
  scanner.setWatchlist(newWl);
  if (removed.length) await safeSend(chatId, `✅ Removed: ${removed.map(s=>`\`${s}\``).join(", ")}`);
  else await safeSend(chatId, `❌ Not found on watchlist.`);
}

async function safeSend(chatId, text) {
  if (!bot) { logger.info(`[CONSOLE→${chatId}]\n${text}`); return; }
  try { await bot.sendMessage(chatId, text, { parse_mode:"Markdown" }); }
  catch(e) { logger.error(`safeSend ${chatId}: ${e.message}`); }
}

function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

module.exports = { initBot, broadcastSignal };

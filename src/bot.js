// bot.js
"use strict";
// ============================================================
// XERO EDGE(TM) v4 -- Telegram Bot
// Live market data: Twelve Data (free)
// Execution: Paper trading with real prices
// ============================================================
require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const schedule    = require("node-schedule");

const { KnowledgeBase, CATEGORIES } = require("./knowledge");
const { TradeJournal }   = require("./journal");
const { RiskEngine }     = require("./risk");
const { Executor }       = require("./executor");
const { VoiceHandler }   = require("./voice");
const { ClaudeAgent, getSessionIST, isSessionValid, MODE_SCORES, setBiasTF, getBiasTF } = require("./claude");
const { AlertMonitor }   = require("./alerts");
const { VisionAnalyser } = require("./vision");
const { marketEngine }   = require("./market");
const { NLPRouter }      = require("./nlp");
const { Scanner, SCAN_MODES, TF_GROUPS } = require("./scanner");
const { resolvePairs, groupSummary, PAIR_GROUPS } = require("./pairs");

// -- Validate required env vars -----------------------------
const REQUIRED = [
  "TELEGRAM_BOT_TOKEN",
  "ADMIN_TELEGRAM_ID",
  "ANTHROPIC_API_KEY",
  "GOOGLE_SHEET_ID",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error("[x] Missing required env vars:", missing.join(", "));
  process.exit(1);
}

// -- Init ---------------------------------------------------
const bot      = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const ADMIN_ID = parseInt(process.env.ADMIN_TELEGRAM_ID);

const kb      = new KnowledgeBase();
const journal = new TradeJournal();
const risk    = new RiskEngine();
const exec    = new Executor();
const voice   = new VoiceHandler();
const claude  = new ClaudeAgent(kb, journal, risk);
const alerts  = new AlertMonitor({ knowledgeBase:kb, journal, executor:exec, bot, adminId:ADMIN_ID });
const vision  = new VisionAnalyser(kb);
const scanner = new Scanner({ kb, journal, risk, exec });
const nlp     = new NLPRouter({ kb, journal, risk, exec, claude, scanner, alerts, marketEngine, bot, adminId:ADMIN_ID });

// -- Helpers ------------------------------------------------
const isAdmin = id => id === ADMIN_ID;

const send = (chatId, text, opts = {}) =>
  bot.sendMessage(chatId, text, { parse_mode:"Markdown", ...opts })
     .catch(e => console.error("[send]", e.message));

const guard = (msg, fn) => {
  if (!isAdmin(msg.from.id)) return send(msg.chat.id, "? Unauthorized.");
  Promise.resolve().then(fn).catch(e => send(msg.chat.id, `[x] Error: ${e.message}`));
};

const PAIR_RE = /\b(XAUUSD|GOLD|EURUSD|GBPUSD|GBPJPY|USDJPY|BTCUSD|ETHUSD|NAS100|US30)\b/i;
function detectPair(t = "") {
  const m = t.match(PAIR_RE);
  if (!m) return null;
  const p = m[0].toUpperCase();
  return p === "GOLD" ? "XAUUSD" : p;
}

// ==========================================================
// COMMANDS
// ==========================================================

// -- /start -------------------------------------------------
bot.onText(/\/start/, msg => guard(msg, () => {
  send(msg.chat.id,
    `[MED] *XERO EDGE(TM) Pro v4 -- Online*\nSession: ${getSessionIST()}\n\n` +
    `? *Just talk naturally -- no commands needed*\n` +
    `_"scan majors" - "what's gold at" - "go long euro" - "how am I doing"_\n\n` +
    `*SCAN*\n\`/scan\` -- default pairs, full protocol\n\`/scan majors\` -- majors\n\`/scan minors\` -- minors\n\`/scan commodities\` -- gold, silver\n\`/scan all\` -- all pairs\n\`/scan XAUUSD GBPJPY\` -- specific pairs\n\n*TF flag (add to any scan):*\n\`tf:1d\` \`tf:4h\` \`tf:1h\` \`tf:15m\`\ne.g. \`/scan majors tf:4h\`\n\n*Mode flag (add to any scan):*\n\`mode:bias\` -- bias only\n\`mode:bias:htf\` -- HTF bias (1D/4H)\n\`mode:bias:ltf\` -- LTF bias (1H/15M)\n\`mode:impulse\` -- bias + impulse\n\`mode:sweep\` -- price at OB\n\`mode:pattern:mw\` -- M or W patterns\n\`mode:pattern:consol\` -- consolidation\n\`mode:full\` -- full protocol (default)\ne.g. \`/scan majors tf:4h mode:sweep\`\n\n\`/pairs\` -- view all pair groups\n\n` +
    `*? CHART TRAINING*\nSend any chart screenshot -> instant analysis\nAdd "train" in caption -> save to knowledge base\n\n` +
    `*? TRAINING*\n\`/teach [rule]\` -- add a rule\n\`/playbook add\` -- build a setup template\n\n` +
    `*? MARKET DATA*\n\`/price XAUUSD\` -- live price + bias\n\`/bias XAUUSD\` -- full bias analysis\n\`/setup XAUUSD\` -- scan one pair\n\`/analyze XAUUSD\` -- full analysis\n\`/marketstatus\` -- data connection\n\n` +
    `*? RISK & JOURNAL*\n\`/risk XAUUSD 2315 2308 2330\`\n\`/account 10000 1\` -- set account\n\`/addtrade\` -- log a trade\n\`/stats\` -- performance\n\n` +
    `*? KNOWLEDGE*\n\`/knowledge\` -- all rules\n\`/playbooks\` -- all playbooks\n\`/visualkb\` -- chart training examples\n\n` +
    `*TRADING*\n\`/autotrade on|off\` -- auto paper trade\n\`/positions\` -- open positions\n\`/close [ticket]\` -- close a position\n\n` +
    `*? SYSTEM*\n\`/mode sniper|balanced|aggressive\` -- set trade mode\n\`/briefing\` -- morning briefing\n\`/status\` -- system health\n\`/clear\` -- reset AI memory`
  );
}));

// -- /teach -------------------------------------------------
bot.onText(/\/teach (.+)/, async (msg, match) => guard(msg, async () => {
  let text = match[1].trim();
  let category = null, pair = "ALL", priority = 7; // default 7 -- Claude treats 7+ as important
  const catMap = {
    htf:CATEGORIES.HTF_BIAS, bias:CATEGORIES.HTF_BIAS,
    entry:CATEGORIES.ENTRY,   trigger:CATEGORIES.ENTRY,
    risk:CATEGORIES.RISK,     avoid:CATEGORIES.AVOID,
    no:CATEGORIES.AVOID,      session:CATEGORIES.SESSION,
    pair:CATEGORIES.PAIR,     psych:CATEGORIES.PSYCHOLOGY,
    mind:CATEGORIES.PSYCHOLOGY,
  };
  const catTag  = text.match(/\bin:([\w]+)/i);
  const pairTag = text.match(/\bpair:([\w]+)/i);
  const priTag  = text.match(/\bpriority:(\d+)/i);
  if (catTag)  { category = catMap[catTag[1].toLowerCase()] || null; text = text.replace(catTag[0],"").trim(); }
  if (pairTag) { pair = pairTag[1].toUpperCase(); text = text.replace(pairTag[0],"").trim(); }
  if (priTag)  { priority = parseInt(priTag[1]);  text = text.replace(priTag[0],"").trim(); }

  const r = await kb.addRule({ text, category, pair, priority });

  if (r.duplicate) return send(msg.chat.id,
    `[!] *That rule already exists*\n\nClaude already knows this. If it's not being applied, use a higher priority:\n\`/teach [rule] priority:9\``
  );

  // Clear Claude's conversation history so it picks up the new rule immediately
  claude.clearHistory();

  send(msg.chat.id,
    `[ok] *Rule Saved & Active*\n\n` +
    `"${r.rule.text}"\n\n` +
    `? Category: *${r.rule.category}*\n` +
    `[target] Pair: *${r.rule.pair}*\n` +
    `[!] Priority: *${r.rule.priority}/10*\n` +
    `? Total rules: *${r.total}*\n\n` +
    `_Memory cleared -- Claude will apply this rule from the next message._\n\n` +
    `*Priority guide:*\n10 = absolute (never break)\n9 = critical\n7-8 = important ? default\n5-6 = standard\n1-4 = minor`
  );
}));

// -- /playbook add ------------------------------------------
bot.onText(/\/playbook add/, msg => guard(msg, async () => {
  const chatId = msg.chat.id;
  const ask = q => new Promise(res => {
    send(chatId, q);
    const fn = m => { if (!isAdmin(m.from.id)) return; bot.removeListener("message", fn); res(m.text); };
    bot.on("message", fn);
  });
  send(chatId, "? *New Playbook -- answer each question:*\n_(type skip for optional)_");
  const name = await ask("1? *Setup name?*");
  const pair = await ask("2? *Pair?*  e.g. XAUUSD or ALL");
  const dir  = await ask("3? *Direction?*  LONG / SHORT / BOTH");
  const htf  = await ask("4? *HTF condition?*  e.g. Daily bearish 2-candle bias confirmed");
  const trig = await ask("5? *Entry trigger?*  e.g. 1H OB rejection + H&S neckline break on M15");
  const sl   = await ask("6? *SL placement?*  e.g. Above C2 high + 5 pip buffer");
  const tp   = await ask("7? *TP target?*  e.g. Previous demand zone");
  const rr   = await ask("8? *Min RR?*  e.g. 2");
  const note = await ask("9? *Notes?*  (or skip)");
  const res  = await kb.addPlaybook({ name, pair, direction:dir, htfBias:htf, trigger:trig, slRule:sl, tpRule:tp, minRR:parseFloat(rr)||2, notes:note==="skip"?"":note });
  send(chatId,
    `[ok] *Playbook Saved: ${res.play.name}*\n\n${res.play.pair} ${res.play.direction} | Min RR: 1:${res.play.minRR}\n` +
    `HTF: ${res.play.htfBias}\nEntry: ${res.play.trigger}\nSL: ${res.play.slRule} | TP: ${res.play.tpRule}`
  );
}));

// -- /playbooks ---------------------------------------------
bot.onText(/\/playbooks/, async msg => guard(msg, async () => {
  const plays = await kb.loadPlaybook();
  if (!plays.length) return send(msg.chat.id, "No playbooks yet. Use `/playbook add`.");
  send(msg.chat.id, `? *Playbooks (${plays.length})*\n\n` +
    plays.map((p,i) => `*${i+1}. ${p.name}* (${p.pair} ${p.direction})\n  Entry: ${p.trigger}\n  RR: 1:${p.minRR}`).join("\n\n")
  );
}));

// -- /knowledge ---------------------------------------------
bot.onText(/\/knowledge/, async msg => guard(msg, async () => {
  const byCat = await kb.getRulesByCategory();
  let text = `? *Knowledge Base* (${kb.getRuleCount()} rules)\n`;
  for (const [cat, rules] of Object.entries(byCat)) {
    if (!rules.length) continue;
    text += `\n*${cat}* (${rules.length})\n`;
    rules.forEach(r => {
      text += `${r.priority>=9?"[!]":r.priority>=7?"-":" "} \`${r.id}\`${r.pair!=="ALL"?` [${r.pair}]`:""} ${r.text}\n`;
    });
  }
  text += `\nDelete: /forget [ruleID]`;
  send(msg.chat.id, text);
}));

// -- /forget ------------------------------------------------
bot.onText(/\/forget (.+)/, async (msg, match) => guard(msg, async () => {
  const r = await kb.deleteRule(match[1].trim());
  send(msg.chat.id, r.success ? `? Deleted: "${r.deleted}"` : `[x] Rule not found: ${match[1]}`);
}));


// ============================================================
// /scan -- Unified scanner
// Syntax: /scan [pairs/group] [tf:TF] [mode:MODE]
//
// Examples:
//   /scan                           -- default pairs, full protocol, all TFs
//   /scan majors                    -- all majors, full protocol, all TFs
//   /scan minors tf:4h              -- minors, 4H bias only
//   /scan XAUUSD GBPJPY tf:1h      -- specific pairs, 1H bias
//   /scan all mode:bias             -- all pairs, bias scan only
//   /scan commodities mode:sweep    -- commodities, sweep scan
//   /scan majors tf:15m mode:pattern:mw  -- M/W patterns on 15M
//   /scan all tf:4h mode:impulse    -- impulse scan, 4H bias
// ============================================================
bot.onText(/\/scan(?:\s+(.+))?/, async (msg, match) => guard(msg, async () => {
  if (!marketEngine.isConnected()) {
    return send(msg.chat.id,
      "Market data not connected. Add TWELVE_DATA_API_KEY to Railway."
    );
  }
  if (scanner.isRunning()) {
    return send(msg.chat.id, "Scan already running. Use /scanstop to cancel.");
  }

  const raw = (match[1] || "").trim().toLowerCase();
  const tokens = raw.split(/\s+/);

  // Parse tf: and mode: flags from tokens
  let tfFlag   = null;
  let modeFlag = null;
  const pairTokens = [];

  for (const tok of tokens) {
    if (tok.startsWith("tf:"))   { tfFlag   = tok.replace("tf:","");   continue; }
    if (tok.startsWith("mode:")) { modeFlag = tok.replace("mode:",""); continue; }
    pairTokens.push(tok);
  }

  // Resolve pairs from remaining tokens
  const pairInput = pairTokens.join(" ").trim() || "default";
  const pairs     = resolvePairs(pairInput);

  // Apply TF and mode overrides
  const validTFs   = ["1d","4h","1h","15m","5m"];
  const validModes = Object.keys(SCAN_MODES);

  // TF: explicit flag takes priority, else detect from raw text
  if (tfFlag && validTFs.includes(tfFlag)) {
    scanner.setBiasTF(tfFlag);
  } else if (tfFlag === "auto") {
    scanner.setBiasTF(null);
  } else {
    // Natural language TF: "scan majors on 1h", "scan in 4h"
    const nlTF = raw.match(/\b(?:on|in)\s+(1d|4h|1h|15m|5m)\b/);
    if (nlTF) scanner.setBiasTF(nlTF[1]);
    // else keep current TF unchanged
  }

  // Mode: explicit flag takes priority, else detect from keywords
  if (modeFlag && validModes.includes(modeFlag)) {
    scanner.setMode(modeFlag);
  } else if (!modeFlag) {
    // Natural language mode detection
    let nlMode = null;
    if (/pattern.*consol|consol.*pattern|sideways|triangle|rectangle|pennant/.test(raw)) nlMode = "pattern:consol";
    else if (/m.?pattern|w.?pattern/.test(raw)) nlMode = "pattern:mw";
    else if (/\bpattern/.test(raw)) nlMode = "pattern:all";
    else if (/bias.?only|only.?bias|just.?bias/.test(raw)) nlMode = "bias";
    else if (/htf.?bias|bias.?htf/.test(raw)) nlMode = "bias:htf";
    else if (/ltf.?bias|bias.?ltf/.test(raw)) nlMode = "bias:ltf";
    else if (/\bimpulse/.test(raw)) nlMode = "impulse";
    else if (/\bsweep/.test(raw)) nlMode = "sweep";
    if (nlMode) scanner.setMode(nlMode);
    // else keep current mode unchanged
  }

  // Show what we are doing
  const tfLabel   = scanner.getBiasTF() ? scanner.getBiasTF().toUpperCase() : "ALL TFs";
  const modeLabel = scanner.getModeLabel();
  send(msg.chat.id,
    "Scanning " + pairs.length + " pairs\n" +
    "TF: " + tfLabel + " | Mode: " + modeLabel + "\n" +
    pairs.slice(0,8).join(" ") + (pairs.length > 8 ? " +" + (pairs.length-8) + " more" : "")
  );

  const res = await scanner.scan(
    pairs,
    (txt) => send(msg.chat.id, txt),
    (result) => {
      const alert = scanner.formatSetupAlert(result);
      send(msg.chat.id, alert.text, { reply_markup: alert.keyboard });
    }
  );

  if (res.checked > 0) {
    send(msg.chat.id, scanner.formatSummary(res.results, res.checked));
  }
}));

// -- /scanstop ----------------------------------------------
bot.onText(/\/scanstop/, msg => guard(msg, () => {
  scanner.cancel();
  send(msg.chat.id, "? Scan cancelled.");
}));
bot.onText(/\/price(?:\s+(.+))?/, async (msg, match) => guard(msg, async () => {
  const pair = (match[1] || "XAUUSD").trim().toUpperCase();
  if (!marketEngine.isConnected()) {
    return send(msg.chat.id,
      `[x] *Market data not connected*\n\nAdd \`TWELVE_DATA_API_KEY\` to Railway Variables.\n\nGet free key at: twelvedata.com`
    );
  }
  send(msg.chat.id, `? Fetching ${pair}...`);
  const [price, candles] = await Promise.all([
    marketEngine.getPrice(pair).catch(() => null),
    marketEngine.getCandles(pair, "4h", 3).catch(() => null),
  ]);
  if (!price) return send(msg.chat.id, `[x] Could not fetch ${pair}. Check the pair symbol.`);
  const bias = candles ? marketEngine.checkBias(candles) : null;
  send(msg.chat.id,
    `? *${pair} -- Live Price*\n\nBid: \`${price.bid}\` | Ask: \`${price.ask}\`\nSpread: ${price.spread} pips\n\n` +
    `4H Bias: *${bias?.bias || "No data"}${bias?.confirmed ? " [ok]" : ""}*\n` +
    (bias?.confirmed ? `Invalidation: \`${bias.invalidationLevel}\`\n${bias.detail}` : "")
  );
}));

// -- /marketstatus ------------------------------------------
bot.onText(/\/marketstatus/, async msg => guard(msg, async () => {
  if (!marketEngine.isConnected()) {
    return send(msg.chat.id,
      `? *Market Data -- Not Connected*\n\n` +
      `To enable live data:\n1. Go to twelvedata.com\n2. Click "Get free API key"\n3. Sign up free -- no card\n4. Add \`TWELVE_DATA_API_KEY\` to Railway Variables\n5. Redeploy`
    );
  }
  send(msg.chat.id, `[WAIT] Fetching live prices...`);
  const prices = await Promise.all(exec.pairs.slice(0,4).map(async p => {
    const price = await marketEngine.getPrice(p).catch(() => null);
    const candles = await marketEngine.getCandles(p, "4h", 3).catch(() => null);
    const bias = candles ? marketEngine.checkBias(candles) : null;
    return price
      ? `*${p}*: ${price.mid} | 4H: ${bias?.bias||"--"}${bias?.confirmed?" [ok]":""}`
      : `*${p}*: error`;
  }));
  send(msg.chat.id,
    `? *Market Data -- Connected [ok]*\n\nSource: Twelve Data (free)\n\n${prices.join("\n")}\n\nAll signals use real OHLC data.`
  );
}));

// -- /bias --------------------------------------------------
bot.onText(/\/bias(?:\s+(.+))?/, async (msg, match) => guard(msg, async () => {
  const pair = (match[1] || "XAUUSD").trim().toUpperCase();
  send(msg.chat.id, `? Analysing ${pair} with real data...`);
  const b = await claude.getBias(pair);
  const dir = b.direction==="BULLISH"?"[bull] BULLISH":b.direction==="BEARISH"?"[HIGH] BEARISH":"[STD] NEUTRAL";
  const mD1 = b._mathBiasD1, m4h = b._mathBias4h;
  send(msg.chat.id,
    `[chart] *${pair} Bias*\n\n${dir} | Confidence: *${b.confidence}%*\nConfluence: *${b.confluenceScore}/100*` +
    (!b.sessionFavorable ? "\n[!] _Session not ideal_" : "") +
    `\n\n*Math Check (real candles):*\nDaily: ${mD1 ? `${mD1.bias}${mD1.confirmed?" [ok] inv:"+mD1.invalidationLevel:" (unconfirmed)"}` : "No data"}\n4H: ${m4h ? `${m4h.bias}${m4h.confirmed?" [ok] inv:"+m4h.invalidationLevel:" (unconfirmed)"}` : "No data"}\n\n` +
    `${b.reasoning}\n\n*Key Levels:*\n${b.keyLevels}\n\n*Aligned:*\n${(b.confluenceFactors||[]).map(f=>`- ${f}`).join("\n")||"--"}`
  );
}));

// -- /setup -------------------------------------------------
bot.onText(/\/setup(?:\s+(.+))?/, async (msg, match) => guard(msg, async () => {
  const pair = (match[1] || "XAUUSD").trim().toUpperCase();
  send(msg.chat.id, `? Scanning ${pair} with real data...`);
  const s = await claude.scanSetup(pair);
  if (s.found) {
    exec.cacheSetup(pair, s.id, s);
    const card = risk.formatCard({ pair, entry:s.entry, sl:s.sl, tp:s.tp });
    send(msg.chat.id,
      `[target] *${pair} Setup*${!s.sessionFavorable?"\n[!] _Session not ideal_":""}\n\n` +
      `Playbook: *${s.playbook||"Custom"}* | Type: *${s.type}*\nDirection: *${s.direction}*\n\n` +
      `Entry: \`${s.entry}\` | SL: \`${s.sl}\` | TP: \`${s.tp}\`\n` +
      `RR: *1:${s.rr}* | Invalidation: \`${s.invalidationLevel}\`\n\n` +
      `Confluence: *${s.confluenceScore}/100*\n${(s.confluenceFactors||[]).map(f=>`[ok] ${f}`).join("\n")}\n\n` +
      `${s.reasoning}\n\n${card}`,
      { reply_markup:{ inline_keyboard:[[
        { text:"[ok] Paper Trade", callback_data:`exec_${pair}_${s.id}` },
        { text:"[chart] Full Analysis", callback_data:`analyze_${pair}` },
        { text:"[x] Skip", callback_data:"skip" },
      ]]}}
    );
  } else {
    send(msg.chat.id, `[WAIT] *No setup on ${pair}*\n\n${s.notes}\n\n? Watch for: ${s.watchFor||"--"}`);
  }
}));

// -- /analyze -----------------------------------------------
bot.onText(/\/analyze(?:\s+(.+))?/, async (msg, match) => guard(msg, async () => {
  const pair = (match[1] || "XAUUSD").trim().toUpperCase();
  send(msg.chat.id, `? Full XERO EDGE(TM) analysis on ${pair} with real data...`);
  send(msg.chat.id, await claude.fullAnalysis(pair));
}));

// -- /risk --------------------------------------------------
bot.onText(/\/risk (\S+) ([\d.]+) ([\d.]+) ([\d.]+)/, async (msg, match) => guard(msg, async () => {
  send(msg.chat.id, risk.formatCard({
    pair:match[1].toUpperCase(), entry:parseFloat(match[2]),
    sl:parseFloat(match[3]), tp:parseFloat(match[4]),
  }));
}));

// -- /account -----------------------------------------------
bot.onText(/\/account ([\d.]+) ([\d.]+)/, async (msg, match) => guard(msg, async () => {
  risk.accountSize = parseFloat(match[1]);
  risk.riskPercent = parseFloat(match[2]);
  risk.currentBalance = risk.peakBalance = risk.accountSize;
  send(msg.chat.id,
    `[ok] *Account Updated*\nSize: *$${risk.accountSize}* | Risk: *${risk.riskPercent}%*\n` +
    `Per trade: *$${(risk.accountSize*risk.riskPercent/100).toFixed(2)}*`
  );
}));

// -- /addtrade ----------------------------------------------
bot.onText(/\/addtrade/, msg => guard(msg, () => {
  send(msg.chat.id,
    `? *Log a Trade*\nFormat: \`PAIR DIR ENTRY SL TP RESULT [setup] [notes]\`\n` +
    `Example: \`XAUUSD SHORT 2320 2328 2300 WIN OB-Short\``
  );
  const fn = async m => {
    if (!isAdmin(m.from.id) || m.text?.startsWith("/")) return;
    bot.removeListener("message", fn);
    const r = await journal.logTradeFromText(m.text);
    send(msg.chat.id, r.success
      ? `[ok] *Trade Logged*\n${r.summary}\n\nWR: *${r.stats.winRate}%* | Streak: *${r.stats.streak.current} ${r.stats.streak.type}s*`
      : `[x] ${r.error}`
    );
  };
  bot.on("message", fn);
}));

// -- /stats -------------------------------------------------
bot.onText(/\/stats/, async msg => guard(msg, async () => {
  const s = await journal.getStats();
  if (!s.total) return send(msg.chat.id, "No trades yet. Use /addtrade to start.");
  send(msg.chat.id,
    `[up] *XERO EDGE(TM) Stats*\n\nTrades: *${s.total}* | W: ${s.wins} | L: ${s.losses}\n` +
    `WR: *${s.winRate}%* | Avg RR: *${s.avgRR}*\nP&L: *${s.totalPnlPips>0?"+":""}${s.totalPnlPips} pips*\n\n` +
    `Best Pair: *${s.bestPair}* | Best Setup: ${s.bestSetup}\n` +
    `${s.streak.type==="WIN"?"?":"?"} Streak: *${s.streak.current} ${s.streak.type}s*\n\n` +
    `*Month:* ${s.monthly.trades} trades | ${s.monthly.winRate}% WR | ${s.monthly.pnlPips>0?"+":""}${s.monthly.pnlPips} pips`
  );
}));

// -- /history -----------------------------------------------
bot.onText(/\/history(?:\s+(\d+))?/, async (msg, match) => guard(msg, async () => {
  const trades = await journal.getRecent(parseInt(match[1])||10);
  if (!trades.length) return send(msg.chat.id, "No trades yet.");
  send(msg.chat.id, `? *Last ${trades.length} Trades*\n\n` +
    trades.map(t => `${t.result==="WIN"?"[ok]":t.result==="LOSS"?"[x]":"?"} *${t.pair}* ${t.direction} | 1:${t.rr} | ${t.date}${t.setup?" | "+t.setup:""}`).join("\n")
  );
}));

// -- /review ------------------------------------------------
bot.onText(/\/review/, async msg => guard(msg, async () => {
  const trades = await journal.getRecent(1);
  if (!trades.length) return send(msg.chat.id, "No trades to review.");
  send(msg.chat.id, "? Reviewing...");
  send(msg.chat.id, `? *Trade Review*\n\n${await claude.reviewTrade(trades[0])}`);
}));

// -- /briefing ----------------------------------------------
bot.onText(/\/briefing/, async msg => guard(msg, async () => {
  send(msg.chat.id, "? Generating briefing with live data...");
  send(msg.chat.id, await claude.generateBriefing(exec.pairs));
}));

// -- /positions ---------------------------------------------
bot.onText(/\/positions/, async msg => guard(msg, async () => {
  const st = await exec.getStatus();
  if (!st.openPositions) return send(msg.chat.id, "? No open positions.");
  send(msg.chat.id, `[chart] *Open Positions (${st.openPositions})*\n\n` +
    st.positions.map(p =>
      `- *${p.pair}* ${p.direction} | Entry:\`${p.entry}\` SL:\`${p.sl}\` TP:\`${p.tp}\`\n  Lot:${p.lot} | #${p.ticket} | ? Paper`
    ).join("\n\n")
  );
}));

// -- /close -------------------------------------------------
bot.onText(/\/close (.+)/, async (msg, match) => guard(msg, async () => {
  try {
    const pos = await exec.closePosition(match[1].trim());
    send(msg.chat.id,
      `[ok] *Position Closed*\n${pos.pair} ${pos.direction} #${pos.ticket}\n` +
      `Close: \`${pos.closePrice}\` | P&L: ${parseFloat(pos.pnlPips)>=0?"+":""}${pos.pnlPips} pips`
    );
  } catch (e) { send(msg.chat.id, `[x] ${e.message}`); }
}));

// -- /alerts ------------------------------------------------
bot.onText(/\/alerts\s+(on|off)/i, async (msg, match) => guard(msg, async () => {
  const on = match[1].toLowerCase() === "on";
  if (on && !marketEngine.isConnected()) {
    return send(msg.chat.id,
      `[x] Cannot start alerts -- market data not connected.\nAdd \`TWELVE_DATA_API_KEY\` to Railway Variables first.`
    );
  }
  if (on) {
    alerts.start();
    send(msg.chat.id,
      "[ok] Background alerts STARTED -- will notify when bias + setup confirmed.\n" +
      "Note: Manual scan with /scan is preferred for full analysis.\n" +
      "Interval: every " + (process.env.SCAN_INTERVAL_MINUTES||15) + " mins"
    );
  } else {
    alerts.stop();
    send(msg.chat.id, "[ok] Background alerts STOPPED. Use /scan for manual scanning.");
  }
}));


// -- /scanmode -- set what to scan for
// Usage: /scanmode bias | /scanmode impulse | /scanmode sweep | /scanmode full
// Combined: /scanmode bias+impulse | /scanmode impulse+sweep
bot.onText(/\/scanmode(?:\s+(\S+))?/i, async (msg, match) => guard(msg, async () => {
  const input = (match[1] || "").toLowerCase();
  const modeList =
    "Scan modes:\n" +
    "/scanmode bias      -- bias confirmed (all TFs)\n" +
    "/scanmode bias:htf  -- HTF bias only (1D, 4H)\n" +
    "/scanmode bias:ltf  -- LTF bias only (1H, 15M)\n" +
    "/scanmode impulse   -- bias + impulse from C2 anchor\n" +
    "/scanmode sweep     -- price at OB (A or B setup)\n" +
    "/scanmode pattern:mw     -- M/W patterns on LTF\n" +
    "/scanmode pattern:consol -- consolidation / sideways\n" +
    "/scanmode pattern:all    -- all patterns\n" +
    "/scanmode full      -- full protocol + A/B grade (default)\n\n" +
    "Current: " + scanner.getModeLabel();
  if (!input || !SCAN_MODES[input]) return send(msg.chat.id, modeList);
  scanner.setMode(input);
  send(msg.chat.id, "Scan mode: " + SCAN_MODES[input].label);
}));


// -- /alertstatus -------------------------------------------
bot.onText(/\/alertstatus/, async msg => guard(msg, async () => {
  send(msg.chat.id,
    `? *Alert Monitor*\nStatus: *${alerts.isRunning()?"Running [ok]":"Stopped ?"}*\n` +
    `Market Data: *${marketEngine.isConnected()?"Connected [ok]":"Not connected [x]"}*\n` +
    `Pairs: ${exec.pairs.join(", ")}\nMin Confluence: ${process.env.MIN_CONFLUENCE||65}\n` +
    `Interval: ${process.env.SCAN_INTERVAL_MINUTES||15} mins | Cooldown: 4h per pair`
  );
}));

// -- /autotrade ---------------------------------------------
bot.onText(/\/autotrade\s+(on|off)/i, async (msg, match) => guard(msg, async () => {
  const on = match[1].toLowerCase() === "on";
  exec.setAutoTrade(on);
  send(msg.chat.id, `${on?"[ok]":"?"} *Auto Paper Trade ${on?"ENABLED":"DISABLED"}*`);
}));

// -- /mode -----------------------------------------------------
bot.onText(/\/mode(?:\s+(\S+))?/i, async (msg, match) => guard(msg, async () => {
  const input = (match[1] || "").toUpperCase();
  const valid = { SNIPER:"SNIPER", BALANCED:"BALANCED", AGGRESSIVE:"AGGRESSIVE", S:"SNIPER", B:"BALANCED", A:"AGGRESSIVE" };
  if (!input) {
    const mode = claude.getMode();
    return send(msg.chat.id,
      `[target] *Current Mode: ${mode}*
Min score: *${MODE_SCORES[mode]}/100*

` +
      `*Modes:*
[HIGH] \`/mode sniper\` -- score ? 80 | A+ setups only | low frequency
` +
      `[MED] \`/mode balanced\` -- score ? 65 | moderate frequency ? default
` +
      `[bull] \`/mode aggressive\` -- score ? 55 | higher frequency`
    );
  }
  const mode = valid[input];
  if (!mode) return send(msg.chat.id, `[x] Unknown mode. Use: sniper / balanced / aggressive`);
  claude.setMode(mode);
  const icons = { SNIPER:"[HIGH]", BALANCED:"[MED]", AGGRESSIVE:"[bull]" };
  send(msg.chat.id,
    `${icons[mode]} *Mode set to ${mode}*
Minimum setup score: *${MODE_SCORES[mode]}/100*

` +
    `${mode==="SNIPER"?"Only A+ setups will fire. Expect fewer but higher quality signals.":mode==="AGGRESSIVE"?"More signals will fire. Quality filtering is lower.":"Standard mode -- balanced quality and frequency."}`
  );
}));

// -- /status ------------------------------------------------
bot.onText(/\/status/, async msg => guard(msg, async () => {
  const st = await exec.getStatus();
  send(msg.chat.id,
    `[bull] *XERO EDGE(TM) v4 Status*\n\n` +
    `Session: *${getSessionIST()}*\n` +
    `Entry valid: *${isSessionValid()?"YES [ok]":"NO -- Analysis only [!]"}*\n` +
    `Mode: *${claude.getMode()}* | Min score: *${MODE_SCORES[claude.getMode()]}/100*\n\n` +
    `Rules: *${kb.getRuleCount()}* | Playbooks: *${kb.getPlaybookCount()}* | Visual: *${kb.getVisualCount()}*\n` +
    `Trades logged: *${await journal.count()}*\n` +
    `Market Data: *${marketEngine.isConnected()?"Twelve Data [ok]":"Not connected [x]"}*\n` +
    `Alerts: *${alerts.isRunning()?"Running [ok]":"Off ?"}*\n` +
    `Auto Trade: *${st.autoTrade?"ON [ok]":"OFF ?"}*\n` +
    `Open Positions: *${st.openPositions}*\n\n` +
    `${risk.getSummary()}\n\n` +
    `${!marketEngine.isConnected()?"[!] Add TWELVE\\_DATA\\_API\\_KEY to Railway to enable live data.":""}`
  );
}));

// -- /clear -------------------------------------------------
bot.onText(/\/clear/, msg => guard(msg, () => {
  claude.clearHistory();
  send(msg.chat.id, "? Conversation memory cleared.");
}));

// -- Chart photos -------------------------------------------
bot.on("photo", async msg => {
  if (!isAdmin(msg.from.id)) return;
  const chatId  = msg.chat.id;
  const caption = msg.caption || "";
  const pair    = detectPair(caption);
  const tfMatch = caption.match(/\b(M\d+|H\d+|D\d+|1min|5min|15min|1h|4h|daily|weekly)\b/i);
  const tf      = tfMatch ? tfMatch[0].toUpperCase() : "";
  const isTraining = /train|learn|save|remember|teach/i.test(caption);

  if (isTraining) {
    send(chatId, `? *Training Mode*\n${pair?`Pair: ${pair} `:""}${tf?`TF: ${tf} `:""}[WAIT] Analysing...`);
    try {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const { base64, mimeType } = await vision.downloadTelegramPhoto(fileId, process.env.TELEGRAM_BOT_TOKEN);
      const { parsed } = await vision.analyseForTraining({ base64, mimeType, pair, timeframe:tf, userNote:caption, chatId });
      send(chatId,
        `? *Chart Analysis -- Training*\n\nPatterns: *${(parsed.patterns||[]).join(", ")}*\n\n` +
        `Structure: ${parsed.structure}\nBias: *${parsed.bias}*\n` +
        (parsed.biasDetail ? `Detail: ${parsed.biasDetail}\n` : "") +
        `Key Levels: ${parsed.keyLevels||"--"}\n\n? Lesson:\n_"${parsed.lesson}"_\n\nConfirm to save:`,
        { reply_markup:{ inline_keyboard:[[
          { text:"[ok] Save", callback_data:`vtrain_confirm_${chatId}` },
          { text:"? Correct lesson", callback_data:`vtrain_correct_${chatId}` },
          { text:"[x] Cancel", callback_data:`vtrain_cancel_${chatId}` },
        ]]}}
      );
    } catch (e) { send(chatId, `[x] Analysis failed: ${e.message}`); }
  } else {
    send(chatId, `? *Chart received*\n${pair?`Pair: ${pair} `:""}${tf?`TF: ${tf} `:""}[WAIT] Analysing...`);
    try {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const { base64, mimeType } = await vision.downloadTelegramPhoto(fileId, process.env.TELEGRAM_BOT_TOKEN);
      send(chatId, await vision.analyseChart({ base64, mimeType, pair, timeframe:tf, userNote:caption }));
    } catch (e) { send(chatId, `[x] Analysis failed: ${e.message}`); }
  }
});

// -- /trainchart --------------------------------------------
bot.onText(/\/trainchart/, msg => guard(msg, () => {
  send(msg.chat.id,
    `? *Chart Training Mode*\n\nSend a screenshot with "train" in the caption.\n\n` +
    `*Caption examples:*\n\`XAUUSD H4 train -- bearish bias\`\n\`EURUSD 1H train -- OB at discount\`\n\n` +
    `Bot identifies patterns -> you confirm -> saves to knowledge base.`
  );
}));

// -- /visualkb ----------------------------------------------
bot.onText(/\/visualkb/, async msg => guard(msg, async () => {
  const examples = await kb.loadVisual();
  if (!examples.length) return send(msg.chat.id, `? No visual examples yet.\nSend a chart with "train" in caption to start.`);
  const byPattern = {};
  examples.forEach(v => { if (!byPattern[v.pattern]) byPattern[v.pattern]=[]; byPattern[v.pattern].push(v); });
  let text = `? *Visual KB* (${examples.length} examples)\n`;
  for (const [pat, exs] of Object.entries(byPattern)) {
    text += `\n*${pat}* (${exs.length})\n`;
    exs.slice(-2).forEach(v => { text += `  \`${v.id}\` ${v.description.slice(0,50)}...\n  -> _${v.lesson}_\n`; });
  }
  send(msg.chat.id, text);
}));

// -- CSV upload ---------------------------------------------
bot.on("document", async msg => {
  if (!isAdmin(msg.from.id)) return;
  if (!msg.document?.file_name?.endsWith(".csv")) return;
  send(msg.chat.id, "[chart] Processing CSV...");
  try {
    const file = await bot.getFile(msg.document.file_id);
    const r    = await journal.importCSV(file.file_path, process.env.TELEGRAM_BOT_TOKEN);
    send(msg.chat.id, `[ok] *Imported* ${r.success}/${r.count} | Skipped: ${r.skipped}\n${r.stats}`);
  } catch (e) { send(msg.chat.id, `[x] Import error: ${e.message}`); }
});

// -- Voice messages -> NLP ----------------------------------
bot.on("voice", async msg => {
  if (!isAdmin(msg.from.id)) return;
  send(msg.chat.id, "? Transcribing...");
  try {
    const file = await bot.getFile(msg.voice.file_id);
    const text = await voice.transcribe(file.file_path, process.env.TELEGRAM_BOT_TOKEN);
    send(msg.chat.id, `? _"${text}"_`);
    // Route through NLP -- same as typing it
    await nlp.route(text, msg.chat.id);
  } catch (e) { send(msg.chat.id, `[x] ${e.message}`); }
});

// -- Inline callbacks ---------------------------------------
bot.on("callback_query", async query => {
  if (!isAdmin(query.from.id)) return;
  const chatId = query.message.chat.id;
  const data   = query.data;

  if (data.startsWith("exec_")) {
    const parts   = data.split("_");
    const pair    = parts[1];
    const setupId = parts[2];
    bot.answerCallbackQuery(query.id, { text:"Opening paper trade..." });
    try {
      const r = await exec.executeTrade(pair, setupId);
      send(chatId,
        `[ok] *Paper Trade Opened -- ${pair}*\n\nTicket: #${r.ticket}\nBroker: ${r.broker}\n` +
        `Entry: \`${r.entry}\` | SL: \`${r.sl}\` | TP: \`${r.tp}\`\nLot: ${r.lot}\n\n` +
        `_Monitoring SL/TP every 2 mins. Will alert when hit._`
      );
    } catch (e) { send(chatId, `[x] ${e.message}`); }

  } else if (data.startsWith("analyze_")) {
    bot.answerCallbackQuery(query.id, { text:"Analysing..." });
    send(chatId, await claude.fullAnalysis(data.split("_")[1]));

  } else if (data.startsWith("vtrain_confirm_")) {
    bot.answerCallbackQuery(query.id, { text:"Saving..." });
    const r = await vision.confirmTraining(parseInt(data.split("_")[2]));
    send(chatId, r.success
      ? `[ok] *Saved*\nPatterns: ${r.patterns.join(", ")}\nLesson: _"${r.lesson}"_\nTotal visual examples: *${r.total}*`
      : `[x] ${r.error}`
    );

  } else if (data.startsWith("vtrain_correct_")) {
    bot.answerCallbackQuery(query.id, { text:"Send correction..." });
    send(chatId, "? Send the corrected lesson:");
    const fn = async m => {
      if (!isAdmin(m.from.id)) return;
      bot.removeListener("message", fn);
      const r = await vision.confirmTraining(parseInt(data.split("_")[2]), m.text);
      send(chatId, r.success ? `[ok] Saved with corrected lesson.` : `[x] ${r.error}`);
    };
    bot.on("message", fn);

  } else if (data.startsWith("vtrain_cancel_")) {
    bot.answerCallbackQuery(query.id, { text:"Cancelled." });
    vision.cancelTraining(parseInt(data.split("_")[2]));
    send(chatId, "[x] Training cancelled.");

  } else if (data.startsWith("close_")) {
    const ticket = data.replace("close_","");
    bot.answerCallbackQuery(query.id, { text:"Closing..." });
    try {
      const closed = await exec.closePosition(ticket);
      send(chatId,
        `[ok] *Position Closed*\n\n${closed.pair} ${closed.direction}\n` +
        `Entry: \`${closed.entry}\` -> Close: \`${closed.closePrice}\`\n` +
        `P&L: ${parseFloat(closed.pnlPips)>=0?"+":""}${closed.pnlPips} pips\n\n` +
        `_Use /addtrade to log this to your journal._`
      );
    } catch (e) { send(chatId, `[x] ${e.message}`); }

  } else if (data.startsWith("close_")) {
    const ticket = data.replace("close_","");
    bot.answerCallbackQuery(query.id, { text:"Closing..." });
    try {
      const closed = await exec.closePosition(ticket);
      send(chatId,
        `[ok] *Closed -- ${closed.pair}*\nEntry: \`${closed.entry}\` -> Close: \`${closed.closePrice}\`\n` +
        `P&L: ${parseFloat(closed.pnlPips)>=0?"+":""}${closed.pnlPips} pips\n\n_Say "log trade" to record this._`
      );
    } catch (e) { send(chatId, `[x] ${e.message}`); }

  } else if (data === "skip") {
    bot.answerCallbackQuery(query.id, { text:"Skipped." });
  }
});

// -- Position closed -> alert --------------------------------
exec.on("trade_closed", async pos => {
  const emoji = pos.result === "WIN" ? "[ok]" : pos.result === "LOSS" ? "[x]" : "?";
  send(ADMIN_ID,
    `${emoji} *Paper Position Closed -- ${pos.pair}*\n\n` +
    `Direction: ${pos.direction} | Result: *${pos.result}*\nTicket: #${pos.ticket}\n` +
    `Entry: \`${pos.entry}\` | Close: \`${pos.closePrice||"--"}\`\n\n` +
    `_Use /addtrade to log this to your journal._`
  );
});

// -- Free-form chat -> NLP Router ---------------------------
// Handles ALL natural language -- no /commands needed
// "what's gold at" "go long on euro" "how am I doing" etc.
bot.on("message", async msg => {
  if (!isAdmin(msg.from.id)) return;
  if (msg.text?.startsWith("/")) return;
  if (msg.voice || msg.document || msg.photo) return;
  if (!msg.text || msg.text.trim().length < 2) return;
  try {
    await nlp.route(msg.text, msg.chat.id);
  } catch (e) {
    send(msg.chat.id, `[x] ${e.message}`);
  }
});

// -- Scheduled: Daily briefing 6:30 AM IST (Mon-Fri) -------
schedule.scheduleJob("0 1 * * 1-5", async () => {
  try { bot.sendMessage(ADMIN_ID, await claude.generateBriefing(exec.pairs), { parse_mode:"Markdown" }); }
  catch (e) { console.error("[Briefing]", e.message); }
});

// -- Startup preload ----------------------------------------
(async () => {
  try {
    await kb.loadRules();
    await kb.loadPlaybook();
    await kb.loadVisual();
    await journal.load();
    console.log(`[Startup] Rules:${kb.getRuleCount()} | Playbooks:${kb.getPlaybookCount()} | Visual:${kb.getVisualCount()} | Trades:${await journal.count()}`);
  } catch (e) { console.error("[Startup]", e.message); }

  if (process.env.TWELVE_DATA_API_KEY) {
    console.log("[Startup] Twelve Data API key found -- live market data enabled.");
  } else {
    console.log("[Startup] TWELVE_DATA_API_KEY not set -- add free key from twelvedata.com");
  }
})();

console.log("[MED] XERO EDGE(TM) Pro v4 -- Live.");

// -- Graceful shutdown -- prevents Telegram 409 on Railway --
const shutdown = async signal => {
  console.log(`[Shutdown] ${signal} -- stopping...`);
  alerts.stop();
  exec.stopMonitor();
  try { await bot.stopPolling(); } catch {}
  console.log("[Shutdown] Done.");
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

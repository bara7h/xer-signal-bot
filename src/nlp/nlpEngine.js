// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE v2 — NLP Engine
// Uses Claude API to understand natural language and map it to bot actions.
// Falls back to keyword matching if Claude API unavailable.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");
const logger = require("../utils/logger");
const { DEFAULT_WATCHLIST } = require("../../config/markets");

const CLAUDE_API = "https://api.anthropic.com/v1/messages";
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || "";

// All valid symbols for resolution
const ALL_SYMBOLS = DEFAULT_WATCHLIST.map(i => i.displayName);
const CATEGORIES  = ["majors","minors","commodities","indices","crypto"];

// ─────────────────────────────────────────────────────────────────────────────
// INTENT SCHEMA
// Every message gets parsed into one of these intents:
//
// { intent: "scan",       symbols: ["XAUUSD"], outputMode: "signal"|"analysis" }
// { intent: "scan",       category: "majors",  outputMode: "signal"|"analysis" }
// { intent: "bias_only",  symbols: ["EURUSD","GBPUSD"] }
// { intent: "bias_only",  category: "all" }
// { intent: "set_output", mode: "signal"|"analysis" }
// { intent: "set_mode",   mode: "3step"|"2step" }
// { intent: "watchlist_add",    symbols: ["GBPJPY"] }
// { intent: "watchlist_remove", symbols: ["GBPJPY"] }
// { intent: "watchlist_view" }
// { intent: "active_signals" }
// { intent: "status" }
// { intent: "help" }
// { intent: "greeting" }
// { intent: "unknown",    raw: "..." }
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the command parser for XERO EDGE™ — a professional Forex/crypto trading signal bot.

Your ONLY job is to parse user messages into a JSON intent object. No conversation, no explanations, just valid JSON.

Available intents and their fields:

scan — user wants to scan instruments for trade signals
  fields: { intent:"scan", symbols?:string[], category?:string, outputMode?:"signal"|"analysis" }

bias_only — user wants to see bias state across timeframes only (no entry/zones)
  fields: { intent:"bias_only", symbols?:string[], category?:string }

set_output — user wants to change output mode
  fields: { intent:"set_output", mode:"signal"|"analysis" }

set_mode — user wants to change fractal mode
  fields: { intent:"set_mode", mode:"2step"|"3step" }

watchlist_add — add symbols to watchlist
  fields: { intent:"watchlist_add", symbols:string[] }

watchlist_remove — remove symbols from watchlist
  fields: { intent:"watchlist_remove", symbols:string[] }

watchlist_view — show current watchlist
  fields: { intent:"watchlist_view" }

active_signals — show all currently active signals
  fields: { intent:"active_signals" }

status — show bot status
  fields: { intent:"status" }

help — user needs help/commands
  fields: { intent:"help" }

greeting — hello/hi/hey with no other request
  fields: { intent:"greeting" }

unknown — cannot determine intent
  fields: { intent:"unknown", raw:string }

RULES:
- symbols must be from: EURUSD GBPUSD USDJPY AUDUSD USDCAD USDCHF NZDUSD GBPJPY EURGBP EURJPY GBPAUD AUDJPY EURAUD XAUUSD XAGUSD WTIUSD SP500 NAS100 US30 DAX40 BTCUSD ETHUSD
- category must be one of: majors minors commodities indices crypto all
- If user says "gold" → XAUUSD, "silver" → XAGUSD, "cable" → GBPUSD, "fiber" → EURUSD, "oil" → WTIUSD, "bitcoin" → BTCUSD, "ethereum"/"eth" → ETHUSD, "pound yen" → GBPJPY, "euro dollar" → EURUSD, "dollar yen" → USDJPY
- outputMode: if user says "with analysis", "explain", "step by step", "breakdown" → "analysis". Default → "signal"
- If user says "bias" or "what's the bias" or "bias scan" or "bias only" → bias_only intent
- If user says "2 step" or "fast mode" → set_mode 2step. "3 step" or "full mode" → set_mode 3step
- If user mentions multiple symbols, include all in symbols array
- Return ONLY the JSON object. No markdown, no explanation, no preamble.`;

// ─────────────────────────────────────────────────────────────────────────────
// Main parse function
// ─────────────────────────────────────────────────────────────────────────────

async function parseIntent(text) {
  // Try Claude API first
  if (CLAUDE_KEY) {
    try {
      const result = await callClaude(text);
      if (result) {
        logger.debug(`NLP (Claude): "${text}" → ${JSON.stringify(result)}`);
        return result;
      }
    } catch (e) {
      logger.warn(`NLP Claude API failed: ${e.message} — falling back to keyword match`);
    }
  }

  // Fallback: keyword matching
  const result = keywordMatch(text);
  logger.debug(`NLP (keyword): "${text}" → ${JSON.stringify(result)}`);
  return result;
}

async function callClaude(text) {
  const res = await axios.post(CLAUDE_API, {
    model: "claude-sonnet-4-20250514",
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: text }],
  }, {
    headers: {
      "x-api-key": CLAUDE_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    timeout: 8000,
  });

  const raw = res.data.content[0]?.text || "";
  // Strip any accidental markdown fences
  const clean = raw.replace(/```json?|```/g, "").trim();
  return JSON.parse(clean);
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyword fallback
// ─────────────────────────────────────────────────────────────────────────────

function keywordMatch(text) {
  const t = text.toLowerCase().trim();

  // Greetings
  if (/^(hi|hey|hello|yo|sup|what'?s up|gm|good morning|good evening)[\s!.]*$/.test(t)) {
    return { intent: "greeting" };
  }

  // Help
  if (/\b(help|commands?|what can you do|how do i|tutorial)\b/.test(t)) {
    return { intent: "help" };
  }

  // Status
  if (/\b(status|uptime|alive|running|bot status)\b/.test(t)) {
    return { intent: "status" };
  }

  // Active signals
  if (/\b(active signals?|show signals?|current signals?|open signals?)\b/.test(t)) {
    return { intent: "active_signals" };
  }

  // Watchlist view
  if (/\b(watchlist|my list|what are you watching|tracked instruments?)\b/.test(t) && !/add|remove|delete/.test(t)) {
    return { intent: "watchlist_view" };
  }

  // Output mode
  if (/\b(output|mode|set)\b.*(signal only|just signal|clean|compact)/.test(t)) return { intent:"set_output", mode:"signal" };
  if (/\b(output|mode|set)\b.*(analysis|analyse|analyze|explain|full|breakdown)/.test(t)) return { intent:"set_output", mode:"analysis" };

  // Fractal mode
  if (/2.?step|fast mode|quick mode/.test(t)) return { intent:"set_mode", mode:"2step" };
  if (/3.?step|full mode|standard mode/.test(t)) return { intent:"set_mode", mode:"3step" };

  // Resolve symbols from text
  const symbols = resolveSymbols(t);
  const category = resolveCategory(t);
  const outputMode = /\b(analysis|analyse|analyze|explain|step.?by.?step|breakdown|why|how)\b/.test(t) ? "analysis" : "signal";

  // Bias only
  if (/\bbias\b/.test(t)) {
    if (symbols.length) return { intent:"bias_only", symbols };
    if (category) return { intent:"bias_only", category };
    return { intent:"bias_only", category:"all" };
  }

  // Watchlist add/remove
  if (/\b(add|track|watch|monitor)\b/.test(t) && symbols.length) {
    return { intent:"watchlist_add", symbols };
  }
  if (/\b(remove|delete|stop watching|untrack)\b/.test(t) && symbols.length) {
    return { intent:"watchlist_remove", symbols };
  }

  // Scan
  if (symbols.length || category ||
      /\b(scan|check|analyse|analyze|look at|signal|setup|trade|entry|what'?s the|find me)\b/.test(t)) {
    const intent = { intent:"scan", outputMode };
    if (symbols.length) intent.symbols = symbols;
    else if (category) intent.category = category;
    else intent.category = "all";
    return intent;
  }

  return { intent:"unknown", raw: text };
}

// ─────────────────────────────────────────────────────────────────────────────
// Symbol and category resolution
// ─────────────────────────────────────────────────────────────────────────────

const ALIASES = {
  "gold":"XAUUSD","xauusd":"XAUUSD","xau":"XAUUSD",
  "silver":"XAGUSD","xagusd":"XAGUSD","xag":"XAGUSD",
  "oil":"WTIUSD","crude":"WTIUSD","crude oil":"WTIUSD","wti":"WTIUSD",
  "bitcoin":"BTCUSD","btc":"BTCUSD","btcusd":"BTCUSD",
  "ethereum":"ETHUSD","eth":"ETHUSD","ethusd":"ETHUSD",
  "cable":"GBPUSD","gbpusd":"GBPUSD","gbp/usd":"GBPUSD",
  "fiber":"EURUSD","eurusd":"EURUSD","eur/usd":"EURUSD","euro dollar":"EURUSD","euro":"EURUSD",
  "dollar yen":"USDJPY","usdjpy":"USDJPY","usd/jpy":"USDJPY",
  "pound yen":"GBPJPY","gbpjpy":"GBPJPY","gbp/jpy":"GBPJPY",
  "aussie":"AUDUSD","audusd":"AUDUSD","aud/usd":"AUDUSD",
  "kiwi":"NZDUSD","nzdusd":"NZDUSD","nzd/usd":"NZDUSD",
  "loonie":"USDCAD","usdcad":"USDCAD","usd/cad":"USDCAD",
  "swissy":"USDCHF","usdchf":"USDCHF","usd/chf":"USDCHF",
  "nasdaq":"NAS100","nas":"NAS100","nas100":"NAS100","ndx":"NAS100",
  "sp500":"SP500","s&p":"SP500","s&p 500":"SP500","spx":"SP500",
  "dow":"US30","us30":"US30","dow jones":"US30",
  "dax":"DAX40","dax40":"DAX40","ger40":"DAX40","german index":"DAX40",
  "eurgbp":"EURGBP","eur/gbp":"EURGBP",
  "eurjpy":"EURJPY","eur/jpy":"EURJPY",
  "gbpaud":"GBPAUD","gbp/aud":"GBPAUD",
  "audjpy":"AUDJPY","aud/jpy":"AUDJPY",
  "euraud":"EURAUD","eur/aud":"EURAUD",
  "xagusd":"XAGUSD","xag/usd":"XAGUSD",
};

function resolveSymbols(text) {
  const found = new Set();

  // Check aliases (longest match first to avoid partial matches)
  const sortedAliases = Object.keys(ALIASES).sort((a,b) => b.length - a.length);
  for (const alias of sortedAliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const aliasRx = new RegExp(`(?<![a-z])${escaped}(?![a-z])`);
    if (aliasRx.test(text)) {
      found.add(ALIASES[alias]);
    }
  }

  // Check direct symbol names
  for (const sym of ALL_SYMBOLS) {
    if (text.includes(sym.toLowerCase())) found.add(sym);
  }

  return Array.from(found);
}

function resolveCategory(text) {
  for (const cat of CATEGORIES) {
    if (text.includes(cat)) return cat;
  }
  if (/\b(all|everything|full list|complete|all pairs)\b/.test(text)) return "all";
  return null;
}

module.exports = { parseIntent, resolveSymbols, resolveCategory };

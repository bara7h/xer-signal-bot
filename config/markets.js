// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE v2 — Market & Timeframe Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_WATCHLIST = [
  { symbol: "EUR/USD", displayName: "EURUSD", category: "majors" },
  { symbol: "GBP/USD", displayName: "GBPUSD", category: "majors" },
  { symbol: "USD/JPY", displayName: "USDJPY", category: "majors" },
  { symbol: "AUD/USD", displayName: "AUDUSD", category: "majors" },
  { symbol: "USD/CAD", displayName: "USDCAD", category: "majors" },
  { symbol: "USD/CHF", displayName: "USDCHF", category: "majors" },
  { symbol: "NZD/USD", displayName: "NZDUSD", category: "majors" },
  { symbol: "GBP/JPY", displayName: "GBPJPY", category: "minors" },
  { symbol: "EUR/GBP", displayName: "EURGBP", category: "minors" },
  { symbol: "EUR/JPY", displayName: "EURJPY", category: "minors" },
  { symbol: "GBP/AUD", displayName: "GBPAUD", category: "minors" },
  { symbol: "AUD/JPY", displayName: "AUDJPY", category: "minors" },
  { symbol: "EUR/AUD", displayName: "EURAUD", category: "minors" },
  { symbol: "XAU/USD", displayName: "XAUUSD", category: "commodities" },
  { symbol: "XAG/USD", displayName: "XAGUSD", category: "commodities" },
  { symbol: "USOIL",   displayName: "WTIUSD", category: "commodities" },
  { symbol: "SPX",     displayName: "SP500",  category: "indices" },
  { symbol: "NAS100",  displayName: "NAS100", category: "indices" },
  { symbol: "US30",    displayName: "US30",   category: "indices" },
  { symbol: "GER40",   displayName: "DAX40",  category: "indices" },
  { symbol: "BTC/USD", displayName: "BTCUSD", category: "crypto" },
  { symbol: "ETH/USD", displayName: "ETHUSD", category: "crypto" },
];

// All timeframes the bot can fetch
const TIMEFRAMES = {
  W:   "1week",
  D:   "1day",
  H4:  "4h",
  H1:  "1h",
  M15: "15min",
  M5:  "5min",
  M1:  "1min",
};

// HTF timeframes scanned for bias in Step 1
const HTF_TIMEFRAMES = ["1week", "1day", "4h", "1h"];

// Bias-only mode — all timeframes
const BIAS_ONLY_TIMEFRAMES = ["1week", "1day", "4h", "1h", "15min", "5min"];

// Fractal stacks per HTF bias
// mtfOptions: checked in order, first one with same-direction bias wins (4H > 1H priority)
const FRACTAL_STACKS = {
  "1week": { htf: "1week", mtfOptions: ["1day", "4h"],   ltf: "1h"   },
  "1day":  { htf: "1day",  mtfOptions: ["4h",   "1h"],   ltf: "15min" },
  "4h":    { htf: "4h",    mtfOptions: ["1h",   "15min"],ltf: "5min"  },
  "1h":    { htf: "1h",    mtfOptions: ["15min","5min"],  ltf: "5min"  }, // falls to 5min if 1min unavailable
};

// Fibonacci zone levels
const FIBO = {
  ZONE1_LOW:  0.618,
  ZONE1_HIGH: 0.768,
};

// Risk:Reward
const RR = { TP1: 1.0, TP2: 2.0 };

// Candle count to fetch per timeframe
const CANDLE_COUNT = 10;

// SL buffers per instrument type
const SL_BUFFERS = {
  XAU: 1.00, XAG: 0.10, BTC: 50.0, ETH: 5.0,
  JPY: 0.02, SPX: 2.0,  NAS: 5.0,  US30: 5.0,
  DAX: 5.0,  OIL: 0.10, DEFAULT: 0.0005,
};

function getSlBuffer(symbol) {
  for (const [k, v] of Object.entries(SL_BUFFERS)) {
    if (k !== "DEFAULT" && symbol.toUpperCase().includes(k)) return v;
  }
  return SL_BUFFERS.DEFAULT;
}

function getTfLabel(tf) {
  const map = { "1week":"1W","1day":"1D","4h":"4H","1h":"1H","15min":"15M","5min":"5M","1min":"1M" };
  return map[tf] || tf.toUpperCase();
}

module.exports = {
  DEFAULT_WATCHLIST, TIMEFRAMES, HTF_TIMEFRAMES,
  BIAS_ONLY_TIMEFRAMES, FRACTAL_STACKS, FIBO, RR,
  CANDLE_COUNT, getSlBuffer, getTfLabel,
};

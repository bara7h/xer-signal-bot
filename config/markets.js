// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE v2 — Market Configuration
// Default watchlist uses ONLY instruments confirmed on Twelve Data FREE tier
// ─────────────────────────────────────────────────────────────────────────────

// Instruments confirmed working on Twelve Data free tier
// Indices and Oil removed — they require paid tier or have different symbol formats
const DEFAULT_WATCHLIST = [
  // Forex Majors
  { symbol:"EUR/USD", displayName:"EURUSD", category:"majors" },
  { symbol:"GBP/USD", displayName:"GBPUSD", category:"majors" },
  { symbol:"USD/JPY", displayName:"USDJPY", category:"majors" },
  { symbol:"AUD/USD", displayName:"AUDUSD", category:"majors" },
  { symbol:"USD/CAD", displayName:"USDCAD", category:"majors" },
  { symbol:"USD/CHF", displayName:"USDCHF", category:"majors" },
  { symbol:"NZD/USD", displayName:"NZDUSD", category:"majors" },
  // Forex Minors
  { symbol:"GBP/JPY", displayName:"GBPJPY", category:"minors" },
  { symbol:"EUR/GBP", displayName:"EURGBP", category:"minors" },
  { symbol:"EUR/JPY", displayName:"EURJPY", category:"minors" },
  { symbol:"GBP/AUD", displayName:"GBPAUD", category:"minors" },
  { symbol:"AUD/JPY", displayName:"AUDJPY", category:"minors" },
  { symbol:"EUR/AUD", displayName:"EURAUD", category:"minors" },
  // Commodities (confirmed free tier)
  { symbol:"XAU/USD", displayName:"XAUUSD", category:"commodities" },
  { symbol:"XAG/USD", displayName:"XAGUSD", category:"commodities" },
  // Crypto (confirmed free tier)
  { symbol:"BTC/USD", displayName:"BTCUSD", category:"crypto" },
  { symbol:"ETH/USD", displayName:"ETHUSD", category:"crypto" },
];

const TIMEFRAMES = {
  W:"1week", D:"1day", H4:"4h", H1:"1h", M15:"15min", M5:"5min", M1:"1min",
};

const HTF_TIMEFRAMES    = ["1day","4h","1h"];   // removed 1week — inconsistent on free tier
const BIAS_ONLY_TIMEFRAMES = ["1day","4h","1h","15min","5min"];

// Fractal stacks — adjusted without 1week
const FRACTAL_STACKS = {
  "1day": { htf:"1day",  mtfOptions:["4h","1h"],    ltf:"15min" },
  "4h":   { htf:"4h",   mtfOptions:["1h","15min"],  ltf:"5min"  },
  "1h":   { htf:"1h",   mtfOptions:["15min","5min"],ltf:"5min"  },
};

const FIBO = { ZONE1_LOW:0.618, ZONE1_HIGH:0.768 };
const RR   = { TP1:1.0, TP2:2.0 };
const CANDLE_COUNT = 10;

const SL_BUFFERS = {
  XAU:0.50, XAG:0.05, BTC:25.0, ETH:2.0,
  JPY:0.015, DEFAULT:0.0003,
};

function getSlBuffer(symbol) {
  for (const [k,v] of Object.entries(SL_BUFFERS)) {
    if (k !== "DEFAULT" && symbol.toUpperCase().includes(k)) return v;
  }
  return SL_BUFFERS.DEFAULT;
}

function getTfLabel(tf) {
  const m = { "1week":"1W","1day":"1D","4h":"4H","1h":"1H","15min":"15M","5min":"5M","1min":"1M" };
  return m[tf] || tf.toUpperCase();
}

module.exports = {
  DEFAULT_WATCHLIST, TIMEFRAMES, HTF_TIMEFRAMES,
  BIAS_ONLY_TIMEFRAMES, FRACTAL_STACKS, FIBO, RR,
  CANDLE_COUNT, getSlBuffer, getTfLabel,
};

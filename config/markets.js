// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE — Market & Timeframe Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DEFAULT WATCHLIST
 * Symbol format depends on provider:
 * - Twelve Data: "XAU/USD", "EUR/USD", "BTC/USD"
 * - Alpha Vantage: "XAUUSD", "EURUSD"
 */
const DEFAULT_WATCHLIST = [
  // Forex Majors
  { symbol: "EUR/USD", displayName: "EURUSD", category: "Forex Major" },
  { symbol: "GBP/USD", displayName: "GBPUSD", category: "Forex Major" },
  { symbol: "USD/JPY", displayName: "USDJPY", category: "Forex Major" },
  { symbol: "AUD/USD", displayName: "AUDUSD", category: "Forex Major" },
  { symbol: "USD/CAD", displayName: "USDCAD", category: "Forex Major" },
  { symbol: "USD/CHF", displayName: "USDCHF", category: "Forex Major" },
  { symbol: "NZD/USD", displayName: "NZDUSD", category: "Forex Major" },

  // Forex Minors
  { symbol: "GBP/JPY", displayName: "GBPJPY", category: "Forex Minor" },
  { symbol: "EUR/GBP", displayName: "EURGBP", category: "Forex Minor" },
  { symbol: "EUR/JPY", displayName: "EURJPY", category: "Forex Minor" },
  { symbol: "GBP/AUD", displayName: "GBPAUD", category: "Forex Minor" },
  { symbol: "AUD/JPY", displayName: "AUDJPY", category: "Forex Minor" },

  // Commodities
  { symbol: "XAU/USD", displayName: "XAUUSD", category: "Commodity" },
  { symbol: "XAG/USD", displayName: "XAGUSD", category: "Commodity" },
  { symbol: "WTI/USD", displayName: "WTIUSD", category: "Commodity" },

  // Indices
  { symbol: "SPX",    displayName: "SP500",  category: "Index" },
  { symbol: "NAS100", displayName: "NAS100", category: "Index" },
  { symbol: "US30",   displayName: "US30",   category: "Index" },
  { symbol: "GER40",  displayName: "DAX40",  category: "Index" },

  // Crypto
  { symbol: "BTC/USD", displayName: "BTCUSD", category: "Crypto" },
  { symbol: "ETH/USD", displayName: "ETHUSD", category: "Crypto" },
];

/**
 * TIMEFRAME CONFIGURATIONS FOR EACH FRACTAL MODE
 *
 * 3-Step Mode: HTF → MTF → LTF
 * 2-Step Mode: HTF → LTF (skip MTF)
 *
 * Each entry defines a "fractal stack" — the system checks alignment top-down.
 */
const FRACTAL_STACKS = {
  "3step": [
    // Stack 1: Daily → 4H → 1H (Swing trades)
    {
      id: "D_4H_1H",
      label: "Daily → 4H → 1H",
      htf: "1day",
      mtf: "4h",
      ltf: "1h",
    },
    // Stack 2: 4H → 1H → 15M (Intraday)
    {
      id: "4H_1H_15M",
      label: "4H → 1H → 15M",
      htf: "4h",
      mtf: "1h",
      ltf: "15min",
    },
    // Stack 3: 1H → 15M → 5M (Scalp precision)
    {
      id: "1H_15M_5M",
      label: "1H → 15M → 5M",
      htf: "1h",
      mtf: "15min",
      ltf: "5min",
    },
  ],

  "2step": [
    // Stack 1: Daily → 1H (Fast swing)
    {
      id: "D_1H",
      label: "Daily → 1H",
      htf: "1day",
      ltf: "1h",
    },
    // Stack 2: 4H → 15M (Fast intraday)
    {
      id: "4H_15M",
      label: "4H → 15M",
      htf: "4h",
      ltf: "15min",
    },
    // Stack 3: 1H → 5M (Fast scalp)
    {
      id: "1H_5M",
      label: "1H → 5M",
      htf: "1h",
      ltf: "5min",
    },
  ],
};

/**
 * FIBONACCI ZONE LEVELS (from C2 range)
 */
const FIBO_ZONES = {
  ZONE1_LOW:  0.618,
  ZONE1_HIGH: 0.768,
  ZONE2_LEVEL: 0.768, // Zone 2 extends from here to C2 extreme
};

/**
 * RISK:REWARD TARGETS
 */
const RR_TARGETS = {
  TP1: 1.0, // 1:1 RR — partial close
  TP2: 2.0, // 2:1 RR — secure trade
  // Remaining position = momentum based
};

/**
 * SCAN INTERVAL PER TIMEFRAME (ms) — how often to check each TF
 * Align roughly to candle close timing
 */
const SCAN_INTERVALS = {
  "5min":  5  * 60 * 1000,
  "15min": 15 * 60 * 1000,
  "1h":    60 * 60 * 1000,
  "4h":    4  * 60 * 60 * 1000,
  "1day":  24 * 60 * 60 * 1000,
};

module.exports = {
  DEFAULT_WATCHLIST,
  FRACTAL_STACKS,
  FIBO_ZONES,
  RR_TARGETS,
  SCAN_INTERVALS,
};

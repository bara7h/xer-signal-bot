// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE — Logger
// ─────────────────────────────────────────────────────────────────────────────

const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[LOG_LEVEL] ?? 1;

function timestamp() {
  return new Date().toISOString();
}

function log(level, ...args) {
  if (LEVELS[level] >= currentLevel) {
    const prefix = `[${timestamp()}] [${level.toUpperCase()}]`;
    console[level === "debug" ? "log" : level](prefix, ...args);
  }
}

module.exports = {
  debug: (...args) => log("debug", ...args),
  info:  (...args) => log("info",  ...args),
  warn:  (...args) => log("warn",  ...args),
  error: (...args) => log("error", ...args),
};

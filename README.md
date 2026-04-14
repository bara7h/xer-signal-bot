# 🔷 XERO EDGE™ Signal Bot
## Fractal Liquidity Model — Telegram Signal Engine
**XERO TRADERS HUB | Built by BARA7H**

---

## 🏗️ Architecture Overview

```
xero-signal-bot/
├── config/
│   └── markets.js          ← Watchlist, fractal stacks, Fibo zones, RR config
├── src/
│   ├── index.js            ← Entry point — boots all systems
│   ├── engine/
│   │   ├── biasEngine.js   ← C1/C2 bias detection, zones, invalidation, SL/TP
│   │   └── fractalEngine.js← 2-Step & 3-Step fractal orchestration
│   ├── scanner/
│   │   ├── scanner.js      ← Multi-instrument scan loop, cooldowns, lifecycle
│   │   └── dataProvider.js ← Twelve Data API / Mock data provider
│   ├── telegram/
│   │   └── bot.js          ← Telegram commands, signal formatter, delivery
│   └── utils/
│       └── logger.js       ← Timestamped logging
├── .env.example            ← Config template
└── package.json
```

---

## ⚡ Quick Start

### 1. Clone / Extract
```bash
cd xero-signal-bot
npm install
cp .env.example .env
```

### 2. Configure `.env`
```env
TELEGRAM_BOT_TOKEN=your_bot_token_from_BotFather
ADMIN_CHAT_ID=716635266
DATA_PROVIDER=twelve_data        # or "mock" for testing
TWELVE_DATA_API_KEY=your_key_here
DEFAULT_MODE=3step
SCAN_INTERVAL_SECONDS=60
```

### 3. Test with Mock Data (no API key needed)
```bash
DATA_PROVIDER=mock node src/index.js
```

### 4. Run Live
```bash
node src/index.js
# or with nodemon for dev:
npm run dev
```

---

## 🤖 Telegram Bot Setup

1. Message [@BotFather](https://t.me/BotFather) → `/newbot`
2. Copy the token → paste into `.env` as `TELEGRAM_BOT_TOKEN`
3. Your admin Chat ID is already set: `716635266`
4. Start the bot, then message it `/start`

### Bot Commands
| Command | Description |
|---------|-------------|
| `/start` | Welcome message & status |
| `/help` | All commands |
| `/mode 3step` | Switch to 3-Step Fractal (HTF→MTF→LTF) |
| `/mode 2step` | Switch to 2-Step Fractal (HTF→LTF) |
| `/mode` | Show current mode |
| `/scan` | Trigger full watchlist scan now |
| `/scan XAUUSD` | Scan specific instrument |
| `/signals` | View all active signals |
| `/watchlist` | List tracked instruments |
| `/add GBPJPY` | Add to watchlist |
| `/remove GBPJPY` | Remove from watchlist |
| `/subscribe` | Subscribe chat to live signals |
| `/stop` | Unsubscribe from signals |
| `/status` | Bot stats & uptime |

---

## 📡 Data Provider — Twelve Data

**Free tier:** 800 requests/day, 8 requests/minute  
**Signup:** https://twelvedata.com/register

**Supported timeframes:** `5min`, `15min`, `1h`, `4h`, `1day`

**Supported symbols (examples):**
- Forex: `EUR/USD`, `XAU/USD`, `GBP/JPY`
- Indices: `SPX`, `NAS100`, `US30`, `GER40`
- Crypto: `BTC/USD`, `ETH/USD`

> **Note:** Free tier may not support all symbols. Upgrade to Basic ($8/mo) for full coverage.

### Rate Limit Management
The scanner batches API calls (max 5 concurrent) with 500ms between batches. 
With 21 instruments × 3 stacks × 3 TFs = 189 calls per cycle.  
**Recommended:** Set `SCAN_INTERVAL_SECONDS=300` (5 min) on free tier.

---

## 🔷 Strategy Implementation

### Bias Detection (biasEngine.js)

**BULLISH** — all 3 must be true:
```
C2.low  < C1.low
C2.high < C1.high
C2.close < C1.high
```

**BEARISH** — all 3 must be true:
```
C2.high > C1.high
C2.low  > C1.low
C2.close > C1.low
```

**Invalidation:**
- Bullish: any subsequent candle closes above C2.high → reset
- Bearish: any subsequent candle closes below C2.low → reset

### Zone Calculation
Fibonacci applied to C2 range (C2.high - C2.low):

| | Bullish | Bearish |
|--|---------|---------|
| Zone 1 | 0.618–0.768 from C2.low | 0.618–0.768 from C2.high |
| Zone 2 | C2.low to 0.618 | 0.768 to C2.high |

### Fractal Stacks

**3-Step Mode:**
- Daily → 4H → 1H (swing)
- 4H → 1H → 15M (intraday)
- 1H → 15M → 5M (scalp)

**2-Step Mode:**
- Daily → 1H (fast swing)
- 4H → 15M (fast intraday)
- 1H → 5M (fast scalp)

### Stop Loss
- 3-Step: SL beyond **MTF zone** extreme
- 2-Step: SL beyond **HTF zone** extreme
- Instrument-specific buffer applied (e.g., $1 for Gold, 0.5 pip for Forex)

### Targets
- TP1 = 1:1 RR → partial close
- TP2 = 2:1 RR → secure trade
- Remainder → momentum-based

---

## 🚀 Deploy to Railway

1. Push to GitHub repo
2. Connect Railway → New Project → Deploy from GitHub
3. Add environment variables in Railway dashboard
4. Set start command: `node src/index.js`
5. Deploy ✅

**Railway variables to add:**
```
TELEGRAM_BOT_TOKEN=...
ADMIN_CHAT_ID=716635266
DATA_PROVIDER=twelve_data
TWELVE_DATA_API_KEY=...
DEFAULT_MODE=3step
SCAN_INTERVAL_SECONDS=300
TZ=Asia/Kolkata
```

---

## 📊 Signal Output Format

```
🔷 XERO EDGE™ SIGNAL
━━━━━━━━━━━━━━━━━━━━━━

🎯 Pair: XAUUSD
📐 Mode: 3-Step
🔴 Bias: BEARISH
⏱ Timeframes: 1DAY → 4H → 1H

━━━━━━━━━━━━━━━━━━━━━━

📍 Entry:  2018.45000
🛑 Stop Loss: 2025.30000
🎯 TP1 (1RR): 2011.60000
🚀 TP2 (2RR): 2004.75000

━━━━━━━━━━━━━━━━━━━━━━

📦 Zone: Zone1
🟢 Status: ACTIVE
🕐 Time: Mon, 14 Apr 2026 10:30:00 UTC

━━━━━━━━━━━━━━━━━━━━━━
Risk only what you can afford to lose.
XERO TRADERS HUB — Trade With Edge™
```

---

## 🔧 Customization

### Add/Remove Instruments
Edit `config/markets.js` → `DEFAULT_WATCHLIST` array.

### Change Fractal Stacks
Edit `config/markets.js` → `FRACTAL_STACKS` object.

### Adjust Fibo Levels
Edit `config/markets.js` → `FIBO_ZONES`.

### Custom Data Provider
Implement `fetchCandles(symbol, interval, count)` and `fetchCurrentPrice(symbol)` in `src/scanner/dataProvider.js`.

---

## ⚠️ Disclaimer

This bot is an educational and analytical tool built for XERO TRADERS HUB students and members. It does not constitute financial advice. Always apply your own judgment and risk management. Past signals do not guarantee future results.

**XERO TRADERS HUB | BARA7H | Pondicherry, India**

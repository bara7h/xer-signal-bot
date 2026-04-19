// ============================================================
// XERO EDGE(TM) v4 -- Knowledge Base
// Rules, playbooks, and visual chart training examples
// ============================================================
"use strict";
const sheets = require("./sheets");

const CATEGORIES = {
  HTF_BIAS:   "HTF Bias",
  ENTRY:      "Entry Triggers",
  RISK:       "Risk Management",
  PAIR:       "Pair-Specific",
  SESSION:    "Session Rules",
  AVOID:      "Avoid Conditions",
  PSYCHOLOGY: "Psychology",
};

// -- XERO EDGE(TM) 2-Candle Bias Rules (hardcoded -- always in prompt) --
const BIAS_RULES = `
#==========================================================#
|     XERO EDGE(TM) -- INSTITUTIONAL STRATEGY PROTOCOL        |
|     Precision Liquidity Execution Engine v4             |
#==========================================================#

CORE PRINCIPLE:
Market moves are driven by liquidity. Your job is to:
1. Identify where liquidity has been taken
2. Predict where price will deliver next
3. Execute ONLY when sweep + displacement align

===========================================================
SECTION 1 -- CANDLE SELECTION (ABSOLUTE)
===========================================================
C1 = second-to-last CLOSED candle
C2 = last CLOSED candle
C3 = currently RUNNING candle -- NEVER used for bias
Bias is calculated on C1 and C2 ONLY. C3 is always ignored.
WICK INVALIDATION (ABSOLUTE): A WICK through the C2 invalidation level CANCELS the bias immediately.
Do not wait for a close. If C3 running candle wicks above C2 high (bullish bias) or below C2 low (bearish bias) -- bias is cancelled. Reset and find new C1/C2.

===========================================================
SECTION 2 -- TIMEFRAME ENGINE (DYNAMIC FRACTAL)
===========================================================
| Bias TF | Impulse TF | Entry TF |
|---------|------------|----------|
| 1D      | 1H         | 15M      |
| 4H      | 15M        | 5M       |
| 1H      | 15M        | 5M       |
| 15M     | 5M         | 1M       |

Rules:
- Identify most recent valid impulse on the Impulse TF
- Bias is confirmed on Bias TF, entry executed on Entry TF

===========================================================
SECTION 3 -- BIAS ENGINE (2-CANDLE LOGIC)
===========================================================
BULLISH BIAS -- all three conditions must be met on C1/C2:
  [!] C2 low < C1 low       (liquidity swept below C1)
  [!] C2 high < C1 high     (C1 high unbreached)
  [!] C2 close < C1 high    (closes inside or below C1 range)
  = BULLISH BIAS CONFIRMED
  Invalidation: CLOSE above C2 high -> reset, find new C1

BEARISH BIAS -- exact inverse:
  [!] C2 high > C1 high     (liquidity swept above C1)
  [!] C2 low > C1 low       (C1 low unbreached)
  [!] C2 close > C1 low     (closes inside or above C1 range)
  = BEARISH BIAS CONFIRMED
  Invalidation: CLOSE below C2 low -> reset, find new C1

===========================================================
SECTION 4 -- IMPULSE DETECTION
===========================================================
After bias is confirmed, identify the impulse wave:
  -> Start from the C2 low (bullish) or C2 high (bearish) on the Impulse TF
  -> A valid impulse is a meaningful move away from the C2 anchor
  -> It must leave behind: a Fair Value Gap (FVG) AND/OR Order Block (OB)

REJECT impulse if:
  ? Choppy price action (overlapping candles, no clear directional move)
  ? No FVG or OB left behind
  ? Price has not moved from the C2 anchor at all

===========================================================
SECTION 5 -- PREMIUM / DISCOUNT ZONES
===========================================================
Measured from the impulse move (swing low to swing high):
  Discount zone = 0-50% of impulse = BUY zone (bullish bias)
  Premium zone  = 50-100% of impulse = SELL zone (bearish bias)
  50% level     = Equilibrium (EQ)

OB must be located INSIDE the correct zone.
OB in wrong zone = REJECT the setup.

===========================================================
SECTION 6 -- ENTRY ZONE (OB on Impulse TF IS the entry)
===========================================================
The OB identified on the Impulse TF is the entry zone -- not an arbitrary zone.
Flow:
  1. Bias confirmed on Bias TF (2-candle C1/C2)
  2. Impulse wave found on Impulse TF from C2 anchor
  3. OB identified within that impulse wave on Impulse TF
  4. That OB is the entry zone -- wait for price to return to it
  5. On the Entry TF: confirm sweep (2-candle or W/M) inside the OB
  6. Execute entry

Priority:
  OB + FVG overlap at the same zone -> HIGHEST probability
  OB only -> strong entry
  FVG only -> only if impulse was very strong

OB definitions:
  Bullish OB = last bearish candle before the strong bullish impulse wave
  Bearish OB = last bullish candle before the strong bearish impulse wave

FVG definitions:
  Bullish FVG = gap between candle 1 high and candle 3 low (no overlap)
  Bearish FVG = gap between candle 1 low and candle 3 high (no overlap)

===========================================================
SECTION 7 -- LIQUIDITY SWEEP ENGINE
===========================================================
Sweep must occur AT the OB/FVG on the Entry TF.

Valid sweep types:
  TYPE 1 -- Two-Candle Sweep:
    Liquidity is taken + immediate rejection follows
    Next candle must show strong opposite displacement

  TYPE 2 -- W Pattern (Bullish):
    U2 breaks below U1 low (sweep of equal lows)
    Entry condition: price reclaims above U1 low
    Followed by bullish displacement candle
    
  TYPE 3 -- M Pattern (Bearish):
    Mirror of W pattern (equal highs swept)
    Entry: price reclaims below U1 high
    Followed by bearish displacement candle

INVALID sweep (skip the trade):
  ? Slow grind through the level
  ? No rejection after sweep
  ? No displacement candle after reclaim

===========================================================
SECTION 8 -- ENTRY TRIGGER (ALL MUST ALIGN)
===========================================================
Enter ONLY when ALL conditions are met:
  ? Bias confirmed on Bias TF (2-candle logic)
  ? Impulse identified on Impulse TF (displacement + imbalance)
  ? Price is inside OB or FVG on Entry TF
  ? Liquidity sweep confirmed on Entry TF
  ? Displacement occurs AFTER the reclaim
  ? Entry must occur within 3 candles after the sweep
  ? Session is active (London or London/NY overlap)
  ? No high-impact news within 15 minutes

===========================================================
SECTION 9 -- TARGET LIQUIDITY ENGINE
===========================================================
TP1 and TP2 are identified by finding WEAK liquidity levels.

BULLISH entry targets:
  TP1 = nearest weak HIGHS on Entry TF (equal highs / multiple taps at same high)
  TP2 = weak HIGHS on Impulse TF (larger equal highs)

BEARISH entry targets:
  TP1 = nearest weak LOWS on Entry TF (equal lows / multiple taps at same low)
  TP2 = weak LOWS on Impulse TF (larger equal lows)

Weak liquidity = 2 or more taps at the same price level (equal highs/lows)
Strong liquidity = clean single swing high/low with no prior taps

Rules:
  Full TP at weak equal highs/lows -- price will sweep through them
  TP before or at the first touch of strong single swing levels
  TP1 always comes before TP2 (closer, on Entry TF)
  At TP1: close 50% of position, move SL to breakeven
  At TP2: close remaining position

===========================================================
SECTION 10 -- TRADE MANAGEMENT
===========================================================
Stop Loss:
  Beyond OB low (bullish) or OB high (bearish) + buffer
  OR beyond the sweep level + buffer
  Minimum buffer: 5 pips Forex / 0.5 pts Gold / 10 pts NAS

Take Profit:
  TP1 = 1:1 RR -> close 50% of position, move SL to breakeven
  TP2 = Target liquidity level (weak highs/lows)
  Minimum overall RR = 1:2

Risk per trade: 1% of account maximum
Daily loss limit: 3% -> stop trading for the day
Account drawdown: 10% -> review and pause

===========================================================
SECTION 11 -- SESSION FILTER
===========================================================
TRADE ONLY during:
  [ok] London session:       13:30-21:30 IST
  [ok] London/NY overlap:    18:30-22:30 IST (highest priority)

AVOID:
  [x] Asian session (05:00-13:00 IST) -- analysis only
  [x] 15 minutes before AND after any high-impact news
  [x] Friday after 19:30 IST -- liquidity drops, spreads widen

===========================================================
SECTION 12 -- MODE CONTROL
===========================================================
SNIPER MODE    -> Score ? 80 required | Low frequency, high RR
BALANCED MODE  -> Score ? 65 required | Moderate frequency
AGGRESSIVE MODE -> Score ? 55 required | Higher frequency

===========================================================
SECTION 13 -- SETUP SCORING (OUT OF 100)
===========================================================
HTF bias clarity (clean 2-candle confirmed)  -> 20 pts
Impulse wave from C2 anchor (FVG or OB)     -> 20 pts
OB in correct premium/discount zone          -> 10 pts
OB + FVG overlap at entry                    -> 10 pts
Liquidity sweep on Entry TF (2-candle/W/M)  -> 25 pts
Weak target liquidity available              -> 15 pts
---------------------------------------------------------
TOTAL POSSIBLE                               -> 100 pts

===========================================================
SECTION 14 -- EXECUTION OUTPUT FORMAT
===========================================================
Every trade signal MUST include:
  Asset | Bias TF | Entry TF | Direction | Entry Price
  Stop Loss | TP1 | TP2 | RR | Setup Score | Mode
  Setup Type: OB / FVG / W-Pattern / M-Pattern / Sweep
  Target Liquidity Type: Weak / Strong
  Session Validity | Invalidation Condition
  Reasoning: max 3 lines

===========================================================
CRITICAL RULES (NEVER BREAK)
===========================================================
[NO] Never force a trade -- if conditions are not all met, WAIT
[NO] Skip if confluence score is below required mode threshold
[NO] Skip if no clear liquidity target identified
[NO] Skip if no displacement after sweep
[NO] Skip if OB is in wrong zone (premium for buys, discount for sells)
[NO] You are NOT a retail indicator -- you are a precision liquidity engine
[NO] Only act when ALL conditions are aligned
`;

class KnowledgeBase {
  constructor() {
    this._rules    = null;
    this._playbook = null;
    this._visual   = null; // visual training examples
  }

  // -- Rules --------------------------------------------------

  async loadRules(force = false) {
    if (this._rules && !force) return this._rules;
    const rows = await sheets.read("KB_Rules", "A2:F5000");
    this._rules = rows.filter(r => r[2]).map(r => ({
      id:       r[0] || "",
      category: r[1] || CATEGORIES.ENTRY,
      text:     r[2] || "",
      pair:     r[3] || "ALL",
      priority: parseInt(r[4]) || 5,
      addedAt:  r[5] || new Date().toISOString(),
    }));
    return this._rules;
  }

  async getAllRules() { return this.loadRules(); }
  getRuleCount()     { return this._rules?.length || 0; }

  async addRule({ text, category, pair = "ALL", priority = 5 }) {
    const rules = await this.loadRules();
    const dup = rules.find(r => r.text.toLowerCase() === text.toLowerCase());
    if (dup) return { duplicate: true, total: rules.length };
    const rule = {
      id:       `R${Date.now()}`,
      category: category || this._inferCategory(text),
      text:     text.trim(),
      pair:     pair.toUpperCase(),
      priority: Math.min(10, Math.max(1, priority)),
      addedAt:  new Date().toISOString(),
    };
    await sheets.append("KB_Rules", [rule.id, rule.category, rule.text, rule.pair, rule.priority, rule.addedAt]);
    this._rules.push(rule);
    return { success: true, rule, total: this._rules.length };
  }

  async deleteRule(ruleId) {
    await this.loadRules();
    const idx = this._rules.findIndex(r => r.id === ruleId);
    if (idx === -1) return { success: false };
    const deleted = this._rules[idx].text;
    this._rules.splice(idx, 1);
    await this._rewriteRules();
    return { success: true, deleted };
  }

  async getRulesByCategory() {
    const rules = await this.loadRules();
    const map = {};
    Object.values(CATEGORIES).forEach(c => { map[c] = []; });
    rules.forEach(r => {
      if (!map[r.category]) map[r.category] = [];
      map[r.category].push(r);
    });
    return map;
  }

  // -- Playbook -----------------------------------------------

  async loadPlaybook(force = false) {
    if (this._playbook && !force) return this._playbook;
    const rows = await sheets.read("KB_Playbook", "A2:J500");
    this._playbook = rows.filter(r => r[1]).map(r => ({
      id:        r[0] || "",
      name:      r[1] || "",
      pair:      r[2] || "ALL",
      direction: r[3] || "BOTH",
      htfBias:   r[4] || "",
      trigger:   r[5] || "",
      slRule:    r[6] || "",
      tpRule:    r[7] || "",
      minRR:     parseFloat(r[8]) || 2,
      notes:     r[9] || "",
    }));
    return this._playbook;
  }

  async addPlaybook(data) {
    await this.loadPlaybook();
    const play = {
      id: `P${Date.now()}`,
      name:      data.name || "Unnamed",
      pair:      (data.pair || "ALL").toUpperCase(),
      direction: (data.direction || "BOTH").toUpperCase(),
      htfBias:   data.htfBias || "",
      trigger:   data.trigger || "",
      slRule:    data.slRule || "",
      tpRule:    data.tpRule || "",
      minRR:     parseFloat(data.minRR) || 2,
      notes:     data.notes || "",
    };
    await sheets.append("KB_Playbook", [play.id, play.name, play.pair, play.direction, play.htfBias, play.trigger, play.slRule, play.tpRule, play.minRR, play.notes]);
    this._playbook.push(play);
    return { success: true, play };
  }

  async getPlaybook({ pair, direction } = {}) {
    const plays = await this.loadPlaybook();
    return plays.filter(p => {
      const pm = p.pair === "ALL" || p.pair === (pair || "").toUpperCase();
      const dm = p.direction === "BOTH" || p.direction === (direction || "").toUpperCase();
      return pm && dm;
    });
  }

  getPlaybookCount() { return this._playbook?.length || 0; }

  // -- Visual Training Examples -------------------------------

  async loadVisual(force = false) {
    if (this._visual && !force) return this._visual;
    const rows = await sheets.read("KB_Visual", "A2:G2000");
    this._visual = rows.filter(r => r[1]).map(r => ({
      id:          r[0] || "",
      pattern:     r[1] || "",        // e.g. "Bullish Bias", "Bearish OB", "FVG"
      pair:        r[2] || "ALL",
      timeframe:   r[3] || "",
      description: r[4] || "",        // what was in the image
      lesson:      r[5] || "",        // what to learn from it
      addedAt:     r[6] || new Date().toISOString(),
    }));
    return this._visual;
  }

  async addVisualExample({ pattern, pair, timeframe, description, lesson }) {
    await this.loadVisual();
    const ex = {
      id:          `V${Date.now()}`,
      pattern:     pattern || "General",
      pair:        (pair || "ALL").toUpperCase(),
      timeframe:   timeframe || "",
      description: description || "",
      lesson:      lesson || "",
      addedAt:     new Date().toISOString(),
    };
    await sheets.append("KB_Visual", [ex.id, ex.pattern, ex.pair, ex.timeframe, ex.description, ex.lesson, ex.addedAt]);
    this._visual.push(ex);
    return { success: true, ex, total: this._visual.length };
  }

  async getVisualExamples({ pattern, pair } = {}) {
    const all = await this.loadVisual();
    return all.filter(v => {
      const pm = !pair    || v.pair    === "ALL" || v.pair    === pair.toUpperCase();
      const pt = !pattern || v.pattern.toLowerCase().includes(pattern.toLowerCase());
      return pm && pt;
    });
  }

  getVisualCount() { return this._visual?.length || 0; }

  // -- Prompt Builder -----------------------------------------

  async formatForPrompt({ pair } = {}) {
    const byCategory = await this.getRulesByCategory();
    const plays      = await this.loadPlaybook();

    // Part 1: Hardcoded core rules -- always first
    let out = BIAS_RULES;

    // Part 2: User-taught rules -- labelled as OVERRIDES so Claude applies them
    const allUserRules = [];
    for (const [cat, rules] of Object.entries(byCategory)) {
      if (!rules.length) continue;
      const relevant = rules
        .filter(r => r.pair === "ALL" || r.pair === (pair || "").toUpperCase())
        .sort((a, b) => b.priority - a.priority);
      relevant.forEach(r => allUserRules.push({ cat, rule: r }));
    }

    if (allUserRules.length > 0) {
      out += `\n? BARA7H'S CUSTOM RULES -- THESE OVERRIDE OR EXTEND THE DEFAULTS ABOVE ?\n`;
      out += `You MUST apply every rule in this section. They represent BARA7H's specific methodology.\n`;

      // Group by category
      const grouped = {};
      allUserRules.forEach(({ cat, rule }) => {
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(rule);
      });

      for (const [cat, rules] of Object.entries(grouped)) {
        if (!rules.length) continue;
        out += `\n> ${cat.toUpperCase()}:\n`;
        rules.forEach(r => {
          let pfx;
          if (r.priority >= 10) pfx = "  [NO] ABSOLUTE -- ";
          else if (r.priority >= 9) pfx = "  [!] CRITICAL -- ";
          else if (r.priority >= 7) pfx = "  - IMPORTANT -- ";
          else pfx = "    ";
          out += `${pfx}${r.text}\n`;
        });
      }
    }

    const rPlays = plays.filter(p => p.pair === "ALL" || p.pair === (pair || "").toUpperCase());
    if (rPlays.length) {
      out += `\n? PLAYBOOK SETUPS ?\n`;
      rPlays.forEach(p => {
        out += `> ${p.name} (${p.pair} ${p.direction}) | Min RR: 1:${p.minRR}\n`;
        out += `  HTF: ${p.htfBias}\n`;
        out += `  Entry: ${p.trigger}\n`;
        out += `  SL: ${p.slRule} | TP: ${p.tpRule}\n`;
      });
    }

    // Include recent visual training examples relevant to pair
    const visuals = await this.getVisualExamples({ pair });
    if (visuals.length) {
      out += `\n? VISUAL TRAINING EXAMPLES (${visuals.length}) ?\n`;
      visuals.slice(-10).forEach(v => { // last 10 most recent
        out += `- [${v.pattern}${v.timeframe ? " " + v.timeframe : ""}] ${v.description} -> Lesson: ${v.lesson}\n`;
      });
    }

    return out;
  }

  // -- Helpers ------------------------------------------------

  _inferCategory(text) {
    const t = text.toLowerCase();
    if (/weekly|daily|htf|higher.?time|bias|trend|c1|c2|bullish bias|bearish bias/.test(t)) return CATEGORIES.HTF_BIAS;
    if (/entry|trigger|neckline|ob |order.?block|fvg|sweep|h&s|head.+shoulder/.test(t))    return CATEGORIES.ENTRY;
    if (/risk|rr|lot|sl|stop|tp|take.?profit|drawdown|size|percent/.test(t))               return CATEGORIES.RISK;
    if (/never|avoid|don.t|skip|no trade|stay out|cancel|invalid/.test(t))                 return CATEGORIES.AVOID;
    if (/london|new york|asian|session|open|close|am|pm|gmt|ist/.test(t))                  return CATEGORIES.SESSION;
    if (/gold|xau|eur|gbp|nas|btc|eth|jpy|forex|pair/.test(t))                            return CATEGORIES.PAIR;
    if (/emotion|patience|discipline|fomo|revenge|mindset|fear|greed/.test(t))             return CATEGORIES.PSYCHOLOGY;
    return CATEGORIES.ENTRY;
  }

  async _rewriteRules() {
    await sheets.clear("KB_Rules", "A2:F5000");
    if (!this._rules.length) return;
    const values = this._rules.map(r => [r.id, r.category, r.text, r.pair, r.priority, r.addedAt]);
    await sheets.update("KB_Rules", `A2:F${values.length + 1}`, values);
  }
}

module.exports = { KnowledgeBase, CATEGORIES, BIAS_RULES };

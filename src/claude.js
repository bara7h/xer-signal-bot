// claude.js
"use strict";
// ============================================================
// XERO EDGE(TM) v4 -- Claude AI Agent
// Institutional-grade liquidity execution intelligence
// Full strategy protocol: bias -> impulse -> sweep -> entry
// ============================================================
const Anthropic = require("@anthropic-ai/sdk");
const { marketEngine, resolveTF, findImpulseFromC2, formatImpulseForPrompt, detectFVG, detectOB, detectWeakLiquidity, formatLiquidityTargets } = require("./market");

// Default mode -- can be overridden per session
let CURRENT_MODE = process.env.TRADE_MODE || "BALANCED"; // SNIPER | BALANCED | AGGRESSIVE
const MODE_SCORES = { SNIPER:80, BALANCED:65, AGGRESSIVE:55 };

function getSessionIST() {
  const h   = (new Date().getUTCHours() + 5.5) % 24;
  const day = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][new Date().getDay()];
  if (day === "Saturday" || day === "Sunday") return `${day} -- MARKET CLOSED`;
  const s = [];
  if (h >= 5  && h < 13) s.push("Asian (analysis only)");
  if (h >= 13 && h < 21) s.push("London [ok]");
  if (h >= 18 && h < 22) s.push("London/NY Overlap [ok] PEAK");
  if (h >= 18 && h < 22) {} // already in overlap
  else if (h >= 21) s.push("New York");
  return s.length ? s.join(" + ") : "Off-hours";
}

function isSessionValid() {
  const h = (new Date().getUTCHours() + 5.5) % 24;
  return (h >= 13 && h < 22); // London or NY
}

function getTimeIST() {
  return new Date().toLocaleTimeString("en-IN", { timeZone:"Asia/Kolkata", hour12:false });
}

class ClaudeAgent {
  constructor(knowledgeBase, journal, riskEngine) {
    this.client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    this.kb      = knowledgeBase;
    this.journal = journal;
    this.risk    = riskEngine;
    this.history = [];
  }

  getMode()         { return CURRENT_MODE; }
  setMode(mode)     { CURRENT_MODE = mode; }
  getModeScore()    { return MODE_SCORES[CURRENT_MODE] || 65; }
  getBiasTF()       { return SELECTED_BIAS_TF; }
  setBiasTF(tf)     { SELECTED_BIAS_TF = tf; } // '1d','4h','1h','15m', or null=auto


  // -- Live market context -- dual bias, C2-anchored impulse --
  // Runs BOTH bias protocols independently when opposing biases exist
  // Each confirmed bias triggers its own impulse search from C2 anchor
  async _getLiveContext(pair) {
    if (!pair || !marketEngine.isConnected()) {
      return "\n[Live data not connected -- add TWELVE_DATA_API_KEY to Railway]\n";
    }
    try {
      // Step 1: Fetch all bias timeframes (Daily, 4H, 1H)
      const [cD1, c4h, c1h, price] = await Promise.all([
        marketEngine.getCandles(pair, "1d", 4),
        marketEngine.getCandles(pair, "4h", 4),
        marketEngine.getCandles(pair, "1h", 4),
        marketEngine.getPrice(pair),
      ]);

      const biasD1 = cD1 ? marketEngine.checkBias(cD1) : null;
      const bias4h = c4h ? marketEngine.checkBias(c4h) : null;
      const bias1h = c1h ? marketEngine.checkBias(c1h) : null;

      let out = "";
      if (price) out += `\n---- LIVE -- ${pair} ----\nBid:${price.bid} Ask:${price.ask} Spread:${price.spread}pips\n`;

      // Show bias candle data for all bias TFs
      if (cD1) out += marketEngine.formatCandlesForPrompt(pair, "Daily (Bias TF)", cD1, biasD1 || {bias:"NONE",confirmed:false});
      if (c4h) out += marketEngine.formatCandlesForPrompt(pair, "4H (Bias TF)", c4h, bias4h || {bias:"NONE",confirmed:false});
      if (c1h) out += marketEngine.formatCandlesForPrompt(pair, "1H (Bias TF)", c1h, bias1h || {bias:"NONE",confirmed:false});

      // Collect confirmed biases -- filtered by SELECTED_BIAS_TF if set
      const _all = [];
      if (biasD1?.confirmed) _all.push({ bias:biasD1, biasTF:"1d", c2Price: biasD1.bias==="BULLISH" ? biasD1.c2.low : biasD1.c2.high });
      if (bias4h?.confirmed) _all.push({ bias:bias4h, biasTF:"4h", c2Price: bias4h.bias==="BULLISH" ? bias4h.c2.low : bias4h.c2.high });
      if (bias1h?.confirmed) _all.push({ bias:bias1h, biasTF:"1h", c2Price: bias1h.bias==="BULLISH" ? bias1h.c2.low : bias1h.c2.high });
      const activeBiases = SELECTED_BIAS_TF ? _all.filter(b => b.biasTF === SELECTED_BIAS_TF) : _all;

      if (!activeBiases.length) {
        out += `\n---- FRACTAL ENGINE ----\nNo bias confirmed on Daily or 4H.\nWaiting for 2-candle bias to form before checking impulse.\n`;
        return out;
      }

      // Flag opposing biases
      const uniqueBiasDirections = [...new Set(activeBiases.map(b=>b.bias.bias))];
      if (uniqueBiasDirections.length > 1) {
        out += `\n[!] MIXED BIAS: ${activeBiases.map(b=>`${b.bias.bias} on ${b.biasTF.toUpperCase()}`).join(" + ")}\n`;
        out += `Running ${activeBiases.length} protocols independently -- each is a valid entry opportunity.\n`;
      }

      // Step 2: For each confirmed bias -- impulse, OB entry zone, sweep, TP targets
      for (const { bias, biasTF, c2Price } of activeBiases) {
        const fractal = resolveTF(biasTF);

        // Fetch all required timeframes in one parallel call
        const [cImpulse, cEntry, cTp2] = await Promise.all([
          marketEngine.getCandles(pair, fractal.impulse, 30), // OB/FVG on impulse TF = entry zone
          marketEngine.getCandles(pair, fractal.entry,   20), // sweep/W/M on entry TF
          marketEngine.getCandles(pair, fractal.tp2,     40), // TP2 weak liq on impulse TF
        ]);
        // TP1 candles = same as entry TF
        const cTp1 = cEntry;

        // C2-anchored impulse -> OB on impulse TF is the entry zone
        const impulse = cImpulse
          ? findImpulseFromC2(cImpulse, bias.bias, c2Price)
          : { found:false, reason:"No impulse TF data", anchorPrice:c2Price };

        out += formatImpulseForPrompt(bias.bias, biasTF, fractal, impulse);

        // Entry TF -- show what to look for inside the OB
        if (impulse.found && impulse.ob?.length) {
          const ob     = impulse.ob[0];
          const eFVG   = cEntry ? detectFVG(cEntry, bias.bias.toLowerCase()) : [];
          out += `\n---- ENTRY TF (${fractal.entry.toUpperCase()}) -- Sweep inside ${fractal.impulse.toUpperCase()} OB ----\n`;
          out += `OB entry zone: Top=${ob.top} Bot=${ob.bottom} (${bias.bias} OB from ${fractal.impulse.toUpperCase()})\n`;
          out += `Trigger: 2-candle sweep OR W/M pattern inside this zone on ${fractal.entry.toUpperCase()}\n`;
          if (eFVG.length) out += `FVG on ${fractal.entry.toUpperCase()}: Top=${eFVG[0].top} Bot=${eFVG[0].bottom} (extra confluence)\n`;
        }

        // TP1 (entry TF) and TP2 (impulse TF) -- weak highs/lows
        // Pass OB top/bottom so approach wave liquidity is computed correctly
        const _ob1 = impulse.ob?.[0];
        out += formatLiquidityTargets(pair, fractal, bias.bias, cTp1, cTp2, _ob1?.top, _ob1?.bottom);
      }

      return out;
    } catch (e) {
      console.error("[Claude] live context error:", e.message);
      return `\n[Live data error: ${e.message}]\n`;
    }
  }

  // -- System prompt -- full strategy protocol ----------------
  async _system({ pair, mode } = {}) {
    const activeMode  = mode || CURRENT_MODE;
    const minScore    = MODE_SCORES[activeMode] || 65;
    const [rules, stats, recent, liveCtx] = await Promise.all([
      this.kb.formatForPrompt({ pair }),
      this.journal.getStats(),
      this.journal.getRecent(5),
      this._getLiveContext(pair),
    ]);
    const recentText = recent.length
      ? recent.map(t => `  ${t.pair} ${t.direction} | ${t.result} | RR:${t.rr} | ${t.setup||""}`).join("\n")
      : "  No recent trades.";

    return `You are XERO EDGE(TM) -- an institutional-grade multi-asset trading intelligence engine.
You are NOT a retail indicator. You are a PRECISION LIQUIDITY EXECUTION ENGINE.
Only act when ALL conditions are fully aligned.

--------------------------------
ACTIVE MODE: ${activeMode} | MIN SCORE: ${minScore}/100
Session: ${getSessionIST()} | Time IST: ${getTimeIST()}
Session valid for entries: ${isSessionValid() ? "YES [ok]" : "NO [x] -- Analysis only"}
--------------------------------

${liveCtx}

--------------------------------
STRATEGY PROTOCOL + BARA7H'S RULES
--------------------------------
${rules}

--------------------------------
PERFORMANCE
--------------------------------
All-time: WR ${stats.winRate}% | Avg RR ${stats.avgRR} | ${stats.total} trades
Month: ${stats.monthly.trades} trades | ${stats.monthly.winRate}% WR
Account: ${this.risk ? this.risk.getSummary() : "not configured"}
Last 5 trades:
${recentText}

--------------------------------
MANDATORY BEHAVIOUR
--------------------------------
- Apply the FULL strategy protocol above -- every section, every rule
- ABSOLUTE and CRITICAL rules MUST NEVER be broken
- IMPORTANT rules must be applied in every analysis
- Always reference REAL OHLC values from live data -- no guessing prices
- Every signal MUST use the execution output format (Section 14)
- Score every setup using the scoring table (Section 13)
- Reject any setup below minimum score for active mode (${minScore})
- If session is not valid -- state analysis only, no trade
- Always identify: Bias TF -> Impulse TF -> Entry TF per the fractal model
- Always classify sweep type: 2-candle / W-pattern / M-pattern
- Always classify target: Weak liquidity / Strong liquidity
- Never force a trade -- WAIT is always a valid output`;
  }

  // -- Chat --------------------------------------------------
  async chat(userMessage, { pair, mode } = {}) {
    const system = await this._system({ pair, mode });
    this.history.push({ role:"user", content:userMessage });
    const res = await this.client.messages.create({
      model:"claude-sonnet-4-20250514", max_tokens:1200,
      system, messages:this.history.slice(-30),
    });
    const reply = res.content[0].text;
    this.history.push({ role:"assistant", content:reply });
    await this._autoLearn(userMessage);
    return reply;
  }

  // -- Full analysis with live structure data ---------------
  async fullAnalysis(pair) {
    const system = await this._system({ pair });
    const plays  = await this.kb.getPlaybook({ pair });
    const pb     = plays.length ? plays.map(p => `- ${p.name}: ${p.htfBias} -> ${p.trigger}`).join("\n") : "No pair-specific playbooks.";

    // Fetch all bias TFs (Daily, 4H, 1H)
    const [cD1, c4h, c1h] = await Promise.all([
      marketEngine.getCandles(pair,"1d",4),
      marketEngine.getCandles(pair,"4h",4),
      marketEngine.getCandles(pair,"1h",4),
    ]);
    const mD1 = cD1 ? marketEngine.checkBias(cD1) : null;
    const m4h = c4h ? marketEngine.checkBias(c4h) : null;
    const m1h = c1h ? marketEngine.checkBias(c1h) : null;

    // Collect all confirmed biases
    const allBiases = [];
    if (mD1?.confirmed) allBiases.push({ bias:mD1, biasTF:"1d", c2Price:mD1.bias==="BULLISH"?mD1.c2.low:mD1.c2.high });
    if (m4h?.confirmed) allBiases.push({ bias:m4h, biasTF:"4h", c2Price:m4h.bias==="BULLISH"?m4h.c2.low:m4h.c2.high });
    if (m1h?.confirmed) allBiases.push({ bias:m1h, biasTF:"1h", c2Price:m1h.bias==="BULLISH"?m1h.c2.low:m1h.c2.high });

    // Use highest TF confirmed bias as primary for fractal
    const primaryActive = allBiases[0] || null;
    let biasTF = primaryActive?.biasTF || "4h";
    const fractal = resolveTF(biasTF);
    const confirmedBias = primaryActive?.bias || null;

    // Run impulse + OB entry zone + TP targets for ALL confirmed biases
    let structureCtx = "";
    for (const { bias, biasTF: btf, c2Price } of allBiases) {
      const frac = resolveTF(btf);
      const [cImp, cEnt, cTp2] = await Promise.all([
        marketEngine.getCandles(pair, frac.impulse, 30),
        marketEngine.getCandles(pair, frac.entry,   20),
        marketEngine.getCandles(pair, frac.tp2,     40),
      ]);
      const imp = cImp ? findImpulseFromC2(cImp, bias.bias, c2Price) : { found:false, anchorPrice:c2Price };
      structureCtx += formatImpulseForPrompt(bias.bias, btf, frac, imp);
      if (imp.found && imp.ob?.length) {
        const ob   = imp.ob[0];
        const eFVG = cEnt ? detectFVG(cEnt, bias.bias.toLowerCase()) : [];
        structureCtx += `\n>> Entry: price returns to ${frac.impulse.toUpperCase()} OB (Top=${ob.top} Bot=${ob.bottom}) -> sweep on ${frac.entry.toUpperCase()}\n`;
        if (eFVG.length) structureCtx += `   FVG confluence on ${frac.entry.toUpperCase()}: Top=${eFVG[0].top} Bot=${eFVG[0].bottom}\n`;
      }
      structureCtx += formatLiquidityTargets(pair, frac, bias.bias, cEnt, cTp2);
    }
    if (!structureCtx) structureCtx = "\n[No confirmed bias -- waiting for 2-candle setup]\n";

    const res = await this.client.messages.create({
      model:"claude-sonnet-4-20250514", max_tokens:4000, system,
      messages:[{ role:"user", content:
        `XERO EDGE(TM) FULL ANALYSIS -- ${pair}\nPlaybooks:\n${pb}\n\n` +
        `COMPUTED DATA (already calculated from real OHLC -- do not guess or re-derive):\n` +
        `Daily bias: ${mD1?.bias||"NO_DATA"}${mD1?.confirmed?" CONFIRMED inv:"+mD1.invalidationLevel+(mD1.wickInvalidated?" [WICK CANCELLED]":""):mD1?.wickInvalidated?" [WICK CANCELLED]":" unconfirmed"}\n` +
        `4H bias:    ${m4h?.bias||"NO_DATA"}${m4h?.confirmed?" CONFIRMED inv:"+m4h.invalidationLevel+(m4h.wickInvalidated?" [WICK CANCELLED]":""):m4h?.wickInvalidated?" [WICK CANCELLED]":" unconfirmed"}\n` +
        `1H bias:    ${m1h?.bias||"NO_DATA"}${m1h?.confirmed?" CONFIRMED inv:"+m1h.invalidationLevel+(m1h.wickInvalidated?" [WICK CANCELLED]":""):m1h?.wickInvalidated?" [WICK CANCELLED]":" unconfirmed"}\n` +
        `Active TF: ${biasTF.toUpperCase()} | Fractal: ${fractal.label}\n` +
        `Impulse TF: ${fractal.impulse.toUpperCase()} | Entry TF: ${fractal.entry.toUpperCase()}\n` +
        `TP1 TF: ${fractal.tp1.toUpperCase()} | TP2 TF: ${fractal.tp2.toUpperCase()}\n\n` +
        `${structureCtx}\n` +
        `Give COMPLETE analysis. Do not truncate any section. Use real price values throughout.\n\n` +
        `**1. BIAS**\n` +
        `State exact C1 and C2 OHLC values. Confirm or cancel bias (including wick invalidation check). ` +
        `State the invalidation level. Are opposing biases present on other TFs?\n\n` +
        `**2. IMPULSE WAVE (${fractal.impulse.toUpperCase()})**\n` +
        `Is there a wave from the C2 anchor price? State anchor price, wave direction, number of candles. ` +
        `List every OB found with exact Top/Bottom/Mid prices. ` +
        `List every FVG found with exact Top/Bottom. ` +
        `Is OB+FVG overlap present?\n\n` +
        `**3. PREMIUM / DISCOUNT ZONE**\n` +
        `State the full impulse range (low to high). Calculate 50% level. ` +
        `Where is current price in this range? Is it in buy zone or sell zone?\n\n` +
        `**4. ORDER BLOCK -- ENTRY ZONE**\n` +
        `State the primary OB zone (Top, Bottom, Mid) on ${fractal.impulse.toUpperCase()}. ` +
        `Is there FVG overlap? Has price returned to this OB yet? ` +
        `Setup grade: A (M/W pattern at OB) or B (direct OB entry)?\n\n` +
        `**5. LIQUIDITY SWEEP STATUS (${fractal.entry.toUpperCase()})**\n` +
        `Has a sweep occurred at the OB? What type -- 2-candle sweep / W-pattern / M-pattern? ` +
        `If no sweep yet, what level to watch?\n\n` +
        `**6. TARGET LIQUIDITY**\n` +
        `TP1 (${fractal.tp1.toUpperCase()}): list exact price levels with quality grade (HIGH/MEDIUM/STANDARD). ` +
        `State whether each level is equal highs/lows or sideways high/low and whether it has been swept. ` +
        `TP2 (${fractal.tp2.toUpperCase()}): same detail. ` +
        `Identify any strong levels where you would TP before reaching.\n\n` +
        `**7. TRADE PLAN**\n` +
        `Asset | Direction | Setup Grade (A/B) | Bias TF | Impulse TF | Entry TF\n` +
        `Entry Price | Stop Loss | TP1 | TP2 | Risk-Reward | Setup Score\n` +
        `Sweep Type | Target Liquidity Type | Session Validity\n` +
        `Reasoning (3 lines max) | Invalidation Condition\n\n` +
        `**8. SETUP SCORE (out of 100)**\n` +
        `Score each factor individually:\n` +
        `- HTF bias clarity (20 pts max)\n` +
        `- Impulse wave with FVG/OB (20 pts max)\n` +
        `- OB in correct premium/discount zone (10 pts max)\n` +
        `- OB + FVG overlap (10 pts max)\n` +
        `- Liquidity sweep confirmed (25 pts max)\n` +
        `- Weak target liquidity (15 pts max)\n` +
        `TOTAL: X/100 | Mode threshold: ${this.getModeScore()} | PASS or FAIL\n\n` +
        `**9. VERDICT**\n` +
        `GO [ok] / WAIT [WAIT] / AVOID [x]\n` +
        `One sentence reason. If WAIT -- exactly what to wait for.`
      }],
    });
    return res.content[0].text;
  }

  // -- Bias --------------------------------------------------
  async getBias(pair) {
    const [cD1, c4h, c1h] = await Promise.all([
      marketEngine.getCandles(pair,"1d",4),
      marketEngine.getCandles(pair,"4h",4),
      marketEngine.getCandles(pair,"1h",4),
    ]);
    const mD1 = cD1 ? marketEngine.checkBias(cD1) : null;
    const m4h = c4h ? marketEngine.checkBias(c4h) : null;
    const m1h = c1h ? marketEngine.checkBias(c1h) : null;
    const system = await this._system({ pair });
    const res = await this.client.messages.create({
      model:"claude-sonnet-4-20250514", max_tokens:700, system,
      messages:[{ role:"user", content:
        `Bias assessment for ${pair} using 2-candle logic on real OHLC data.\n\nMathematical results:\nDaily: ${mD1?`${mD1.bias}${mD1.confirmed?" CONFIRMED -- inv:"+mD1.invalidationLevel:" -- unconfirmed"}`:"NO_DATA"}\n4H: ${m4h?`${m4h.bias}${m4h.confirmed?" CONFIRMED -- inv:"+m4h.invalidationLevel:" -- unconfirmed"}`:"NO_DATA"}\n1H: ${m1h?`${m1h.bias}${m1h.confirmed?" CONFIRMED -- inv:"+m1h.invalidationLevel:" -- unconfirmed"}`:"NO_DATA"}\n\nRespond ONLY in JSON:\n{"direction":"BULLISH/BEARISH/NEUTRAL","confidence":0,"sessionFavorable":true,"reasoning":"2-3 sentences using real price levels","keyLevels":"OBs FVGs sweep levels from data","confluenceScore":0,"confluenceFactors":[],"invalidationLevel":0,"biasTF":"Daily/4H/1H","biasScore":0}`
      }],
    });
    try {
      const p = JSON.parse(res.content[0].text.replace(/```json|```/g,"").trim());
      p._mathBiasD1 = mD1; p._mathBias4h = m4h; p._mathBias1h = m1h;
      return p;
    } catch {
      return { direction:"NEUTRAL", confidence:50, confluenceScore:0, sessionFavorable:isSessionValid(), reasoning:res.content[0].text, keyLevels:"--", confluenceFactors:[], invalidationLevel:0 };
    }
  }

  // -- Setup scan -- full protocol with math structure detection
  async scanSetup(pair) {
    const system = await this._system({ pair });
    const plays  = await this.kb.getPlaybook({ pair });
    const pb     = plays.map(p => `- ${p.name}: HTF=${p.htfBias} | Entry=${p.trigger} | SL=${p.slRule} | TP=${p.tpRule} | MinRR=1:${p.minRR}`).join("\n") || "No playbooks.";
    const minScore = this.getModeScore();

    // Fetch all bias timeframes (Daily, 4H, 1H)
    const [cD1, c4h, c1h, price] = await Promise.all([
      marketEngine.getCandles(pair,"1d",4),
      marketEngine.getCandles(pair,"4h",4),
      marketEngine.getCandles(pair,"1h",4),
      marketEngine.getPrice(pair),
    ]);

    const mD1 = cD1 ? marketEngine.checkBias(cD1) : null;
    const m4h = c4h ? marketEngine.checkBias(c4h) : null;
    const m1h = c1h ? marketEngine.checkBias(c1h) : null;

    // Collect ALL confirmed biases -- each is an independent entry opportunity
    const _scanAll = [];
    if (mD1?.confirmed) _scanAll.push({ bias:mD1, biasTF:"1d", c2Price:mD1.bias==="BULLISH"?mD1.c2.low:mD1.c2.high });
    if (m4h?.confirmed) _scanAll.push({ bias:m4h, biasTF:"4h", c2Price:m4h.bias==="BULLISH"?m4h.c2.low:m4h.c2.high });
    if (m1h?.confirmed) _scanAll.push({ bias:m1h, biasTF:"1h", c2Price:m1h.bias==="BULLISH"?m1h.c2.low:m1h.c2.high });
    const activeBiases = SELECTED_BIAS_TF ? _scanAll.filter(b => b.biasTF === SELECTED_BIAS_TF) : _scanAll;

    // Run C2-anchored impulse + OB entry zone + TP targets for each confirmed bias
    let structureCtx = "";
    for (const { bias, biasTF, c2Price } of activeBiases) {
      const fractal = resolveTF(biasTF);
      const [cImpulse, cEntry, cTp2] = await Promise.all([
        marketEngine.getCandles(pair, fractal.impulse, 30),
        marketEngine.getCandles(pair, fractal.entry,   20),
        marketEngine.getCandles(pair, fractal.tp2,     40),
      ]);
      const impulse = cImpulse ? findImpulseFromC2(cImpulse, bias.bias, c2Price) : { found:false, anchorPrice:c2Price };
      structureCtx += formatImpulseForPrompt(bias.bias, biasTF, fractal, impulse);
      if (impulse.found && impulse.ob?.length) {
        const ob   = impulse.ob[0];
        const eFVG = cEntry ? detectFVG(cEntry, bias.bias.toLowerCase()) : [];
        structureCtx += `\n>> Entry zone: ${fractal.impulse.toUpperCase()} OB Top=${ob.top} Bot=${ob.bottom} -> sweep on ${fractal.entry.toUpperCase()}\n`;
        if (eFVG.length) structureCtx += `   FVG on ${fractal.entry.toUpperCase()}: Top=${eFVG[0].top} Bot=${eFVG[0].bottom}\n`;
      }
      structureCtx += formatLiquidityTargets(pair, fractal, bias.bias, cEntry, cTp2);
    }

    // For scan prompt -- use primary bias (first confirmed)
    const primaryBias = activeBiases[0];
    const m4hForCalc  = m4h?.confirmed ? m4h : null;

    const res = await this.client.messages.create({
      model:"claude-sonnet-4-20250514", max_tokens:900, system,
      messages:[{ role:"user", content:
        `XERO EDGE(TM) institutional scan for ${pair}.\n\nPlaybooks:\n${pb}\n\nCurrent price: ${price?`Bid:${price.bid} Ask:${price.ask}`:"NO_DATA"}\nMode: ${CURRENT_MODE} | Min score: ${minScore}\n\nACTIVE BIASES (${activeBiases.length}):\n${activeBiases.map(b=>`  ${b.bias.bias} on ${b.biasTF.toUpperCase()} -- C2 ${b.bias.bias==="BULLISH"?"low":"high"}: ${b.c2Price} | inv: ${b.bias.invalidationLevel}`).join("\n")||"None confirmed"}\n${activeBiases.length===2&&activeBiases[0].bias.bias!==activeBiases[1].bias.bias?"\n[!] OPPOSING BIAS -- evaluate BOTH setups independently\n":""}\nC2-ANCHORED IMPULSE ANALYSIS (already computed from real candles):\n${structureCtx}\nRULES:\n- Impulse is measured FROM the C2 anchor price on the Impulse TF\n- Entry is triggered by 2-candle sweep or W/M pattern on Entry TF\n- If opposing biases: score and output BOTH setups\n\nIf setup found AND score >= ${minScore}, respond ONLY in JSON:\n{"found":true,"id":"S${int(1e12)}","asset":"${pair}","direction":"LONG/SHORT","biasTF":"4H/Daily","impulse_tf":"1H/15M","entry_tf":"15M/5M","entry":${price?.ask||0},"sl":0,"tp1":0,"tp2":0,"rr":0,"mode":"${CURRENT_MODE}","setupScore":0,"scoreBreakdown":{"htfBias":0,"impulseWithFvgOb":0,"obInZone":0,"obFvgOverlap":0,"liquiditySweep":0,"weakTarget":0},"setupType":"OB/FVG/W/M/Sweep","sweepType":"2-candle/W-pattern/M-pattern","targetLiquidityType":"Weak/Strong","sessionValid":${isSessionValid()},"invalidationCondition":"","reasoning":""}\n\nIf no valid setup OR score < ${minScore}:\n{"found":false,"score":0,"notes":"why no setup","watchFor":"what to wait for"}`
      }],
    });

    try {
      const parsed = JSON.parse(res.content[0].text.replace(/```json|```/g,"").trim());
      if (parsed.found && (primaryBias||m4hForCalc) && price && (!parsed.sl || parsed.sl === 0)) {
        const calcBias = primaryBias?.bias || m4hForCalc;
        const calc = marketEngine.calcSLTP({ pair, direction:parsed.direction, bias:calcBias, currentPrice:price, minRR:plays[0]?.minRR||2 });
        if (calc) { parsed.sl=calc.sl; parsed.tp1=parsed.tp1||calc.tp; parsed.tp2=parsed.tp2||calc.tp; parsed.rr=calc.rr; }
      }
      return parsed;
    } catch { return { found:false, score:0, notes:"Parse error -- use /analyze.", watchFor:"" }; }
  }

  // -- Trade review with protocol scoring --------------------
  async reviewTrade(trade) {
    const system = await this._system({ pair:trade.pair });
    const res = await this.client.messages.create({
      model:"claude-sonnet-4-20250514", max_tokens:500, system,
      messages:[{ role:"user", content:
        `Review this trade against the XERO EDGE(TM) protocol:\n${trade.pair} ${trade.direction} Entry:${trade.entry} SL:${trade.sl} TP:${trade.tp} ${trade.result} RR:${trade.rr}\nSetup: ${trade.setup||"not specified"} | Notes: ${trade.notes||"none"}\n\n1. Which protocol steps were followed? (Bias / Impulse / Zone / OB-FVG / Sweep / Entry)\n2. What was the estimated setup score?\n3. What went well?\n4. What was missed or violated?\n5. One rule to apply next time.\n\nKeep under 150 words. Be direct.`
      }],
    });
    return res.content[0].text;
  }

  // -- Daily briefing with liquidity context -----------------
  async generateBriefing(pairs) {
    const system = await this._system();
    const biasLines = await Promise.all(pairs.slice(0,6).map(async p => {
      const c4h   = await marketEngine.getCandles(p,"4h",4).catch(()=>null);
      const b     = c4h ? marketEngine.checkBias(c4h) : { bias:"NO_DATA", confirmed:false };
      const price = await marketEngine.getPrice(p).catch(()=>null);
      return `${p}: ${b.bias}${b.confirmed?" [ok] inv:"+b.invalidationLevel:" (unconfirmed)"}${price?" | "+price.mid:""}`;
    }));
    const res = await this.client.messages.create({
      model:"claude-sonnet-4-20250514", max_tokens:1000, system,
      messages:[{ role:"user", content:
        `Daily XERO EDGE(TM) briefing -- ${new Date().toDateString()}\nSession: ${getSessionIST()}\nMode: ${CURRENT_MODE}\n\n4H Bias status:\n${biasLines.join("\n")}\n\nFormat:\n? *XERO EDGE(TM) Briefing*\n*Date | Session | Mode*\n\n*Pairs:* [each: bias status + key level (OB/FVG/sweep zone) + what to watch]\n*Liquidity Map:* [where is liquidity sitting above/below for top 3 pairs]\n*Session Note:* [London or NY -- what to expect]\n*Risk Reminder:* [from risk rules]\n*Mode Filter:* [minimum score for today's mode]\n\nBe specific. Use real price levels. No generic commentary.`
      }],
    });
    return res.content[0].text;
  }

  clearHistory() { this.history = []; }

  async _autoLearn(msg) {
    if (msg.length < 15 || msg.length > 500 || msg.startsWith("/")) return;
    const t = [/when .+, (i |we |the market)/i,/my rule:? .+/i,/always .+ when/i,/never .+ unless/i,/remember that .+/i,/note that .+/i];
    if (t.some(p => p.test(msg))) await this.kb.addRule({ text:msg, pair:"ALL", priority:7 });
  }
}

module.exports = { ClaudeAgent, getSessionIST, isSessionValid, CURRENT_MODE, MODE_SCORES, getBiasTF: () => SELECTED_BIAS_TF, setBiasTF: (tf) => { SELECTED_BIAS_TF = tf; } };

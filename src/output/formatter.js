// ─────────────────────────────────────────────────────────────────────────────
// XERO EDGE v2 — Output Formatter
// Two modes: SIGNAL (clean levels) | ANALYSIS (full step-by-step)
// ─────────────────────────────────────────────────────────────────────────────

const { getTfLabel } = require("../../config/markets");

function fmt(symbol) {
  const hi = ["JPY","XAU","XAG","BTC","ETH","OIL","WTI","SPX","NAS","US30","DAX","SP5","GER","USOIL"];
  if (hi.some(k => (symbol||"").toUpperCase().includes(k))) return n => Number(n).toFixed(2);
  return n => Number(n).toFixed(5);
}
function ts(iso) { return new Date(iso).toUTCString().replace(" GMT"," UTC"); }

// ── Bias Only ─────────────────────────────────────────────────────────────────

function formatBiasOnly(symbol, biasMap) {
  const order = ["1week","1day","4h","1h","15min","5min"];
  const em = b => b==="BULLISH"?"🟢":b==="BEARISH"?"🔴":b==="NEUTRAL"?"⚪":"❌";
  const rows = order.filter(tf=>biasMap[tf]).map(tf=>{
    const r = biasMap[tf];
    return `${em(r.bias)} \`${getTfLabel(tf).padEnd(4)}\` → *${r.bias}*`;
  });
  return [
    `🔷 *XERO EDGE™ — Bias Scan*`,
    `\`${symbol}\`  ·  ${new Date().toUTCString().split(" ").slice(0,5).join(" ")}`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    rows.join("\n"),
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `_🟢 Bullish · 🔴 Bearish · ⚪ Neutral · ❌ No data_`,
  ].join("\n");
}

// ── Signal Mode ───────────────────────────────────────────────────────────────

function formatSignal(signal) {
  const f = fmt(signal.symbol);
  const isBull = signal.bias === "BULLISH";
  const risk = Math.abs(signal.entry - signal.sl);
  const mtfQ = signal.mtfQuality === "HIGH" ? "_(4H quality)_" : "_(1H fallback)_";
  return [
    `🔷 *XERO EDGE™ SIGNAL*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `${isBull?"🟢":"🔴"} *${signal.bias}*  ·  \`${signal.symbol}\``,
    `⏱ *Stack:* ${signal.tfLabel}  ${mtfQ}`,
    `📦 *Zone:* ${signal.zone}${signal.htfZones.recalculated?" _(recalculated)_":""}`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `📍 *Entry:*     \`${f(signal.entry)}\``,
    `🛑 *Stop Loss:* \`${f(signal.sl)}\``,
    `🎯 *TP1 (1RR):* \`${f(signal.tp1)}\``,
    `🚀 *TP2 (2RR):* \`${f(signal.tp2)}\``,
    `📐 *R:R @ TP2:* 1 : ${signal.rr}`,
    `📊 *Risk:*      \`${f(risk)}\` pts`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `🟢 *Status:* ${signal.status}  ·  🕐 ${ts(signal.timestamp)}`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `_XERO TRADERS HUB — Trade With Edge™_`,
  ].join("\n");
}

// ── Analysis Mode ─────────────────────────────────────────────────────────────

function formatAnalysis(signal) {
  const f = fmt(signal.symbol);
  const isBull = signal.bias === "BULLISH";
  const L = [];

  L.push(`🧠 *ANALYSIS — ${signal.symbol} · ${signal.bias}*`);
  L.push(`━━━━━━━━━━━━━━━━━━━━━━`);
  L.push(``);

  // Step 1: HTF Bias
  L.push(`*📌 Step 1 — ${getTfLabel(signal.htfTf)} Bias (XERO EDGE™ C1/C2)*`);
  if (signal.htfBias?.C1 && signal.htfBias?.C2) {
    const { C1, C2 } = signal.htfBias;
    L.push(`C1 → H:\`${f(C1.high)}\` L:\`${f(C1.low)}\` C:\`${f(C1.close)}\``);
    L.push(`C2 → H:\`${f(C2.high)}\` L:\`${f(C2.low)}\` C:\`${f(C2.close)}\``);
    L.push(``);
    if (isBull) {
      L.push(`✅ C2 low \`${f(C2.low)}\` < C1 low \`${f(C1.low)}\``);
      L.push(`✅ C2 high \`${f(C2.high)}\` < C1 high \`${f(C1.high)}\``);
      L.push(`✅ C2 close \`${f(C2.close)}\` < C1 high \`${f(C1.high)}\``);
      L.push(`→ *BULLISH* — C2 swept below C1 low, closed back inside. Liquidity taken below. Expecting UP move.`);
    } else {
      L.push(`✅ C2 high \`${f(C2.high)}\` > C1 high \`${f(C1.high)}\``);
      L.push(`✅ C2 low \`${f(C2.low)}\` > C1 low \`${f(C1.low)}\``);
      L.push(`✅ C2 close \`${f(C2.close)}\` > C1 low \`${f(C1.low)}\``);
      L.push(`→ *BEARISH* — C2 swept above C1 high, closed back inside. Liquidity taken above. Expecting DOWN move.`);
    }
  }
  L.push(``);

  // Step 2: HTF Zones
  L.push(`*📌 Step 2 — ${getTfLabel(signal.htfTf)} Entry Zones (Fibonacci on C2)*`);
  if (signal.htfZones) {
    const z = signal.htfZones;
    L.push(`C2 range: \`${f(z.C2Low)}\` → \`${f(z.C2High)}\`  (range = \`${f(z.range)}\`)`);
    if (z.recalculated) L.push(`⚠️ _Zones recalculated: price exceeded C2 extreme, stayed inside C1. Fib redrawn from reversal._`);
    L.push(isBull
      ? `Zone 1 (0.618–0.768 from C2 low): \`${f(z.zone1.low)}\` – \`${f(z.zone1.high)}\``
      : `Zone 1 (0.618–0.768 from C2 high): \`${f(z.zone1.low)}\` – \`${f(z.zone1.high)}\``
    );
    L.push(isBull
      ? `Zone 2 (deep discount → C2 low): \`${f(z.zone2.low)}\` – \`${f(z.zone2.high)}\``
      : `Zone 2 (deep premium → C2 high): \`${f(z.zone2.low)}\` – \`${f(z.zone2.high)}\``
    );
    L.push(`✅ Price \`${f(signal.currentPrice)}\` tapped *${signal.zone}*`);
  }
  L.push(``);

  // Step 3: MTF
  L.push(`*📌 Step 3 — ${getTfLabel(signal.mtfTf)} Confirmation* _(${signal.mtfQuality === "HIGH" ? "priority TF ✅" : "fallback TF"})_`);
  if (signal.mtfBias?.C1 && signal.mtfBias?.C2) {
    const { C1, C2 } = signal.mtfBias;
    L.push(`C1 → H:\`${f(C1.high)}\` L:\`${f(C1.low)}\` C:\`${f(C1.close)}\``);
    L.push(`C2 → H:\`${f(C2.high)}\` L:\`${f(C2.low)}\` C:\`${f(C2.close)}\``);
    L.push(isBull
      ? `✅ C2 low < C1 low  ✅ C2 high < C1 high  ✅ C2 close < C1 high`
      : `✅ C2 high > C1 high  ✅ C2 low > C1 low  ✅ C2 close > C1 low`
    );
    L.push(`→ ${signal.bias} confirmed on ${getTfLabel(signal.mtfTf)} ✅`);
  }
  if (signal.mtfZones) {
    const mz = signal.mtfZones;
    L.push(`MTF Zone 1: \`${f(mz.zone1.low)}\` – \`${f(mz.zone1.high)}\``);
    L.push(`MTF Zone 2: \`${f(mz.zone2.low)}\` – \`${f(mz.zone2.high)}\``);
    L.push(`SL → beyond MTF Zone 2 ${isBull?"low (below discount)":"high (above premium)"}: \`${f(signal.sl)}\``);
  }
  L.push(``);

  // Step 4: LTF
  L.push(`*📌 Step 4 — ${getTfLabel(signal.ltfTf)} Entry Trigger*`);
  if (signal.ltfBias?.C1 && signal.ltfBias?.C2) {
    const { C1, C2 } = signal.ltfBias;
    L.push(`C1 → H:\`${f(C1.high)}\` L:\`${f(C1.low)}\` C:\`${f(C1.close)}\``);
    L.push(`C2 → H:\`${f(C2.high)}\` L:\`${f(C2.low)}\` C:\`${f(C2.close)}\``);
    L.push(isBull
      ? `✅ C2 low < C1 low  ✅ C2 high < C1 high  ✅ C2 close < C1 high`
      : `✅ C2 high > C1 high  ✅ C2 low > C1 low  ✅ C2 close > C1 low`
    );
    L.push(`→ ${signal.bias} confirmed on ${getTfLabel(signal.ltfTf)} — all TFs aligned, entry triggered ✅`);
  }
  if (signal.ltfZones) {
    const lz = signal.ltfZones;
    L.push(`LTF Zone 1: \`${f(lz.zone1.low)}\` – \`${f(lz.zone1.high)}\``);
    L.push(`Entry = midpoint of LTF Zone 1 → \`${f(signal.entry)}\``);
  }
  L.push(``);

  // Risk summary
  const risk = Math.abs(signal.entry - signal.sl);
  const rTP1 = Math.abs(signal.tp1 - signal.entry);
  const rTP2 = Math.abs(signal.tp2 - signal.entry);
  L.push(`*📌 Risk & Reward*`);
  L.push(`Risk:    \`${f(risk)}\` pts  →  SL: \`${f(signal.sl)}\``);
  L.push(`TP1 1:1: \`${f(signal.tp1)}\`  (reward: \`${f(rTP1)}\`)`);
  L.push(`TP2 2:1: \`${f(signal.tp2)}\`  (reward: \`${f(rTP2)}\`)`);
  L.push(`Remainder: hold for momentum beyond TP2`);
  L.push(``);
  L.push(`━━━━━━━━━━━━━━━━━━━━━━`);
  L.push(`_Risk only what you can afford to lose._`);

  return L.join("\n");
}

// ── Scan Summary ──────────────────────────────────────────────────────────────

function formatScanSummary(results, outputMode) {
  const L = [];
  L.push(`🔷 *XERO EDGE™ Scan Complete*`);
  L.push(`━━━━━━━━━━━━━━━━━━━━━━`);
  L.push(``);

  let totalSignals = 0;
  for (const { symbol, result } of results) {
    const { htfBiases, signals, noHTFBias, error } = result;
    if (error) { L.push(`\`${symbol}\` ❌ ${error}`); continue; }
    if (noHTFBias || !Object.keys(htfBiases||{}).length) {
      L.push(`\`${symbol}\` ⚪ No HTF bias`); continue;
    }
    const biasLabels = Object.entries(htfBiases).map(([tf,b])=>
      `${b.bias==="BULLISH"?"🟢":"🔴"}${getTfLabel(tf)}`
    ).join(" ");
    const n = (signals||[]).length;
    totalSignals += n;
    L.push(`\`${symbol}\`  ${biasLabels}  →  *${n} signal${n!==1?"s":""}*`);
  }

  L.push(``);
  L.push(`━━━━━━━━━━━━━━━━━━━━━━`);
  L.push(`*${totalSignals} signal${totalSignals!==1?"s":""} total*`);
  if (totalSignals > 0) L.push(`_${outputMode==="analysis"?"Full analysis":"Signal only"} — details below_`);
  return L.join("\n");
}

// ── No Signal explanation ─────────────────────────────────────────────────────

function formatNoSignal(symbol, result) {
  const { analysisLog, htfBiases, noHTFBias } = result;
  const L = [];
  L.push(`📭 *No signal — \`${symbol}\`*`);
  L.push(`━━━━━━━━━━━━━━━━━━━━━━`);
  L.push(``);

  if (noHTFBias || !Object.keys(htfBiases||{}).length) {
    L.push(`No HTF bias on 1W, 1D, 4H, or 1H.`);
    L.push(`All timeframes neutral — no structure yet. Wait for C1/C2 to form.`);
    return L.join("\n");
  }

  const htfFound = Object.entries(htfBiases).map(([tf,b])=>
    `${b.bias==="BULLISH"?"🟢":"🔴"} ${getTfLabel(tf)} ${b.bias}`
  ).join("\n");
  L.push(`*HTF biases found:*`);
  L.push(htfFound);
  L.push(``);
  L.push(`*Breakdown — why no entry:*`);

  for (const log of (analysisLog||[])) {
    if (!log.steps) continue;
    const last = log.steps[log.steps.length - 1];
    if (!last) continue;
    const hl = getTfLabel(log.htfTf);
    if (last.result === "PRICE_NOT_IN_ZONE") L.push(`• ${hl} stack: Price not in zone — waiting for pullback`);
    else if (last.result === "NO_MTF_ALIGNMENT") L.push(`• ${hl} stack: MTF didn't confirm — no alignment`);
    else if (last.result === "INVALIDATED") L.push(`• ${hl} stack: Bias invalidated before entry`);
    else if (last.step === "ltf_check") L.push(`• ${hl} stack: ${getTfLabel(last.tf)} didn't trigger — no entry`);
    else L.push(`• ${hl} stack: ${last.result}`);
  }

  L.push(``);
  L.push(`_Patience. Wait for full fractal alignment._`);
  return L.join("\n");
}

module.exports = { formatBiasOnly, formatSignal, formatAnalysis, formatScanSummary, formatNoSignal, fmt };

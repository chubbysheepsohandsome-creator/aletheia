/*
 * ALETHEIA Deep Scan — runs entirely in the browser.
 *
 * Adds to the standard engine:
 *   1. a hashed character (3–5) + word (1–2) n-gram TF-IDF model (exact port of sklearn HashingVectorizer:
 *      MurmurHash3_x86_32, seed 0, |h| mod 2^18),
 *   2. a stacker that combines it with the GBM document model (thresholds fixed on a calibration split),
 *   3. window-level re-scoring for finer sentence/paragraph maps,
 *   4. bootstrap resampling of sentences for an uncertainty interval and a stability estimate,
 *   5. (Supreme) leave-one-paragraph-out influence analysis and a PDF report.
 * Every extra step is real computation; nothing waits artificially.
 */
(function (root) {
  "use strict";
  const enc = new TextEncoder();

  function murmur3(bytes) { // MurmurHash3_x86_32, seed 0 → signed int32
    let h = 0, k, i = 0;
    const len = bytes.length, nblocks = len >> 2;
    for (let b = 0; b < nblocks; b++, i += 4) {
      k = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
      k = Math.imul(k, 0xcc9e2d51); k = (k << 15) | (k >>> 17); k = Math.imul(k, 0x1b873593);
      h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    }
    k = 0;
    switch (len & 3) {
      case 3: k ^= bytes[i + 2] << 16; // falls through
      case 2: k ^= bytes[i + 1] << 8; // falls through
      case 1: k ^= bytes[i]; k = Math.imul(k, 0xcc9e2d51); k = (k << 15) | (k >>> 17); k = Math.imul(k, 0x1b873593); h ^= k;
    }
    h ^= len; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h | 0;
  }

  let M = null, IDF = null, COEF = null, RCOEF = null, CCOEF = null, TOKRE = null;
  function model() {
    if (M) return M;
    M = root.AletheiaDeepModel || (typeof require === "function" ? require("./deep_model.js") : null);
    if (!M) throw new Error("Deep Scan model not loaded");
    const b64 = (s) => { const bin = typeof atob === "function" ? atob(s) : Buffer.from(s, "base64").toString("binary"); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };
    IDF = b64(M.idf_b64); COEF = new Int8Array(b64(M.coef_b64).buffer);
    RCOEF = M.register ? new Int8Array(b64(M.register.coef_b64).buffer) : null;
    CCOEF = M.register && M.register.creative ? new Int8Array(b64(M.register.creative.coef_b64).buffer) : null;
    TOKRE = new RegExp(M.token_pattern, "g");
    return M;
  }

  // n-gram counts for one text: Map<index, count>
  function counts(text, into) {
    const m = model(), NF = m.n_features, out = into || new Map();
    const add = (s) => { const h = murmur3(enc.encode(s)); const idx = (h === -2147483648 ? 0 : Math.abs(h)) % NF; out.set(idx, (out.get(idx) || 0) + 1); };
    const low = text.toLowerCase();
    const cs = Array.from(low.replace(/\s\s+/g, " "));
    for (let n = m.char_ngram[0]; n <= Math.min(m.char_ngram[1], cs.length); n++)
      for (let i = 0; i + n <= cs.length; i++) add(cs.slice(i, i + n).join(""));
    const toks = low.match(TOKRE) || [];
    for (const t of toks) add(t);
    for (let i = 0; i + 1 < toks.length; i++) add(toks[i] + " " + toks[i + 1]);
    return out;
  }
  function scoresFromCounts(c) { // → {ai, academic, creative}: same normalized TF-IDF vector, three linear heads
    const m = model(); let dot = 0, rdot = 0, cdot = 0, nrm = 0;
    for (const [idx, v] of c) {
      const tf = (1 + Math.log(v)) * IDF[idx] * m.idf_scale; nrm += tf * tf; dot += tf * COEF[idx] * m.coef_scale;
      if (RCOEF) rdot += tf * RCOEF[idx] * m.register.coef_scale;
      if (CCOEF) cdot += tf * CCOEF[idx] * m.register.creative.coef_scale;
    }
    const n = nrm > 0 ? Math.sqrt(nrm) : 1, sig = (x) => 1 / (1 + Math.exp(-x));
    return { ai: sig(dot / n + m.intercept), academic: RCOEF ? sig(rdot / n + m.register.intercept) : 0,
             creative: CCOEF ? sig(cdot / n + m.register.creative.intercept) : 0 };
  }
  const probFromCounts = (c) => scoresFromCounts(c).ai;
  // Register-specific thresholds: academic-abstract style is calibrated separately (≤1% human FPR in each register).
  // Three registers: academic abstracts (strict), creative writing (calibrated on human fiction), everything else
  // ("general": news, essays, blogs…; conservative, because its human calibration data is the most varied).
  function thresholdsFor(pAcad, pCre) {
    const m = model(), r = m.register;
    const academic = !!r && pAcad >= r.cut;
    const creative = !academic && !!(r && r.creative) && (pCre || 0) >= r.creative.cut;
    const key = academic ? "academic" : creative ? "creative" : "general";
    return { academic, creative, name: key, pAcademic: pAcad, pCreative: pCre || 0,
             high: r ? r.t_high[key] : m.t_high, low: r ? r.t_low[key] : m.t_low };
  }
  // Quick check used by the Standard mode: academic register + deep score, no bootstrap.
  function guard(base) {
    if (!base || base.status !== "ok") return null;
    const prose = base.blocks.filter((b) => b.type === "prose" || b.type === "list-prose").map((b) => b.text).join("\n\n");
    const sc = scoresFromCounts(counts(prose));
    return Object.assign(thresholdsFor(sc.academic, sc.creative), { deep: stack(base.score, sc.ai), pNgram: sc.ai });
  }
  const ngramProb = (text) => probFromCounts(counts(text));
  const lg = (p) => { p = Math.min(1 - 1e-6, Math.max(1e-6, p)); return Math.log(p / (1 - p)); };
  function stack(pg, pn) {
    const s = model().stack, a = lg(pg == null ? 0.5 : pg), b = lg(pn);
    return 1 / (1 + Math.exp(-(s.w[0] * a + s.w[1] * b + s.w[2] * Math.min(a, b) + s.b)));
  }
  const merge = (maps) => { const o = new Map(); for (const mp of maps) for (const [k, v] of mp) o.set(k, (o.get(k) || 0) + v); return o; };
  const quant = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  const LEVELS = {
    deep: { ngramBoot: 300, gbmBoot: 40, windows: [3], loo: false, label: "Deep Scan" },
    supreme: { ngramBoot: 2000, gbmBoot: 300, windows: [1, 3, 5], loo: true, label: "Supreme Deep Scan" },
  };

  async function run(text, opts = {}) {
    const E = root.ProseLensEngine || require("./engine.js");
    const L = LEVELS[opts.level || "deep"], prog = opts.onProgress || (() => {}), t0 = Date.now();
    const cancelled = () => opts.signal && opts.signal.aborted;
    const stages = [];
    const stage = async (name, frac) => {
      const key = name.split(" (")[0], lastS = stages[stages.length - 1];
      if (!lastS || lastS.key !== key) stages.push({ key, name: key, at: Date.now() - t0 }); else lastS.end = Date.now() - t0;
      prog({ stage: name, frac }); await tick(); if (cancelled()) throw new Error("cancelled");
    };
    model();
    await stage("Standard engine: preprocessing, 23 features, GBM document model", 0.02);
    const base = E.analyze(text);
    if (base.status !== "ok") return { status: base.status, base, level: opts.level };
    const prose = base.sentences.filter((s) => s.score !== null);
    const proseText = base.blocks.filter((b) => b.type === "prose" || b.type === "list-prose").map((b) => b.text).join("\n\n");

    await stage("n-gram stylometric model and register analysis on the full document", 0.06);
    const docSc = scoresFromCounts(counts(proseText)); const pDoc = docSc.ai; const REG = thresholdsFor(docSc.academic, docSc.creative);
    const pGbm = base.score;
    const deepScore = stack(pGbm, pDoc);

    await stage("Sentence counts for window and bootstrap analysis", 0.1);
    const sc = prose.map((s) => counts(s.text));

    await stage("Window re-scoring (sentence neighbourhoods)", 0.14);
    const winProb = prose.map(() => []);
    for (const w of L.windows) {
      const h = Math.floor(w / 2);
      for (let i = 0; i < prose.length; i++) {
        const lo = Math.max(0, i - h), hi = Math.min(prose.length, i + h + 1);
        winProb[i].push(probFromCounts(merge(sc.slice(lo, hi))));
      }
      await tick();
    }
    const sentDeep = prose.map((s, i) => {
      const w = winProb[i].reduce((a, b) => a + lg(b), 0) / winProb[i].length;
      return 1 / (1 + Math.exp(-(0.55 * w + 0.45 * lg(s.local ?? s.score))));
    });
    prose.forEach((s, i) => { s.deep = sentDeep[i]; s.deepCat = sentDeep[i] >= 0.8 ? "strong" : sentDeep[i] >= 0.6 ? "moderate" : sentDeep[i] <= 0.25 ? "human" : "mixed"; });

    await stage("Paragraph-level n-gram scoring", 0.2);
    const paras = base.paragraphs.map((p) => {
      const ss = prose.filter((s) => s.para === p.index);
      const pn = ss.length ? probFromCounts(merge(ss.map((s) => sc[prose.indexOf(s)]))) : null;
      return Object.assign({}, p, { ngram: pn, deep: pn == null ? null : (ss.reduce((a, s) => a + s.deep * s.f.wc, 0) / Math.max(1, ss.reduce((a, s) => a + s.f.wc, 0))) });
    });

    // ---- bootstrap: n-gram part (cheap) and GBM part (re-runs the full engine on resampled documents)
    const n = prose.length, ngB = [], gbB = [], dB = [];
    const rnd = (() => { let x = 2463534242; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 1e9) / 1e9; }; })();
    for (let b = 0; b < L.ngramBoot; b++) {
      const pick = Array.from({ length: n }, () => Math.floor(rnd() * n));
      ngB.push(probFromCounts(merge(pick.map((i) => sc[i]))));
      if (b % 25 === 0) await stage(`Bootstrap resampling, n-gram model (${b}/${L.ngramBoot})`, 0.22 + 0.33 * b / L.ngramBoot);
    }
    for (let b = 0; b < L.gbmBoot; b++) {
      const pick = Array.from({ length: n }, () => Math.floor(rnd() * n));
      const paraTexts = []; for (let i = 0; i < pick.length; i += 5) paraTexts.push(pick.slice(i, i + 5).map((k) => prose[k].text).join(" "));
      const r = E.analyze(paraTexts.join("\n\n"));
      if (r.status === "ok") { gbB.push(r.score); dB.push(stack(r.score, ngB[b % ngB.length])); }
      if (b % 5 === 0) await stage(`Bootstrap resampling, full engine (${b}/${L.gbmBoot})`, 0.55 + 0.33 * b / L.gbmBoot);
    }
    const M_ = model();
    const ci = dB.length ? [quant(dB, 0.05), quant(dB, 0.95)] : [deepScore, deepScore];
    const stability = dB.length ? dB.filter((x) => (x >= REG.high) === (deepScore >= REG.high)).length / dB.length : 1;

    // ---- leave-one-paragraph-out influence (Supreme)
    let influence = [];
    if (L.loo && paras.filter((p) => p.ngram != null).length >= 2) {
      await stage("Leave-one-paragraph-out influence analysis", 0.9);
      for (const p of paras) {
        if (p.ngram == null) continue;
        const keep = prose.map((s, i) => (s.para === p.index ? null : i)).filter((x) => x !== null);
        if (!keep.length) continue;
        const txt = base.blocks.filter((b) => (b.type === "prose" || b.type === "list-prose") && b.i !== p.block).map((b) => b.text).join("\n\n");
        const r = E.analyze(txt);
        const without = stack(r.status === "ok" ? r.score : pGbm, probFromCounts(merge(keep.map((i) => sc[i]))));
        influence.push({ para: p.index, block: p.block, delta: deepScore - without, preview: p.preview });
        await tick();
      }
      influence.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    }

    await stage("Combining evidence", 0.97);
    const tH = REG.high, tL = REG.low;
    if (REG.academic && deepScore < tH) // academic register: never imply AI authorship below the academic threshold
      prose.forEach((s) => { if (s.deepCat === "strong" || s.deepCat === "moderate") s.deepCat = "mixed"; });
    const pd = paras.filter((p) => p.deep != null && p.words >= 25).map((p) => p.deep);
    let catKey, category;
    if (!REG.academic && pd.length >= 3 && Math.max(...pd) >= 0.8 && Math.min(...pd) <= 0.25 && deepScore >= tL) { catKey = "mixed-authorship"; category = "Mixed signals across sections"; }
    else if (deepScore >= tH) {
      if (ci[0] >= tH && deepScore >= 0.97) { catKey = "strong"; category = "Strong AI-like signals"; }
      else { catKey = "substantial"; category = "Substantial AI-like signals"; }
    } else if (deepScore >= tL) { catKey = "inconclusive"; category = "Inconclusive"; }
    else if (deepScore >= 0.12) { catKey = "mostly-human"; category = "Mostly human-like, some AI-like signals"; }
    else { catKey = "human"; category = "Predominantly human-like"; }
    let confidence = base.evidence === "Limited" ? "Low" : stability >= 0.95 ? "High" : stability >= 0.8 ? "Medium" : "Low";
    if (catKey === "inconclusive" || catKey === "mixed-authorship") confidence = confidence === "High" ? "Medium" : confidence;
    const flagged = prose.filter((s) => s.deepCat === "strong" || s.deepCat === "moderate").reduce((a, s) => a + s.f.wc, 0) / Math.max(1, base.qualifyingWords);
    prog({ stage: "Done", frac: 1 });
    return { status: "ok", level: opts.level || "deep", levelLabel: L.label, base, deepScore, pGbm, pNgram: pDoc, ci, stability, catKey, category, confidence,
             flaggedShare: flagged, paragraphs: paras, influence, thresholds: { high: tH, low: tL }, bootstrap: { ngram: ngB.length, full: dB.length },
             stages, elapsedMs: Date.now() - t0, modelVersion: M_.version, modelPool: M_.pool, windows: L.windows, register: REG };
  }

  // ---------------------------------------------------------------- PDF report (jsPDF, built-in fonts)
  function pdf(R, meta = {}) {
    const { jsPDF } = root.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const W = 595.28, H = 841.89, MX = 54;
    const clean = (s) => String(s ?? "").replace(/[“”„]/g, '"').replace(/[‘’‚]/g, "'").replace(/[—–]/g, "-").replace(/…/g, "...").replace(/≤/g, "<=").replace(/≥/g, ">=").replace(/[⁻−]/g, "-").replace(/→/g, "->").replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "?");
    const C = { ink: [16, 17, 20], mute: [110, 112, 120], gold: [185, 154, 91], line: [220, 216, 205], red: [196, 97, 79], amber: [201, 161, 74], green: [111, 159, 120], paper: [250, 250, 247] };
    let y = 0, page = 0;
    const footer = () => {
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(...C.mute);
      doc.text(clean(`ALETHEIA ${R.levelLabel} report - ${meta.date || ""} - page ${page}`), MX, H - 28);
      doc.text("A detector score is not proof of authorship.", W - MX, H - 28, { align: "right" });
    };
    const newPage = () => { if (page) footer(); if (page) doc.addPage(); page++; y = 64; doc.setFillColor(...C.paper); doc.rect(0, 0, W, H, "F"); };
    const need = (h) => { if (y + h > H - 56) newPage(); };
    const logo = (x, y0, s) => { // symbol: two blades, a cut, a beam
      const k = s / 48; doc.setFillColor(...C.ink);
      const tri = (pts) => { doc.triangle(x + pts[0] * k, y0 + pts[1] * k, x + pts[2] * k, y0 + pts[3] * k, x + pts[4] * k, y0 + pts[5] * k, "F"); };
      tri([22, 4.5, 4, 44, 22, 44]); tri([26, 4.5, 44, 44, 26, 44]);
      doc.setFillColor(...C.paper); doc.rect(x, y0 + 30.5 * k, 48 * k, 1.6 * k, "F");
      doc.setFillColor(...C.gold); doc.rect(x + 23.1 * k, y0 + 11 * k, 1.8 * k, 33 * k, "F");
    };
    const h2 = (t) => { need(40); y += 12; doc.setFont("times", "bold"); doc.setFontSize(15); doc.setTextColor(...C.ink); doc.text(clean(t), MX, y); y += 8; doc.setDrawColor(...C.line); doc.line(MX, y, W - MX, y); y += 16; };
    const para = (t, size = 9.5, color = C.ink, font = "helvetica", style = "normal", width = W - 2 * MX) => {
      doc.setFont(font, style); doc.setFontSize(size); doc.setTextColor(...color);
      for (const ln of doc.splitTextToSize(clean(t), width)) { need(size * 1.45); doc.text(ln, MX, y); y += size * 1.45; }
    };
    const kv = (rows) => {
      doc.setFontSize(9);
      for (const [k, v] of rows) { need(14); doc.setFont("helvetica", "normal"); doc.setTextColor(...C.mute); doc.text(clean(k), MX, y); doc.setFont("courier", "normal"); doc.setTextColor(...C.ink); doc.text(clean(v), W - MX, y, { align: "right" }); y += 14; }
    };
    const bar = (x, y0, w, v, col) => { doc.setFillColor(232, 229, 220); doc.rect(x, y0, w, 6, "F"); doc.setFillColor(...col); doc.rect(x, y0, Math.max(1, w * v), 6, "F"); };
    const colOf = (v) => (v >= 0.8 ? C.red : v >= 0.6 ? C.amber : v <= 0.25 ? C.green : [160, 160, 168]);

    newPage();
    logo(MX, 46, 30); doc.setFont("times", "bold"); doc.setFontSize(17); doc.setTextColor(...C.ink); doc.text("A L E T H E I A", MX + 40, 68);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...C.mute); doc.text("AI WRITING INTELLIGENCE", MX + 40, 80);
    y = 124; doc.setFont("times", "bold"); doc.setFontSize(26); doc.setTextColor(...C.ink); doc.text(clean(R.levelLabel + " report"), MX, y);
    y += 18; para(`${meta.file ? "Document: " + meta.file + "  -  " : ""}Generated ${meta.date || ""}  -  Analysis time ${(R.elapsedMs / 1000).toFixed(1)} s`, 9, C.mute);
    // verdict box
    y += 10; const bx = y; doc.setFillColor(255, 255, 255); doc.setDrawColor(...C.line); doc.rect(MX, bx, W - 2 * MX, 118, "FD");
    doc.setFont("times", "bold"); doc.setFontSize(44); doc.setTextColor(...C.ink); doc.text(`${Math.round(R.deepScore * 100)}`, MX + 22, bx + 62);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...C.mute); doc.text("DEEP SCORE / 100", MX + 22, bx + 78);
    doc.text(clean(`90% interval ${Math.round(R.ci[0] * 100)}-${Math.round(R.ci[1] * 100)}`), MX + 22, bx + 92);
    doc.setFont("times", "bold"); doc.setFontSize(17); doc.setTextColor(...C.ink); doc.text(clean(R.category), MX + 150, bx + 36);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...C.mute);
    const lines = doc.splitTextToSize(clean(`Confidence ${R.confidence}. ${Math.round(R.flaggedShare * 100)}% of qualifying prose is highlighted as AI-like. The verdict held in ${Math.round(R.stability * 100)}% of ${R.bootstrap.full} bootstrap re-analyses. Flagging threshold ${Math.round(R.thresholds.high * 100)}, review threshold ${Math.round(R.thresholds.low * 100)}.`), W - 2 * MX - 170);
    lines.forEach((l, i) => doc.text(l, MX + 150, bx + 56 + i * 13));
    bar(MX + 150, bx + 100, W - 2 * MX - 172, R.deepScore, colOf(R.deepScore));
    y = bx + 140;
    h2("Document");
    kv([["Total words", String(R.base.totalWords)], ["Qualifying prose (words)", String(R.base.qualifyingWords)], ["Excluded: headings, lists, tables, references", String(R.base.excludedWords)],
        ["Quoted words excluded", String(R.base.quotedWords)], ["Sentences", String(R.base.stats.sentences)], ["Language", R.base.language.name], ["Evidence amount", R.base.evidence]]);
    h2("How the result was reached");
    kv([["Standard engine (GBM document model)", `${(R.pGbm * 100).toFixed(1)} / 100`], ["n-gram stylometric model", `${(R.pNgram * 100).toFixed(1)} / 100`],
        ["Combined deep score", `${(R.deepScore * 100).toFixed(1)} / 100`], ["Bootstrap re-analyses (n-gram / full engine)", `${R.bootstrap.ngram} / ${R.bootstrap.full}`],
        ["Window sizes (sentences)", R.windows.join(", ")], ["Writing register", R.register.academic ? `academic abstract (p=${R.register.pAcademic.toFixed(2)}): strictest threshold` : R.register.creative ? `creative writing (p=${R.register.pCreative.toFixed(2)}): threshold calibrated on human fiction` : `general (academic p=${R.register.pAcademic.toFixed(2)}, creative p=${R.register.pCreative.toFixed(2)}): conservative threshold`],
        ["Engine / Deep model", `${R.base.version} / ${R.modelVersion}`]]);
    para("Stages: " + R.stages.map((s) => `${s.name} (from ${(s.at / 1000).toFixed(1)} s)`).join("; ") + ".", 7.5, C.mute);
    h2("Evidence from interpretable signals");
    for (const f of R.base.families) {
      need(26); doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(...C.ink); doc.text(clean(f.name), MX, y);
      doc.setFont("courier", "normal"); doc.text(clean(String(f.value)), W - MX, y, { align: "right" }); y += 11;
      para(f.detail, 8, C.mute); y += 3;
    }
    h2("Paragraph map");
    R.paragraphs.forEach((p, i) => {
      if (p.deep == null) return; need(30);
      doc.setFont("courier", "normal"); doc.setFontSize(8.5); doc.setTextColor(...C.mute); doc.text(`P${i + 1}`, MX, y + 5);
      bar(MX + 28, y, 150, p.deep, colOf(p.deep)); doc.text(`${Math.round(p.deep * 100)}`, MX + 186, y + 5);
      doc.setFont("helvetica", "normal"); doc.setTextColor(...C.ink); doc.text(clean(doc.splitTextToSize(clean(p.preview), W - 2 * MX - 210)[0] + "..."), MX + 210, y + 5); y += 18;
    });
    if (R.influence.length) {
      h2("Which paragraphs drive the result");
      para("Leave-one-paragraph-out: how much the deep score changes when each paragraph is removed (positive = the paragraph pushes towards AI-like).", 8.5, C.mute);
      R.influence.slice(0, 6).forEach((x) => { para(`P${x.para + 1}  ${x.delta >= 0 ? "+" : ""}${(x.delta * 100).toFixed(1)}  -  ${x.preview}...`, 8.5); });
    }
    h2("Highlighted sentences");
    para("Sentences are listed with their deep sentence score. [AI++] strong AI-like signals, [AI+] moderate, [H] human-like, [ ] inconclusive.", 8, C.mute); y += 4;
    const tag = { strong: "[AI++]", moderate: "[AI+]", human: "[H]", mixed: "[ ]" };
    for (const s of R.base.sentences.filter((s) => s.score !== null)) {
      const col = s.deepCat === "strong" ? C.red : s.deepCat === "moderate" ? C.amber : s.deepCat === "human" ? C.green : C.mute;
      doc.setFont("times", "normal"); doc.setFontSize(10);
      const ls = doc.splitTextToSize(clean(s.text), W - 2 * MX - 70);
      need(ls.length * 13 + 4);
      doc.setFillColor(...col); doc.rect(MX, y - 8, 3, ls.length * 13, "F");
      doc.setFont("courier", "normal"); doc.setFontSize(7.5); doc.setTextColor(...col); doc.text(`${tag[s.deepCat] || ""} ${Math.round(s.deep * 100)}`, MX + 8, y);
      doc.setFont("times", "normal"); doc.setFontSize(10); doc.setTextColor(...C.ink);
      ls.forEach((l, i) => doc.text(l, MX + 62, y + i * 13)); y += ls.length * 13 + 5;
    }
    h2("Limitations and fair use");
    para("ALETHEIA measures statistical and stylistic patterns associated with AI-generated text. It cannot prove who wrote a document, and its scores are not the probability that a particular person used AI. Formal, technical, template-based and non-native English writing can show AI-like patterns; edited or paraphrased AI text can look human. Do not use this report as the sole basis for any academic or employment decision; consider drafts, notes, version history and a conversation with the writer.", 9);
    y += 6;
    para(`Model provenance: the deep model (${R.modelVersion}) was trained and calibrated on research datasets (Ghostbuster; Profiler, EMNLP 2025; DetectRL; a human / ChatGPT / QuillBot academic-abstract corpus; short fiction from 120+ language models, 2023-2026, from public creative-writing benchmarks; public-domain fiction) whose upstream rights are under review. Thresholds are calibrated separately for three writing registers (academic abstracts, creative writing, everything else) so that at most 1% of human texts in each calibration group are flagged. On held-out data it flagged 0.2% of human texts overall, 0% of held-out human fiction, 1.5% of human academic abstracts and 1.8% of 2024 human news articles. Performance on other genres and on humanizer-rewritten text is lower.`, 8, C.mute);
    if (R.register.academic) { y += 4; para("This document was recognised as academic-abstract style. ALETHEIA cannot reliably separate AI-rewritten abstracts from human ones, so a high score here is reported as inconclusive unless the evidence is exceptionally strong.", 8.5, C.ink, "helvetica", "bold"); }
    footer();
    return doc.output("blob");
  }

  const api = { run, pdf, ngramProb, counts, murmur3, LEVELS, guard, scoresFromCounts };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.AletheiaDeep = api;
})(typeof window !== "undefined" ? window : globalThis);

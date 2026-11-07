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

  // V1.8.5/6: earlier models kept for comparison. current = seg-0.8; seg07 = V1.8.2 (deep_model_v182.js); seg06 = V1.3 to V1.8.1 (deep_model_seg06.js)
  const MODEL_SRC = { current: ["AletheiaDeepModel", "./deep_model.js"], seg07: ["AletheiaDeepModelLegacy", "./deep_model_v182.js"], seg06: ["AletheiaDeepModelSeg06", "./deep_model_seg06.js"] };
  let which = "current";
  let M = null, IDF = null, COEF = null, RCOEF = null, CCOEF = null, GCOEF = null, SCOEF = null, TOKRE = null;
  function model() {
    if (M) return M;
    const src = MODEL_SRC[which]; M = root[src[0]] || (typeof require === "function" ? require(src[1]) : null);
    if (!M) throw new Error("Deep Scan model not loaded");
    const b64 = (s) => { const bin = typeof atob === "function" ? atob(s) : Buffer.from(s, "base64").toString("binary"); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };
    IDF = b64(M.idf_b64); COEF = new Int8Array(b64(M.coef_b64).buffer);
    RCOEF = M.register ? new Int8Array(b64(M.register.coef_b64).buffer) : null;
    CCOEF = M.register && M.register.creative ? new Int8Array(b64(M.register.creative.coef_b64).buffer) : null;
    GCOEF = M.general_head ? new Int8Array(b64(M.general_head.coef_b64).buffer) : null;
    SCOEF = M.segment_head ? new Int8Array(b64(M.segment_head.coef_b64).buffer) : null;
    TOKRE = new RegExp(M.token_pattern, "g");
    return M;
  }

  function setModel(w) { w = w === true ? "seg07" : (w || "current"); if (!MODEL_SRC[w]) w = "current"; if (w !== which) { which = w; M = null; } }
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
    const m = model(); let dot = 0, rdot = 0, cdot = 0, gdot = 0, sdot = 0, nrm = 0;
    for (const [idx, v] of c) {
      const tf = (1 + Math.log(v)) * IDF[idx] * m.idf_scale; nrm += tf * tf; dot += tf * COEF[idx] * m.coef_scale;
      if (RCOEF) rdot += tf * RCOEF[idx] * m.register.coef_scale;
      if (CCOEF) cdot += tf * CCOEF[idx] * m.register.creative.coef_scale;
      if (GCOEF) gdot += tf * GCOEF[idx] * m.general_head.coef_scale;
      if (SCOEF) sdot += tf * SCOEF[idx] * m.segment_head.coef_scale;
    }
    const n = nrm > 0 ? Math.sqrt(nrm) : 1, sig = (x) => 1 / (1 + Math.exp(-x));
    return { ai: sig(dot / n + m.intercept), academic: RCOEF ? sig(rdot / n + m.register.intercept) : 0,
             creative: CCOEF ? sig(cdot / n + m.register.creative.intercept) : 0,
             gen: GCOEF ? sig(gdot / n + m.general_head.intercept) : null,
             seg: SCOEF ? sig(sdot / n + m.segment_head.intercept) : null };
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
  function guard(base, opts = {}) {
    if (!base || base.status !== "ok") return null;
    const prose = base.blocks.filter((b) => b.type === "prose" || b.type === "list-prose").map((b) => b.text).join("\n\n");
    const sc = scoresFromCounts(counts(prose));
    const T = thresholdsFor(sc.academic, sc.creative);
    const ps = base.sentences.filter((s) => s.score !== null);
    const cov = model().segment ? coverage(ps.map((s) => Object.assign({}, s)), ps.map((s) => counts(s.text)), T.name, opts.student, opts.sensitive) : null;
    return Object.assign(T, { deep: deepOf(base.score, sc, T), pNgram: sc.ai, pGeneral: sc.gen, coverage: cov, union: (model().segment || {}).union_coverage || null });
  }
  const ngramProb = (text) => probFromCounts(counts(text));
  const lg = (p) => { p = Math.min(1 - 1e-6, Math.max(1e-6, p)); return Math.log(p / (1 - p)); };
  function stack(pg, pn) {
    const s = model().stack, a = lg(pg == null ? 0.5 : pg), b = lg(pn);
    return 1 / (1 + Math.exp(-(s.w[0] * a + s.w[1] * b + s.w[2] * Math.min(a, b) + s.b)));
  }
  // General register (not academic, not creative): the deep-0.4 stack and the general-writing head are each measured
  // against their own threshold and the larger margin wins; the result is calibrated so 0.5 sits at the decision threshold.
  function stackG(pg, pn) {
    const s = model().stack_general, a = lg(pg == null ? 0.5 : pg), b = lg(pn);
    return 1 / (1 + Math.exp(-(s.w[0] * a + s.w[1] * b + s.w[2] * Math.min(a, b) + s.b)));
  }
  function deepOf(pg, sc, reg) {
    const m = model(), d4 = stack(pg, sc.ai);
    if (!reg || reg.name !== "general" || sc.gen == null || !m.stack_general) return d4;
    const c = m.stack_general.combine, d7 = stackG(pg, sc.gen);
    return 1 / (1 + Math.exp(-Math.max(lg(d4) - lg(c.t_base), lg(d7) - lg(c.t_general))));
  }
  // ---- AI coverage (segment level, in the style of Turnitin's AI percentage)
  // Overlapping windows of about W words (step W/2) are scored by the segment head; each sentence takes the mean logit
  // of the windows that contain it and is highlighted when that reaches the register's calibrated threshold.
  function segWindows(wc, W) {
    const n = wc.length, total = wc.reduce((a, b) => a + b, 0);
    if (total <= W * 1.25) return [[0, n]];
    const win = []; let start = 0;
    for (;;) {
      let end = start, w = 0; while (end < n && w < W) { w += wc[end]; end++; }
      if (end === n) { let s = start, ww = w; while (ww < W && s > 0) { s--; ww += wc[s]; } win.push([s, n]); break; }
      win.push([start, end]);
      let a = 0, ns = start; while (ns < end - 1 && a < W / 2) { a += wc[ns]; ns++; }
      start = Math.max(ns, start + 1);
    }
    return win;
  }
  // Student-assignment mode: thresholds calibrated on human student essays only (>= student_min_words prose words);
  // used only when the user says the text is a student assignment. Outside that scope the standard thresholds apply.
  // High sensitivity (student mode only): also highlights "screening leads" between t_screen and t_student; the
  // percentage then counts both, and pctStrong / displayStrong keep the student-threshold figure.
  function coverage(prose, sc, regName, student, sensitive) {
    const m = model(), S = m.segment;
    if (!S || !SCOEF || !prose.length) return null;
    const wc = prose.map((s) => s.f.wc), wins = segWindows(wc, S.W), acc = prose.map(() => [0, 0]);
    for (const [a, b] of wins) { const l = lg(scoresFromCounts(merge(sc.slice(a, b)))[S.head]); for (let i = a; i < b; i++) { acc[i][0] += l; acc[i][1]++; } }
    const qWords = wc.reduce((x, w) => x + (w >= 3 ? w : 0), 0);
    const stu = !!(student && S.t_student && qWords >= (S.student_min_words || 300));
    const lvl = !stu ? 0 : (sensitive === 2 && S.t_screen2) ? 2 : (sensitive && S.t_screen) ? 1 : 0;
    const sens = lvl > 0, TS2 = lvl === 2 ? S.t_screen2 : S.t_screen;
    const TT = stu ? S.t_student : S.t;
    const t = TT[regName] ?? TT.general, lgS = acc.map(([x, k]) => x / Math.max(1, k));
    const tLow = sens ? (TS2[regName] ?? TS2.general) : t;
    // V1.7 (student mode): short-passage pass. 100-word windows scored by the main deep head catch AI paragraphs of
    // 60-150 words that the 250-word windows dilute; a sentence counts if either pass reaches its threshold.
    const SP = stu && S.short ? S.short : null; let l100 = null, tS = Infinity, tSLow = Infinity;
    if (SP) {
      const a2 = prose.map(() => [0, 0]);
      for (const [a, b] of segWindows(wc, SP.W)) { const l = lg(scoresFromCounts(merge(sc.slice(a, b)))[SP.head]); for (let i = a; i < b; i++) { a2[i][0] += l; a2[i][1]++; } }
      l100 = a2.map(([x, k]) => x / Math.max(1, k));
      tS = t + SP.shift.t_student; tSLow = sens ? tLow + SP.shift[lvl === 2 ? "t_screen2" : "t_screen"] : tS;
    }
    let total = 0, flagged = 0, strong = 0; const runs = []; let cur = null;
    prose.forEach((s, i) => {
      s.seg = 1 / (1 + Math.exp(-lgS[i]));
      const isStrong = lgS[i] >= t || (l100 !== null && l100[i] >= tS);
      s.segAI = isStrong || lgS[i] >= tLow || (l100 !== null && l100[i] >= tSLow); s.segLead = s.segAI && !isStrong;
      s.segShort = !!(l100 !== null && s.segAI && lgS[i] < (isStrong ? t : tLow));
      if (s.f.wc >= 3) { total += s.f.wc; if (s.segAI) flagged += s.f.wc; if (s.segAI && !s.segLead) strong += s.f.wc; }
      if (s.segAI) { if (!cur) { cur = { from: i, to: i, words: 0, lg: -Infinity, lead: true }; runs.push(cur); } cur.to = i; cur.words += s.f.wc; cur.lg = Math.max(cur.lg, lgS[i]); if (!s.segLead) cur.lead = false; }
      else cur = null;
    });
    runs.forEach((r, k) => { r.n = k + 1; r.prob = 1 / (1 + Math.exp(-r.lg)); prose.slice(r.from, r.to + 1).forEach((s) => { s.segRun = k + 1; }); });
    const reportable = total >= S.min_words;
    const fmt = (p) => (!reportable ? "--" : p === 0 ? "0%" : p < S.report_from ? "*%" : `${Math.round(p * 100)}%`);
    const pct = total ? flagged / total : 0, pctStrong = total ? strong / total : 0;
    return { pct, reportable, display: fmt(pct), pctStrong, displayStrong: fmt(pctStrong),
             flaggedWords: flagged, strongWords: strong, qualifyingWords: total, runs, windows: wins.length, W: S.W, threshold: t, screenThreshold: sens ? tLow : null,
             register: regName, version: S.version, calibration: S.calibration || null,
             student: stu, studentRequested: !!student, studentMinWords: S.student_min_words || 300, studentCalibration: stu ? (S.student_calibration || null) : null,
             shortPass: !!SP, shortCalibration: SP ? (SP.calibration || null) : null, sensitive: sens, sensitiveLevel: lvl, sensitiveRequested: !!sensitive, screenCalibration: sens ? ((lvl === 2 ? S.screen2_calibration : S.screen_calibration) || null) : null };
  }
  const merge = (maps) => { const o = new Map(); for (const mp of maps) for (const [k, v] of mp) o.set(k, (o.get(k) || 0) + v); return o; };
  // ---- V1.8.4 (test): which words pull a window's segment score up.
  // The segment head is linear in the normalised TF-IDF features, so a window's logit (minus the intercept) splits
  // exactly into one share per n-gram occurrence. Each share is spread over the characters the n-gram covers and summed
  // per word. Nothing here changes any score; it only reads the same weights the score uses.
  function occurrencesOf(text) {
    const m = model(), NF = m.n_features, low = text.toLowerCase(), pts = [];
    for (let i = 0; i < low.length;) { const ch = String.fromCodePoint(low.codePointAt(i)); pts.push([ch, i]); i += ch.length; }
    const cs = [], po = [], ws = (c) => /\s/.test(c);
    for (let j = 0; j < pts.length;) {
      if (ws(pts[j][0]) && j + 1 < pts.length && ws(pts[j + 1][0])) { let k = j; while (k < pts.length && ws(pts[k][0])) k++; cs.push(" "); po.push(pts[j][1]); j = k; }
      else { cs.push(pts[j][0]); po.push(pts[j][1]); j++; }
    }
    po.push(low.length);
    const idxOf = (s) => { const h = murmur3(enc.encode(s)); return (h === -2147483648 ? 0 : Math.abs(h)) % NF; };
    const occ = [], toks = [], re = new RegExp(m.token_pattern, "g"); let mt;
    for (let n = m.char_ngram[0]; n <= Math.min(m.char_ngram[1], cs.length); n++)
      for (let i = 0; i + n <= cs.length; i++) occ.push({ i: idxOf(cs.slice(i, i + n).join("")), a: po[i], b: po[i + n] });
    while ((mt = re.exec(low))) toks.push({ t: mt[0], a: mt.index, b: mt.index + mt[0].length });
    for (const t of toks) occ.push({ i: idxOf(t.t), a: t.a, b: t.b });
    for (let i = 0; i + 1 < toks.length; i++) occ.push({ i: idxOf(toks[i].t + " " + toks[i + 1].t), a: toks[i].a, b: toks[i + 1].b });
    return { occ, toks, len: low.length };
  }
  // prose: [{text, f:{wc}}]; returns, per sentence, [{t, a, b, c}] words with their share (logit points) of the windows' score.
  function explain(prose, headName, W) {
    const m = model(), HD = { ai: [COEF, m.coef_scale], gen: [GCOEF, m.general_head && m.general_head.coef_scale], seg: [SCOEF, m.segment_head && m.segment_head.coef_scale] }[headName];
    if (!HD || !HD[0]) return null;
    const O = prose.map((s) => occurrencesOf(s.text)), wc = prose.map((s) => s.f.wc), wins = segWindows(wc, W), kWin = prose.map(() => 0);
    const cnt = O.map((o) => { const c = new Map(); for (const x of o.occ) c.set(x.i, (c.get(x.i) || 0) + 1); return c; });
    for (const [a, b] of wins) for (let i = a; i < b; i++) kWin[i]++;
    const ch = O.map((o) => new Float32Array(o.len + 1));
    for (const [a, b] of wins) {
      const v = merge(cnt.slice(a, b)), c = new Map(); let nrm = 0;
      for (const [idx, n] of v) { const tf = (1 + Math.log(n)) * IDF[idx] * m.idf_scale; nrm += tf * tf; c.set(idx, tf * HD[0][idx] * HD[1] / n); }
      const nn = nrm > 0 ? Math.sqrt(nrm) : 1;
      for (let i = a; i < b; i++) for (const x of O[i].occ) { const sh = c.get(x.i) / nn / kWin[i] / Math.max(1, x.b - x.a); for (let p = x.a; p < x.b; p++) ch[i][p] += sh; }
    }
    return O.map((o, i) => {
      const out = o.toks.map((t) => ({ t: t.t, a: t.a, b: t.b, c: 0 })); let j = 0;
      if (out.length) for (let p = 0; p < o.len; p++) { while (j + 1 < out.length && p >= out[j + 1].a) j++; out[j].c += ch[i][p]; }
      return out;
    });
  }
  // ---- V1.8.4 (test): "why does this look like AI" marks.
  // AI_LEX lists words that (a) pull segment scores up in flagged text from at least 6 different datasets, and
  // (b) occur at least twice as often per document in AI-written samples as in human samples, in most datasets
  // that hold both. The number is that median ratio. Topic words and names fail (a); common function words fail (b).
  // Only these words are ever marked, and only where their share of the window score is positive.
  const AI_LEX = {"absorbing":2.1,"academic":4.4,"accessible":2.9,"accuracy":2.8,"accurate":2.6,"adapt":2.8,"additionally":3.5,"addressing":2.5,"advanced":2.0,"advancements":5.8,"align":2.9,"alike":5.1,"ambition":2.8,"amidst":2.6,"ancient":3.5,"applications":2.8,"applying":3.6,"appreciate":2.3,"appreciation":3.5,"approach":2.1,"architecture":2.1,"argue":2.6,"argued":2.1,"arguing":2.8,"artifact":2.9,"artificial":3.6,"audience":2.1,"authorities":2.4,"avoiding":2.1,"balance":4.2,"balanced":2.8,"beliefs":2.1,"boundaries":3.2,"broader":4.6,"bustling":2.2,"capabilities":2.9,"carefully":2.2,"carries":2.8,"centuries":2.9,"challenges":5.6,"chaos":2.1,"cities":3.5,"civilization":2.9,"classroom":2.1,"collaboration":4.4,"commitment":2.8,"compassion":2.9,"compelling":2.2,"complex":3.8,"comprehensive":4.6,"concerns":2.9,"conclusion":2.1,"conflict":3.1,"connections":2.9,"consequences":4.4,"considering":2.2,"contribute":4.4,"contributing":2.1,"countless":2.8,"creative":2.2,"creativity":4.4,"creatures":3.5,"criticism":2.8,"crucial":2.6,"cunning":2.1,"decisions":2.8,"deeper":2.9,"deeply":2.8,"demonstrate":3.5,"designed":2.2,"determination":2.4,"determined":4.2,"dialogue":2.9,"disappointment":2.8,"discover":3.9,"distinct":2.9,"diverse":5.6,"edges":2.1,"effectively":2.4,"effectiveness":4.1,"emotional":2.2,"emotionally":2.1,"enable":2.1,"enabling":4.4,"engagement":3.5,"engaging":4.2,"enhance":5.0,"ensure":3.8,"ensuring":4.6,"environments":4.4,"essential":2.9,"establish":3.1,"excitement":2.8,"exciting":2.4,"existence":2.2,"experiences":5.2,"experiencing":2.9,"expertise":4.9,"exploration":5.8,"explore":2.9,"exposure":3.2,"expressed":2.1,"fabric":4.4,"faced":2.9,"feelings":3.1,"findings":5.4,"flexibility":2.6,"forgiveness":2.8,"foster":3.9,"fostering":4.4,"fosters":2.1,"foundation":2.1,"fresh":2.4,"gaps":2.8,"grows":2.5,"guided":2.4,"guiding":2.1,"habit":2.1,"handling":2.1,"harsh":2.9,"healing":3.1,"healthcare":2.9,"here's":6.0,"hesitation":3.5,"hidden":2.9,"highlight":3.7,"highlights":2.4,"impact":3.0,"implications":3.9,"importance":3.3,"improved":2.1,"improving":5.1,"including":2.5,"inclusive":2.9,"indicate":2.9,"individuals":2.4,"innovation":2.2,"insights":6.6,"institutions":3.2,"intellectual":3.1,"intense":3.7,"interests":2.1,"intricate":2.1,"investments":2.8,"involves":2.8,"involving":2.1,"journey":3.9,"kindness":3.5,"lasting":2.1,"laughter":2.8,"leading":3.1,"legend":3.1,"lessons":2.1,"limitations":6.3,"loyalty":2.5,"luxury":2.5,"machinery":3.1,"maintain":3.5,"materials":2.1,"meaningful":2.5,"measures":2.4,"merely":2.1,"mysterious":3.8,"navigate":8.7,"navigating":3.1,"necessary":3.3,"numerous":2.3,"obstacles":2.8,"odds":2.8,"offers":3.3,"one's":3.9,"ongoing":2.9,"opportunities":2.9,"ordinary":2.9,"organized":2.8,"outcomes":4.4,"overall":6.6,"participate":2.1,"particularly":2.7,"passionate":2.8,"perspective":2.1,"physical":2.4,"policies":2.3,"potential":3.3,"practical":3.4,"preferences":4.1,"presence":3.7,"presents":3.5,"preserving":2.9,"prevent":2.1,"principles":3.1,"prioritize":3.5,"privacy":2.8,"profound":4.5,"promising":2.5,"promote":2.4,"promoting":3.5,"prompt":2.5,"protect":2.2,"protecting":2.9,"provide":2.9,"provides":4.0,"providing":3.1,"raised":2.1,"raises":2.8,"raising":2.5,"range":2.8,"realizing":2.8,"realm":4.4,"recognition":3.0,"recognizing":3.5,"recording":2.9,"redemption":2.9,"reduce":3.3,"reducing":2.3,"reflecting":2.9,"reflection":2.9,"relationships":2.3,"reliable":2.1,"remains":2.2,"reminder":2.1,"remote":2.4,"represents":2.2,"reputation":2.1,"resilience":4.4,"resistance":2.9,"resolution":2.1,"response":2.4,"responsibilities":2.8,"responsibility":2.1,"responsible":2.3,"resulting":2.8,"safety":2.8,"saving":2.1,"secrets":4.2,"secure":3.1,"sense":2.6,"sentences":4.2,"setting":2.1,"shadows":2.8,"shaped":2.8,"shared":2.3,"significance":2.7,"significant":3.5,"skills":2.4,"societal":4.6,"solving":2.5,"specific":2.6,"steady":2.2,"strangers":2.9,"struggle":2.4,"substantial":2.5,"successful":3.7,"suggests":2.1,"surrounding":3.3,"sustainable":3.1,"symbol":2.9,"symbols":2.9,"systems":2.4,"tailored":3.1,"talent":2.2,"tapestry":2.9,"targeted":2.1,"teams":2.2,"teamwork":2.1,"tension":2.1,"testament":2.9,"tools":2.5,"traditional":3.2,"trusted":2.1,"ultimately":3.2,"uncertain":2.9,"uncertainty":2.5,"uncover":2.9,"understanding":4.4,"unique":3.5,"urban":2.8,"utilizing":4.4,"valuable":2.9,"voices":2.4,"weight":2.2,"widely":2.6,"widespread":2.4};
  const WHY_MIN = 0.05;
  function addWhy(prose, cov) {
    const S = model().segment; if (!S || !cov) return;
    const ex = explain(prose, S.head, S.W); if (!ex) return;
    const agg = new Map();
    prose.forEach((s, i) => {
      s.why = null; if (!s.segAI || s.text.toLowerCase().length !== s.text.length) return;
      const marks = [];
      for (const w of ex[i]) { const r = AI_LEX[w.t]; if (r && w.c >= WHY_MIN) marks.push({ a: w.a, b: w.b, t: w.t, x: r, c: +w.c.toFixed(3) }); }
      marks.sort((p, q) => q.c - p.c); const keep = marks.slice(0, 5).sort((p, q) => p.a - q.a);
      if (!keep.length) return;
      s.why = keep;
      for (const k of keep) { const o = agg.get(k.t) || { t: k.t, x: k.x, n: 0, c: 0 }; o.n++; o.c += k.c; agg.set(k.t, o); }
    });
    cov.why = [...agg.values()].sort((p, q) => q.c - p.c).slice(0, 8);
  }
  const quant = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  const LEVELS = {
    deep: { ngramBoot: 300, gbmBoot: 40, windows: [3], loo: false, label: "Deep Scan" },
    supreme: { ngramBoot: 2000, gbmBoot: 300, windows: [1, 3, 5], loo: true, label: "Supreme Deep Scan" },
  };

  async function run(text, opts = {}) {
    const E = root.ProseLensEngine || require("./engine.js");
    setModel(opts.model || opts.legacy);
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
    const deepScore = deepOf(pGbm, docSc, REG);
    const useGen = REG.name === "general" && docSc.gen != null;
    const winP = (c) => scoresFromCounts(c).ai;  // sentence/paragraph maps keep the deep-0.4 n-gram head (validated for section-level use)

    await stage("Sentence counts for window and bootstrap analysis", 0.1);
    const sc = prose.map((s) => counts(s.text));

    await stage("AI coverage: overlapping segment scoring", 0.12);
    const cov = coverage(prose, sc, REG.name, opts.student, opts.sensitive);
    if (cov && which === "current") addWhy(prose, cov);  // the wording list was built on seg-0.8

    await stage("Window re-scoring (sentence neighbourhoods)", 0.14);
    const winProb = prose.map(() => []);
    for (const w of L.windows) {
      const h = Math.floor(w / 2);
      for (let i = 0; i < prose.length; i++) {
        const lo = Math.max(0, i - h), hi = Math.min(prose.length, i + h + 1);
        winProb[i].push(winP(merge(sc.slice(lo, hi))));
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
      const pn = ss.length ? winP(merge(ss.map((s) => sc[prose.indexOf(s)]))) : null;
      return Object.assign({}, p, { ngram: pn, deep: pn == null ? null : (ss.reduce((a, s) => a + s.deep * s.f.wc, 0) / Math.max(1, ss.reduce((a, s) => a + s.f.wc, 0))) });
    });

    // ---- bootstrap: n-gram part (cheap) and GBM part (re-runs the full engine on resampled documents)
    const n = prose.length, ngB = [], gbB = [], dB = [];
    const rnd = (() => { let x = 2463534242; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 1e9) / 1e9; }; })();
    for (let b = 0; b < L.ngramBoot; b++) {
      const pick = Array.from({ length: n }, () => Math.floor(rnd() * n));
      ngB.push(scoresFromCounts(merge(pick.map((i) => sc[i]))));
      if (b % 25 === 0) await stage(`Bootstrap resampling, n-gram model (${b}/${L.ngramBoot})`, 0.22 + 0.33 * b / L.ngramBoot);
    }
    for (let b = 0; b < L.gbmBoot; b++) {
      const pick = Array.from({ length: n }, () => Math.floor(rnd() * n));
      const paraTexts = []; for (let i = 0; i < pick.length; i += 5) paraTexts.push(pick.slice(i, i + 5).map((k) => prose[k].text).join(" "));
      const r = E.analyze(paraTexts.join("\n\n"));
      if (r.status === "ok") { gbB.push(r.score); dB.push(deepOf(r.score, ngB[b % ngB.length], REG)); }
      if (b % 5 === 0) await stage(`Bootstrap resampling, full engine (${b}/${L.gbmBoot})`, 0.55 + 0.33 * b / L.gbmBoot);
    }
    const M_ = model();
    // Resampled documents lose their paragraph structure, which shifts their scores; the bootstrap spread is therefore
    // re-centred on the actual document's score in logit space (its width is kept, its offset removed).
    const sig_ = (x) => 1 / (1 + Math.exp(-x));
    const medB = dB.length ? quant(dB, 0.5) : deepScore, shift = lg(deepScore) - lg(medB);
    const dC = dB.map((x) => sig_(lg(x) + shift));
    const ci = dC.length ? [quant(dC, 0.05), quant(dC, 0.95)] : [deepScore, deepScore];
    const stability = dC.length ? dC.filter((x) => (x >= REG.high) === (deepScore >= REG.high)).length / dC.length : 1;

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
        const without = deepOf(r.status === "ok" ? r.score : pGbm, scoresFromCounts(merge(keep.map((i) => sc[i]))), REG);
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
    // V1.2: a document whose AI percentage reaches the calibrated union level gets an AI verdict even when the
    // whole-document score stays below its threshold (sections written by a 2026 model often dilute the document score).
    const UC = M_.segment && M_.segment.union_coverage;
    let byCoverage = false;
    if (UC && cov && cov.reportable && cov.pct >= UC && !(catKey === "strong" || catKey === "substantial")) { catKey = "substantial"; category = "Substantial AI-like signals"; byCoverage = true; }
    let confidence = base.evidence === "Limited" ? "Low" : stability >= 0.95 ? "High" : stability >= 0.8 ? "Medium" : "Low";
    if (catKey === "inconclusive" || catKey === "mixed-authorship") confidence = confidence === "High" ? "Medium" : confidence;
    const flagged = prose.filter((s) => s.deepCat === "strong" || s.deepCat === "moderate").reduce((a, s) => a + s.f.wc, 0) / Math.max(1, base.qualifyingWords);
    prog({ stage: "Done", frac: 1 });
    return { status: "ok", level: opts.level || "deep", levelLabel: L.label, base, deepScore, pGbm, pNgram: pDoc, pGeneral: useGen ? docSc.gen : null, ci, stability, catKey, category, confidence,
             flaggedShare: flagged, paragraphs: paras, influence, thresholds: { high: tH, low: tL }, bootstrap: { ngram: ngB.length, full: dB.length },
             stages, elapsedMs: Date.now() - t0, modelVersion: M_.version, modelPool: M_.pool, windows: L.windows, register: REG, coverage: cov, byCoverage };
  }

  // ---------------------------------------------------------------- PDF report (jsPDF)
  // Part A follows the layout people know from Turnitin's AI writing report: a cover with document details, an overview
  // with the AI percentage and detection groups, then the whole document with highlighted segments, page by page.
  // Part B is ALETHEIA's own deep analysis (document score, evidence, paragraph map, influence, sentence scores).
  function pdf(R, meta = {}) {
    const { jsPDF } = root.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "a4", compress: true });
    const W = 595.28, H = 841.89, MX = 54, TOP = 78, BOTTOM = H - 58;
    const FONTS = root.AletheiaReportFonts;
    let SANS = "helvetica";
    if (FONTS) {
      try {
        doc.addFileToVFS("DejaVuSans.ttf", FONTS.regular); doc.addFont("DejaVuSans.ttf", "DejaVu", "normal");
        doc.addFileToVFS("DejaVuSans-Bold.ttf", FONTS.bold); doc.addFont("DejaVuSans-Bold.ttf", "DejaVu", "bold");
        doc.addFileToVFS("DejaVuSans-Oblique.ttf", FONTS.italic); doc.addFont("DejaVuSans-Oblique.ttf", "DejaVu", "italic");
        SANS = "DejaVu";
      } catch (e) { SANS = "helvetica"; }
    }
    const uni = SANS === "DejaVu";
    // with the embedded font most characters print as they are; the built-in fonts only cover Latin-1
    const clean = (s) => { s = String(s ?? "").replace(/­|[​-‏⁠﻿]/g, "");
      return uni ? s.replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-ɏˆ-˝Ͱ-Ͽ -⏿■-◿✓-✗]/g, "?")
        : s.replace(/[“”„]/g, '"').replace(/[‘’‚]/g, "'").replace(/[—–]/g, "-").replace(/…/g, "...").replace(/≤/g, "<=").replace(/≥/g, ">=").replace(/≈/g, "~").replace(/√/g, "sqrt").replace(/[⁻−]/g, "-").replace(/→/g, "->").replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "?"); };
    const C = { ink: [16, 17, 20], mute: [110, 112, 120], gold: [185, 154, 91], line: [220, 216, 205], red: [196, 97, 79], amber: [201, 161, 74], green: [111, 159, 120],
                paper: [255, 255, 255], hl: [182, 230, 238], hlLead: [250, 226, 178], hlMark: [28, 140, 160], warnBg: [253, 246, 231], warn: [150, 102, 20], soft: [246, 245, 241] };
    const cov = R.coverage, b = R.base, enc8 = new TextEncoder();
    const fullText = b.blocks.map((x) => x.text).join("\n\n");
    const hex = (n) => (n >>> 0).toString(16).padStart(8, "0");
    const scanId = meta.scanId || `aln:${hex(murmur3(enc8.encode(fullText)))}${hex(murmur3(enc8.encode(fullText + "|aletheia")))}`.slice(0, 20);
    const title = (meta.file || "Pasted text").replace(/\.(docx|pdf|txt|md)$/i, "");
    let y = TOP;
    const setF = (style = "normal", size = 9.5, color = C.ink, face = SANS) => { doc.setFont(face, style); doc.setFontSize(size); doc.setTextColor(...color); };
    const newPage = () => { doc.addPage(); y = TOP; };
    const need = (h) => { if (y + h > BOTTOM) newPage(); };
    const logo = (x, y0, s) => { // symbol: two blades, a cut, a beam
      const k = s / 48; doc.setFillColor(...C.ink);
      const tri = (p) => { doc.triangle(x + p[0] * k, y0 + p[1] * k, x + p[2] * k, y0 + p[3] * k, x + p[4] * k, y0 + p[5] * k, "F"); };
      tri([22, 4.5, 4, 44, 22, 44]); tri([26, 4.5, 44, 44, 26, 44]);
      doc.setFillColor(...C.paper); doc.rect(x, y0 + 30.5 * k, 48 * k, 1.6 * k, "F");
      doc.setFillColor(...C.gold); doc.rect(x + 23.1 * k, y0 + 11 * k, 1.8 * k, 33 * k, "F");
    };
    const para = (t, size = 9.5, color = C.ink, style = "normal", width = W - 2 * MX, x = MX, lh = 1.45) => {
      setF(style, size, color);
      for (const ln of doc.splitTextToSize(clean(t), width)) { need(size * lh); doc.text(ln, x, y); y += size * lh; }
    };
    const h1 = (t, size = 20) => { need(40); setF("bold", size); doc.text(clean(t), MX, y); y += size * 0.9; };
    const h2 = (t) => { need(40); y += 12; doc.setFont("times", "bold"); doc.setFontSize(15); doc.setTextColor(...C.ink); doc.text(clean(t), MX, y); y += 8; doc.setDrawColor(...C.line); doc.line(MX, y, W - MX, y); y += 16; };
    const kv = (rows, mono = true) => {
      for (const [k, v] of rows) { need(15); setF("normal", 9, C.mute); doc.text(clean(k), MX, y); setF("normal", 9, C.ink, mono ? "courier" : SANS);
        const vv = doc.splitTextToSize(clean(v), W - 2 * MX - 200); vv.forEach((l, i) => doc.text(l, W - MX, y + i * 11, { align: "right" })); y += 15 + (vv.length - 1) * 11; }
    };
    const bar = (x, y0, w, v, col) => { doc.setFillColor(232, 229, 220); doc.rect(x, y0, w, 6, "F"); doc.setFillColor(...col); doc.rect(x, y0, Math.max(1, w * v), 6, "F"); };
    const colOf = (v) => (v >= 0.8 ? C.red : v >= 0.6 ? C.amber : v <= 0.25 ? C.green : [160, 160, 168]);
    const fmtBytes = (n) => (n == null ? "—" : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);
    const fmtInt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));

    // ===================== PART A · page 1: cover / document details
    y = 150;
    setF("normal", 9, C.mute); doc.text("AI WRITING REPORT", MX, y); y += 26;
    setF("bold", 24); doc.splitTextToSize(clean(title), W - 2 * MX).slice(0, 3).forEach((l) => { doc.text(l, MX, y); y += 28; });
    y += 4; setF("normal", 10, C.mute); doc.text(clean(`${R.levelLabel} · ALETHEIA V1.7`), MX, y); y += 40;
    setF("bold", 12); doc.text("Document details", MX, y); y += 8; doc.setDrawColor(...C.line); doc.line(MX, y, W - MX, y); y += 18;
    const pages = meta.pages ? String(meta.pages) : `${Math.max(1, Math.round(b.totalWords / 450))} (estimated)`;
    kv([["Scan ID", scanId], ["Scan date", meta.date || ""], ["File name", meta.file || "(pasted text)"], ["File size", fmtBytes(meta.fileSize)],
        ["Pages", pages], ["Words", fmtInt(b.totalWords)], ["Characters", fmtInt(fullText.length)], ["Qualifying prose (words)", fmtInt(cov ? cov.qualifyingWords : b.qualifyingWords)],
        ["Language", b.language.name], ["Analysis level", `${R.levelLabel} (${(R.elapsedMs / 1000).toFixed(1)} s on the user's device)`],
        ["Models", `${b.version} · ${R.modelVersion}${cov ? " · " + cov.version : ""}`], ["Where the analysis ran", "In the browser. The document was not uploaded."]]);
    y += 20;
    doc.setFillColor(...C.soft); doc.rect(MX, y, W - 2 * MX, 54, "F");
    setF("normal", 8.5, C.mute); doc.splitTextToSize(clean("This report has two parts. Part A gives the AI percentage and shows the whole document with the segments that look AI-generated highlighted. Part B is ALETHEIA's deep analysis of the document as a whole. A detector result is not proof of authorship."), W - 2 * MX - 24).forEach((l, i) => doc.text(l, MX + 12, y + 18 + i * 12));

    // ===================== PART A · page 2: overview
    newPage();
    const big = !cov ? "--" : cov.display;
    setF("bold", 30); doc.text(clean(`${big} detected as AI`), MX, y + 8); y += 30;
    if (cov && cov.sensitive) { setF("bold", 10, C.warn); doc.text(clean(`${cov.sensitiveLevel === 2 ? "Very-high" : "High"}-sensitivity screening: ${cov.displayStrong} at the student-assignment threshold; the rest are screening leads (amber).`), MX, y); y += 16; }
    setF("normal", 9.5, C.mute);
    para(!cov ? "The segment model is not available in this version." : !cov.reportable
      ? `Not enough qualifying prose for an AI percentage: ${cov.qualifyingWords} words were found and at least ${model().segment.min_words} are needed.`
      : "The share of qualifying text that ALETHEIA's segment model highlights as likely AI-generated (or AI-generated and then edited). Percentages from 1% to 19% are shown as *% because false positives are more likely in that range.", 9.5, C.mute);
    y += 10;
    // caution box
    const cau = "Caution: review required. An AI detector can be wrong, and it cannot tell who wrote a text or whether AI use was allowed. Use this result as one input alongside drafts, notes, version history and a conversation with the writer, never as the sole basis for an academic or employment decision.";
    setF("normal", 8.8); const cl = doc.splitTextToSize(clean(cau), W - 2 * MX - 28); need(cl.length * 12 + 20);
    doc.setFillColor(...C.warnBg); doc.setDrawColor(...C.amber); doc.rect(MX, y, W - 2 * MX, cl.length * 12 + 16, "FD");
    setF("normal", 8.8, C.warn); cl.forEach((l, i) => doc.text(l, MX + 14, y + 16 + i * 12)); y += cl.length * 12 + 34;
    // detection groups
    setF("bold", 12); doc.text("Detection groups", MX, y); y += 8; doc.setDrawColor(...C.line); doc.line(MX, y, W - MX, y); y += 20;
    const grow = (col, n, label, pct, sub) => {
      need(44); doc.setFillColor(...col); doc.rect(MX, y - 9, 11, 11, "F");
      setF("bold", 10.5); doc.text(clean(n), MX + 20, y); const nw = doc.getTextWidth(clean(n));
      setF("normal", 10.5); doc.text(clean(label), MX + 26 + nw, y); setF("bold", 10.5); doc.text(clean(pct), W - MX, y, { align: "right" }); y += 13;
      setF("normal", 8.5, C.mute); doc.splitTextToSize(clean(sub), W - 2 * MX - 20).forEach((l) => { doc.text(l, MX + 20, y); y += 11; }); y += 12;
    };
    if (cov && cov.reportable) {
      const nLead = b.sentences.filter((s) => s.segLead).length, nStrong = cov.runs.filter((r) => !r.lead).length;
      grow(C.hlMark, String(nStrong), nStrong === 1 ? "AI-generated segment" : "AI-generated segments", cov.sensitive ? cov.displayStrong : cov.display,
           "Text with patterns of large-language-model output. Includes AI text that was lightly edited by a person or a tool.");
      if (cov.sensitive) grow(C.hlLead, String(nLead), nLead === 1 ? "sentence marked as a screening lead" : "sentences marked as screening leads", `+${Math.round((cov.pct - cov.pctStrong) * 100)}%`,
           "High-sensitivity screening only: weaker AI-like patterns that the student-assignment threshold does not count. More human text reaches this level, so treat these as places to look, not as evidence.");
      grow([170, 170, 178], "—", "AI-generated, then paraphrased or humanized", "not separated",
           "ALETHEIA V1.7 does not yet report this group on its own. Heavily paraphrased or humanizer-rewritten AI text is either counted above or missed.");
    } else grow([170, 170, 178], "—", "No AI percentage for this document", "--", "See the note above.");
    // whole-document assessment (ALETHEIA's own measure)
    y += 4; setF("bold", 12); doc.text("Whole-document assessment", MX, y); y += 8; doc.line(MX, y, W - MX, y); y += 20;
    need(70); doc.setFillColor(...C.soft); doc.rect(MX, y - 4, W - 2 * MX, 62, "F");
    setF("bold", 26); doc.text(`${Math.round(R.deepScore * 100)}`, MX + 14, y + 30); setF("normal", 7.5, C.mute); doc.text("DEEP SCORE / 100", MX + 14, y + 44);
    setF("bold", 12); doc.text(clean(R.category), MX + 120, y + 16);
    setF("normal", 8.5, C.mute); doc.splitTextToSize(clean(`How likely the document as a whole is to be AI-generated, from two trained models. Decision threshold ${Math.round(R.thresholds.high * 100)} for ${R.register.name} writing; 90% interval ${Math.round(R.ci[0] * 100)}–${Math.round(R.ci[1] * 100)}. Details in Part B.`), W - 2 * MX - 140).forEach((l, i) => doc.text(l, MX + 120, y + 30 + i * 11));
    y += 76;
    if (cov && cov.reportable && cov.pct >= 0.2 && R.deepScore < R.thresholds.low)
      para("The two measures disagree: some sections look AI-generated, while the document as a whole does not. This pattern fits partly AI-assisted writing, and also formulaic human sections (templates, repeated sentence frames, evaluation checklists). Review the highlighted segments individually.", 8.8, C.ink, "italic");
    // FAQ
    y += 6; setF("bold", 12); need(30); doc.text("Frequently asked questions", MX, y); y += 8; doc.line(MX, y, W - MX, y); y += 18;
    const cal = cov && cov.calibration;
    const faq = [
      ...(cov && cov.sensitive ? [["What is high-sensitivity screening?", `A setting inside student-assignment mode (on by default there) that prefers catching more AI text over avoiding false alarms; the very-high level goes further.${cov.sensitiveLevel === 2 ? " This report used the very-high level." : ""} It also highlights weaker AI-like segments (screening leads, amber), and the percentage at the top counts them.${cov.screenCalibration ? ` On held-out human student essays never used to choose the setting, ${cov.screenCalibration.hold_student_over20} reached 20% (student-assignment threshold alone: ${cov.screenCalibration.hold_student_over20_base}); AI-generated essays and answers reached 20% in ${cov.screenCalibration.ai_over20} of cases (student-assignment threshold alone: ${cov.screenCalibration.ai_over20_base}).` : ""} Use it to decide where to look, never as evidence on its own.`]] : []),
      ...(cov && cov.studentRequested ? [["What does student-assignment mode change?", cov.student
        ? `The AI percentage used thresholds calibrated only on human student essays of at least ${cov.studentMinWords} words, the kind of text Turnitin is designed for.${cov.studentCalibration ? ` On held-out human student essays never used to choose the thresholds, ${cov.studentCalibration.hold_student_over20} reached 20%. Fully AI-generated essays reached 20% in ${cov.studentCalibration.hold_ai_essay_over20} of cases (standard thresholds: ${cov.studentCalibration.std_ai_essay_over20}), and essays and answers by 2026 models in ${cov.studentCalibration.ai2026_over20} (standard: ${cov.studentCalibration.std_ai2026_over20}).` : ""} Use it only for student assignments: on other kinds of writing (news, reports, magazine features) these thresholds flag human text more often.`
        : `Student-assignment mode was requested, but the document has fewer than ${cov.studentMinWords} qualifying words, so the standard thresholds were used.`]] : []),
      ["How should I read the AI percentage and false positives?", `The percentage is the share of qualifying words in highlighted segments. Thresholds were set on human writing so that at most 1% of the human documents in each calibration group (and at most 0.5% overall) reach 20%.${cal ? ` On held-out documents never used for any choice, ${cal.hold_human_over20} of human documents reached 20% (including ${cal.hold_student_over20} of student essays), and AI-generated documents averaged ${cal.hold_ai_mean} coverage.` : ""} A highlight means the text resembles AI output, not that it was produced by AI.`],
      ["What counts as qualifying text?", "Sentences in paragraphs of prose. Headings, short labels, lists of fragments, tables of numbers, equations, captions and reference lists are shown in the document view but are not scored."],
      ["Why can the percentage and the deep score differ?", "The percentage looks at overlapping sections of about " + (cov ? cov.W : 250) + " words; the deep score looks at the whole document with a stricter threshold. A document can contain a few AI-like sections without being AI-like overall, and short formulaic passages can look AI-like on their own."],
      ["How is this different from Turnitin?", "Turnitin's AI percentage comes from a transformer model trained on student writing; ALETHEIA runs smaller statistical models entirely in your browser. The two tools are trained on different data and will not always agree. Neither can prove authorship."],
    ];
    for (const [q, a] of faq) { need(40); setF("bold", 9.5); doc.text(clean(q), MX, y); y += 13; para(a, 8.8, C.mute); y += 8; }

    // ===================== PART A · document with highlights
    newPage();
    setF("normal", 8.5, C.mute); doc.text(clean("The document as analysed. Highlighted text: segments the AI percentage counts. Numbers in the margin mark each segment."), MX, y); y += 12;
    setF("normal", 8.5, C.mute); doc.text(clean("Grey text was not scored (headings, labels, tables, equations, captions, references)."), MX, y); y += 22;
    const marked = new Set();
    const proseIdx = new Map(); b.sentences.filter((s) => s.score !== null).forEach((s) => { (proseIdx.get(s.block) || proseIdx.set(s.block, []).get(s.block)).push(s); });
    const flow = (spans, size, lh, defColor) => { // spans: [{text, hl, run}] laid out with highlight boxes behind highlighted words
      setF("normal", size, defColor);
      const maxW = W - 2 * MX, sp = doc.getTextWidth(" ");
      const lines = []; let line = [], x = 0;
      for (const s of spans) for (const w of clean(s.text).split(/\s+/).filter(Boolean)) {
        const ww = doc.getTextWidth(w);
        if (x > 0 && x + ww > maxW) { lines.push(line); line = []; x = 0; }
        if (ww > maxW) { // a very long token (URL, formula): break it by characters
          let chunk = ""; for (const ch of w) { if (doc.getTextWidth(chunk + ch) > maxW - x) { line.push({ x, w: doc.getTextWidth(chunk), t: chunk, hl: s.hl, run: s.run }); lines.push(line); line = []; x = 0; chunk = ""; } chunk += ch; }
          if (chunk) { const cw = doc.getTextWidth(chunk); line.push({ x, w: cw, t: chunk, hl: s.hl, run: s.run }); x += cw + sp; }
          continue;
        }
        line.push({ x, w: ww, t: w, hl: s.hl, run: s.run }); x += ww + sp;
      }
      if (line.length) lines.push(line);
      for (const ln of lines) {
        need(size * lh);
        for (let i = 0; i < ln.length; i++) if (ln[i].hl) {
          const nx = ln[i + 1] && ln[i + 1].hl ? ln[i + 1].x : ln[i].x + ln[i].w + 1.5;
          doc.setFillColor(...(ln[i].hl === "lead" ? C.hlLead : C.hl)); doc.rect(MX + ln[i].x - 1, y - size * 0.88, nx - ln[i].x + 1, size * 1.22, "F");
        }
        const r = ln.find((it) => it.hl && it.run && !marked.has(it.run));
        if (r) { marked.add(r.run); setF("bold", 7, C.hlMark); doc.text(String(r.run), MX - 8, y - 1, { align: "right" }); }
        for (const it of ln) { setF("normal", size, it.hl == null ? defColor : C.ink); doc.text(it.t, MX + it.x, y); }
        y += size * lh;
      }
    };
    for (const blk of b.blocks) {
      const t = blk.text.trim(); if (!t) continue;
      const hd = t.replace(/^#+\s*/, "");
      if (blk.type === "heading" && hd.split(/\s+/).length <= 8 && !/[=<>|^_]|\d{3,}/.test(hd)) { need(30); y += 6; setF("bold", 11.5, C.ink); doc.splitTextToSize(clean(t.replace(/^#+\s*/, "")), W - 2 * MX).forEach((l) => { need(16); doc.text(l, MX, y); y += 15; }); y += 2; continue; }
      const ss = proseIdx.get(blk.i);
      if (!ss || !cov) { flow([{ text: t, hl: null }], 9.5, 1.5, (blk.type === "prose" || blk.type === "list-prose") ? C.ink : C.mute); y += 5; continue; }
      // rebuild the block from its sentences so each one can carry its own highlight
      const spans = []; let pos = 0;
      for (const s of ss) {
        const at = t.indexOf(s.text, pos);
        if (at < 0) { spans.push({ text: s.text, hl: s.segAI ? (s.segLead ? "lead" : true) : false, run: s.segRun }); continue; }
        if (at > pos) spans.push({ text: t.slice(pos, at), hl: false });
        spans.push({ text: s.text, hl: s.segAI ? (s.segLead ? "lead" : true) : false, run: s.segRun }); pos = at + s.text.length;
      }
      if (pos < t.length) spans.push({ text: t.slice(pos), hl: false });
      flow(spans, 10, 1.55, C.ink); y += 6;
    }
    if (cov && cov.runs.length) {
      h2("Highlighted segments");
      const prose = b.sentences.filter((s) => s.score !== null);
      for (const r of cov.runs) {
        const txt = prose.slice(r.from, r.to + 1).map((s) => s.text).join(" ");
        need(30); setF("bold", 9, r.lead ? C.warn : C.hlMark); doc.text(r.lead ? `Segment ${r.n} · screening lead` : `Segment ${r.n}`, MX, y); setF("normal", 8.5, C.mute);
        doc.text(clean(`${r.words} words · peak segment score ${Math.round(r.prob * 100)}/100`), W - MX, y, { align: "right" }); y += 12;
        para(txt.length > 420 ? txt.slice(0, 400).replace(/\s\S*$/, "") + " …" : txt, 8.8, C.ink); y += 6;
      }
    }

    // ===================== PART B · ALETHEIA deep analysis
    newPage();
    setF("normal", 9, C.mute); doc.text("PART B", MX, y); y += 26;
    doc.setFont("times", "bold"); doc.setFontSize(24); doc.setTextColor(...C.ink); doc.text(clean(R.levelLabel + ": deep analysis"), MX, y); y += 16;
    para(`Generated ${meta.date || ""} · analysis time ${(R.elapsedMs / 1000).toFixed(1)} s`, 9, C.mute);
    y += 10; const bx = y; doc.setFillColor(255, 255, 255); doc.setDrawColor(...C.line); doc.rect(MX, bx, W - 2 * MX, 118, "FD");
    doc.setFont("times", "bold"); doc.setFontSize(44); doc.setTextColor(...C.ink); doc.text(`${Math.round(R.deepScore * 100)}`, MX + 22, bx + 62);
    setF("normal", 8, C.mute); doc.text("DEEP SCORE / 100", MX + 22, bx + 78);
    doc.text(clean(`90% interval ${Math.round(R.ci[0] * 100)}–${Math.round(R.ci[1] * 100)}`), MX + 22, bx + 92);
    doc.setFont("times", "bold"); doc.setFontSize(17); doc.setTextColor(...C.ink); doc.text(clean(R.category), MX + 150, bx + 36);
    setF("normal", 9, C.mute);
    doc.splitTextToSize(clean(`Confidence ${R.confidence}. The verdict held in ${Math.round(R.stability * 100)}% of ${R.bootstrap.full} bootstrap re-analyses. Flagging threshold ${Math.round(R.thresholds.high * 100)}, review threshold ${Math.round(R.thresholds.low * 100)}. AI percentage (Part A): ${cov ? cov.display : "--"}.`), W - 2 * MX - 170).forEach((l, i) => doc.text(l, MX + 150, bx + 56 + i * 13));
    bar(MX + 150, bx + 100, W - 2 * MX - 172, R.deepScore, colOf(R.deepScore));
    y = bx + 140;
    h2("Document");
    kv([["Total words", String(b.totalWords)], ["Qualifying prose (words)", String(b.qualifyingWords)], ["Excluded: headings, lists, tables, equations, references", String(b.excludedWords)],
        ["Quoted words excluded", String(b.quotedWords)], ["Sentences", String(b.stats.sentences)], ["Language", b.language.name], ["Evidence amount", b.evidence]]);
    h2("How the result was reached");
    kv([["Standard engine (GBM document model)", `${(R.pGbm * 100).toFixed(1)} / 100`], ["n-gram stylometric model", `${(R.pNgram * 100).toFixed(1)} / 100`], ...(R.pGeneral != null ? [["General-writing n-gram model", `${(R.pGeneral * 100).toFixed(1)} / 100`]] : []),
        ["Combined deep score", `${(R.deepScore * 100).toFixed(1)} / 100`], ...(cov ? [["AI percentage (segment model)", `${(cov.pct * 100).toFixed(1)}% of ${cov.qualifyingWords} words · ${cov.runs.length} segments · ${cov.windows} windows of ~${cov.W} words`]] : []),
        ["Bootstrap re-analyses (n-gram / full engine)", `${R.bootstrap.ngram} / ${R.bootstrap.full}`],
        ["Window sizes (sentences)", R.windows.join(", ")], ["Writing register", R.register.academic ? `academic (p=${R.register.pAcademic.toFixed(2)}): strictest threshold` : R.register.creative ? `creative writing (p=${R.register.pCreative.toFixed(2)}): threshold calibrated on human fiction` : `general (academic p=${R.register.pAcademic.toFixed(2)}, creative p=${R.register.pCreative.toFixed(2)}): conservative threshold`],
        ["Engine / Deep model", `${b.version} / ${R.modelVersion}`]]);
    para("Stages: " + R.stages.map((s) => `${s.name} (from ${(s.at / 1000).toFixed(1)} s)`).join("; ") + ".", 7.5, C.mute);
    h2("Evidence from interpretable signals");
    for (const f of b.families) {
      need(26); setF("bold", 9); doc.text(clean(f.name), MX, y);
      doc.setFont("courier", "normal"); doc.text(clean(String(f.value)), W - MX, y, { align: "right" }); y += 11;
      para(f.detail, 8, C.mute); y += 3;
    }
    h2("Paragraph map");
    para("Deep score of each paragraph (0–100). A teal mark means the paragraph contains a highlighted segment from Part A.", 8, C.mute); y += 4;
    const segBlocks = new Set(b.sentences.filter((s) => s.segAI).map((s) => s.block));
    R.paragraphs.forEach((p, i) => {
      if (p.deep == null) return; need(18);
      doc.setFont("courier", "normal"); doc.setFontSize(8.5); doc.setTextColor(...C.mute); doc.text(`P${i + 1}`, MX, y + 5);
      if (segBlocks.has(p.block)) { doc.setFillColor(...C.hlMark); doc.rect(MX + 22, y - 1, 3, 8, "F"); }
      bar(MX + 28, y, 150, p.deep, colOf(p.deep)); doc.text(`${Math.round(p.deep * 100)}`, MX + 186, y + 5);
      setF("normal", 8.5); doc.text(clean(doc.splitTextToSize(clean(p.preview), W - 2 * MX - 210)[0] + "…"), MX + 210, y + 5); y += 18;
    });
    if (R.influence.length) {
      h2("Which paragraphs drive the result");
      para("Leave-one-paragraph-out: how much the deep score changes when each paragraph is removed (positive = the paragraph pushes towards AI-like).", 8.5, C.mute);
      R.influence.slice(0, 6).forEach((x) => { para(`P${x.para + 1}  ${x.delta >= 0 ? "+" : ""}${(x.delta * 100).toFixed(1)}  ·  ${x.preview}…`, 8.5); });
    }
    h2("Sentence scores");
    para("Each sentence with its deep sentence score (neighbourhood n-gram model + sentence model). [AI++] strong AI-like signals, [AI+] moderate, [H] human-like, [ ] inconclusive. A teal bar marks sentences inside a highlighted segment of Part A.", 8, C.mute); y += 4;
    const tag = { strong: "[AI++]", moderate: "[AI+]", human: "[H]", mixed: "[ ]" };
    for (const s of b.sentences.filter((s) => s.score !== null)) {
      const col = s.deepCat === "strong" ? C.red : s.deepCat === "moderate" ? C.amber : s.deepCat === "human" ? C.green : C.mute;
      setF("normal", 9.5); const ls = doc.splitTextToSize(clean(s.text), W - 2 * MX - 70);
      need(ls.length * 12.5 + 4);
      doc.setFillColor(...col); doc.rect(MX, y - 8, 3, ls.length * 12.5, "F");
      if (s.segAI) { doc.setFillColor(...C.hlMark); doc.rect(MX + 4.5, y - 8, 2, ls.length * 12.5, "F"); }
      doc.setFont("courier", "normal"); doc.setFontSize(7.5); doc.setTextColor(...col); doc.text(`${tag[s.deepCat] || ""} ${Math.round(s.deep * 100)}`, MX + 10, y);
      setF("normal", 9.5); ls.forEach((l, i) => doc.text(l, MX + 62, y + i * 12.5)); y += ls.length * 12.5 + 5;
    }
    h2("Limitations and fair use");
    para("ALETHEIA measures statistical and stylistic patterns associated with AI-generated text. It cannot prove who wrote a document, and its scores are not the probability that a particular person used AI. Formal, technical, template-based and non-native English writing can show AI-like patterns; edited or paraphrased AI text can look human. Do not use this report as the sole basis for any academic or employment decision; consider drafts, notes, version history and a conversation with the writer.", 9);
    y += 6;
    para(`Model provenance: the deep model (${R.modelVersion}) and the segment model (${cov ? cov.version : "n/a"}) were trained and calibrated on research datasets (Ghostbuster; Profiler, EMNLP 2025; DetectRL; a human / ChatGPT / QuillBot academic-abstract corpus; short fiction from 120+ language models, 2023-2026, from public creative-writing benchmarks; DACTYL, WildChat, HC3, RAID, Cosmopedia, M4; OUTFOX and GEDE student essays; 2026 text from 33 generators and 12 humanizers (wasitaigenerated and AI Humanizer benchmarks); 2026 text from about 60 further models (arena-prose, ELI5, research-paper and OpAI-Bench sets, incl. GPT-6, Claude Opus 5.5, Gemini 3.7); public-domain fiction, Wikipedia, learner essays and pre-2022 openly licensed news and textbooks) whose upstream rights are under review. Whole-document thresholds are calibrated separately for three writing registers (academic, creative, everything else) so that at most 1% of human texts in each calibration group are flagged; on held-out data the deep score flagged 0.14% of human texts overall. The AI percentage is calibrated so that at most 1% of human documents in each group reach 20%, and no calibration group is flagged more often than with the previous version. Performance on genres outside the training data and on humanizer-rewritten text is lower.`, 8, C.mute);

    // headers and footers on every page except the cover's header
    const N = doc.getNumberOfPages();
    for (let p = 1; p <= N; p++) {
      doc.setPage(p);
      logo(MX, 26, 18); setF("bold", 9.5, C.ink, "times"); doc.text("A L E T H E I A", MX + 24, 39);
      setF("normal", 7.5, C.mute); doc.text(clean(`Page ${p} of ${N} · AI Writing Report`), MX + 118, 39);
      doc.text(clean(`Scan ID ${scanId}`), W - MX, 39, { align: "right" });
      doc.setDrawColor(...C.line); doc.line(MX, 48, W - MX, 48);
      doc.line(MX, H - 40, W - MX, H - 40);
      doc.text(clean(`ALETHEIA · Page ${p} of ${N}`), MX, H - 28);
      doc.text("A detector score is not proof of authorship.", W - MX, H - 28, { align: "right" });
    }
    return doc.output("blob");
  }

  const api = { run, pdf, ngramProb, counts, murmur3, LEVELS, guard, scoresFromCounts, segWindows, coverage, explain, occurrencesOf, addWhy, AI_LEX, setModel };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.AletheiaDeep = api;
})(typeof window !== "undefined" ? window : globalThis);

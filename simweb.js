/* ALETHEIA Similarity (V1.9.8): checks one document against open web and publication sources and the user's own saved documents.
 * Sources: Wikipedia (MediaWiki API, exact-phrase search + plain-text extracts), OpenAlex (full-text n-gram search + abstracts),
 * documents saved in this browser (IndexedDB), and documents the user adds for this check. Optional general web search endpoint
 * (window.ALETHEIA_WEB_SEARCH, off by default). Only short phrases (8 words each, at most 40) leave the browser, and only after consent.
 * Matching: shared runs of at least 8 words (word 8-grams, case- and punctuation-insensitive). Each matched word is credited to one source
 * (the source with the most matched words first), so overlapping sources are not double-counted. Not proof of misconduct.
 */
(function (root) {
  "use strict";
  const N = 8;
  const STOP = new Set("a an the and or but if of to in on at by for with from as is are was were be been being it its this that these those there their they them he she his her we our you your i not no so than then too very can could will would should may might must do does did done has have had having which who whom whose what when where why how all any both each few more most other some such only own same into over under again further once here about against between through during before after above below up down out off also just".split(" "));
  const WORD = /[0-9A-Za-zÀ-ɏͰ-ϿЀ-ӿ]+(?:['’][A-Za-z]+)*/g;
  const ZW = /[​-‍⁠﻿­]/g;
  const ODDSPACE = /[ -   　 ]/g;

  function tokenize(text) {
    const out = []; WORD.lastIndex = 0; let m;
    while ((m = WORD.exec(text))) out.push({ w: m[0].normalize("NFKC").toLowerCase().replace(/’/g, "'"), s: m.index, e: m.index + m[0].length });
    return out;
  }
  // sentences with offsets
  // sentence ends: . ! ? or a line break; not after "et al.", "e.g.", "Fig." and similar, not inside decimals like 3.5,
  // and not when the next word starts in lower case (so "(Smith et al., 2020)." stays in its sentence)
  const ABBR = /(?:\bet al|\be\.g|\bi\.e|\betc|\bvs|\bcf|\bFig|\bfig|\bEq|\beq|\bp|\bpp|\bNo|\bno|\bVol|\bvol|\bDr|\bMr|\bMrs|\bMs|\bSt|\bed|\beds|\b[A-Z])$/;
  function sentences(text) {
    const out = []; let start = 0; const n = text.length;
    const push = (e) => { const seg = text.slice(start, e); if (seg.trim()) out.push({ s: start, e, text: seg }); start = e; };
    for (let i = 0; i < n; i++) {
      const c = text[i];
      if (c === "\n") { push(i + 1); continue; }
      if (c !== "." && c !== "!" && c !== "?") continue;
      let j = i; while (j + 1 < n && /[.!?]/.test(text[j + 1])) j++;
      while (j + 1 < n && /["”’)\]]/.test(text[j + 1])) j++;
      if (c === "." && /\d/.test(text[i - 1] || "") && /\d/.test(text[i + 1] || "")) continue;
      if (c === "." && ABBR.test(text.slice(Math.max(0, i - 8), i))) continue;
      const rest = text.slice(j + 1, j + 4).replace(/^[ \t]+/, "");
      if (rest && /^[a-z,;:]/.test(rest)) continue;
      push(j + 1); i = j;
    }
    if (start < n) push(n);
    return out;
  }
  function bibStart(text) {
    const re = /^[ \t]*(?:\d+[.)]?\s*)?(references|reference list|bibliography|works cited|sources|literature cited)\s*:?[ \t]*$/gim; let m, last = -1;
    while ((m = re.exec(text))) { const pos = m.index / Math.max(1, text.length); if (pos >= (/^\s*(?:\d+[.)]?\s*)?sources/i.test(m[0]) ? 0.6 : 0.3)) last = m.index; }
    return last;
  }
  function quoteSpans(text) {
    const out = []; let m;
    const re = /“[^”]{3,800}”|"[^"\n]{3,800}"/g;
    while ((m = re.exec(text))) out.push([m.index, m.index + m[0].length]);
    // single quotes (common in Australian and British writing); must open after a space or bracket and close before one, so apostrophes don't count
    const re2 = /(^|[\s(\[—–-])(‘[^‘\n]{3,600}?’|'[^'\n]{3,600}?')(?=[\s.,;:!?)\]—–]|$)/gm;
    while ((m = re2.exec(text))) { const a = m.index + m[1].length; if (!out.some(([x, y]) => a >= x && a < y)) out.push([a, a + m[2].length]); }
    return out;
  }
  const CITE = /\((?:[A-Z][A-Za-z'’\-]+(?:\s+(?:et al\.|and|&)\s*[A-Z]?[A-Za-z'’\-]*)?,?\s+(?:\d{4}[a-z]?|n\.d\.)(?:[,;][^)]{0,40})?)\)|\[\d+(?:\s*[,–-]\s*\d+)*\]|\((?:\d{4}|n\.d\.)\)|\b[A-Z][A-Za-z'’\-]+(?: et al\.)? \((?:\d{4}|n\.d\.)\)/;

  function prepare(text) {
    const toks = tokenize(text), sents = sentences(text), bib = bibStart(text), quotes = quoteSpans(text);
    const inQuote = (o) => quotes.some(([a, b]) => o >= a && o < b);
    // token -> sentence index
    let si = 0; for (const t of toks) { while (si < sents.length - 1 && t.s >= sents[si].e) si++; t.sent = si; t.bib = bib >= 0 && t.s >= bib; t.quote = inQuote(t.s); }
    const cited = sents.map((s) => CITE.test(s.text));
    return { text, toks, sents, bib, quotes, cited };
  }

  // choose up to maxQ 8-word phrases, spread across the document, from sentences of 10+ words outside the bibliography
  function pickQueries(P, maxQ) {
    const bySent = new Map();
    P.toks.forEach((t, i) => { if (t.bib) return; if (!bySent.has(t.sent)) bySent.set(t.sent, []); bySent.get(t.sent).push(i); });
    const cands = [];
    for (const [s, idx] of bySent) {
      if (idx.length < 10) continue;
      let best = -1, bestScore = -1;
      for (let k = 0; k + N <= idx.length; k++) {
        const ws = idx.slice(k, k + N).map((i) => P.toks[i].w);
        if (ws.filter((w) => /^\d+$/.test(w)).length > 2) continue;
        const sc = ws.filter((w) => !STOP.has(w) && w.length > 2).length - Math.abs(k - (idx.length - N) / 2) * 0.05;
        if (sc > bestScore) { bestScore = sc; best = k; }
      }
      if (best < 0 || bestScore < 3) continue;
      const ti = idx.slice(best, best + N);
      cands.push({ sent: s, tok: ti, q: ti.map((i) => P.toks[i].w).join(" ") });
    }
    if (cands.length <= maxQ) return cands;
    const step = cands.length / maxQ, out = [];
    for (let k = 0; k < maxQ; k++) out.push(cands[Math.floor(k * step)]);
    return out;
  }

  // polite per-host fetch queue
  const sleep = (ms, signal) => new Promise((res, rej) => { const t = setTimeout(res, ms); if (signal) signal.addEventListener("abort", () => { clearTimeout(t); rej(new Error("cancelled")); }, { once: true }); });
  function queue(maxInFlight, spacing, signal) {
    let inFlight = 0, next = 0, limited = 0; const q = [];
    const pump = () => {
      if (signal && signal.aborted) { while (q.length) q.shift().rej(new Error("cancelled")); return; }
      // after 3 rate-limit answers in a row, stop asking this service (the rest count as failed searches)
      if (limited >= 3) { while (q.length) q.shift().rej(new Error("rate-limited")); return; }
      if (inFlight >= maxInFlight || !q.length) return;
      const now = Date.now(), wait = Math.max(0, next - now); next = Math.max(now, next) + spacing;
      const job = q.shift(); inFlight++;
      setTimeout(async () => {
        try { const j = await getJSON(job.url, signal); limited = 0; job.res(j); } catch (e) { if (e && e.limited) limited++; job.rej(e); } finally { inFlight--; pump(); }
      }, wait);
      pump();
    };
    return (url) => new Promise((res, rej) => { q.push({ url, res, rej }); pump(); });
  }
  async function getJSON(url, signal) {
    let delay = 1000;
    for (let a = 0; a < 2; a++) {
      if (signal && signal.aborted) throw new Error("cancelled");
      const c = new AbortController(), t = setTimeout(() => c.abort(), 15000);
      const off = signal ? () => c.abort() : null; if (signal) signal.addEventListener("abort", off, { once: true });
      let r;
      try { r = await fetch(url, { signal: c.signal, headers: { Accept: "application/json" } }); }
      catch (e) { clearTimeout(t); if (signal && signal.aborted) throw new Error("cancelled"); if (a === 1) throw e; await sleep(delay, signal); delay *= 2; continue; }
      finally { if (signal) signal.removeEventListener("abort", off); }
      clearTimeout(t);
      if (r.status === 429 || r.status >= 500) { if (a === 1) { const e = new Error("HTTP " + r.status); e.limited = r.status === 429; throw e; } const ra = parseFloat(r.headers.get("Retry-After") || ""); await sleep(isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 5000) : delay, signal); delay *= 2; continue; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    }
  }

  const absText = (inv) => { if (!inv) return ""; const arr = []; for (const [w, pos] of Object.entries(inv)) for (const p of pos) arr[p] = w; return arr.filter(Boolean).join(" "); };
  const shingles = (toks) => { const S = new Set(); for (let i = 0; i + N <= toks.length; i++) S.add(toks.slice(i, i + N).map((t) => t.w).join(" ")); return S; };

  // ---- local library (IndexedDB): documents the user chose to save on this device
  const DB = "aletheia-sim", ST = "docs";
  function idb() { return new Promise((res, rej) => { if (!root.indexedDB) return rej(new Error("no IndexedDB")); const r = root.indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(ST, { keyPath: "id" }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  async function libList() { try { const d = await idb(); return await new Promise((res) => { const t = d.transaction(ST).objectStore(ST).getAll(); t.onsuccess = () => res(t.result || []); t.onerror = () => res([]); }); } catch (e) { return []; } }
  async function libSave(name, text) {
    const d = await idb(), h = hash(text);
    const doc = { id: h, name: String(name || "Untitled").slice(0, 120), savedAt: new Date().toISOString(), words: tokenize(text).length, text };
    await new Promise((res, rej) => { const t = d.transaction(ST, "readwrite"); t.objectStore(ST).put(doc); t.oncomplete = res; t.onerror = () => rej(t.error); });
    return doc;
  }
  async function libDelete(id) { const d = await idb(); await new Promise((res) => { const t = d.transaction(ST, "readwrite"); if (id) t.objectStore(ST).delete(id); else t.objectStore(ST).clear(); t.oncomplete = res; t.onerror = res; }); }
  function hash(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return "d" + h.toString(16) + s.length.toString(16); }

  // ---- integrity flags: hidden characters, mixed alphabets, hidden or white text in .docx
  function integrity(text, docxXml) {
    const flags = [];
    const zw = (text.match(ZW) || []).length; if (zw) flags.push({ key: "hidden_chars", n: zw });
    const odd = (text.match(ODDSPACE) || []).length; if (odd > 20) flags.push({ key: "odd_spaces", n: odd });
    let mixed = 0; for (const t of tokenize(text)) { const w = t.w; if (/[a-z]/.test(w) && /[Ͱ-ϿЀ-ӿ]/.test(w)) mixed++; }
    if (mixed) flags.push({ key: "mixed_alphabet", n: mixed });
    if (docxXml) {
      let hidden = 0, white = 0, tiny = 0;
      // white text on a shaded table cell or paragraph (e.g. a template's table header) is visible, so mask those regions first
      const shaded = (x) => /<w:shd [^>]*w:fill="(?!FFFFFF|ffffff|auto)[0-9A-Fa-f]{6}"/.test(x);
      const xml = docxXml.replace(/<w:tc>[\s\S]*?<\/w:tc>|<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g, (c) => { const pr = (c.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/) || [""])[0]; return shaded(pr) ? c.replace(/<w:color w:val="(?:FFFFFF|ffffff)"\s*\/>/g, "") : c; })
        .replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (pp) => { const pr = (pp.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [""])[0].replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, ""); return shaded(pr) ? pp.replace(/<w:color w:val="(?:FFFFFF|ffffff)"\s*\/>/g, "") : pp; });
      const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g; let m;
      while ((m = runRe.exec(xml))) {
        const r = m[1], words = (r.match(/<w:t\b[^>]*>([^<]*)<\/w:t>/g) || []).map((x) => x.replace(/<[^>]+>/g, "")).join(" ").trim().split(/\s+/).filter(Boolean).length;
        if (!words) continue;
        const rpr = (r.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/) || [])[1] || "";
        if (/<w:vanish\s*\/>|<w:vanish w:val="(?:1|true|on)"/.test(rpr)) hidden += words;
        if (/<w:color w:val="(?:FFFFFF|ffffff)"/.test(rpr) && !shaded(rpr) && !/<w:highlight w:val="(?!none|white)/.test(rpr)) white += words;
        const sz = rpr.match(/<w:sz w:val="(\d+)"/); if (sz && +sz[1] <= 6) tiny += words;
      }
      if (hidden) flags.push({ key: "hidden_text", n: hidden }); if (white) flags.push({ key: "white_text", n: white }); if (tiny) flags.push({ key: "tiny_text", n: tiny });
    }
    return flags;
  }

  // ---- the check
  async function check(text, opts = {}) {
    const prog = opts.onProgress || (() => {}), signal = opts.signal;
    const P = prepare(text);
    const maxQ = opts.maxQueries || 40;
    const Q = opts.online ? pickQueries(P, maxQ) : [];
    const sources = []; // {id,type:'internet'|'publication'|'local'|'provided', title, url, year, toks, phraseQ:Set}
    const byKey = new Map();
    const addSource = (key, o) => { if (byKey.has(key)) return byKey.get(key); const s = Object.assign({ id: key, phraseQ: new Set() }, o); byKey.set(key, s); sources.push(s); return s; };
    // OpenAlex gives each address a small free daily budget, so only every other phrase (at most 15) is searched there
    const QO = Q.map((q, qi) => qi).filter((qi, k) => k % 2 === 0).slice(0, 15);
    let done = 0, total = Q.length + QO.length + 1, failed = { wiki: 0, openalex: 0, web: 0, pages: 0 }, searches = { wiki: Q.length, openalex: QO.length, pages: 0 };
    const ab = (e) => { if ((signal && signal.aborted) || (e && e.message === "cancelled")) throw new Error("cancelled"); };
    const tick = (stage) => { done++; prog({ stage, frac: Math.min(0.95, done / Math.max(1, total)) }); };

    if (opts.online && Q.length) {
      const wq = queue(3, 120, signal), oq = queue(1, 1050, signal);
      const lang = opts.wikiLang || "en";
      const wikiTitles = new Map();
      const jobs = [];
      for (const [qi, q] of Q.entries()) {
        jobs.push(wq(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=2&srwhat=text&srsearch=${encodeURIComponent('"' + q.q + '"')}`)
          .then((j) => { for (const h of ((j.query || {}).search || [])) { const t = h.title; if (!wikiTitles.has(t)) wikiTitles.set(t, new Set()); wikiTitles.get(t).add(qi); } })
          .catch((e) => { ab(e); failed.wiki++; }).finally(() => tick("Searching Wikipedia and OpenAlex")));
      }
      for (const qi of QO) { const q = Q[qi];
        jobs.push(oq(`https://api.openalex.org/works?per-page=3&select=id,title,doi,publication_year,primary_location,abstract_inverted_index&filter=fulltext.search:${encodeURIComponent('"' + q.q + '"')}`)
          .then((j) => { for (const w of (j.results || [])) { const s = addSource("oa:" + w.id, { type: "publication", title: w.title || "Untitled work", url: w.doi || w.id, year: w.publication_year, venue: w.primary_location && w.primary_location.source ? w.primary_location.source.display_name : "", toks: tokenize(absText(w.abstract_inverted_index)) }); s.phraseQ.add(qi); } })
          .catch((e) => { ab(e); failed.openalex++; }).finally(() => tick("Searching Wikipedia and OpenAlex")));
      }
      if (opts.webSearch) {
        jobs.push(fetch(opts.webSearch, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queries: Q.map((q) => q.q) }), signal })
          .then((r) => r.json()).then((j) => { for (const h of (j.results || [])) { const s = addSource("web:" + h.url, { type: "internet", title: h.title || h.url, url: h.url, toks: tokenize(h.text || h.snippet || "") }); (h.queries || []).forEach((qi) => s.phraseQ.add(qi)); } })
          .catch((e) => { ab(e); failed.web++; }));
      }
      await Promise.all(jobs); ab();
      // Wikipedia page texts (at most 12 pages, the ones hit by the most phrases first)
      const titles = [...wikiTitles.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 12);
      total += titles.length; searches.pages = titles.length;
      await Promise.all(titles.map(([t, qs]) => wq(`https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&origin=*&redirects=1&titles=${encodeURIComponent(t)}`)
        .then((j) => { const p = Object.values((j.query || {}).pages || {})[0] || {}; const s = addSource("wiki:" + t, { type: "internet", title: t + " (Wikipedia)", url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, "_"))}`, toks: tokenize(p.extract || "") }); if (s.toks.length < N) qs.forEach((q) => s.phraseQ.add(q)); })
        .catch((e) => { ab(e); failed.pages++; }).finally(() => tick("Reading matched pages"))));
      ab();
    }
    // local library + documents provided for this check
    const docHash = hash(text);
    let sameInLibrary = false;
    if (opts.useLibrary) for (const d of await libList()) { if (d.id === docHash) { sameInLibrary = true; continue; } addSource("lib:" + d.id, { type: "local", title: d.name, savedAt: d.savedAt, toks: tokenize(d.text) }); }
    for (const [k, d] of (opts.extra || []).entries()) addSource("x:" + k, { type: "provided", title: d.name || `Source ${k + 1}`, toks: tokenize(d.text || "") });

    prog({ stage: "Comparing", frac: 0.97 });
    const R = compare(P, Q, sources);
    R.queries = Q.length; R.failed = failed; R.searches = searches;
    const tried = searches.wiki + searches.openalex, bad = failed.wiki + failed.openalex;
    R.searchFailed = !!opts.online && Q.length > 0 && tried > 0 && bad / tried > 0.5;
    R.noQueries = !!opts.online && Q.length === 0; R.usedLibrary = !!opts.useLibrary; R.sameInLibrary = sameInLibrary; R.online = !!opts.online;
    R.flags = integrity(text, opts.docxXml || null);
    R.docHash = docHash; R.at = new Date().toISOString();
    prog({ stage: "Done", frac: 1 });
    return R;
  }

  // credit matched words to sources; filters can be changed later without new searches (recompute)
  function compare(P, Q, sources) {
    const nT = P.toks.length;
    for (const s of sources) {
      const cov = new Uint8Array(nT);
      if (s.toks && s.toks.length >= N) {
        const S = shingles(s.toks);
        for (let i = 0; i + N <= nT; i++) { const k = P.toks.slice(i, i + N).map((t) => t.w).join(" "); if (S.has(k)) for (let j = i; j < i + N; j++) cov[j] = 1; }
      }
      // full-text phrase hits (OpenAlex full text, general web) where the source text itself is not available
      for (const qi of s.phraseQ) for (const ti of Q[qi].tok) cov[ti] = 1;
      s.cov = cov; s.raw = cov.reduce((a, b) => a + b, 0);
    }
    return { P, Q, sources, nT };
  }

  // apply filters and build the report numbers
  function summarise(R, f = {}) {
    const exBib = f.excludeBibliography !== false, exQuote = !!f.excludeQuotes, minRun = f.minWords || N;
    const P = R.P, nT = R.nT, use = new Uint8Array(nT);
    let denom = 0; for (let i = 0; i < nT; i++) { const t = P.toks[i]; if ((exBib && t.bib) || (exQuote && t.quote)) continue; use[i] = 1; denom++; }
    // each source keeps only its own matching runs of at least minRun words (counted on the words still in use) ...
    const eff = R.sources.map((s) => { const c = new Uint8Array(nT); let i = 0;
      while (i < nT) { if (!(use[i] && s.cov[i])) { i++; continue; } let j = i; while (j < nT && use[j] && s.cov[j]) j++; if (j - i >= minRun) for (let k = i; k < j; k++) c[k] = 1; i = j; }
      let n = 0; for (let k = 0; k < nT; k++) n += c[k]; return { s, c, n }; });
    // ... then each word is credited to one source only, the source with the most matching words first
    const order = eff.filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
    const owner = new Int16Array(nT).fill(-1);
    order.forEach((x, k) => { for (let i = 0; i < nT; i++) if (x.c[i] && owner[i] < 0) owner[i] = k; });
    const credited = order.map(() => 0); let matched = 0;
    for (let i = 0; i < nT; i++) if (owner[i] >= 0) { credited[owner[i]]++; matched++; }
    const kept = order.map((x, k) => ({ s: x.s, k, words: credited[k] })).filter((x) => x.words > 0).sort((a, b) => b.words - a.words);
    const num = new Map(); kept.forEach((x, i) => num.set(x.k, i + 1));
    // blocks and match groups
    const blocks = []; const groups = { none: 0, cited: 0, quoted: 0, both: 0 };
    for (let i = 0; i < nT;) {
      if (owner[i] < 0) { i++; continue; } let j = i; while (j < nT && owner[j] === owner[i]) j++;
      const mid = P.toks[Math.floor((i + j - 1) / 2)], q = mid.quote, c = !!P.cited[mid.sent];
      const g = q && c ? "both" : q ? "quoted" : c ? "cited" : "none"; groups[g] += j - i;
      blocks.push({ from: i, to: j - 1, s: P.toks[i].s, e: P.toks[j - 1].e, n: num.get(owner[i]), group: g });
      i = j;
    }
    const pct = (k) => (denom ? k / denom : 0);
    const srcList = kept.map((x, i) => ({ n: i + 1, type: x.s.type, title: x.s.title, url: x.s.url || "", year: x.s.year || "", venue: x.s.venue || "", savedAt: x.s.savedAt || "", words: x.words, pct: pct(x.words), phraseOnly: x.s.type === "publication" || !x.s.toks || x.s.toks.length < N }));
    const byType = { internet: 0, publication: 0, local: 0, provided: 0 };
    kept.forEach((x) => { byType[x.s.type] = (byType[x.s.type] || 0) + x.words; });
    return { overall: pct(matched), matched, denom, totalWords: nT, groups, groupsPct: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, pct(v)])),
             byType, byTypePct: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, pct(v)])), sources: srcList, blocks, filters: { excludeBibliography: exBib, excludeQuotes: exQuote, minWords: minRun },
             bibliographyFound: P.bib >= 0 };
  }

  const fmtPct = (p) => (p <= 0 ? "0%" : p < 0.01 ? "<1%" : Math.round(p * 100) + "%");
  const PAL = [[255, 196, 196], [196, 222, 255], [204, 240, 204], [255, 226, 180], [230, 205, 250], [255, 210, 235], [200, 240, 240], [240, 240, 190], [215, 215, 215], [250, 215, 200], [210, 230, 200], [225, 215, 245]];
  const PAL_INK = [[176, 40, 40], [30, 90, 170], [30, 120, 60], [170, 100, 10], [120, 60, 170], [170, 40, 110], [20, 120, 120], [120, 120, 20], [90, 90, 90], [160, 80, 50], [70, 110, 50], [100, 80, 160]];
  const TYPE_EN = { internet: "Internet", publication: "Publication", local: "Saved document", provided: "Provided source" };
  const GROUP_EN = { none: ["Not cited or quoted", "Matches with neither in-text citation nor quotation marks"], cited: ["Cited but not quoted", "Matches with an in-text citation nearby but no quotation marks"], quoted: ["Quoted but not cited", "Matches in quotation marks without an in-text citation"], both: ["Cited and quoted", "Matches in quotation marks with an in-text citation"] };
  const FLAG_EN = { hidden_chars: ["Hidden characters", "Zero-width or soft-hyphen characters inside the text. They can split words so that matches are missed."], odd_spaces: ["Unusual spaces", "Many non-standard space characters. They can come from PDFs or web pages, or be used to break up matches."], mixed_alphabet: ["Mixed alphabets", "Words that mix Latin letters with look-alike Greek or Cyrillic letters, a known way to hide copied text."], hidden_text: ["Hidden text", "Words formatted as hidden in the Word file."], white_text: ["White text", "Words coloured white in the Word file, invisible on a white page."], tiny_text: ["Tiny text", "Words in a font of 3 points or smaller in the Word file."] };

  // ---- PDF report (jsPDF), same visual language as the AI writing report
  function pdf(R, S, meta = {}) {
    const { jsPDF } = root.jspdf; const doc = new jsPDF({ unit: "pt", format: "a4", compress: true });
    const W = 595.28, H = 841.89, MX = 54, TOP = 78, BOTTOM = H - 58, FONTS = root.AletheiaReportFonts; let SANS = "helvetica";
    if (FONTS) { try { doc.addFileToVFS("DejaVuSans.ttf", FONTS.regular); doc.addFont("DejaVuSans.ttf", "DejaVu", "normal"); doc.addFileToVFS("DejaVuSans-Bold.ttf", FONTS.bold); doc.addFont("DejaVuSans-Bold.ttf", "DejaVu", "bold"); doc.addFileToVFS("DejaVuSans-Oblique.ttf", FONTS.italic); doc.addFont("DejaVuSans-Oblique.ttf", "DejaVu", "italic"); SANS = "DejaVu"; } catch (e) { SANS = "helvetica"; } }
    const uni = SANS === "DejaVu";
    const clean = (s) => { s = String(s ?? "").replace(/[­​-‏⁠﻿]/g, ""); return uni ? s.replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-ɏˆ-˝Ͱ-ϿЀ-ӿ -⏿■-◿]/g, "?") : s.replace(/[“”„]/g, '"').replace(/[‘’‚]/g, "'").replace(/[—–]/g, "-").replace(/…/g, "...").replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "?"); };
    const C = { ink: [16, 17, 20], mute: [110, 112, 120], gold: [185, 154, 91], line: [220, 216, 205], soft: [246, 245, 241], warn: [150, 102, 20], warnBg: [253, 246, 231], amber: [201, 161, 74], paper: [255, 255, 255] };
    let y = TOP, page = 1;
    const setF = (st = "normal", sz = 9.5, col = C.ink, face = SANS) => { doc.setFont(face, st); doc.setFontSize(sz); doc.setTextColor(...col); };
    const newPage = () => { doc.addPage(); page++; y = TOP; };
    const need = (h) => { if (y + h > BOTTOM) newPage(); };
    const para = (t, sz = 9.5, col = C.ink, st = "normal", w = W - 2 * MX, x = MX, lh = 1.45) => { setF(st, sz, col); for (const ln of doc.splitTextToSize(clean(t), w)) { need(sz * lh); doc.text(ln, x, y); y += sz * lh; } };
    const rule = () => { doc.setDrawColor(...C.line); doc.line(MX, y, W - MX, y); };
    const head = (t) => { need(44); y += 6; setF("bold", 12); doc.text(clean(t), MX, y); y += 8; rule(); y += 18; };
    const logo = (x, y0, s) => { const k = s / 48; doc.setFillColor(...C.ink); const tri = (p) => doc.triangle(x + p[0] * k, y0 + p[1] * k, x + p[2] * k, y0 + p[3] * k, x + p[4] * k, y0 + p[5] * k, "F"); tri([22, 4.5, 4, 44, 22, 44]); tri([26, 4.5, 44, 44, 26, 44]); doc.setFillColor(...C.paper); doc.rect(x, y0 + 30.5 * k, 48 * k, 1.6 * k, "F"); doc.setFillColor(...C.gold); doc.rect(x + 23.1 * k, y0 + 11 * k, 1.8 * k, 33 * k, "F"); };
    const title = (meta.file || "Pasted text").replace(/\.(docx|pdf|txt|md)$/i, ""), scanId = "aln-sim:" + R.docHash.slice(1, 13);
    const kv = (rows) => { for (const [k, v] of rows) { need(16); setF("normal", 9, C.mute); doc.text(clean(k), MX, y); setF("normal", 9, C.ink); const vv = doc.splitTextToSize(clean(v), W - 2 * MX - 190); vv.forEach((l, i) => doc.text(l, W - MX, y + i * 11, { align: "right" })); y += 16 + (vv.length - 1) * 11; } };

    // page 1: cover
    y = 150; setF("normal", 9, C.mute); doc.text("SIMILARITY REPORT", MX, y); y += 26;
    setF("bold", 24); doc.splitTextToSize(clean(title), W - 2 * MX).slice(0, 3).forEach((l) => { doc.text(l, MX, y); y += 28; });
    y += 4; setF("normal", 10, C.mute); doc.text(clean(`ALETHEIA V${meta.version || "1.9.8"} · Similarity Check`), MX, y); y += 40;
    head("Document details");
    kv([["Scan ID", scanId], ["Checked", meta.date || new Date(R.at).toLocaleString()], ["File name", meta.file || "Pasted text"], ["Words", R.nT.toLocaleString("en-US")], ["Characters", R.P.text.length.toLocaleString("en-US")],
        ["Sources searched", [R.online ? "Wikipedia, OpenAlex full text" + (meta.webSearch ? ", general web" : "") : "", R.usedLibrary ? "documents saved on this device" : ""].filter(Boolean).join(", ").replace(/^d/, "D") || "None"],
        ["Phrases searched", R.online ? `${R.queries} on Wikipedia, ${R.searches ? R.searches.openalex : R.queries} on OpenAlex` : "0"]]);
    y += 10; setF("normal", 8.5, C.mute);
    const intro = doc.splitTextToSize(clean("This report has two parts. Part A gives the overall similarity, how the matches were used, the top sources and integrity flags. Part B shows the document with each match highlighted and numbered by source. A match shows shared wording, not misconduct: quotations, common phrases and shared task wording also match. ALETHEIA searches open sources only, so it can miss copied text that Turnitin's private database would find."), W - 2 * MX - 24);
    doc.setFillColor(...C.soft); doc.rect(MX, y, W - 2 * MX, intro.length * 12 + 20, "F"); setF("normal", 8.5, C.mute); intro.forEach((l, i) => doc.text(l, MX + 12, y + 18 + i * 12));

    // page 2: overview
    newPage();
    setF("bold", 40); doc.text(fmtPct(S.overall), MX, y + 20); setF("normal", 12, C.mute); doc.text("Overall similarity", MX + 110, y + 4);
    setF("normal", 9, C.mute); doc.splitTextToSize(clean(`${S.matched.toLocaleString("en-US")} of ${S.denom.toLocaleString("en-US")} words are in passages of ${S.filters.minWords}+ words that also appear in a source. Each word is credited to one source only.`), W - 2 * MX - 110).forEach((l, i) => doc.text(l, MX + 110, y + 20 + i * 11));
    y += 56;
    const fails = R.failed ? R.failed.wiki + R.failed.openalex : 0, tried = R.searches ? R.searches.wiki + R.searches.openalex : 0;
    const warn = R.searchFailed ? `INCOMPLETE: ${fails} of ${tried} online searches failed (network or rate limit). This percentage is not a reliable result; run the check again later.`
      : R.noQueries ? "No phrases could be searched online (the text has no sentences of 10 or more words in a supported script), so only saved documents were compared."
      : fails ? `${fails} of ${tried} online searches failed, so some matches may be missing.` : "";
    if (warn) { const wl = doc.splitTextToSize(clean(warn), W - 2 * MX - 24); doc.setFillColor(...C.warnBg); doc.rect(MX, y - 6, W - 2 * MX, wl.length * 12 + 14, "F"); setF(R.searchFailed ? "bold" : "normal", 9, C.warn); wl.forEach((l, i) => doc.text(l, MX + 12, y + 8 + i * 12)); y += wl.length * 12 + 22; }
    const filt = [S.filters.excludeBibliography ? (S.bibliographyFound ? "Bibliography" : "Bibliography (none found)") : null, S.filters.excludeQuotes ? "Quoted text" : null, `Matches under ${S.filters.minWords} words`].filter(Boolean);
    setF("normal", 9, C.mute); doc.text(clean("Filtered from the report: " + filt.join(" · ")), MX, y); y += 26;
    head("Match groups");
    for (const g of ["none", "cited", "quoted", "both"]) { need(30); setF("bold", 10); doc.text(clean(`${GROUP_EN[g][0]}  ${fmtPct(S.groupsPct[g])}`), MX, y); setF("normal", 8.5, C.mute); doc.text(clean(GROUP_EN[g][1]), MX, y + 12); y += 30; }
    head("Top sources by type");
    for (const [k, lab] of [["internet", "Internet sources"], ["publication", "Publications"], ["local", "Documents saved on this device"], ["provided", "Sources you added"]]) { if (k === "provided" && !S.byType.provided) continue; need(18); setF("bold", 10); doc.text(fmtPct(S.byTypePct[k] || 0), MX, y); setF("normal", 10); doc.text(lab, MX + 50, y); y += 18; }
    y += 6; head("Integrity flags");
    if (!R.flags.length) { para("No hidden characters, mixed alphabets or hidden text were found.", 9.5, C.mute); }
    for (const fl of R.flags) { need(30); setF("bold", 10, C.warn); doc.text(clean(`${FLAG_EN[fl.key][0]}: ${fl.n.toLocaleString("en-US")}`), MX, y); y += 12; para(FLAG_EN[fl.key][1], 8.5, C.mute); y += 6; }
    y += 4; para("A flag is not necessarily a problem. It points to something worth a look.", 8.5, C.mute, "italic");

    // sources list
    head("Sources");
    if (!S.sources.length) para("No source shares a passage of " + S.filters.minWords + " or more words with this document.", 9.5, C.mute);
    S.sources.forEach((s) => {
      need(40); const col = PAL[(s.n - 1) % PAL.length], ink = PAL_INK[(s.n - 1) % PAL_INK.length];
      doc.setFillColor(...col); doc.rect(MX, y - 10, 20, 14, "F"); setF("bold", 9, ink); doc.text(String(s.n), MX + 10, y, { align: "center" });
      setF("normal", 8, C.mute); doc.text(clean(TYPE_EN[s.type] + (s.type === "publication" ? " · phrase found in the full text; only the abstract was compared" : s.phraseOnly ? " · phrase found in full text" : "")), MX + 30, y - 2);
      setF("bold", 9.5); const tl = doc.splitTextToSize(clean(s.title + (s.year ? ` (${s.year})` : "")), W - 2 * MX - 90); tl.slice(0, 2).forEach((l, i) => doc.text(i === 1 && tl.length > 2 ? l.replace(/\s*\S{0,3}$/, "") + "…" : l, MX + 30, y + 10 + i * 11));
      setF("bold", 11); doc.text(fmtPct(s.pct), W - MX, y + 4, { align: "right" });
      let yy = y + 10 + Math.min(2, tl.length) * 11; if (s.url) { setF("normal", 8, C.mute); doc.text(clean(s.url).slice(0, 95), MX + 30, yy); yy += 10; }
      y = yy + 10;
    });

    // part B: document with highlights
    newPage(); setF("normal", 9, C.mute); doc.text("PART B · DOCUMENT WITH MATCHES", MX, y); y += 24;
    const text = R.P.text, starts = new Map(), owner = new Map();
    S.blocks.forEach((b) => { starts.set(b.s, b.n); for (let i = b.from; i <= b.to; i++) owner.set(R.P.toks[i].s, b.n); });
    const sz = 9.5, lh = 14; setF("normal", sz);
    const paras = text.split(/\n+/); let off = 0;
    for (const ptxt of paras) {
      const pStart = text.indexOf(ptxt, off); off = pStart + ptxt.length;
      if (!ptxt.trim()) continue;
      need(lh); let x = MX; const re = /\S+\s*/g; let m;
      while ((m = re.exec(ptxt))) {
        const chunk = m[0], abs = pStart + m.index, word = chunk.trimEnd();
        // find token at this word start (first token whose start is inside the chunk)
        let n = null; for (let k = abs; k < abs + word.length; k++) if (owner.has(k)) { n = owner.get(k); break; }
        const st = [...starts.keys()].find((k) => k >= abs && k < abs + word.length);
        const label = st != null ? String(starts.get(st)) : null;
        setF("normal", sz); const wW = doc.getTextWidth(clean(word)), sW = doc.getTextWidth(" "), lW = label ? (setF("bold", 6.5), doc.getTextWidth(label) + 4) : 0;
        if (x + lW + wW > W - MX) { y += lh; x = MX; need(lh); }
        if (lW + wW > W - 2 * MX) { // a very long token (URL): break it over several lines
          setF("normal", sz, C.ink); const parts = doc.splitTextToSize(clean(word), W - 2 * MX - lW - 2);
          parts.forEach((pt, pi) => { if (pi) { y += lh; x = MX; need(lh); } if (n) { doc.setFillColor(...PAL[(n - 1) % PAL.length]); doc.rect(x - 0.5, y - 9.5, doc.getTextWidth(pt) + 1, 12.5, "F"); } setF("normal", sz, C.ink); doc.text(pt, x, y); x += doc.getTextWidth(pt); });
          x += sW; continue;
        }
        if (label) { const ink = PAL_INK[(+label - 1) % PAL_INK.length]; doc.setFillColor(...ink); doc.rect(x, y - 8, lW - 1, 9, "F"); setF("bold", 6.5, C.paper); doc.text(label, x + 1.5, y - 1.5); x += lW; }
        if (n) { const col = PAL[(n - 1) % PAL.length]; doc.setFillColor(...col); doc.rect(x - 0.5, y - 9.5, wW + (chunk.length > word.length ? sW : 0) + 1, 12.5, "F"); }
        setF("normal", sz, C.ink); doc.text(clean(word), x, y); x += wW + (chunk.length > word.length ? sW : 0);
      }
      y += lh + 5;
    }
    // footers
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) { doc.setPage(i); logo(MX, 26, 18); setF("bold", 8.5); doc.text("ALETHEIA", MX + 24, 39); setF("normal", 7.5, C.mute); doc.text(clean(`Similarity report · ${scanId}`), W - MX, 39, { align: "right" }); doc.setDrawColor(...C.line); doc.line(MX, 48, W - MX, 48);
      setF("normal", 7.5, C.mute); doc.text(`Page ${i} of ${pages}`, W - MX, H - 30, { align: "right" }); doc.text(clean("Shared wording is not proof of misconduct. Review each match in context."), MX, H - 30); }
    return doc.output("blob");
  }

  const api = { check, summarise, recompare: compare, pdf, libList, libSave, libDelete, integrity, tokenize, prepare, pickQueries, fmtPct, PAL, PAL_INK, GROUP_EN, FLAG_EN, TYPE_EN, N };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.AletheiaSim = api;
})(typeof window !== "undefined" ? window : globalThis);

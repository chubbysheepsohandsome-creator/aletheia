/* ALETHEIA .docx reader: body text in reading order, with equations and tables kept.
 * mammoth's raw-text mode drops Word equations (OMML), which leaves sentences such as "For each test, , represents ..."
 * and changes both the word count and the n-gram statistics. This reader linearises equations ("Z_(n+1) = Z_n^4 + c"),
 * keeps table cells as their own paragraphs, marks heading styles, and reads Word's own page/word counts.
 * Works in browsers (DecompressionStream) and Node (zlib). No dependencies.
 */
(function (root) {
  "use strict";
  const td = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;
  const u16 = (b, o) => b[o] | (b[o + 1] << 8), u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== "undefined") {
      const ds = new DecompressionStream("deflate-raw");
      const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
      return new Uint8Array(await out.arrayBuffer());
    }
    return new Uint8Array(require("zlib").inflateRawSync(Buffer.from(bytes)));
  }
  async function unzip(buf, want) {
    const b = new Uint8Array(buf); let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 66000); i--) if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("Not a valid .docx (zip) file.");
    const n = u16(b, eocd + 10); let p = u32(b, eocd + 16); const files = {};
    for (let k = 0; k < n; k++) {
      if (u32(b, p) !== 0x02014b50) break;
      const method = u16(b, p + 10), csize = u32(b, p + 20), nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32), off = u32(b, p + 42);
      const name = td.decode(b.subarray(p + 46, p + 46 + nlen));
      if (want.includes(name)) {
        const start = off + 30 + u16(b, off + 26) + u16(b, off + 28), data = b.subarray(start, start + csize);
        files[name] = td.decode(method === 0 ? data : await inflateRaw(data));
      }
      p += 46 + nlen + xlen + clen;
    }
    return files;
  }
  const ent = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) =>
    e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'" : String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
  const attr = (a, k) => { const m = new RegExp(k + '="([^"]*)"').exec(a); return m ? ent(m[1]) : null; };

  // Parse word/document.xml into blocks: {type: "heading"|"para"|"cell"|"equation", text, level?, table?, row?, col?}
  function parseDocument(xml) {
    const blocks = [], pstack = [], dstack = [];
    let inMath = 0, inBody = false, tbl = -1, tblCount = -1, row = -1, col = -1, skip = 0; const ms = [];
    const cur = () => pstack[pstack.length - 1];
    const emit = (s) => { const p = cur(); if (p && !skip) (inMath ? p.mathBuf : p.buf).push(s); };
    const re = /<(\/?)([\w:]+)([^>]*?)(\/?)>|([^<]+)/g; let m;
    while ((m = re.exec(xml))) {
      if (m[5] !== undefined) { if (inBody && !skip && cur() && cur().inT) emit(ent(m[5])); continue; }
      const close = m[1] === "/", tag = m[2], a = m[3], selfc = m[4] === "/";
      if (tag === "w:body") { inBody = !close; continue; }
      if (!inBody) continue;
      if (tag === "w:delText" || tag === "w:instrText" || tag === "w:footnoteReference" || tag === "mc:Fallback") { if (!selfc) skip += close ? -1 : 1; continue; }
      if (skip) continue;
      switch (tag) {
        case "w:tbl": if (close) tbl = -1; else { tblCount++; tbl = tblCount; row = -1; } break;
        case "w:tr": if (!close) { row++; col = -1; } break;
        case "w:tc": if (!close) col++; break;
        case "w:p":
          if (selfc) { blocks.push({ type: "para", text: "" }); break; }
          if (!close) pstack.push({ buf: [], mathBuf: [], style: "", list: false, inT: false, mathOnly: true, hasText: false, table: tbl, row, col });
          else {
            const p = pstack.pop(); if (!p) break;
            const text = p.buf.join("").replace(/[ \t ]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/ ([,.;:!?)])/g, "$1").replace(/(\S) -(?=[a-z])/g, "$1-").replace(/\( (?=\S)/g, "(").trim();
            const st = p.style.toLowerCase(); let type = "para", level;
            const hm = /^(heading|title|subtitle)\s*(\d*)/.exec(st.replace(/[^a-z0-9 ]/g, ""));
            if (hm) { type = "heading"; level = hm[1] === "title" ? 0 : +(hm[2] || 1); }
            else if (p.table >= 0) type = "cell";
            else if (p.mathOnly && text) type = "equation";
            blocks.push({ type, text, level, list: p.list, table: p.table >= 0 ? p.table : undefined, row: p.table >= 0 ? p.row : undefined, col: p.table >= 0 ? p.col : undefined });
          }
          break;
        case "w:pStyle": if (cur()) cur().style = attr(a, "w:val") || ""; break;
        case "w:numPr": if (cur() && !close) cur().list = true; break;
        case "w:t": if (cur()) { cur().inT = !close && !selfc; if (!close && !selfc && !inMath) cur().mathOnly = false; } break;
        case "m:t": if (cur()) cur().inT = !close && !selfc; break;
        case "w:tab": if (!close) emit("\t"); break;
        case "w:br": case "w:cr": if (!close && !/type="page"/.test(a)) emit("\n"); break;
        case "w:noBreakHyphen": emit("-"); break;
        case "w:sym": { const c = attr(a, "w:char"); if (c) emit(String.fromCharCode(parseInt(c, 16) & 0xff ? 0x2022 : 0x20)); break; }
        // ---- equations (OMML) → linear text
        case "m:oMath":
          if (!close) { inMath++; if (cur()) cur().mathBuf = []; }
          else { inMath--; const p = cur(); if (p) { const s = tidyMath(p.mathBuf.join("")); p.buf.push((p.buf.length && !/[\s(\-]$/.test(p.buf[p.buf.length - 1]) ? " " : "") + s + " "); p.mathBuf = []; } }
          break;
        case "m:sup": emit(close ? ")" : "^("); break;
        case "m:sub": emit(close ? ")" : "_("); break;
        case "m:num": emit(close ? ")" : "("); break;
        case "m:den": emit(close ? ")" : "/("); break;
        case "m:deg": if (!close && !selfc) skip++; else if (close) skip--; break;
        case "m:d": if (!close) dstack.push({ beg: "(", end: ")", sep: "|", n: 0 }); else { const d = dstack.pop(); if (d) emit(d.end); } break;
        case "m:begChr": if (dstack.length) dstack[dstack.length - 1].beg = attr(a, "m:val") ?? ""; break;
        case "m:endChr": if (dstack.length) dstack[dstack.length - 1].end = attr(a, "m:val") ?? ""; break;
        case "m:sepChr": if (dstack.length) dstack[dstack.length - 1].sep = attr(a, "m:val") ?? ""; break;
        case "m:chr": break;
        default: break;
      }
      if (/^m:(d|rad|sSup|sSub|sSubSup|f|nary|func|acc|bar|limLow|limUpp|groupChr|box|borderBox|eqArr|sPre|m)$/.test(tag) && !selfc) { if (close) ms.pop(); else ms.push(tag); }
      if (tag === "m:e" && !selfc) {
        const top = ms[ms.length - 1];
        if (!close && top === "m:d") { const d = dstack[dstack.length - 1]; emit(d.n++ ? d.sep : d.beg); }
        else if (top === "m:rad") emit(close ? ")" : "√(");
      }
    }
    return blocks;
  }
  function tidyMath(s) {
    s = s.replace(/\s+/g, " ").trim();
    for (let i = 0; i < 3; i++) s = s.replace(/\((\w+(?:\.\d+)?)\)\/\((\w+(?:\.\d+)?)\)/g, "$1/$2").replace(/([_^])\(([\w.]+|[\w.]+\/[\w.]+)\)/g, (m, op, x) => op + (x.includes("/") ? "(" + x + ")" : x));
    return s;
  }
  function toText(blocks) {
    // headings and equations stand alone; table cells become paragraphs in reading order
    const out = [];
    for (const b of blocks) { if (!b.text) continue; out.push(b.text.replace(/\t+/g, " ")); }
    return out.join("\n\n");
  }
  function meta(files) {
    const app = files["docProps/app.xml"] || "", core = files["docProps/core.xml"] || "";
    const num = (k) => { const m = new RegExp("<" + k + ">(\\d+)</" + k + ">").exec(app); return m ? +m[1] : null; };
    return { pages: num("Pages"), words: num("Words"), characters: num("Characters"), charactersWithSpaces: num("CharactersWithSpaces"),
             created: (/<dcterms:created[^>]*>([^<]+)</.exec(core) || [])[1] || null, modified: (/<dcterms:modified[^>]*>([^<]+)</.exec(core) || [])[1] || null };
  }
  async function extract(buf) {
    const files = await unzip(buf, ["word/document.xml", "docProps/app.xml", "docProps/core.xml"]);
    if (!files["word/document.xml"]) throw new Error("This .docx has no main document part.");
    const blocks = parseDocument(files["word/document.xml"]);
    return { text: toText(blocks), blocks, meta: meta(files) };
  }
  // ---------------------------------------------------------------------------------------------------------------
  // V1.7: annotated copy. Highlights flagged sentences inside the original .docx (run shading), adds a short notice
  // paragraph at the top, and re-zips. Every other part of the package is copied byte for byte; the text itself is
  // never changed. Sentences are located by word tokens, so equations and spacing differences do not break matching.
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  async function deflateRaw(bytes) {
    if (typeof CompressionStream !== "undefined") {
      const cs = new CompressionStream("deflate-raw");
      return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer());
    }
    return new Uint8Array(require("zlib").deflateRawSync(Buffer.from(bytes)));
  }
  function zipIndex(b) {
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 66000); i--) if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("Not a valid .docx (zip) file.");
    const n = u16(b, eocd + 10), cdSize = u32(b, eocd + 12), cdOff = u32(b, eocd + 16);
    if (n === 0xffff || cdOff === 0xffffffff) throw new Error("zip64 not supported");
    const entries = []; let p = cdOff;
    for (let k = 0; k < n; k++) {
      if (u32(b, p) !== 0x02014b50) throw new Error("bad central directory");
      const nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32), len = 46 + nlen + xlen + clen;
      entries.push({ name: td.decode(b.subarray(p + 46, p + 46 + nlen)), flags: u16(b, p + 8), method: u16(b, p + 10), csize: u32(b, p + 20),
                     local: u32(b, p + 42), cd: b.slice(p, p + len) });
      p += len;
    }
    const byOff = entries.slice().sort((x, y) => x.local - y.local);
    byOff.forEach((e, i) => { e.end = i + 1 < byOff.length ? byOff[i + 1].local : cdOff; });
    if (entries.some((e) => e.flags & 1)) throw new Error("encrypted document");
    return { entries, eocd: b.slice(eocd, b.length), cdOff, cdSize };
  }
  async function readEntry(b, e) {
    const start = e.local + 30 + u16(b, e.local + 26) + u16(b, e.local + 28), data = b.subarray(start, start + e.csize);
    return e.method === 0 ? data : await inflateRaw(data);
  }
  const w16 = (a, o, v) => { a[o] = v & 255; a[o + 1] = (v >>> 8) & 255; };
  const w32 = (a, o, v) => { a[o] = v & 255; a[o + 1] = (v >>> 8) & 255; a[o + 2] = (v >>> 16) & 255; a[o + 3] = (v >>> 24) & 255; };
  async function rezip(b, idx, replace) {
    const parts = [], cds = []; let off = 0;
    for (const e of idx.entries.slice().sort((x, y) => x.local - y.local)) {
      const cd = e.cd.slice();
      if (replace[e.name]) {
        const raw = replace[e.name], comp = await deflateRaw(raw), crc = crc32(raw), nameB = b.subarray(e.local + 30, e.local + 30 + u16(b, e.local + 26));
        const lh = new Uint8Array(30 + nameB.length); w32(lh, 0, 0x04034b50); w16(lh, 4, 20); w16(lh, 6, e.flags & 0x0800); w16(lh, 8, 8);
        w16(lh, 10, u16(b, e.local + 10)); w16(lh, 12, u16(b, e.local + 12)); w32(lh, 14, crc); w32(lh, 18, comp.length); w32(lh, 22, raw.length);
        w16(lh, 26, nameB.length); w16(lh, 28, 0); lh.set(nameB, 30);
        w16(cd, 8, e.flags & 0x0800); w16(cd, 10, 8); w32(cd, 16, crc); w32(cd, 20, comp.length); w32(cd, 24, raw.length); w32(cd, 42, off);
        parts.push(lh, comp); off += lh.length + comp.length;
      } else {
        const chunk = b.subarray(e.local, e.end); w32(cd, 42, off); parts.push(chunk); off += chunk.length;
      }
      cds.push(cd);
    }
    // keep the central directory in its original order
    const order = new Map(idx.entries.map((e, i) => [e.name, i])), sortedCd = cds.map((c, i) => c).sort((x, y) => order.get(td.decode(x.subarray(46, 46 + u16(x, 28)))) - order.get(td.decode(y.subarray(46, 46 + u16(y, 28)))));
    const cdLen = sortedCd.reduce((s, c) => s + c.length, 0), eocd = idx.eocd.slice(); w32(eocd, 12, cdLen); w32(eocd, 16, off);
    const out = new Uint8Array(off + cdLen + eocd.length); let p = 0;
    for (const x of parts) { out.set(x, p); p += x.length; } for (const x of sortedCd) { out.set(x, p); p += x.length; } out.set(eocd, p);
    return out;
  }
  const xesc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const RPR_AFTER_SHD = ["w:fitText", "w:vertAlign", "w:rtl", "w:cs", "w:em", "w:lang", "w:eastAsianLayout", "w:specVanish", "w:oMath"];
  function shadeRpr(rpr, fill) {
    const shd = `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>`;
    if (!rpr) return `<w:rPr>${shd}</w:rPr>`;
    let inner = rpr.replace(/^<w:rPr>/, "").replace(/<\/w:rPr>$/, "").replace(/<w:shd\b[^>]*\/>/g, "").replace(/<w:highlight\b[^>]*\/>/g, "");
    let at = inner.length;
    for (const t of RPR_AFTER_SHD) { const i = inner.search(new RegExp("<" + t + "[\\s/>]")); if (i >= 0 && i < at) at = i; }
    return "<w:rPr>" + inner.slice(0, at) + shd + inner.slice(at) + "</w:rPr>";
  }
  // Scan document.xml for top-level runs inside the body. Returns runs [{s, e, attrs, rpr, kind, text, parts}] and
  // paragraph ends, in document order.
  function scanRuns(xml) {
    const bodyAt = xml.search(/<w:body[\s>]/); if (bodyAt < 0) throw new Error("no body");
    const re = /<(\/?)([\w:]+)([^>]*?)(\/?)>/g; re.lastIndex = bodyAt;
    const runs = [], seq = []; let m, run = null, depth = 0, del = 0, fall = 0;
    while ((m = re.exec(xml))) {
      const close = m[1] === "/", tag = m[2], selfc = m[4] === "/";
      if (tag === "w:del" || tag === "w:moveFrom") { if (!selfc) del += close ? -1 : 1; continue; }
      if (tag === "mc:Fallback") { if (!selfc) fall += close ? -1 : 1; continue; }
      if (tag === "w:r") {
        if (selfc) continue;
        if (!close) { depth++; if (depth === 1) run = { s: m.index, attrs: m[3], bad: del > 0 || fall > 0 }; else if (run) run.bad = true; }
        else { depth--; if (depth === 0 && run) { run.e = re.lastIndex; runs.push(run); seq.push({ run: runs.length - 1 }); run = null; } }
        continue;
      }
      if (depth >= 1 && run && /^(w:drawing|w:pict|w:object|mc:AlternateContent|w:rPrChange|w:fldChar|w:instrText|w:ptab)$/.test(tag)) run.bad = true;
      if (!depth && tag === "w:p" && close) seq.push({ pend: true });
    }
    for (const r of runs) {
      const body = xml.slice(r.s, r.e), inner = body.replace(/^<w:r\b[^>]*>/, "").replace(/<\/w:r>$/, "");
      const rm = /^\s*(<w:rPr>[\s\S]*?<\/w:rPr>|<w:rPr\/>)/.exec(inner);
      r.rpr = rm ? (rm[1] === "<w:rPr/>" ? "" : rm[1]) : ""; const rest = rm ? inner.slice(rm[0].length) : inner;
      // children: only w:t, w:tab, w:br, w:noBreakHyphen, w:softHyphen, w:lastRenderedPageBreak are understood
      const kids = [...rest.matchAll(/<(w:t)(\s[^>]*)?>([\s\S]*?)<\/w:t>|<(w:t)(\s[^>]*)?\/>|<(w:tab|w:br|w:cr|w:noBreakHyphen|w:softHyphen|w:lastRenderedPageBreak)\b[^>]*\/>|(\s+)/g)];
      const covered = kids.reduce((s, k) => s + k[0].length, 0);
      if (covered !== rest.length) r.bad = true;
      r.text = ""; r.nT = 0;
      for (const k of kids) {
        if (k[1]) { r.text += ent(k[3]); r.nT++; }
        else if (k[6] === "w:tab" || k[6] === "w:br" || k[6] === "w:cr") r.text += " ";
        else if (k[6] === "w:noBreakHyphen") r.text += "-";
      }
      r.simple = !r.bad && r.nT === 1 && kids.every((k) => k[1] || k[7] || k[6] === "w:lastRenderedPageBreak");
    }
    return { runs, seq };
  }
  const TOK = /[\p{L}\p{N}]+/gu;
  function locate(P, sentences) {
    // token stream of the document text P with character spans. A sentence matches where the document tokens follow it
    // in order; sentence tokens with no counterpart (linearised equations, symbols) may be skipped.
    const toks = [...P.matchAll(TOK)].map((m) => ({ w: m[0].toLowerCase(), a: m.index, b: m.index + m[0].length }));
    const out = []; let cur = 0;
    const tryAt = (i, T) => {
      let p = i, matched = 0, skips = 0, last = -1; const maxSkip = Math.max(3, Math.floor(T.length * 0.25));
      for (let j = 0; j < T.length; j++) {
        if (p < toks.length && toks[p].w === T[j]) { last = p; p++; matched++; }
        else if (++skips > maxSkip) return -1;
      }
      return matched >= Math.max(Math.min(3, T.length), Math.ceil(T.length * 0.75)) ? last : -1;
    };
    for (const s of sentences) {
      const T = [...s.text.matchAll(TOK)].map((m) => m[0].toLowerCase());
      if (!T.length) { out.push(null); continue; }
      let hit = null;
      for (const [from, to] of [[cur, toks.length], [0, cur]]) {
        for (let i = from; i < to && !hit; i++) {
          // the first sentence token may itself be a skipped symbol, so allow the match to start on T[0] or T[1]
          for (const off of [0, 1]) { if (off >= T.length || toks[i].w !== T[off]) continue; const e = tryAt(i, T.slice(off)); if (e >= 0) { hit = [i, e]; break; } }
        }
        if (hit) break;
      }
      if (!hit) { out.push(null); continue; }
      out.push([toks[hit[0]].a, toks[hit[1]].b]); cur = hit[1] + 1;
    }
    return out;
  }
  async function annotate(buf, marks, notice) {
    const b = new Uint8Array(buf), idx = zipIndex(b), de = idx.entries.find((e) => e.name === "word/document.xml");
    if (!de) throw new Error("This .docx has no main document part.");
    const xml = td.decode(await readEntry(b, de)), { runs, seq } = scanRuns(xml);
    // document text P with a map from P offsets to (run, offset in run text)
    let P = ""; const pr = [];
    for (const x of seq) { if (x.pend) { P += "\n"; continue; } const r = runs[x.run]; pr.push([P.length, x.run]); P += r.text; }
    const firstEnding = (pos) => { let lo = 0, hi = pr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (pr[mid][0] + runs[pr[mid][1]].text.length > pos) hi = mid; else lo = mid + 1; } return lo; };
    const spans = locate(P, marks);
    const hl = new Map(); let found = 0, partial = 0;
    spans.forEach((sp, i) => {
      if (!sp) return; found++;
      const fill = marks[i].lead ? "FAE2B2" : "B6E6EE"; let miss = false;
      for (let j = firstEnding(sp[0]); j < pr.length && pr[j][0] < sp[1]; j++) {
        const [base, ri] = pr[j], r = runs[ri], a = Math.max(0, sp[0] - base), e = Math.min(r.text.length, sp[1] - base);
        if (e <= a) continue;
        if (!r.bad) (hl.get(ri) || hl.set(ri, []).get(ri)).push([a, e, fill]); else miss = true;
      }
      if (miss) partial++;
    });
    // rewrite runs from the end so offsets stay valid
    let out = xml; const order = [...hl.keys()].sort((x, y) => runs[y].s - runs[x].s);
    for (const ri of order) {
      const r = runs[ri], ranges = hl.get(ri).sort((x, y) => x[0] - y[0]), open = `<w:r${r.attrs}>`;
      let rep;
      if (r.simple) {
        const segs = []; let p = 0;
        for (const [a, e, f] of ranges) { const a2 = Math.max(a, p); if (a2 > p) segs.push([p, a2, null]); if (e > a2) segs.push([a2, e, f]); p = Math.max(p, e); }
        if (p < r.text.length) segs.push([p, r.text.length, null]);
        rep = segs.filter((s) => s[1] > s[0]).map(([a, e, f]) => `${open}${f ? shadeRpr(r.rpr, f) : r.rpr}<w:t xml:space="preserve">${xesc(r.text.slice(a, e))}</w:t></w:r>`).join("");
      } else {
        const cover = ranges.reduce((s, [a, e]) => s + (e - a), 0); if (cover * 2 < r.text.length) continue;
        const body = xml.slice(r.s, r.e), inner = body.slice(open.length);
        const f = ranges.some((x) => x[2] === "B6E6EE") ? "B6E6EE" : "FAE2B2";
        rep = open + (r.rpr ? inner.replace(r.rpr, shadeRpr(r.rpr, f)) : shadeRpr("", f) + inner);
      }
      out = out.slice(0, r.s) + rep + out.slice(r.e);
    }
    if (notice && notice.length) {
      const paras = notice.map((line, i) => `<w:p><w:r><w:rPr>${i === 0 ? "<w:b/>" : ""}<w:color w:val="${i === 0 ? "1C8CA0" : "555555"}"/><w:sz w:val="${i === 0 ? 22 : 18}"/></w:rPr><w:t xml:space="preserve">${xesc(line)}</w:t></w:r></w:p>`).join("");
      out = out.replace(/(<w:body\b[^>]*>)/, "$1" + paras);
    }
    const enc = new TextEncoder(), bytes = await rezip(b, idx, { "word/document.xml": enc.encode(out) });
    return { bytes, total: marks.length, found, partial, missed: marks.length - found };
  }
  const api = { extract, parseDocument, toText, annotate };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.AletheiaDocx = api;
})(typeof window !== "undefined" ? window : globalThis);

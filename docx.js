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
  const api = { extract, parseDocument, toText };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.AletheiaDocx = api;
})(typeof window !== "undefined" ? window : globalThis);

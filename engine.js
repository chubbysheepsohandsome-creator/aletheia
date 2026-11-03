/*
 * ALETHEIA detection engine — heuristic-0.1.0
 * Runs entirely client-side. No text leaves the browser.
 *
 * Layers:
 *   1. Preprocessing: block classification (prose / heading / list / table / reference / quote / math),
 *      quotation masking, sentence segmentation, language check.
 *   2. Statistical layer: sentence-length burstiness, paragraph uniformity, lexical diversity (MATTR),
 *      sentence-opening repetition, punctuation profile.
 *   3. Stylistic layer: vocabulary and phrase markers drawn from editorial observations
 *      (Wikipedia: Signs of AI writing), chatbot artefacts, formatting artefacts, and human-writing signals.
 *   4. Ensemble: capped per-family contributions in log-odds space (so many weak stylistic hits cannot
 *      dominate), a conservative prior toward "human", then sentence/paragraph/document aggregation.
 *
 * IMPORTANT: weights are hand-set from published observations and have NOT been calibrated on
 * labelled data. Scores are relative signal strengths, not probabilities of authorship.
 */
(function (root) {
  "use strict";

  const VERSION = "0.2.0";
  const MIN_WORDS = 80;        // below: insufficient evidence, no score
  const LOW_EVIDENCE = 250;    // below: limited evidence warning
  const GOOD_EVIDENCE = 600;

  // ---------- Lexicons ----------
  // Vocabulary over-represented in LLM output (editorial observation, not proof). weight ≈ strength.
  const AI_WORDS = [
    ["delve", 1.0], ["delves", 1.0], ["delving", 1.0], ["tapestry", 1.0], ["testament", 0.9],
    ["multifaceted", 1.0], ["meticulous", 0.9], ["meticulously", 0.9], ["intricate", 0.7], ["intricacies", 1.0],
    ["interplay", 0.9], ["underscore", 0.9], ["underscores", 1.0], ["underscoring", 1.0], ["underscored", 0.8],
    ["showcase", 0.7], ["showcases", 0.8], ["showcasing", 0.9], ["pivotal", 0.9], ["realm", 0.8],
    ["embark", 0.8], ["embarking", 0.8], ["bolster", 0.7], ["bolstering", 0.8], ["garner", 0.7], ["garnered", 0.7],
    ["vibrant", 0.7], ["enduring", 0.6], ["nuanced", 0.6], ["seamless", 0.7], ["seamlessly", 0.8],
    ["commendable", 0.9], ["invaluable", 0.7], ["ever-evolving", 1.0], ["ever-changing", 0.6], ["holistic", 0.7],
    ["transformative", 0.8], ["paramount", 0.8], ["unwavering", 0.9], ["resonate", 0.7], ["resonates", 0.8],
    ["foster", 0.7], ["fosters", 0.8], ["fostering", 0.9], ["elevate", 0.6], ["noteworthy", 0.7],
    ["groundbreaking", 0.6], ["landscape", 0.5], ["crucial", 0.45], ["comprehensive", 0.35], ["robust", 0.4],
    ["navigate", 0.5], ["navigating", 0.6], ["leverage", 0.5], ["leveraging", 0.6], ["additionally", 0.6],
    ["notably", 0.5], ["furthermore", 0.45], ["moreover", 0.45], ["profound", 0.5], ["insights", 0.4],
    ["captivating", 0.8], ["boasts", 0.8], ["nestled", 0.9], ["breathtaking", 0.6], ["renowned", 0.5],
    ["empower", 0.5], ["empowering", 0.6], ["harness", 0.5], ["harnessing", 0.6], ["streamline", 0.5],
    ["cutting-edge", 0.5], ["game-changer", 0.6], ["synergy", 0.5], ["intrinsically", 0.5], ["unparalleled", 0.7],
    ["indelible", 0.9], ["enigmatic", 0.6], ["poignant", 0.6], ["evocative", 0.6], ["exemplifies", 0.7],
    ["encompasses", 0.5], ["encompassing", 0.5], ["facilitate", 0.35], ["utilize", 0.35], ["utilizing", 0.4],
    ["optimize", 0.3], ["dynamic", 0.3], ["innovative", 0.35], ["significance", 0.35], ["endeavor", 0.6],
    ["endeavors", 0.6], ["endeavour", 0.6], ["endeavours", 0.6], ["thereby", 0.35], ["inherent", 0.35],
    ["overarching", 0.6], ["myriad", 0.8], ["plethora", 0.7], ["stark", 0.4], ["beacon", 0.8], ["bustling", 0.7],
    ["intertwined", 0.6], ["cornerstone", 0.6], ["spearheaded", 0.6], ["burgeoning", 0.6],
  ];
  const AI_WORD_MAP = new Map(AI_WORDS);

  // Phrase templates: [regex, weight, short label, explanation]
  const PHRASES = [
    [/\bit(?: is|'s|’s) (?:important|crucial|essential|worth) (?:to note|noting|to remember|to recognize|to consider)\b/gi, 1.2, "“It’s important to note…”", "Stock framing phrase common in assistant-style prose."],
    [/\bplays? an? (?:crucial|pivotal|vital|key|significant|essential|important|central) role\b/gi, 1.0, "“plays a crucial role”", "Formulaic emphasis on significance."],
    [/\bin today'?s (?:fast-paced|digital|modern|ever-changing|rapidly changing|interconnected) (?:world|age|era|society|landscape)\b/gi, 1.4, "“In today’s fast-paced world”", "Generic scene-setting opener."],
    [/\ba testament to\b/gi, 1.1, "“a testament to”", "Puffery about significance."],
    [/\brich (?:tapestry|history|heritage|cultural)\b/gi, 0.8, "“rich tapestry / rich history”", "Promotional, generic description."],
    [/\bthe realm of\b/gi, 0.9, "“the realm of”", "Over-used abstract framing."],
    [/\bnavigat\w* (?:the )?(?:complexities|challenges|intricacies|landscape)\b/gi, 1.1, "“navigate the complexities”", "Formulaic abstract metaphor."],
    [/\bshed(?:s|ding)? (?:new )?light on\b/gi, 0.7, "“shed light on”", "Stock phrase."],
    [/\bpav(?:e|es|ed|ing) the way\b/gi, 0.7, "“pave the way”", "Stock phrase."],
    [/\ba (?:myriad|plethora|wide (?:range|array|variety)) of\b/gi, 0.6, "“a myriad / wide range of”", "Vague quantity phrase."],
    [/\bdelv(?:e|es|ed|ing) (?:deeper )?into\b/gi, 1.3, "“delve into”", "Strongly over-represented in LLM text."],
    [/\b(?:stands|stand|serves|serve) as an? (?:powerful |stark |poignant |vital |crucial |timeless )?(?:testament|reminder|symbol|beacon|example)\b/gi, 1.2, "“serves as a reminder / stands as a testament”", "Inflated symbolism."],
    [/(?:^|[.!?]\s+)(?:In conclusion|In summary|To sum up|To summarize|In essence|Overall|Ultimately),/gm, 0.8, "Formulaic conclusion opener", "Template-like conclusion signpost."],
    [/\bthe future (?:of [\w\s]{1,30})?(?:looks|is|remains) (?:bright|promising|uncertain)\b/gi, 1.0, "“the future looks bright”", "Generic forward-looking close."],
    [/\bremains to be seen\b/gi, 0.6, "“remains to be seen”", "Generic hedge."],
    [/\bnot only\b[^.!?]{1,80}\bbut also\b/gi, 0.6, "“not only … but also”", "Parallel construction used heavily by LLMs."],
    [/\b(?:it'?s|it’s|this is|that is|is) not (?:just|merely|only|simply) (?:about )?[^.!?]{1,60}?[,;—–-]\s*(?:it'?s|it’s|but)\b/gi, 1.0, "“It’s not just X — it’s Y”", "Negative-parallelism template."],
    [/\bwhether you(?:'re|’re| are) (?:a |an )?[^.!?]{1,40}? or\b/gi, 0.9, "“Whether you’re X or Y”", "Audience-broadening template."],
    [/\b(?:a|the) sense of (?:community|belonging|purpose|connection|wonder)\b/gi, 0.6, "“a sense of community/belonging”", "Generic emotional framing."],
    [/\b(?:valuable|key|deeper|unique) insights?\b/gi, 0.6, "“valuable insights”", "Generic value claim."],
    [/\bkey takeaways?\b/gi, 0.8, "“key takeaways”", "Templated summary phrase."],
    [/\bin (?:an|the) (?:ever-evolving|rapidly evolving|ever-changing)\b/gi, 1.2, "“in an ever-evolving…”", "Generic change framing."],
    [/\bin an era (?:of|where|when)\b/gi, 0.6, "“in an era of”", "Generic scene-setting."],
    [/\bbroader (?:implications|context|landscape|significance|themes?)\b/gi, 0.8, "“broader implications”", "Emphasis on wider significance."],
    [/\bcontinues? to (?:shape|inspire|evolve|captivate|resonate)\b/gi, 0.8, "“continues to shape / inspire”", "Inflated legacy statement."],
    [/\bit is (?:essential|crucial|vital|imperative) (?:to|that|for)\b/gi, 0.8, "“It is essential to…”", "Formulaic prescriptive framing."],
    [/\bat its core\b/gi, 0.6, "“at its core”", "Stock phrase."],
    [/\bwhen it comes to\b/gi, 0.35, "“when it comes to”", "Common filler (weak)."],
    [/\bembark(?:s|ed|ing)? on\b/gi, 0.7, "“embark on”", "Journey metaphor cliché."],
    [/\ba double-edged sword\b/gi, 0.7, "“a double-edged sword”", "Cliché."],
    [/\bthe intersection of\b/gi, 0.6, "“the intersection of”", "Abstract framing."],
    [/\b(?:highlight|underscor|emphasiz|emphasis|reflect|showcas|illustrat|demonstrat)(?:es|ing|ed)? (?:the|its|their|our) (?:importance|significance|need|value|power|role|potential)\b/gi, 0.9, "“highlighting the importance of”", "Superficial significance analysis."],
    [/\b(?:fostering|cultivating|promoting) (?:a |an )?(?:culture|sense|environment|spirit) of\b/gi, 0.9, "“fostering a culture of”", "Abstract promotional phrasing."],
    [/\bby (?:doing so|understanding|embracing|leveraging)\b/gi, 0.5, "“By doing so / By embracing…”", "Template causal link."],
    [/\b(?:a|the) (?:crucial|vital|pivotal|key|critical) (?:step|aspect|component|factor|element)\b/gi, 0.6, "“a crucial aspect”", "Generic importance claim."],
    [/\b(?:ensuring|ensure) that\b/gi, 0.3, "“ensuring that”", "Common in assistant prose (weak)."],
    [/\b(?:offers|provides) a (?:unique|valuable|comprehensive|holistic) (?:perspective|opportunity|approach|lens)\b/gi, 0.9, "“offers a unique perspective”", "Promotional generic phrase."],
    [/\bboth [\w-]+ and [\w-]+ alike\b/gi, 0.7, "“both X and Y alike”", "Audience-broadening template."],
  ];

  // Trailing participial analysis: ", highlighting/underscoring …" at sentence end
  const PARTICIPIAL_TAIL = /,\s+(?:highlighting|underscoring|emphasizing|emphasising|reflecting|showcasing|demonstrating|illustrating|ensuring|fostering|contributing to|solidifying|cementing|signaling|signalling|symbolizing|marking|paving)\b[^.!?]*[.!?]?$/i;

  // Chatbot artefacts — near-decisive when present (still could be quoted deliberately)
  const CHATBOT = [
    [/\bas an ai(?: language)? model\b/gi, "“As an AI language model”"],
    [/\bi hope this helps\b/gi, "“I hope this helps”"],
    [/^(?:certainly|absolutely|of course|sure)[!,.]\s/gim, "Assistant-style opener (“Certainly!”)"],
    [/\bgreat question\b/gi, "“Great question”"],
    [/\blet me know if you(?:'d| would)? (?:like|need|have|want)\b/gi, "“Let me know if you’d like…”"],
    [/\bhere(?:'s| is) (?:a|an|the|your) (?:revised|rewritten|improved|refined|polished|updated|concise|detailed) (?:version|draft|essay|paragraph|text)\b/gi, "“Here’s a revised version…”"],
    [/\b(?:knowledge cut-?off|as of my last (?:update|training))\b/gi, "Knowledge-cutoff disclaimer"],
    [/oaicite|contentReference\[|turn\d+(?:search|news|view)\d+|utm_source=chatgpt\.com|【\d+†/gi, "Chatbot citation/tool artefact"],
    [/\[(?:insert|your|add) [^\]]{2,40}\]/gi, "Unfilled template placeholder"],
    [/\bfeel free to (?:ask|reach out|let me know)\b/gi, "“Feel free to ask”"],
  ];

  // Human-writing signals
  const INFORMAL = new Set(["lol", "lmao", "gonna", "wanna", "gotta", "kinda", "sorta", "yeah", "yep", "nah", "nope", "idk", "tbh", "btw", "omg", "dunno", "ok", "okay", "haha", "ugh", "hmm", "dude", "bro", "cuz", "coz", "y'all", "ain't", "meh", "stuff", "anyways", "literally", "basically", "honestly", "pretty", "heaps", "reckon", "arvo", "mate"]);
  const MISSPELLINGS = new Set(["teh", "recieve", "recieved", "definately", "definatly", "seperate", "seperately", "alot", "untill", "wich", "becuase", "beacuse", "thier", "beleive", "occured", "tommorow", "tomorow", "goverment", "enviroment", "wierd", "accomodate", "arguement", "begining", "embarass", "existance", "grammer", "independant", "neccessary", "necesary", "occurence", "persistant", "publically", "truely", "youre", "dont", "cant", "wont", "didnt", "doesnt", "isnt", "wasnt", "shouldnt", "couldnt", "wouldnt", "thats", "whats", "theyre", "im", "ive", "u", "ur", "thru", "becasue", "probaly", "realy", "finaly", "basicly", "suprise", "suprised", "freind", "freinds", "untill", "acheive", "acheived", "beggining", "calender", "concious", "foriegn", "garantee", "happend", "immediatly", "knowlege", "libary", "noticable", "posession", "prefered", "recomend", "refered", "relevent", "remeber", "rember", "sentance", "succesful", "tounge", "writting", "writen", "everytime", "aswell", "infact", "eachother", "alright"]);
  const TRANSITIONS = /^(?:additionally|furthermore|moreover|however|consequently|notably|importantly|ultimately|overall|in addition|in conclusion|in summary|therefore|thus|similarly|conversely|nevertheless|nonetheless|subsequently|as a result|on the other hand|in contrast|indeed|crucially|interestingly|specifically)\b/i;
  const STOPWORDS = new Set("the of and to a in is that it for was on are as with be by this at from or an have not but they which you we his her their its has had were been can will would there all more one also what so if about when who than other into some them these only out up do could may such our my your he she i me him how".split(" "));
  const ABBREV_WORDS = /\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|fig|no|vol|pp|ch|approx|dept|est|inc|ltd|co|corp|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|u\.s|u\.k|a\.m|p\.m|al)\.$/i;
  const INITIAL = /(?:^|\s)[A-Z]\.$/;
  const ABBREV = { test: (t) => ABBREV_WORDS.test(t) || INITIAL.test(t) };

  // ---------- Utilities ----------
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const sigmoid = (z) => 1 / (1 + Math.exp(-z));
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const std = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
  const cv = (a) => { const m = mean(a); return m > 0 ? std(a) / m : 0; };
  const words = (s) => (s.match(/[A-Za-zÀ-ɏ]+(?:['’-][A-Za-zÀ-ɏ]+)*/g) || []);
  const countMatches = (re, s) => { re.lastIndex = 0; const m = s.match(re); return m ? m.length : 0; };

  function mattr(tokens, w = 50) {
    if (tokens.length < w) return tokens.length ? new Set(tokens).size / tokens.length : 0;
    const counts = new Map(); let uniq = 0, total = 0, n = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]; const c = counts.get(t) || 0; if (c === 0) uniq++; counts.set(t, c + 1);
      if (i >= w) { const o = tokens[i - w]; const oc = counts.get(o) - 1; counts.set(o, oc); if (oc === 0) uniq--; }
      if (i >= w - 1) { total += uniq / w; n++; }
    }
    return total / n;
  }

  // ---------- Preprocessing ----------
  // Character tricks used by "humanizer" tools: invisible characters and Cyrillic/Greek look-alikes inside Latin words.
  const INVISIBLE = /[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD\u180E]/g;
  const LOOKALIKE = { "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0456": "i",
    "\u0458": "j", "\u0455": "s", "\u0501": "d", "\u04BB": "h", "\u04CF": "l", "\u0410": "A", "\u0412": "B", "\u0415": "E", "\u041A": "K",
    "\u041C": "M", "\u041D": "H", "\u041E": "O", "\u0420": "P", "\u0421": "C", "\u0422": "T", "\u0425": "X", "\u03BF": "o", "\u03B1": "a",
    "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0397": "H", "\u0399": "I", "\u039A": "K", "\u039C": "M", "\u039D": "N", "\u039F": "O",
    "\u03A1": "P", "\u03A4": "T", "\u03A7": "X", "\u0261": "g" };
  const LOOK_RE = new RegExp("[" + Object.keys(LOOKALIKE).join("") + "]", "g");
  function cleanTricks(text) {
    let invisible = 0, lookalike = 0;
    text = text.replace(INVISIBLE, () => { invisible++; return ""; });
    // only replace a look-alike that sits next to a Latin letter (real Greek or Russian text is left alone)
    text = text.replace(LOOK_RE, (ch, i, str) => {
      if (/[A-Za-z]/.test(str[i - 1] || "") || /[A-Za-z]/.test(str[i + 1] || "")) { lookalike++; return LOOKALIKE[ch]; }
      return ch;
    });
    return { text, invisible, lookalike };
  }
  function normalize(text) {
    return text.replace(/\r\n?/g, "\n").replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // Line-numbered prose (scripts, monologues, poems with line numbers): "1. Prim." "2. Look at me." ...
  // When most non-empty lines carry a running number and read as sentences, the numbers are line labels, not a list.
  function unnumberLines(text) {
    const lines = text.split("\n").filter(l => l.trim());
    const num = lines.map(l => l.match(/^\s*(\d{1,4})[.)]\s+(.*\S)\s*$/)).filter(Boolean);
    if (num.length < 8 || num.length < lines.length * 0.6) return { text, numbered: 0 };
    let seq = 0; for (let i = 1; i < num.length; i++) if (+num[i][1] === +num[i - 1][1] + 1) seq++;
    const sentenceLike = num.filter(m => /[.!?…]["'”’)]?$/.test(m[2])).length;
    if (seq < (num.length - 1) * 0.8 || sentenceLike < num.length * 0.6) return { text, numbered: 0 };
    return { text: text.replace(/^[ \t]*\d{1,4}[.)][ \t]+/gm, ""), numbered: num.length };
  }

  function splitBlocks(text) {
    let blocks = text.split(/\n\s*\n/);
    // If the text has no blank lines but many single newlines (e.g. DOCX/PDF extraction), split on single newlines
    if (blocks.length <= 2 && (text.match(/\n/g) || []).length >= 3) blocks = text.split(/\n/);
    const out = [];
    for (const b of blocks) {
      const lines = b.split("\n");
      // A block of list lines → split each list item into its own block
      const listLike = lines.filter(l => /^\s*(?:[-*•▪◦]|\d+[.)])\s+/.test(l)).length;
      const citeLike = lines.filter(l => CITATION_LINE.test(l.trim())).length;
      if (lines.length > 1 && (listLike >= Math.ceil(lines.length / 2) || citeLike >= Math.ceil(lines.length / 2))) {
        for (const l of lines) if (l.trim()) out.push(l.trim());
      } else if (lines.length > 1 && /^#{1,6}\s/.test(lines[0])) {
        out.push(lines[0].trim()); const rest = lines.slice(1).join(" ").trim(); if (rest) out.push(rest);
      } else {
        const joined = lines.join(" ").replace(/\s+/g, " ").trim();
        if (joined) out.push(joined);
      }
    }
    return out;
  }

  const REF_HEADING = /^(?:#+\s*)?(?:references?|bibliography|works cited|reference list|sources|citations|endnotes|footnotes)\s*:?\s*$/i;
  const CITATION_LINE = /^(?:\[\d+\]\s*)?[A-Z][A-Za-z'’\-]+,\s*(?:[A-Z]\.\s*)+.*\(?\b(?:19|20)\d{2}[a-z]?\b\)?|https?:\/\/\S+$|\bdoi:\s*10\.|Retrieved from\b/;

  function classifyBlock(b) {
    const wc = words(b).length;
    if (/^>\s?/.test(b)) return "quote";
    if (/^#{1,6}\s/.test(b)) return "heading";
    if ((b.match(/\|/g) || []).length >= 3 || /\t.*\t/.test(b)) return "table";
    if (/^\s*(?:[-*•▪◦]|\d+[.)])\s+/.test(b)) return wc >= 12 && /[.!?]["'”’)]?$/.test(b) ? "list-prose" : "list";
    const sym = (b.match(/[=+^√∑∫×÷<>±≤≥∆πθλμσ0-9()]/g) || []).length;
    if (b.length > 0 && sym / b.length > 0.3) return "math";
    if (wc <= 12 && !/[.!?]["'”’)]?$/.test(b)) return "heading";
    return "prose";
  }

  function segmentSentences(p) {
    const parts = [];
    const re = /[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/g;
    let m; const raw = [];
    while ((m = re.exec(p)) !== null) { if (m[0].trim()) raw.push(m[0]); if (m.index === re.lastIndex) re.lastIndex++; }
    let buf = "";
    for (let i = 0; i < raw.length; i++) {
      buf += raw[i];
      const t = buf.trim();
      const next = (raw[i + 1] || "").trimStart();
      const endsAbbrev = ABBREV.test(t);
      const decimal = /\d\.$/.test(t) && /^\d/.test(next);
      const nextLower = next && /^[a-z]/.test(next);
      if (i < raw.length - 1 && (endsAbbrev || decimal || nextLower)) continue;
      parts.push(t); buf = "";
    }
    if (buf.trim()) parts.push(buf.trim());
    return parts;
  }

  // Mask quotations of 6+ words so quoted material is not scored as the author's prose
  function maskQuotes(s) {
    let quoted = 0;
    const masked = s.replace(/[“"]([^”"]{3,}?)[”"]/g, (all, inner) => {
      const n = words(inner).length;
      if (n >= 6) { quoted += n; return " "; }
      return all;
    });
    return { masked, quoted };
  }

  function detectLanguage(text) {
    const cjk = (text.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length;
    const letters = (text.match(/\p{L}/gu) || []).length || 1;
    if (cjk / letters > 0.2) return { code: "cjk", name: "Chinese/Japanese/Korean", supported: false };
    const toks = words(text.toLowerCase());
    if (!toks.length) return { code: "unknown", name: "Unknown", supported: false };
    const sw = toks.filter(t => STOPWORDS.has(t)).length / toks.length;
    if (sw < 0.18) return { code: "other", name: "Not English (or very little running prose)", supported: false };
    return { code: "en", name: "English", supported: true };
  }

  // ---------- Per-sentence features ----------
  function sentenceFeatures(s) {
    const { masked, quoted } = maskQuotes(s);
    const toks = words(masked);
    const lower = toks.map(t => t.toLowerCase());
    const f = { wc: toks.length, quoted, hits: [], aiVocab: 0, phrase: 0, chatbot: 0, human: 0, transition: 0, triplet: 0, emdash: 0, participial: 0, contractions: 0 };
    for (const t of lower) {
      const w = AI_WORD_MAP.get(t);
      if (w) { f.aiVocab += w; f.hits.push({ kind: "vocab", text: t, w }); }
      if (INFORMAL.has(t)) { f.human += 0.8; f.hits.push({ kind: "human", text: t, label: "Informal word" }); }
      if (MISSPELLINGS.has(t)) { f.human += 1.0; f.hits.push({ kind: "human", text: t, label: "Spelling slip / missing apostrophe" }); }
      if (/['’](?:s|t|re|ve|ll|d|m)$/.test(t) && !/['’]s$/.test(t)) f.contractions++;
    }
    for (const [re, w, label] of PHRASES) {
      const n = countMatches(re, masked);
      if (n) { f.phrase += w * n; f.hits.push({ kind: "phrase", text: label, w }); }
    }
    for (const [re, label] of CHATBOT) {
      const n = countMatches(re, masked);
      if (n) { f.chatbot += n; f.hits.push({ kind: "chatbot", text: label }); }
    }
    if (PARTICIPIAL_TAIL.test(masked)) { f.participial = 1; f.hits.push({ kind: "phrase", text: "Trailing “, highlighting …” clause", w: 0.8 }); }
    if (TRANSITIONS.test(masked.trim().replace(/^["“'(]+/, ""))) { f.transition = 1; }
    const trip = masked.match(/\b[\w-]+(?: [\w-]+)?, [\w-]+(?: [\w-]+)?,? and [\w-]+(?: [\w-]+)?\b/g);
    if (trip) f.triplet = trip.length;
    f.emdash = (masked.match(/—|\s–\s|\s--\s/g) || []).length;
    // human micro-signals
    if (/(?:!!|\?\?|\?!|!\?)/.test(masked)) { f.human += 0.8; f.hits.push({ kind: "human", text: "Repeated punctuation", label: "Expressive punctuation" }); }
    if (/(?:^|\s)i(?:\s|'|’)/.test(masked)) { f.human += 1.0; f.hits.push({ kind: "human", text: "lowercase “i”", label: "Lowercase pronoun" }); }
    if (/^[a-z]/.test(masked.trim())) { f.human += 0.5; }
    const dbl = masked.match(/\b(\w+)\s+\1\b/i);
    if (dbl && !/^(?:that|had|is|very|so|bye|ha|no|yes|really|far|more|many|again)$/i.test(dbl[1])) { f.human += 0.8; f.hits.push({ kind: "human", text: `“${dbl[0]}”`, label: "Doubled word" }); }
    return f;
  }

  // ---------- Trained model loader / tree evaluator ----------
  let _model;
  function getModel() {
    if (_model !== undefined) return _model;
    _model = null;
    try {
      if (root.ProseLensModel === false) _model = null; // explicitly disabled (rule-based scoring only)
      else if (root.ProseLensModel) _model = root.ProseLensModel;
      else if (typeof require === "function") _model = require("./model.js");
    } catch (e) { _model = null; }
    return _model;
  }
  function predictTrees(M, x) {
    let raw = M.baseline;
    for (const t of M.trees) {
      let i = 0;
      while (!t[i][0]) i = x[t[i][1]] <= t[i][2] ? t[i][3] : t[i][4];
      raw += t[i][5];
    }
    return sigmoid(raw);
  }

  // ---------- Main analysis ----------
  function analyze(input, opts = {}) {
    const tricks = cleanTricks(input || "");
    const un = unnumberLines(normalize(tricks.text));
    const text = un.text;
    const started = Date.now();
    const blocksRaw = splitBlocks(text);
    let inRefs = false;
    const blocks = blocksRaw.map((b, i) => {
      let type = classifyBlock(b);
      if (REF_HEADING.test(b.replace(/[*_]/g, "").trim())) { inRefs = true; type = "heading"; return { i, text: b, type, excludedReason: "Reference heading" }; }
      if (inRefs) {
        if (type === "heading" && !REF_HEADING.test(b)) { /* stays in refs until clear prose */ }
        if (type === "prose" && !CITATION_LINE.test(b) && words(b).length > 40) inRefs = false;
        else return { i, text: b, type: "reference", excludedReason: "Reference / bibliography" };
      }
      if (type === "prose" && CITATION_LINE.test(b) && words(b).length < 60) return { i, text: b, type: "reference", excludedReason: "Citation entry" };
      return { i, text: b, type };
    });

    const formattingHits = [];
    const md = {
      bold: (text.match(/\*\*[^*\n]{2,80}\*\*/g) || []).length,
      headings: (text.match(/^#{1,6}\s/gm) || []).length,
      boldLabelBullets: (text.match(/^\s*(?:[-*•]|\d+[.)])\s+\*\*[^*]+\*\*\s*:?/gm) || []).length,
      emojiBullets: (text.match(/^\s*(?:[\u{1F300}-\u{1FAFF}✅✨❌✔\u{1F680}])/gmu) || []).length,
    };
    if (md.bold >= 2) formattingHits.push(`${md.bold} Markdown **bold** spans`);
    if (md.headings >= 2) formattingHits.push(`${md.headings} Markdown “#” headings`);
    if (md.boldLabelBullets >= 2) formattingHits.push(`${md.boldLabelBullets} bullets starting with a bold label`);
    if (md.emojiBullets >= 2) formattingHits.push(`${md.emojiBullets} emoji-led lines`);

    const prose = blocks.filter(b => b.type === "prose" || b.type === "list-prose");
    const totalWords = words(text).length;
    const lang = detectLanguage(prose.map(b => b.text).join(" ") || text);

    // Sentences
    const sentences = [];
    prose.forEach((b, pi) => {
      b.sentences = segmentSentences(b.text).map((s) => {
        const f = sentenceFeatures(s);
        const obj = { text: s, block: b.i, para: pi, f };
        sentences.push(obj); return obj;
      });
    });
    const scorable = sentences.filter(s => s.f.wc >= 3);
    const qualifyingWords = scorable.reduce((a, s) => a + s.f.wc, 0);
    const quotedWords = sentences.reduce((a, s) => a + s.f.quoted, 0);
    const excluded = blocks.filter(b => !(b.type === "prose" || b.type === "list-prose"));
    const excludedWords = excluded.reduce((a, b) => a + words(b.text).length, 0);

    const base = {
      version: VERSION, analyzedAt: new Date().toISOString(), totalWords, qualifyingWords, quotedWords, excludedWords,
      language: lang, blocks, sentences, paragraphs: [], formattingHits,
    };

    if (!lang.supported) {
      return Object.assign(base, { status: "unsupported", message: `Detected language: ${lang.name}. This free version only analyses English prose.` });
    }
    if (qualifyingWords < MIN_WORDS) {
      return Object.assign(base, { status: "insufficient", message: `Only ${qualifyingWords} words of qualifying prose were found. At least ${MIN_WORDS} are needed, and 300+ gives far more reliable results.` });
    }

    // ---------- Document-level families (log-odds contributions, each capped) ----------
    const per100 = 100 / qualifyingWords;
    const lens = scorable.map(s => s.f.wc);
    const nS = scorable.length;
    const sum = (k) => scorable.reduce((a, s) => a + s.f[k], 0);
    const allToks = scorable.flatMap(s => words(maskQuotes(s.text).masked).map(t => t.toLowerCase()));

    const families = [];
    const add = (id, name, layer, value, contribution, detail, strength) => families.push({ id, name, layer, value, contribution, detail, strength });

    // Statistical: burstiness
    const sentCV = cv(lens);
    if (nS >= 6) {
      const rel = Math.min(1, nS / 18);
      const c = clamp((0.5 - sentCV) * 4.5, -1.8, 1.5) * rel;
      add("burstiness", "Sentence-length variation (burstiness)", "Statistical", sentCV.toFixed(2), c,
        sentCV < 0.35 ? "Sentence lengths are unusually uniform. LLM output often has low variation; many careful human writers do too."
          : sentCV > 0.6 ? "Sentence lengths vary a lot (short and long mixed), which is more typical of human writing."
            : "Sentence-length variation is in the ordinary range.", "moderate");
    }
    // Paragraph uniformity
    const pLens = prose.map(b => words(b.text).length).filter(n => n >= 15);
    if (pLens.length >= 4) {
      const pcv = cv(pLens);
      const rel = Math.min(1, pLens.length / 7);
      add("para", "Paragraph-length uniformity", "Statistical", pcv.toFixed(2), clamp((0.3 - pcv) * 2.0, -0.4, 0.4) * rel,
        pcv < 0.25 ? "Paragraphs are very similar in length, a common pattern in generated essays." : "Paragraph lengths vary normally.", "weak");
    }
    // Sentence openings
    const transRate = sum("transition") / Math.max(1, nS);
    add("transitions", "Formal transition openers", "Statistical", (transRate * 100).toFixed(0) + "% of sentences", clamp((transRate - 0.08) * 5, -0.3, 0.9),
      transRate > 0.18 ? "Many sentences open with “Additionally”, “Furthermore”, “Moreover”, etc." : "Transition-word openers are not unusually frequent.", "weak");
    const firstWords = scorable.map(s => (words(s.text)[0] || "").toLowerCase());
    const fwCounts = {}; firstWords.forEach(w => fwCounts[w] = (fwCounts[w] || 0) + 1);
    const topFirst = Object.entries(fwCounts).sort((a, b) => b[1] - a[1])[0];
    // Lexical diversity — informational, near-zero weight (shown as ineffective-alone indicator)
    const lexDiv = mattr(allToks);
    add("mattr", "Lexical diversity (MATTR-50)", "Statistical", lexDiv.toFixed(3), 0,
      "Shown for information only. Vocabulary diversity depends heavily on topic and proficiency, so it is not used in the score.", "ineffective");

    // Stylistic: vocabulary
    const vocabD = sum("aiVocab") * per100;
    add("vocab", "AI-associated vocabulary", "Stylistic", vocabD.toFixed(2) + " /100 words", clamp((vocabD - 0.45) * 1.1, -0.5, 2.0),
      vocabD > 1.2 ? "Dense use of words like “delve”, “pivotal”, “tapestry”, “underscores”, “fostering”." : vocabD > 0.6 ? "Some AI-associated vocabulary is present." : "Little AI-associated vocabulary.", "moderate");
    // Stylistic: phrase templates
    const phraseD = (sum("phrase") + sum("participial") * 0.8) * per100;
    add("phrases", "Formulaic phrase templates", "Stylistic", phraseD.toFixed(2) + " /100 words", clamp((phraseD - 0.12) * 2.0, -0.3, 2.2),
      phraseD > 0.6 ? "Several template phrases (e.g. “plays a crucial role”, “It’s not just X — it’s Y”, “highlighting the importance of”)." : phraseD > 0.25 ? "A few template phrases." : "Few template phrases.", "moderate");
    // Rule of three + em dash (combined “rhythm devices”, capped together to avoid double-counting)
    const tripD = sum("triplet") * per100, dashD = sum("emdash") * per100;
    add("devices", "Rhetorical devices (lists of three, em dashes)", "Stylistic", `${tripD.toFixed(2)} triplets, ${dashD.toFixed(2)} dashes /100w`,
      clamp((tripD - 0.25) * 0.8 + (dashD - 0.2) * 0.6, -0.2, 0.6), "Heavy use of three-item lists and em dashes is an editorial observation, not a reliable signal on its own.", "weak");
    // Chatbot artefacts
    const chat = sum("chatbot");
    if (chat > 0) add("chatbot", "Chatbot artefacts", "Stylistic", chat + " found", clamp(1.8 + chat * 0.8, 0, 4),
      "Phrases or citation markers typically produced by chat assistants (e.g. “I hope this helps”, oaicite markers). These are strong but can appear in quoted or discussed text.", "strong");
    // Formatting
    const fmtN = md.bold + md.headings * 0.5 + md.boldLabelBullets * 1.5 + md.emojiBullets;
    if (fmtN >= 2) add("format", "Chat-style formatting", "Stylistic", formattingHits.join("; "), clamp(fmtN * 0.12, 0, 0.8),
      "Markdown bold labels, “#” headings or emoji bullets pasted from a chat interface.", "weak");
    // Human signals
    const humanD = sum("human") * per100;
    const contrD = sum("contractions") * per100;
    add("human", "Human-writing signals", "Stylistic", humanD.toFixed(2) + " /100 words", -clamp(humanD * 1.6, 0, 2.6),
      humanD > 0.4 ? "Informal words, spelling slips, lowercase “i”, doubled words or expressive punctuation — rare in unedited LLM output." : "Few informal or error-type signals (normal for polished or edited writing, so this is not evidence of AI).", "moderate");
    add("contractions", "Contractions", "Stylistic", contrD.toFixed(2) + " /100 words", contrD > 2 ? -0.35 : 0,
      contrD > 2 ? "Frequent contractions suggest a conversational, personal register." : "Contraction use is not used as evidence either way in formal writing.", "weak");

    // Raw feature vector (used by the trained model and the benchmark pipeline)
    const proseText = scorable.map(s => maskQuotes(s.text).masked).join(" ");
    const wl = allToks.map(t => t.length);
    const fw = allToks.filter(t => STOPWORDS.has(t)).length / Math.max(1, allToks.length);
    const commas = (proseText.match(/,/g) || []).length / Math.max(1, nS);
    const firstPerson = allToks.filter(t => /^(?:i|me|my|mine|we|us|our)$/.test(t)).length * per100;
    const qx = (proseText.match(/[?!]/g) || []).length / Math.max(1, nS);
    const digits = (proseText.match(/\d+/g) || []).length * per100;
    const parens = (proseText.match(/\(/g) || []).length * per100;
    const startDiv = new Set(firstWords).size / Math.max(1, nS);
    const features = {
      sentCV, paraCV: pLens.length >= 2 ? cv(pLens) : 0.4, transRate, vocabD, phraseD, tripD, dashD, chat, fmtN, humanD, contrD,
      mattr: lexDiv, meanSentLen: mean(lens), meanWordLen: mean(wl), wordLenCV: cv(wl), funcWordRatio: fw, commasPerSent: commas,
      firstPerson, qxPerSent: qx, digits, parens, startDiv, logWords: Math.log(qualifyingWords),
    };

    // Ensemble
    const PRIOR = -1.1; // conservative prior: protect human writers
    let z = PRIOR + families.reduce((a, f) => a + f.contribution, 0);
    // Agreement check: stylistic and statistical evidence should agree for strong conclusions
    const styl = families.filter(f => f.layer === "Stylistic" && f.id !== "human").reduce((a, f) => a + f.contribution, 0);
    const stat = families.filter(f => f.layer === "Statistical").reduce((a, f) => a + f.contribution, 0);
    const humanC = families.filter(f => f.id === "human" || f.id === "contractions").reduce((a, f) => a + f.contribution, 0);
    if (z > 0 && stat < -0.6 && chat === 0) z -= 0.4; // structure looks human → temper
    const heuristicScore = sigmoid(z);

    // Trained document model (gradient-boosted trees over the feature vector), when available
    const M = getModel();
    let docScore = heuristicScore, modelUsed = false;
    if (M) {
      const x = M.features.map(k => (M.log.includes(k) ? Math.log1p(features[k]) : features[k]));
      docScore = predictTrees(M, x); modelUsed = true;
      const zm = Math.log(Math.max(1e-6, docScore) / Math.max(1e-6, 1 - docScore));
      families.unshift({ id: "model", name: "Trained document model (" + M.version + ")", layer: "ML", value: (docScore * 100).toFixed(1) + " / 100",
        contribution: clamp(zm, -2.5, 2.5),
        detail: docScore >= M.t_high ? "Above the calibrated flagging threshold (chosen so ≤1% of human texts per validation group are flagged)."
          : docScore >= M.t_low ? "Between the review and flagging thresholds: some AI-like patterns, not enough to flag." : "Below the review threshold.",
        strength: "trained" });
      z = clamp(zm, -6, 6);
    }

    // ---------- Sentence-level ----------
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i], f = s.f;
      if (f.wc < 3) { s.score = null; s.cat = "excluded"; continue; }
      const win = sentences.slice(Math.max(0, i - 3), i + 4).filter(x => x.f.wc >= 3).map(x => x.f.wc);
      const lcv = win.length >= 5 ? cv(win) : 0.5;
      let zl = -0.9
        + Math.min(f.aiVocab * 0.55, 1.6)
        + Math.min(f.phrase * 0.9 + f.participial * 0.8, 2.0)
        + Math.min(f.chatbot * 2.5, 3.5)
        + f.transition * 0.35 + Math.min(f.triplet * 0.25, 0.5) + Math.min(f.emdash * 0.15, 0.3)
        - Math.min(f.human * 1.0, 2.5)
        + clamp((0.45 - lcv) * 1.4, -0.6, 0.5);
      s.local = sigmoid(zl);
      const zs = 0.75 * zl + 0.25 * clamp(z, -2, 2);
      s.score = sigmoid(zs);
      s.cat = s.score >= 0.75 ? "strong" : s.score >= 0.58 ? "moderate" : s.score <= 0.3 ? "human" : "mixed";
    }

    // ---------- Paragraph-level ----------
    const paragraphs = prose.map((b, pi) => {
      const ss = b.sentences.filter(s => s.score !== null);
      const wsum = ss.reduce((a, s) => a + s.f.wc, 0);
      const sc = wsum ? ss.reduce((a, s) => a + s.score * s.f.wc, 0) / wsum : null;
      const loc = wsum ? ss.reduce((a, s) => a + s.local * s.f.wc, 0) / wsum : null;
      return { index: pi, block: b.i, words: words(b.text).length, score: sc, local: loc, preview: b.text.slice(0, 90) };
    });
    const scoredParas = paragraphs.filter(p => p.score !== null && p.words >= 25);

    // ---------- Assessment ----------
    const pScores = scoredParas.map(p => p.local); // local-only evidence, so sections are compared independently
    const pHigh = pScores.filter(x => x >= 0.68).length, pLow = pScores.filter(x => x <= 0.38).length;
    let category, catKey;
    if (scoredParas.length >= 3 && pHigh >= 1 && pLow >= 1 && (Math.max(...pScores) - Math.min(...pScores)) > 0.38) {
      catKey = "mixed-authorship"; category = "Mixed signals across sections";
    } else {
      const tHigh = M ? M.t_high : 0.62, tLow = M ? M.t_low : 0.42;
      if (docScore >= tHigh) {
        if (chat > 0 || docScore >= (M ? 0.99 : 0.82)) { catKey = "strong"; category = "Strong AI-like signals"; }
        else if (stat < -0.3 || humanC < -0.8) { catKey = "ai-edited"; category = "AI-like wording with human-like structure"; }
        else { catKey = "substantial"; category = "Substantial AI-like signals"; }
      }
      else if (docScore >= tLow) { catKey = "inconclusive"; category = "Inconclusive"; }
      else if (docScore >= (M ? 0.2 : 0.22)) { catKey = "mostly-human"; category = "Mostly human-like, some AI-like signals"; }
      else { catKey = "human"; category = "Predominantly human-like"; }
    }

    // Evidence / confidence
    const evidence = qualifyingWords < LOW_EVIDENCE ? "Limited" : qualifyingWords < GOOD_EVIDENCE ? "Moderate" : "Substantial";
    const disagreement = modelUsed
      ? (docScore >= M.t_high && heuristicScore < 0.3) || (docScore < M.t_low && heuristicScore > 0.85)
      : (styl > 0.8 && stat < -0.5) || (styl < 0.1 && stat > 0.8);
    let confidence = evidence === "Limited" ? "Low" : evidence === "Moderate" ? "Medium" : "Medium-high";
    if (disagreement || catKey === "inconclusive") confidence = evidence === "Substantial" ? "Medium" : "Low";

    const notes = [];
    if (evidence === "Limited") notes.push(`Short text (${qualifyingWords} words of prose). Results on short texts are much less reliable; treat as indicative only.`);
    if (disagreement) notes.push(modelUsed ? "The trained model and the rule-based signals disagree, so confidence is reduced." : "Statistical and stylistic layers disagree, so confidence is reduced.");
    if (modelUsed) notes.push("The trained model was benchmarked on 2023-era ChatGPT and Claude text. Newer models (GPT-4o/5, Claude 3+, Gemini, DeepSeek, Llama) are not yet in its test set.");
    if (quotedWords > 0) notes.push(`${quotedWords} words inside quotation marks were excluded from scoring.`);
    if (tricks.invisible + tricks.lookalike > 0) notes.push(`${tricks.invisible} invisible and ${tricks.lookalike} look-alike characters (e.g. Cyrillic letters inside English words) were found and normalised before analysis. Such characters are a known trick of some AI "humanizer" tools, but they can also come from copy-pasting; they are not counted as evidence on their own.`);
    if (un.numbered) notes.push(`${un.numbered} numbered lines were read as running prose; the line numbers were ignored.`);
    if (excludedWords > 0) notes.push(`${excludedWords} words in headings, lists, tables or references were excluded from scoring.`);
    if (topFirst && nS >= 8 && topFirst[1] / nS > 0.25 && topFirst[0]) notes.push(`${Math.round(topFirst[1] / nS * 100)}% of sentences start with “${topFirst[0]}”.`);
    notes.push("Formal, technical, and non-native English writing can trigger AI-like signals. A score is never proof of authorship.");

    // Top contributing sentences (explanation)
    const topSentences = sentences.filter(s => s.score !== null).sort((a, b) => b.score - a.score).slice(0, 3)
      .filter(s => s.score >= 0.58).map(s => ({ text: s.text, score: s.score, hits: s.f.hits.filter(h => h.kind !== "human").map(h => h.text) }));

    const strongShare = scorable.length ? scorable.filter(s => s.cat === "strong" || s.cat === "moderate").reduce((a, s) => a + s.f.wc, 0) / qualifyingWords : 0;

    return Object.assign(base, {
      status: "ok", score: docScore, heuristicScore, modelVersion: modelUsed ? M.version : null, thresholds: M ? { high: M.t_high, low: M.t_low } : null, z, features, category, catKey, evidence, confidence, families, notes, paragraphs,
      flaggedShare: strongShare, topSentences, stats: { sentences: nS, meanSentenceLength: mean(lens), sentenceCV: sentCV, mattr: lexDiv },
      elapsedMs: Date.now() - started,
    });
  }

  const api = { analyze, VERSION, _internals: { segmentSentences, splitBlocks, classifyBlock, sentenceFeatures, detectLanguage, mattr } };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.ProseLensEngine = api;
})(typeof window !== "undefined" ? window : globalThis);

// ALETHEIA web-search relay (Cloudflare Worker).
// Keeps the search API key off the public site. It receives short phrases (8 words each) from the
// Similarity check, asks the search provider for exact-phrase matches, and can return the visible text of a
// result page so the browser can compare word for word. It keeps no user data and logs no phrases
// (search answers and public pages may sit in Cloudflare's cache for a few days to save credits).
//
// Routes
//   POST /search  {queries: string[]}            -> {provider, searched, results:[{url,title,snippet,queries:[i],sig}]}
//   POST /page    {url, sig}                     -> {url, text}   (only URLs this relay returned, signed, same UTC day)
//   GET  /health                                  -> {ok, provider}
//
// Secrets (wrangler secret put …): SERPER_KEY or BRAVE_KEY, SIGNING_SECRET
// Vars (wrangler.toml): PROVIDER = "serper" | "brave", ALLOWED_ORIGINS, MAX_QUERIES, MAX_RESULTS_PER_QUERY

const enc = new TextEncoder();
const json = (obj, status, cors) => new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, cors) });

function corsFor(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "https://aletheiadetect.com,https://www.aletheiadetect.com").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin) || (env.ALLOW_LOCALHOST === "1" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  return { ok, headers: ok ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400", "Vary": "Origin" } : { "Vary": "Origin" } };
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const today = () => new Date().toISOString().slice(0, 10);

// phrases must look like what the Similarity check sends: 3–12 words of letters/digits, at most 120 characters
const cleanPhrase = (q) => String(q || "").replace(/[^\p{L}\p{N}' -]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 120);
const okPhrase = (q) => { const n = q.split(" ").length; return n >= 3 && n <= 12; };

function pickEven(arr, max) {
  if (arr.length <= max) return arr.map((q, i) => [i, q]);
  const out = []; for (let k = 0; k < max; k++) { const i = Math.floor((k * arr.length) / max); out.push([i, arr[i]]); }
  return out;
}

async function searchSerper(env, items, per) {
  // Serper accepts a batch: an array of queries in one request (one credit per query)
  const body = items.map(([, q]) => ({ q: `"${q}"`, num: per }));
  const r = await fetch(env.SERPER_URL || "https://google.serper.dev/search", { method: "POST", headers: { "X-API-KEY": env.SERPER_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("serper " + r.status);
  const j = await r.json();
  const arr = Array.isArray(j) ? j : [j];
  return arr.map((x) => ((x && x.organic) || []).map((o) => ({ url: o.link, title: o.title, snippet: o.snippet || "" })));
}

async function searchBrave(env, items, per) {
  const out = [];
  for (const [, q] of items) { // Brave's entry plans allow about 1 request per second
    const t0 = Date.now();
    const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(`"${q}"`)}&count=${per}&safesearch=moderate`, { headers: { "Accept": "application/json", "X-Subscription-Token": env.BRAVE_KEY } });
    if (r.status === 429) { out.push(null); await new Promise((z) => setTimeout(z, 1100)); continue; }
    if (!r.ok) { out.push(null); continue; }
    const j = await r.json();
    out.push((((j.web || {}).results) || []).map((o) => ({ url: o.url, title: o.title, snippet: (o.description || "").replace(/<[^>]+>/g, "") })));
    const wait = 1050 - (Date.now() - t0); if (wait > 0) await new Promise((z) => setTimeout(z, wait));
  }
  return out;
}

const SKIP_HOSTS = /(^|\.)(wikipedia\.org|wikimedia\.org|aletheiadetect\.com)$/i; // Wikipedia is searched directly by the browser
function safeUrl(u, env) {
  let x; try { x = new URL(u); } catch (e) { return null; }
  if (env && env.TEST_ALLOW_LOCAL === "1" && /^https?:$/.test(x.protocol)) return x.toString();
  if (!/^https?:$/.test(x.protocol) || x.username || x.password || (x.port && !["80", "443"].includes(x.port))) return null;
  const h = x.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^(127\.|10\.|192\.168\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || /^\d+$/.test(h) || h.includes(":")) return null;
  return x.toString();
}

// Best-effort limits that need no extra setup: per address and per Worker instance, per minute and per day.
// (Each Cloudflare location runs its own instances, so these are not global; Serper's free credits are the hard cap.)
const hits = new Map(), dayCount = new Map(); let dayKey = "";
function allow(bucket, ip, perMin, perDay, globalPerDay) {
  const now = Date.now(), d = today();
  if (d !== dayKey) { dayKey = d; dayCount.clear(); hits.clear(); }
  const key = bucket + ":" + ip, h = hits.get(key) || { m: 0, t: now, d: 0 }, g = dayCount.get(bucket) || 0;
  if (now - h.t > 60000) { h.m = 0; h.t = now; }
  if (h.m >= perMin || h.d >= perDay || g >= globalPerDay) return false;
  h.m++; h.d++; dayCount.set(bucket, g + 1); hits.set(key, h); if (hits.size > 5000) hits.clear();
  return true;
}
async function sha(s) { const b = await crypto.subtle.digest("SHA-256", enc.encode(s)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""); }

async function handleSearch(req, env, cors) {
  const ip = req.headers.get("CF-Connecting-IP") || "?";
  if (!allow("s", ip, +env.SEARCH_PER_MIN || 4, +env.SEARCH_PER_DAY || 40, +env.SEARCH_GLOBAL_PER_DAY || 400)) return json({ error: "rate limited" }, 429, cors);
  let body; try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400, cors); }
  const raw = Array.isArray(body && body.queries) ? body.queries.slice(0, 60) : [];
  const phrases = raw.map(cleanPhrase);
  const max = Math.max(1, Math.min(40, +env.MAX_QUERIES || 20)), per = Math.max(3, Math.min(10, +env.MAX_RESULTS_PER_QUERY || 5));
  const items = pickEven(phrases, max).filter(([, q]) => okPhrase(q));
  if (!items.length) return json({ provider: env.PROVIDER, searched: 0, results: [] }, 200, cors);
  const provider = (env.PROVIDER || "serper").toLowerCase();
  // the same phrases (for example a document checked twice) are answered from Cloudflare's cache for 3 days, costing no credits
  const cache = caches.default, ck = new Request("https://cache.aletheia.invalid/search/" + provider + "/" + per + "/" + await sha(items.map(([, q]) => q).join("|")));
  let lists = null;
  try { const hit = await cache.match(ck); if (hit) lists = await hit.json(); } catch (e) {}
  if (!lists) {
    try { lists = provider === "brave" ? await searchBrave(env, items, per) : await searchSerper(env, items, per); }
    catch (e) { return json({ error: "search provider failed", detail: String(e.message || e).slice(0, 80) }, 502, cors); }
    try { await cache.put(ck, new Response(JSON.stringify(lists), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=259200" } })); } catch (e) {}
  }
  const byUrl = new Map(); let failed = 0;
  lists.forEach((list, k) => {
    if (!list) { failed++; return; }
    const qi = items[k][0];
    for (const h of list) {
      const url = safeUrl(h.url, env); if (!url) continue;
      if (SKIP_HOSTS.test(new URL(url).hostname)) continue;
      if (!byUrl.has(url)) byUrl.set(url, { url, title: String(h.title || "").slice(0, 300), snippet: "", queries: [] });
      const e = byUrl.get(url); if (!e.queries.includes(qi)) e.queries.push(qi);
      if (e.snippet.length < 1200) e.snippet += (e.snippet ? " … " : "") + String(h.snippet || "").slice(0, 400);
    }
  });
  const d = today(), results = [...byUrl.values()].sort((a, b) => b.queries.length - a.queries.length).slice(0, 60);
  for (const r of results) r.sig = await hmac(env.SIGNING_SECRET, d + "|" + r.url);
  return json({ provider, searched: items.length, failed, results }, 200, cors);
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", hellip: "…", shy: "", zwj: "", zwnj: "", thinsp: " ", ensp: " ", emsp: " ", laquo: "«", raquo: "»", copy: "©", reg: "®", deg: "°", middot: "·", bull: "•", times: "×", divide: "÷", minus: "−", szlig: "ß", aelig: "æ", oelig: "œ", eth: "ð", thorn: "þ" };
for (const [l, accents] of Object.entries({ a: "grave:à,acute:á,circ:â,tilde:ã,uml:ä,ring:å", e: "grave:è,acute:é,circ:ê,uml:ë", i: "grave:ì,acute:í,circ:î,uml:ï", o: "grave:ò,acute:ó,circ:ô,tilde:õ,uml:ö,slash:ø", u: "grave:ù,acute:ú,circ:û,uml:ü", y: "acute:ý,uml:ÿ", n: "tilde:ñ", c: "cedil:ç" }))
  for (const kv of accents.split(",")) { const [k, ch] = kv.split(":"); ENT[l + k] = ch; ENT[l.toUpperCase() + k] = ch.toUpperCase(); }
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z]+\d*);/gi, (m, k) => { if (ENT[k] != null) return ENT[k]; if (ENT[k.toLowerCase()] != null) return ENT[k.toLowerCase()]; if (k[0] === "#") { const n = k[1] === "x" || k[1] === "X" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " "; } return m; });

async function handlePage(req, env, cors) {
  if (!allow("p", req.headers.get("CF-Connecting-IP") || "?", 40, 400, 4000)) return json({ error: "rate limited" }, 429, cors);
  let body; try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400, cors); }
  const url = safeUrl(body && body.url, env);
  if (!url || !body.sig) return json({ error: "bad url" }, 400, cors);
  const d = today(), y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const same = (a, b) => { a = String(a); b = String(b); if (a.length !== b.length) return false; try { return crypto.subtle.timingSafeEqual(enc.encode(a), enc.encode(b)); } catch (e) { let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; } };
  const ok = same(body.sig, await hmac(env.SIGNING_SECRET, d + "|" + url)) || same(body.sig, await hmac(env.SIGNING_SECRET, y + "|" + url));
  if (!ok) return json({ error: "not a search result" }, 403, cors);
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  let r, cur = url;
  try {
    // follow at most 3 redirects, checking every new address the same way as the first
    for (let hop = 0; ; hop++) {
      r = await fetch(cur, { headers: { "User-Agent": "ALETHEIA-similarity/1.0 (+https://aletheiadetect.com)", "Accept": "text/html,text/plain;q=0.9" }, redirect: "manual", signal: ctl.signal, cf: { cacheTtl: 3600, cacheEverything: true } });
      if (r.status < 300 || r.status > 399) break;
      const loc = r.headers.get("Location"); const next = loc && safeUrl(new URL(loc, cur).toString(), env);
      if (!next || hop >= 3) { clearTimeout(t); return json({ error: "redirect refused" }, 200, cors); }
      cur = next;
    }
  } catch (e) { clearTimeout(t); return json({ error: "fetch failed" }, 502, cors); }
  const len = +(r.headers.get("Content-Length") || 0);
  if (len > 3e6) { clearTimeout(t); ctl.abort(); return json({ error: "too large" }, 200, cors); }
  const ct = (r.headers.get("Content-Type") || "").toLowerCase();
  if (!r.ok || !/text\/html|text\/plain|application\/xhtml/.test(ct)) { clearTimeout(t); return json({ error: "unsupported", status: r.status, type: ct.split(";")[0] }, 200, cors); }
  const MAX = 150000; const parts = []; let size = 0, skip = 0;
  if (ct.includes("text/plain")) { // read at most MAX characters, then stop the download
    const rd = r.body.getReader(), dec = new TextDecoder(); let txt = "";
    try { while (txt.length < MAX) { const { done, value } = await rd.read(); if (done) break; txt += dec.decode(value, { stream: true }); } } catch (e) {}
    try { rd.cancel(); } catch (e) {} clearTimeout(t); return json({ url, text: txt.slice(0, MAX) }, 200, cors);
  }
  const rw = new HTMLRewriter()
    .on("script,style,noscript,svg,template,iframe,select,button,nav,footer,form", { element(e) { if (e.selfClosing || !e.canHaveContent) return; skip++; try { e.onEndTag(() => { skip--; }); } catch (x) { skip--; } } })
    .on("p,div,li,h1,h2,h3,h4,h5,h6,br,tr,td,th,section,article,blockquote,pre,dd,dt", { element() { if (size < MAX) parts.push("\n"); } })
    .on("*", { text(c) { if (!skip && size < MAX && c.text) { parts.push(c.text); size += c.text.length; if (size >= MAX) ctl.abort(); } } });
  try { await rw.transform(r).arrayBuffer(); } catch (e) { /* keep what we have */ }
  clearTimeout(t);
  const text = decode(parts.join("")).replace(/[ \t\r\f\v]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, MAX);
  return json({ url, text }, 200, cors);
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    // test-only switches work only when the relay itself runs on localhost (wrangler dev), never in production
    if (!/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) {
      const keep = {}; for (const k of ["SERPER_KEY", "BRAVE_KEY", "SIGNING_SECRET", "PROVIDER", "ALLOWED_ORIGINS", "MAX_QUERIES", "MAX_RESULTS_PER_QUERY", "SEARCH_PER_MIN", "SEARCH_PER_DAY", "SEARCH_GLOBAL_PER_DAY", "LIMITER"]) keep[k] = env[k];
      env = keep;
    }
    const c = corsFor(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: c.ok ? 204 : 403, headers: c.headers });
    if (u.pathname === "/health") return json({ ok: true, provider: env.PROVIDER || "serper" }, 200, c.headers);
    if (req.method !== "POST") return json({ error: "not found" }, 404, c.headers);
    if (!c.ok) return json({ error: "origin not allowed" }, 403, c.headers);
    if (!env.SIGNING_SECRET || !(env.SERPER_KEY || env.BRAVE_KEY)) return json({ error: "relay not configured" }, 503, c.headers);
    if (env.LIMITER) { // optional per-address limit (Workers rate limiting binding)
      const ip = req.headers.get("CF-Connecting-IP") || "?";
      const { success } = await env.LIMITER.limit({ key: (u.pathname === "/search" ? "s:" : "p:") + ip });
      if (!success) return json({ error: "rate limited" }, 429, c.headers);
    }
    if (u.pathname === "/search") return handleSearch(req, env, c.headers);
    if (u.pathname === "/page") return handlePage(req, env, c.headers);
    return json({ error: "not found" }, 404, c.headers);
  }
};

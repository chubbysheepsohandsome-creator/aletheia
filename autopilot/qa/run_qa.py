#!/usr/bin/env python3
"""ALETHEIA release QA (autopilot). Usage:
    python3 run_qa.py SITE_DIR [--expect-version 1.9.10] [--out /tmp/qa_out]
Serves SITE_DIR on localhost:8766, drives Chrome with Playwright, prints PASS/FAIL lines and exits 1 on any FAIL.
All network calls to Wikipedia, OpenAlex and the web-search relay are mocked: QA never spends search credits.
"""
import sys, os, re, json, glob, time, threading, subprocess, argparse, urllib.parse, http.server, functools
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser(); ap.add_argument("site"); ap.add_argument("--expect-version", default=None); ap.add_argument("--out", default="/tmp/qa_out"); ap.add_argument("--chrome", default=None)
A = ap.parse_args(); os.makedirs(A.out, exist_ok=True)
HERE = os.path.dirname(os.path.abspath(__file__)); PORT = 8766; B = f"http://localhost:{PORT}/"
FAILS = []
def check(name, ok, info=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  [{info}]" if info else "")); (None if ok else FAILS.append(name))

class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Q, directory=os.path.abspath(A.site)))
threading.Thread(target=srv.serve_forever, daemon=True).start()

ESSAY = open(os.path.join(HERE, "sample_essay.txt")).read()
WIKI = "A Markov chain or Markov process is a stochastic process describing a sequence of possible events in which the probability of each event depends only on the state attained in the previous event. Informally, this may be thought of as what happens next depends only on the state of affairs now."
WEBPAGE = "Music maths blog. Python turns the chords into counts and Excel uses matrix powers and random numbers to generate twelve chord sections of a new piece of music for the listener."
SIMDOC = open(os.path.join(HERE, "sample_similarity.txt")).read()
ALLOWED_EXT = ("pagead2.googlesyndication.com",)

def norm(s): return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", s.lower())).strip()
def mock(route):
    u = route.request.url; H = {"Access-Control-Allow-Origin": "*"}
    if "wikipedia.org" in u and "list=search" in u:
        q = urllib.parse.parse_qs(urllib.parse.urlparse(u).query)["srsearch"][0].strip('"')
        return route.fulfill(json={"query": {"search": [{"title": "Markov chain"}] if q in norm(WIKI) else []}}, headers=H)
    if "wikipedia.org" in u: return route.fulfill(json={"query": {"pages": {"1": {"extract": WIKI}}}}, headers=H)
    if "api.openalex.org" in u: return route.fulfill(json={"meta": {"count": 0}, "results": []}, headers=H)
    if "workers.dev" in u or "localhost:8787" in u:
        if route.request.method == "OPTIONS": return route.fulfill(status=204, headers=dict(H, **{"Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST"}))
        body = json.loads(route.request.post_data or "{}")
        if u.endswith("/search"):
            qs = body.get("queries", []); hit = [i for i, q in enumerate(qs) if q in norm(WEBPAGE)]
            res = [{"url": "https://example.org/music-maths", "title": "Music maths blog", "snippet": WEBPAGE, "queries": hit, "sig": "x"}] if hit else []
            return route.fulfill(json={"provider": "mock", "searched": len(qs), "failed": 0, "results": res}, headers=H)
        if u.endswith("/page"): return route.fulfill(json={"url": body.get("url"), "text": WEBPAGE}, headers=H)
    if u.startswith(B) or u.startswith("data:") or u.startswith("blob:"): return route.continue_()
    if any(h in u for h in ALLOWED_EXT): return route.abort()
    return route.continue_()

with sync_playwright() as p:
    kw = {"executable_path": A.chrome} if A.chrome else ({"executable_path": "/usr/bin/google-chrome"} if os.path.exists("/usr/bin/google-chrome") else {})
    b = p.chromium.launch(**kw)
    errs, ext = [], set()
    def page(lang="en", w=1360):
        pg = b.new_page(viewport={"width": w, "height": 900}, accept_downloads=True)
        pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
        pg.on("request", lambda r: ext.add(r.url.split("?")[0]) if not (r.url.startswith(B) or r.url.startswith("data:") or r.url.startswith("blob:")) else None)
        pg.route("**/*", mock); pg.add_init_script(f"try{{localStorage.setItem('aletheia.lang','{lang}')}}catch(e){{}}")
        return pg

    # 1. detector: version, Deep scan at General / High / Very high, models, ZH, PDF
    pg = page(); pg.goto(B + "index.html#detect"); pg.wait_for_timeout(1500)
    badge = pg.text_content(".vbadge") or ""
    check("version badge", (A.expect_version is None) or badge.strip() == "V" + A.expect_version, badge)
    pg.fill("#input", ESSAY)
    def run(lv, student):
        if pg.is_checked("#studentMode") != student: pg.click("label[for=studentMode]")
        if lv: pg.click("#pickBtn"); pg.click(f'#pickList [data-lv="{lv}"]')
        pg.evaluate("document.getElementById('deepPanel').innerHTML=''"); pg.click("#go")
        pg.wait_for_selector("#deepPanel .evbox, #deepPanel .covbox", timeout=180000); pg.wait_for_timeout(400)
        return re.sub(r"\s+", " ", pg.text_content("#deepPanel") or "")
    for lv, st, nm in [(None, False, "General"), ("1", True, "High"), ("2", True, "Very high")]:
        t = run(lv, st); check(f"deep scan {nm}", "%" in t and "undefined" not in t and "NaN" not in t, t[:90])
    for m in ["v196", "seg07", "current"]:
        if pg.locator(f'#modelBar [data-model="{m}"]').count():
            pg.click(f'#modelBar [data-model="{m}"]'); t = run(None, True); check(f"model {m}", "%" in t and "NaN" not in t)
    pg.click("#langBtn"); pg.wait_for_timeout(400)
    zh = pg.eval_on_selector_all("#deepPanel .zh-i", "a=>a.filter(x=>getComputedStyle(x).display!=='none').length")
    check("Chinese toggle shows ZH text", zh > 0, str(zh)); pg.click("#langBtn"); pg.wait_for_timeout(300)
    try:
        with pg.expect_download(timeout=120000) as d:
            pg.click("#mkPdf"); pg.wait_for_timeout(3000); pg.click("#pdfSave")
        pdfp = os.path.join(A.out, "report.pdf"); d.value.save_as(pdfp)
        from pypdf import PdfReader
        txt = " ".join((x.extract_text() or "") for x in PdfReader(pdfp).pages)
        check("detector PDF", "undefined" not in txt and "NaN" not in txt and (A.expect_version is None or A.expect_version in txt), f"{len(txt)} chars")
    except Exception as e: check("detector PDF", False, str(e)[:120])

    # 2. similarity mode (mocked), EN and ZH
    for lang in ["en", "zh"]:
        pg = page(lang); pg.goto(B + "index.html#detect"); pg.wait_for_timeout(1000)
        pg.fill("#input", SIMDOC); pg.click('.modes [data-mode="similarity"]'); pg.wait_for_timeout(300)
        pg.click("#go"); pg.wait_for_selector("#simPanel .simbig", timeout=120000); pg.wait_for_timeout(500)
        big = pg.text_content("#simPanel .simbig"); srcs = pg.text_content("#simPanel .srcs") or ""
        check(f"similarity {lang} score", big and big.strip() not in ("0%", ""), big)
        check(f"similarity {lang} sources", "Markov" in srcs, srcs[:80].replace("\n", " "))
        if lang == "en":
            check("similarity web source (mock relay)", "Music maths" in srcs, srcs[:120].replace("\n", " "))
            pg.uncheck("#sfBib"); pg.wait_for_timeout(300); check("filters recompute", pg.is_visible("#simPanel .simbig"))
            try:
                with pg.expect_download(timeout=60000) as d: pg.click("#simPdf")
                sp = os.path.join(A.out, "similarity.pdf"); d.value.save_as(sp)
                from pypdf import PdfReader
                t = " ".join((x.extract_text() or "") for x in PdfReader(sp).pages); check("similarity PDF", "undefined" not in t and "NaN" not in t and "Sources" in t, f"{len(t)} chars")
            except Exception as e: check("similarity PDF", False, str(e)[:120])
            pg.click('.modes [data-mode="deep"]'); pg.wait_for_timeout(300); check("mode switch hides similarity panel", pg.is_hidden("#simPanel"))

    # 3. writing process page with fixtures
    if not os.path.exists(os.path.join(HERE, "fx", "rich.docx")): subprocess.run([sys.executable, os.path.join(HERE, "make_fixture.py"), os.path.join(HERE, "fx", "rich.docx")], check=False)
    multi = [f for f in sorted(glob.glob(os.path.join(HERE, "fx", "draft*.docx"))) + glob.glob(os.path.join(HERE, "fx", "pasted.docx")) if os.path.exists(f)]
    cases = [("en", [os.path.join(HERE, "fx", "rich.docx")]), ("zh", [os.path.join(HERE, "fx", "rich.docx")])] + ([("en", multi)] if len(multi) > 1 else [])
    for lang, files in cases:
        pg = page(lang); pg.goto(B + "process.html"); pg.wait_for_timeout(500)
        pg.set_input_files("#file-input", files); pg.wait_for_selector("#main-results:not(.hidden)", timeout=60000); pg.wait_for_timeout(600)
        t = pg.inner_text("#main-results"); check(f"writing process {lang} x{len(files)}", len(t) > 400 and "undefined" not in t and "NaN" not in t, f"{len(t)} chars")

    # 4. other pages, theme, mobile
    for f in ["index.html#tools", "index.html#privacy", "index.html#changelog", "similarity.html", "references.html", "process.html"]:
        pg = page(); pg.goto(B + f); pg.wait_for_timeout(700); check("loads " + f, len(pg.inner_text("body")) > 200)
    m = page(w=390); m.goto(B + "index.html#detect"); m.wait_for_timeout(800); m.screenshot(path=os.path.join(A.out, "mobile.png"))
    check("mobile no horizontal overflow", m.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 2"))

    check("no page errors", not errs, "; ".join(errs[:3]))
    bad = [u for u in ext if not any(h in u for h in ALLOWED_EXT) and not any(h in u for h in ("wikipedia.org", "openalex.org", "workers.dev"))]
    check("no unexpected external requests", not bad, ", ".join(sorted(bad)[:5]))
    b.close()
srv.shutdown()
print(f"\n{len(FAILS)} failed" if FAILS else "\nALL PASS"); sys.exit(1 if FAILS else 0)

---
name: aletheia-autopilot-daily
description: Use for the scheduled ALETHEIA autopilot daily build (Mon–Sat, Nov 2026–Jan 2027): research, one small tested improvement on the autopilot branch, and a log entry.
---

# ALETHEIA autopilot — daily build (Mon–Sat)

The owner (Year 12 student, Brisbane) is away from 30 Nov 2026 to 22 Jan 2027 and wants ALETHEIA (aletheiadetect.com, repo chubbysheepsohandsome-creator/aletheia) to keep improving. Every weekday and Saturday you ship ONE small, tested improvement to the `autopilot` branch. Nobody is watching: decide and note your reading; never wait for answers. Write owner-facing text in Chinese (result first), code and commit messages in English.

## 0. Guard
- Today's date in Australia/Brisbane must be between 2026-11-30 and 2027-01-22. Before: stop with one line. After 2027-01-22: disable this scheduled task (update_trigger enabled=false; its prompt says when to stop) and stop.
- Sunday is release day; this skill is not for Sunday.

## 1. Set up (fresh cloud session; nothing from earlier sessions exists)
1. `add_repo` chubbysheepsohandsome-creator/aletheia with access "push", clone as instructed, `register_repo_root`.
2. `git fetch --depth=50 origin autopilot main`; `git checkout -B autopilot origin/autopilot` (if the branch is missing, create it from origin/main and push it).
3. If origin/main has commits that autopilot lacks (owner or Sunday release), merge origin/main into autopilot first.
4. `pip install --break-system-packages playwright pypdf` if missing; use /usr/bin/google-chrome if present, else `python3 -m playwright install chromium`.
5. Read the Project docs `claude/aletheia-autopilot-plan.md` (backlog, rules, weekly theme) and the last 7 entries of `claude/aletheia-autopilot-log.md`.

## 2. Research (about 15 minutes)
Search the web for one thing that helps today's task or the backlog: new detection research, student-writing integrity tools, browser APIs, citation styles, accessibility, competitor features (Turnitin, GPTZero, Copyleaks) described publicly. Record sources with links in the log. No scraping behind logins, no copying code with unknown licences (MIT/Apache/BSD/CC0 only, keep the notice).

## 3. Build one improvement (60–90 minutes)
- Pick the top backlog item matching today's theme in the plan (or a bug you found). Small and finishable today. Write it in the flat site files on the `autopilot` branch.
- Every user-facing string needs EN and ZH (`.en-i/.zh-i` spans, the ZH dictionary in index.html, or the `bz(en, zh)` helper; process/similarity/references pages have their own EN/ZH dicts).
- Add or extend a test in `autopilot/qa/` (run_qa.py checks or a node unit test) that proves the change works.
- Run `python3 autopilot/qa/run_qa.py . --out /tmp/qa` from the repo root. ALL PASS is required before committing. If you cannot make it pass, revert today's change, log why, and commit only notes.
- Commit with a clear message ending with the session attribution lines from the system reminder, then `git -c push.negotiate=true push origin autopilot`. Never push to main.

## 4. Hard limits (never break)
- Protected files, never edit: `deep_model*.js`, `model.js`, `engine.js`, the scoring/threshold code and `EV_CAL` numbers in `deep.js`, `report_fonts.js`, vendor libraries (jspdf, mammoth, pdf.js), `CNAME`, `ads.txt`. No training data exists in the cloud, so detector accuracy cannot be re-measured: never change detection behaviour or any accuracy number, rate, denominator or claim.
- No new third-party requests or trackers. Network features may only use services already disclosed on the privacy page (Wikipedia, OpenAlex, Crossref, the ALETHEIA search relay). Never send whole documents anywhere.
- Never call the live search relay more than 3 times a day (Serper credits are limited); tests use the mocks in run_qa.py.
- Never claim proof of authorship or that text "is AI"; keep the existing honest wording.
- No humanizer, evasion or "make it undetectable" features.
- Never print or store donated or user text; never use real student documents as fixtures (write synthetic ones).
- Licensed or donated data only; nothing scraped into the repo.
- Do not touch secrets, the Cloudflare account or the Serper account.

## 5. Log (always, even on failure)
Append to `claude/aletheia-autopilot-log.md` (read it first, then project_write the whole file): date, theme, what was built (files, commit hash), QA result, research notes with links, ideas added to the backlog, problems. Move finished backlog items to "Done" in the plan doc and add 2–3 new ideas. Keep the log short: roll entries older than 14 days into a summary.

## 6. Final message (Chinese, short)
What was built today, QA result, commit, anything risky the Sunday release must look at.

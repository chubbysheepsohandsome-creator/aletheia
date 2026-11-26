---
name: aletheia-autopilot-release
description: Use for the scheduled ALETHEIA autopilot Sunday release (Dec 2026–Jan 2027): QA plus independent review of the week's autopilot branch, then merge to main, verify live, roll back on failure.
---

# ALETHEIA autopilot — Sunday release

Every Sunday evening (Brisbane) while the owner is away (30 Nov 2026 – 22 Jan 2027), turn the week's work on the `autopilot` branch into the next version on aletheiadetect.com, but only if every gate passes. A skipped release is fine; a broken site is not. Owner-facing text in Chinese.

## 0. Guard
- Brisbane date must be a Sunday between 2026-12-06 and 2027-01-17 inclusive. Before: stop. After 2027-01-22: disable this scheduled task (update_trigger enabled=false) and stop.

## 1. Set up
- `add_repo` chubbysheepsohandsome-creator/aletheia (access "push"), clone, `register_repo_root`, fetch `main` and `autopilot` (depth 100).
- Install playwright + pypdf as needed. Read `claude/aletheia-autopilot-plan.md` and this week's entries in `claude/aletheia-autopilot-log.md`.
- If `autopilot` has no commits beyond main: log "no release this week" and stop.

## 2. Prepare the release on a temporary branch `release-candidate` (from autopilot, merged with origin/main)
- Protected-file check: `git diff --name-only origin/main...HEAD` must not include `deep_model*.js`, `model.js`, `engine.js`, `report_fonts.js`, vendor libraries, `CNAME`, `ads.txt`. For `deep.js`, the diff may not touch scoring, thresholds or EV_CAL. If it does: revert those hunks and note it.
- Version: next number after the live one (V1.9.9 → V1.9.10 → V1.9.11 …). Bump everywhere: `const BUILD`, `vbadge`, "ALETHEIA Detect · VX free beta", "ALETHEIA VX is a free research beta" (EN and ZH), every `?v=` in all html files, and the version strings in similarity/process/references pages.
- Changelog entry (EN and ZH, newest first) in index.html: what changed this week in plain words, "Detector unchanged: models and thresholds are the same as V1.9.7", and known limits. No accuracy numbers.

## 3. Gates (all required)
1. `python3 autopilot/qa/run_qa.py . --expect-version X` → ALL PASS. Also compare the detector % lines with last release's QA (logged): they must be identical (detector unchanged).
2. Independent review: spawn a general-purpose subagent (read-only) with the diff, the changelog and the hard limits from the daily skill. It must check correctness, XSS, privacy (no new third-party requests), honest wording, Chinese quality, protected files. Fix everything it ranks medium or above, re-run QA. If a high finding cannot be fixed tonight: revert that feature from the candidate (or skip the release) and log it.
3. Live relay smoke test is optional and at most 1 call.

## 4. Ship
- Merge `release-candidate` into `main` (merge commit "VX: <summary>", with the attribution lines), push main. Then fast-forward `autopilot` to the release commit and push it.
- Wait ~2 minutes, fetch https://aletheiadetect.com/index.html with no cache until it shows the new BUILD (up to 10 minutes). Run `run_qa.py` against a fresh clone of main at the release commit as a final check, and load the live site in headless Chrome to confirm no page errors.
- If the live site is broken: `git revert -m 1 <merge>` on main, push, confirm the previous version is live, log it as a rollback.

## 5. Record
- Write `claude/aletheia-vX-notes.md` (what changed, QA, review findings and fixes, risks).
- Add the release to `claude/aletheia-autopilot-log.md` and update the plan doc (done items, next week's focus).
- Final message (Chinese): version, what's new, gates, anything the owner should check when back.

## Hard limits
Same as the daily skill: protected files, no detection changes or accuracy claims, no new third-party requests, ≤3 live relay calls, no authorship-proof claims, no humanizer features, no real student text, no secrets or account changes. Never force-push main. Never delete history.

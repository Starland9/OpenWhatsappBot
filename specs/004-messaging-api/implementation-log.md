# Implementation log: feature 004 (messaging API)

## Baseline (T001, T002), 2026-11-02

- BASE = `136f9c2` (last documentation commit; branch `004-messaging-api` departs from `master` at `6706c4b`).
- Full suite, Node v24.20.0, `NODE_OPTIONS=--max-old-space-size=1024`: **2,962 tests, 2,955 pass, 0 fail, 7 skipped**; `BOT_LANG=fr` 43 s, `BOT_LANG=en` 54 s.
- `node tools/check-unused-deps.js`: `0 unused dependencies`.
- `tools/measure-panel-memory.js` (median of 3, idle 20 s): baseline RSS 170.2 MB, panel RSS 191.8 MB, delta **21.7 MB** (heap+external 6.9 MB).
- ffmpeg 6.1.1 present (media tests will run); `sharp` and `file-type` load; `test/fixtures/` does not exist; no `lib/api`, `lib/messaging`, `lib/utils/{schema,sendGate,apiState,stickerMaker}.js` yet.

## Waves

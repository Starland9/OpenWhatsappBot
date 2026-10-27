# Quickstart: validating the audit and its fixes

## Prerequisites

| Tool | Version | Check |
| ------ | --------- | ------- |
| Node.js | >= 24 (`package.json` engines) | `nvm use 24 && node -v` |
| Yarn | 4.17, vendored | `node .yarn/releases/yarn-4.17.0.cjs -v` (or `corepack enable`, then `yarn -v`) |
| ffmpeg | any recent version | `ffmpeg -version` |
| yt-dlp | latest release (R, section C) | `yt-dlp --version`. Without it, `youtube`, `insta` and `dl` answer "service indisponible" |

## 1. Clean install

```bash
nvm use 24
rm -rf node_modules
node .yarn/releases/yarn-4.17.0.cjs install   # or: yarn install
```

Expected: no missing modules (`@ryuu-reinzz/button-helper`, `html-entities`), and `node -e "require('baileys/package.json').version"` prints `7.0.0-rc14`.

## 2. Automated check (FR-024, SC-010)

```bash
yarn test                              # node --test test/
BOT_LANG=fr yarn test                  # same in French
node --test --test-name-pattern=alias test/   # one family of checks
```

Expected: every test passes in under 2 minutes, with no network access needed (axios, fetch and `execFile` are stubbed). The families are described in [research.md, section F](research.md#f-verification-fr-024).

## 3. Start-up

```bash
LOG_LEVEL=debug yarn dev
```

Expected in the logs:
- `Loaded 80 plugins` (or the final count), and no `Failed to load plugin` line;
- no `alias already registered` warning;
- `Database synced` against an **existing** database, which shows that `alter` is additive.

## 4. Manual checks on a real account (FR-025)

Use a test number set as `SUDO`, a second test number, and a group where the bot is admin. The complete checklist, with a pass/fail box per line, is in the audit report `docs/AUDIT_COMMANDES.md`. Essential scenarios:

| # | Scenario | Expected |
| --- | ---------- | ---------- |
| 1 | `.kiss`, `.export`, `.faq` | No response |
| 2 | Second number: `.vv` (replying to a view-once), `.exec 1`, `.ban` | Refused |
| 3 | `.welcome on`, then add the second number to the group | Welcome message that mentions them |
| 4 | `.goodbye on`, then remove them | Goodbye message |
| 5 | `.filter salut=Bonjour !`, then send "Salut" | "Bonjour !" |
| 6 | Second number: `.afk lunch`; first number mentions them | AFK reply with the reason; reset when the second number writes again |
| 7 | `.ban` in a group, then `.ping` from the second number; restart the bot; `.ping` again; then `.unban` from SUDO | Silence before and after the restart, then the bot responds again |
| 8 | Send messages, then `.level`, `.top` | Non-zero counters |
| 9 | `.remind 1m test`, restart the bot within the minute | The reminder arrives |
| 10 | `.menu2`, tap a category; `.ttt @second`, tap a cell | The buttons work (R8) |
| 11 | Same scenarios 3, 5 and 10 with `yarn panel` | Identical behaviour |
| 12 | `.ytv <url>`, `.yta <url>` | A playable video / audio |

## 5. Dependencies (FR-026 to FR-029, SC-011)

```bash
node .yarn/releases/yarn-4.17.0.cjs outdated   # expected: only baileys (prerelease) listed, or nothing
node tools/check-unused-deps.js                # expected: "0 unused dependencies" (script delivered by the dependency task)
```

# Implementation log (feature 002)

Orchestrator notes, kept across context compactions. Decisions taken while the user was away are in [research.md](research.md) (O-rows).

## Baseline (T003, 2026-10-28)

- BASE = `8f41358e3a4d53e498e233a3361fbbdeaca35c07` (last documentation commit before implementation; the branch departs from `001-audit-fix-commands`, not merged into `master`).
- `yarn test`: 208 tests, 205 pass, 0 fail, 3 skipped, about 4 s.
- `test/panel.test.js`: 14 pass.
- `node tools/check-unused-deps.js`: 0 unused dependencies.

## Progress

| Wave | Agent | Tasks | Status | Commit |
| --- | --- | --- | --- | --- |
| Setup | main | T001–T003 | done | (this commit) |
| W0-A | F1 | T019–T025 | done | a96eedf |
| W0-A | F7 | T038–T042 | done | 08f47a7 |

## Pending requests (feed to later agents)

- F5: call `logger.install()` first in `index.js` and `panel.js`, then `setLevel(config.LOG_LEVEL)` after `store.load()`; replace the `pino(` calls left in `index.js`, `panel.js`, `lib/core/pipeline.js`, `lib/utils/{conversationManager,antiDeleteHandler,memoryManager}.js` (antiDeleteHandler is F2's in W0) so `test/admin-logging.test.js` passes; pipeline tests call `maintenanceMode._reset()` between tests.
- W1 (W-CMD, W-GRP, W-ALR): emit on the bus (`lib/utils/events.js`) and pass `service` to `classifyError` in the nine plugins.
| W0-A | F3 | T004–T018 | done | 3ae351b |
| W0-A | F6 | T060–T073 | done | 90f7df3 |

Note for the user: F6's headless-Chrome smoke left `/tmp/owb-chrome-*` profile directories; its own cleanup was denied by the permission system, so the orchestrator left them for the user to remove (`rm -rf /tmp/owb-chrome-*`).
| W0-A | F2 | T026–T037 | done | 4e9b3be |

**Incident (F2)**: a scratch script of agent F2 loaded the real `config.env` through `config.js` and printed some values in the agent's own tool output (nothing written or committed). Mitigation: `config.js` now skips `config.env` when `OWB_NO_CONFIG_ENV=1` (commit cf7f25c); every later agent runs with it exported, and F5 sets it in `test/helpers/fakes.js#setupEnv`. To report to the user.

- F2 requests (boot, F5): `settingsStore.load({ models, secretBox, redactor })` after `sync()` and before `PluginLoader.loadAll()`; `restartBot` calls `settingsStore.reload()` + `markInForce()` + `reconfigure()` on the three singletons; `BOT_LANG` change → `languageManager.reload()` (unwired: give to F5 via store change event); `TIMEZONE` change → broadcaster recompute (W-BC).
| W0-A | F4 | T043–T059 | done | 2836534 |

- F4 requests: W-DASH and W-PAIR call `hub.setSnapshot("state"|"pairing", fn)` and `hub.publishState({force:true})`; W2-A adds panel key `errors.starting`.
| W0-B | F5 | T074–T084 | done | 2fbf530 |

- F5 requests: W2-A merges `bot-*` fragments (until then `admin.panel_listening`, `admin.setup_link` print raw keys); W2-C turns guarded requires in `lib/core/boot.js` into hard requires (ENGINES, textOverrides, commandState, ytdlpUpdate).
| W0-B | F8 | T085–T096 | done | e2440fc |
| W0 | main | T097–T098 | checkpoint passed | (this commit) |

### W0 checkpoint (isolated worktree, fresh SQLite, no config.env)

- Boot: 79 plugins, no load failure, setup link printed once in French without a pino prefix; `/health` 503 `initializing` (no WhatsApp), `/admin/` 200, `/admin/api/session` 200.
- US1: setup with 11 chars → 422 `validation_failed`; 12+ → 200 + session; reused link → 303 `/admin/#/setup/invalid`; 6 wrong logins → 401×5 then 429 (`Retry-After: 900`); right password while blocked → 429; `tools/admin-reset.js` prints a link; consuming a reset link revokes the older sessions (per contract, issuing alone does not).
- Port already in use → logged error, bot keeps running without the panel.
- `/admin/api/settings` answers 404 until W-SET registers it (route-level 401 is covered by `test/admin-security.test.js` for registered routes).
- Polish for W2-A: French wording mixes "Panel d'administration" (setup link) and "Panneau d'administration" (listen error); use one term ("panel d'administration").
| W1-A | W-CMD | T120–T129 | done | bcff10b |
| W1-A | W-PAIR | T115–T119 | done | 880090d |

- W2-A requests so far: CSS class `.pairing-code` (large monospace); merge every `panel-*` and `bot-*` fragment; panel key `errors.starting`; one French term "panel d'administration".
| W1-A | W-DASH | T099–T105, T142–T149 | done | ad3916f |

- W2-A CSS requests: `.card + .card` margin inside `.grid`; `.log-msg` wrap rule. W-BAK/W-MNT use `getStateService(deps).addBannerProvider(fn)` (banners `restore_interrupted`, `update_restart` via `deps.updater.restartRequired()`).
| W1-B | W-ALR | T199–T205 | done | 949f337 |

- W2-C request: `plugins/reddit.js` (`REDDIT_BAD_CREDENTIALS`) and `plugins/news.js` (`newsApiKind` `apiKeyInvalid`) answer before `classifyError`, so these refusals never emit `key:refused`; emit it (or call classifyError with `service`) on those paths. Housekeeping may call `alerts.prune` (idempotent).
| W1-A | W-SET | T106–T114, T193–T198 | done | 9a09768 |

- W2-C request (atomicity): add an optional `transaction` to `settingsStore.set/unset` and make SET-2 write store overrides and model adapters in one transaction (today a DB adapter failure after the store commit leaves overrides applied and answers 500). `test/helpers/fakeDom.js` is reusable for view tests.
| W1-A | W-GRP | T130–T141 | done | 591bc88 |

- W2-B: CLAUDE.md onMessage order gains knownchats (5) and groupguard (50); `lib/utils/warnings.js` is the shared warning helper. W2-C: align the router `userJid` pattern (`\d{5,20}`) with the samples of `test/admin-security.test.js` (W-GRP used `\d{3,20}` on its two routes). The `BAE5` id shape is not in Baileys 6.7.9/7.0.0-rc14 sources (kept as recalled, see comment in groupguard).
| W1-B | W-BC | T158–T166 | done | 2d5aaea |
| W1-B | main | router fix | `paramsFit` in match(): a route whose parameter cannot match is not a candidate (405 on literal paths) | cb26803 |
| W1-B | W-DATA | T150–T157 | done | 06fe5e6 |

- W2-C requests: `alerts.js#resolveRow` passes `updatedAt` with `silent: true`, which Sequelize ignores (retention of resolved outbox rows counts from creation): set the timestamp explicitly. The `GET /broadcasts/preview` 405 guard route of W-BC is redundant since the router fix (keep or drop with its table test).
| W1-B | W-MNT | T177–T192 | done | 20a46fa |

Note for the user: W-MNT's killed first test run left 3 `/tmp/owb-updater-*` directories; its cleanup was denied by the permission classifier, so they are left for the user (`rm -rf /tmp/owb-updater-*`). W2-A: update the `update` row of `docs/AUDIT_COMMANDES.md` (W2-B owns docs). W2-C: `ytdlpUpdate` becomes a hard require in boot.js.
| W1-B | W-BAK | T167–T176 | done | fcc094e |

- W2-A: fix the import scanner of `test/admin-frontend.test.js` (it reads string literals such as ".../backup/export" as ES export statements) and revert W-BAK's `${"expor"}t` workaround in `backup-logic.mjs` (EXPORT_PATH); CSS class for `<progress>`. W2-B: document BAK-1 `Content-Length` and the BAK-2 summary fields `ignoredSettings`/`ignoredTexts`. Optional: share the scrypt gate of `password.js` with BAK-1/BAK-2.

### W1 checkpoint B (all W1 agents committed)

- Full suite: 2349 tests, 2343 pass, 0 fail, 6 skipped (one is the opt-in Postgres round trip), 18 s, identical with `BOT_LANG=fr` and `en`. `check-unused-deps`: 0.
| W2 | W2-B | T211–T216 | done | 57a6d8f |
| W2 | W2-A | T206–T210 | done | 5bc858e |
| W2 | W2-C | T217–T220 + 5 fixes | done | 8268f65 |

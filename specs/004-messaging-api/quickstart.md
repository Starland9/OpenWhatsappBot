# Quickstart: validating the messaging API

How to validate feature 004 end to end: the automated checks by area, a manual run with `curl` against a local bot (every format, media by file and by URL, status and wait, idempotency, every refusal of US1 and US2, the SSRF battery, the plain-HTTP rule), the panel walkthrough (US4), a check for every success criterion (SC-001 to SC-011), and the **Phone checklist** (SC-004 and the risks of [research.md](research.md) section 3) that only a real phone can settle. No implementation code here: the wire contract is [contracts/public-api.md](contracts/public-api.md), the engine and the modules are [contracts/runtime.md](contracts/runtime.md), the panel routes [contracts/admin-api.md](contracts/admin-api.md), the screens [contracts/panel-ui.md](contracts/panel-ui.md), the tables [data-model.md](data-model.md), the requirements [spec.md](spec.md).

Legend: **Auto** = covered by the offline suite (no WhatsApp, no network), **Manual** = needs the bot running with a browser and `curl`, **Phone** = needs a paired WhatsApp account and real handsets. The panel labels ("API", "Keys", "History", "Usage", "Test", "Docs") are the English ones. The bot answers in French unless `BOT_LANG=en`.

## Prerequisites

| Tool | Version | Check |
| ---- | ------- | ----- |
| Node.js | >= 24 (`package.json` engines) | `source ~/.nvm/nvm.sh && nvm use 24 && node -v` |
| Yarn | vendored (`.yarn/releases`) | `node .yarn/releases/yarn-4.17.0.cjs -v` (or `corepack enable`, then `yarn -v`) |
| ffmpeg | any recent | `ffmpeg -version`; needed by the voice, GIF and sticker paths and to generate the samples below (the suites that need it skip themselves when it is missing) |
| curl, jq | any | `curl --version`, `jq --version` |
| Browser | the two latest Chrome, Firefox or Safari | DevTools device toolbar for the 360 px check |

Run every ad-hoc script, tool and agent command with `OWB_NO_CONFIG_ENV=1` (`config.js` then skips `config.env`, the owner's secrets); the tests set it themselves. Never read or print `config.env`, `sessions/`, `data/` or `database.db` of the real install: the manual part runs in a sandbox (section 2).

**Resource discipline** (memory note `resource-limits`: an out-of-memory test once closed the editor): always cap memory and time, run one test file at a time, never start two suites at once, run the full suite once at the end. On exit 137 or "heap out of memory", stop and bisect with a smaller scope before running anything again.

The cast for the manual and phone parts:

| Name | Who | Notes |
| ---- | --- | ----- |
| B | the bot account | a **spare** number paired in the sandbox (never your main number: the checklist sends bursts and one message to a never-contacted number) |
| O | the owner phone | listed in `SUDO`; also the panel owner in the browser |
| R | recipient phone 1 | has written to the bot once in private (a known chat); shows native buttons |
| R2 | recipient phone 2 | a handset or client that does **not** render native buttons (older phone, desktop client); skip the numbered-answer checks and record "not run" if you have none |
| G | test group | B is **admin**; O, R and R2 are members |
| G2 | second test group | only admins may send; B is an ordinary member |
| G3 | a group B has left | copy its id from the panel before leaving |
| L | optional: a member of G whose number WhatsApp hides (LID only) | for the mention and poll-vote checks |
| X | a valid-looking number that is not on WhatsApp | for `not_on_whatsapp` |
| N | optional: a number that never chatted with B and is in no contact list | for the `463` observation (Phone checklist, R6) |

Samples for the media formats (generated once in a scratch folder; any equivalent small files do):

```bash
mkdir -p /tmp/owb-qs && cd /tmp/owb-qs
ffmpeg -loglevel error -f lavfi -i testsrc=duration=2:size=320x240:rate=15 -pix_fmt yuv420p sample.mp4
ffmpeg -loglevel error -f lavfi -i testsrc=duration=2:size=320x240:rate=10 sample.gif
ffmpeg -loglevel error -f lavfi -i testsrc -frames:v 1 sample.jpg
ffmpeg -loglevel error -f lavfi -i testsrc -frames:v 1 sample.png
ffmpeg -loglevel error -f lavfi -i sine=frequency=440:duration=2 -c:a libopus sample.ogg
ffmpeg -loglevel error -f lavfi -i sine=frequency=440:duration=2 sample.mp3
# any small PDF as sample.pdf; the next three are deliberate traps
printf '#!/bin/sh\necho trap\n' > script-as-image.jpg
{ cat sample.jpg; head -c 17000000 /dev/zero; } > too-big.jpg        # valid start, 17 MB: over the 16 MB image cap
head -c 64 sample.ogg > corrupt.ogg                                  # a valid Ogg start with nothing decodable: media_conversion_failed on a voice note
cp /bin/true fake.pdf                                                # an executable named .pdf
```

## 1. Automated checks

```bash
source ~/.nvm/nvm.sh && nvm use 24
export OWB_NO_CONFIG_ENV=1
NODE_OPTIONS=--max-old-space-size=1024 timeout 600 yarn test        # whole suite, once, at the end
BOT_LANG=en NODE_OPTIONS=--max-old-space-size=1024 timeout 600 yarn test   # same in English (default is fr)
timeout 120 node --max-old-space-size=1024 --test --test-force-exit --test-timeout=30000 test/api-contract.test.js   # one file
for f in test/api-*.test.js; do timeout 120 node --max-old-space-size=1024 --test --test-force-exit --test-timeout=30000 "$f" || break; done   # one area, one file at a time
node tools/check-unused-deps.js                                     # expected: "0 unused dependencies" (no dependency was added, G2)
node tools/measure-panel-memory.js                                  # SC-011: new modes api-off and api-on
```

Expected: every test passes with no network, no WhatsApp and no write to the real `data/`, `sessions/` or `database.db`. Report the test count and duration in the PR. `LOG_LEVEL=debug node index.js` (sandbox) prints one more plugin than before the feature (the hook-only `apireplies.js`), no `Failed to load plugin` and no `Duplicate alias`. `measure-panel-memory.js` exits 0, the panel delta stays under its current 50 MB bound, and `api-on` minus `api-off` stays under 20 MiB.

Translations (bot fragment `bot-api.json`, panel fragments `panel-api.json`, `panel-api-server.json`, and the six alert titles in the 002 fragment `panel-alerts.json`): after the merges of [contracts/panel-ui.md](contracts/panel-ui.md) 11.2 and [contracts/runtime.md](contracts/runtime.md) 17.2, a second dry run changes nothing.

```bash
node tools/merge-i18n.js --frag-dir specs/004-messaging-api/i18n --pattern "bot-*.json" --dry-run
node tools/merge-panel-i18n.js --frag-dir specs/004-messaging-api/i18n --dry-run
node tools/merge-panel-i18n.js --frag-dir specs/002-admin-panel/i18n --dry-run
git status --short lang lib/admin/public/i18n      # the catalogs only differ by the merges of this feature
```

New and edited suites by area (names as in the contracts; follow the tasks if one was renamed). The "Test obligations" section of each contract is the complete list.

| Area | Test files | Covers |
| ---- | ---------- | ------ |
| Data ([data-model.md](data-model.md)) | `database.test.js` (edit), `api-data.test.js`, `api-state.test.js`, `api-retention.test.js`, `backup.test.js` (edit, `helpers/backupKit.js`), `housekeeping.test.js`, `settings-store.test.js`, `admin-settings.test.js`, `config-accessors.test.js`, `settings-example.test.js`, `capture-sites.test.js` (edits); helper `helpers/apiInvariants.js` | the 4 tables, 7 unique indexes, no per-column UNIQUE, NULL-distinct pairs, status machine T1-T11 and invariants I1-I9, key names and `version` CAS, `ApiState` (no row created by a read, caps 20 and 50), the five housekeeping steps, the four models excluded from backups, 112 settings with 11 new panel-only entries, no top-level `= config.` |
| Engine ([runtime.md](contracts/runtime.md) 1-14) | `messaging-formats.test.js`, `messaging-submit.test.js`, `messaging-outbox.test.js`, `messaging-recipients.test.js`, `messaging-receipts.test.js`, `messaging-replies.test.js`, `messaging-never-command.test.js`, `messaging-media.test.js`, `send-gate.test.js`, `schema.test.js`; edits `broadcaster.test.js` (unchanged assertions), `pipeline.test.js`, `hooks.test.js`, `boot.test.js`, `permissions.test.js`, and the `knownChats`, sticker and buttons tests | the 13 format modules and their real Baileys content, accept path and admission, pacing (SC-005), at-most-once across a crash (SC-006), the `463` breaker (3 in 10 minutes), receipts, reply and poll-vote capture, the `sentIds` guard (SC-008), media staging, the shared send gate, nested schemas |
| Public API ([public-api.md](contracts/public-api.md), [runtime.md](contracts/runtime.md) 15-16) | `api-contract.test.js`, `api-security.test.js`, `api-pipeline.test.js`, `api-messages.test.js`, `api-formats-contract.test.js`, `api-quotas.test.js`, `api-idempotency.test.js`, `api-multipart.test.js`, `url-fetch.test.js`, `api-availability.test.js`, `api-openapi.test.js`, `api-leak-scan.test.js`, `api-registry.test.js`, `api-keys.test.js`, `api-ip-rules.test.js`, `api-transport.test.js`, `api-lifecycle.test.js`; edits `panel-legacy.test.js`, `admin-logging.test.js`, `admin-memory.test.js` | document, registries and OpenAPI cannot drift; SC-002 route-table enumeration; check order; error catalogue; quotas and idempotency on the fake clock; multipart fuzz; SSRF battery (SC-007); availability table of section 9; SC-003 leak scan; SC-009 demo module; SC-011 memory |
| Panel backend ([admin-api.md](contracts/admin-api.md)) | `admin-integration.test.js`, `admin-http.test.js`, `admin-security.test.js`, `admin-i18n.test.js`, `admin-audit.test.js`, `admin-view-logs-stats.test.js`, `alerts.test.js`, `admin-alerts.test.js` (edits); new `admin-stepup.test.js`, `admin-api-state.test.js`, `admin-api-keys.test.js`, `admin-api-messages.test.js`, `admin-api-leak.test.js`, `admin-uploads.test.js` (edit) | routes API-1..13 and AUTH-7 against the contract, the exact `stepUp` set, widening matrix (login starts the 5-minute window), `policy_anyone` order, secret once, revoke cancels, engine refusals mapped (no 500), audit rows without secrets, upload purpose `api` |
| Panel UI ([panel-ui.md](contracts/panel-ui.md)) | `admin-view-api-logic.test.js`, `admin-view-api.test.js`, `admin-view-api-messages.test.js`, `admin-view-api-test.test.js`, `admin-view-api-guards.test.js`, `admin-view-guard.test.js`, `api-panel-texts.test.js`; edits `admin-frontend.test.js`, `admin-view-alerts.test.js` | pure logic against the shared fixtures (`api-ip-entries.json`, `api-widenings.json`), enable/disable/networks/keys/editor/secret dialog flows, bounded polling, the generic test form for the 13 real descriptors, render-loop guards, every panel text for every registered right, format and failure code |

## 2. Work in a sandbox

Manual scenarios create a session, a database, `data/panel.key`, API keys and staged media. Run them in a scratch worktree so the real `sessions/`, `database.db` and `data/` are never touched.

```bash
source ~/.nvm/nvm.sh && nvm use 24
git worktree add --detach ../owb-qs4 004-messaging-api
cd ../owb-qs4
node .yarn/releases/yarn-4.17.0.cjs install                       # no config.env in the sandbox: pass settings inline
OWB_NO_CONFIG_ENV=1 SUDO=<O's number, digits only> LOG_LEVEL=info node index.js   # prints the QR and the panel setup link
```

Pair B (QR or pairing code), open the setup link, choose a password, log in. B must be a member of G (admin) and G2, and must have left G3. The bot listens on `127.0.0.1:3000` unless `PANEL_PORT`/`PORT` is set. Most refusal checks (3.1, rows 1-10 and 14-16 of 3.4, 3.6, 3.7, 3.8) need the bot process only: an unpaired bot still accepts and queues, and a queued message expires at `API_QUEUE_EXPIRY_MIN`. To start over: stop the bot and delete `sessions/main`, `database.db` and `data/` inside the sandbox.

Shell helpers used below (a scratch shell, not repository code):

```bash
export BASE=http://127.0.0.1:3000/api/v1
export R=<R's number with country code>  G=<G's id, digits@g.us>  G2=<G2's id>  G3=<G3's id>  X=<unregistered number>  BOTNUM=<B's number>
export BAD=owbk_0123456789abcdef_$(printf 'A%.0s' $(seq 43))                   # well-formed token, wrong secret
send()     { curl -sS -i -X POST "$BASE/messages${WAIT:+?wait=$WAIT}" -H "Authorization: Bearer ${KEY:-$OWB_KEY}" "$@"; }
sendjson() { local b="$1"; shift; send -H 'Content-Type: application/json' -d "$b" "$@"; }                  # $1 = the JSON body, then extra curl flags
sendfile() { local m="$1" f="$2"; shift 2; send -F "message=$m;type=application/json" -F "file=@$f" "$@"; }   # $1 = the JSON part, $2 = the file
get()      { curl -sS -i "$BASE/$1" -H "Authorization: Bearer ${KEY:-$OWB_KEY}"; }
```

Every request body is the example block of the matching format in [contracts/public-api.md](contracts/public-api.md) section 3 with `to` replaced by `$R` or `$G`; the commands below name the format and the section instead of repeating the bodies.

## 3. End-to-end run with curl

### 3.1 Switched off (US1.1, FR-001, FR-007)

Before the first enable (the default), every path under `/api/v1/` answers exactly like any unknown URL, whatever the verb and the key:

```bash
for m in GET POST OPTIONS; do
  diff <(curl -si -X $m "$BASE/messages" | grep -vi '^date:') <(curl -si -X $m http://127.0.0.1:3000/unknown | grep -vi '^date:') && echo "$m identical"
done
diff <(curl -si "$BASE/openapi.json" -H "Authorization: Bearer $BAD" | grep -vi '^date:') <(curl -si http://127.0.0.1:3000/unknown | grep -vi '^date:') && echo "with a key: identical"
```

Expected: three "identical" and the keyed one, no JSON body, no hint that an API exists. The same answer holds with `ADMIN_PANEL=false` (restart the sandbox with it, repeat, restore) and while the registry has failed (automated only).

### 3.2 Enable and create the keys (US1.2, US4.7)

In the browser: **API**. The page shows the "disabled" banner. **Enable** shows the warning dialog (ban risk, key shown once); confirm; the password dialog follows when the session is not confirmed (right after a login it is, for 5 minutes: see section 4, step 4). Then **Keys > New key** three times (each creation asks for the password when the 5 minutes have passed):

| Key | Rights | Recipients | Other |
| --- | ------ | ---------- | ----- |
| `qs-all` | the 13 `messages.send.*`, `messages.read`, `media.url`, `api.docs` | list: R, G, G2, G3, X, `$BOTNUM` | defaults |
| `qs-text` | `messages.send.text` only | list: R | defaults |
| `qs-read` | `messages.read` only | list: R | defaults |

For each creation the secret dialog shows the whole key once, with Copy; Escape does not close it; closing without copying asks first. Copy `qs-all` into `OWB_KEY`, `qs-text` into `TEXT_KEY`, `qs-read` into `READ_KEY` (the helpers use `KEY` when set: `KEY=$TEXT_KEY sendjson ...`). Afterwards the list shows only the name and the last 4 characters. `grep -r "$OWB_KEY"` over the sandbox log output and `data/` finds nothing (SC-003; the hash is stored, never the key).

### 3.3 First text, latency, never a command (US1.3, US1.7, SC-001, SC-008, SC-010)

```bash
time sendjson "{\"format\":\"text\",\"to\":\"$R\",\"text\":\"Hello from the API\"}"
```

Expected: `HTTP/1.1 202`, `Location: /api/v1/messages/msg_...`, `X-Request-Id`, `Cache-Control: no-store`, body `status: "queued"`, in under one second (SC-010). Within seconds `get messages/<id>` shows `sent`, and R receives the text from B (Phone). Stopwatch for SC-001: from the enabled API to the first text on R's phone, using only the **Docs** tab, under 5 minutes.

Never a command: send `.eval 1+1` and `.restart` as texts to R (`qs-all`). R receives the exact text; the sandbox log shows no command dispatch and no restart; O's chat with B shows no reply. Repeat with the prefix of your `PREFIX` followed by an owner command in group G.

### 3.4 Refusals of US1 (check order of public-api.md section 5)

Use `qs-all` unless the row says otherwise. Every refusal carries `X-Request-Id`, an `error.code` and no prose; none of them creates a message (the API page's History tab does not move). Rows 1, 14, 15 and 16 count toward the origin budget (10 failures in 5 minutes, steps 7-9 of public-api.md section 5): run row 14 last, or restart the sandbox to reset the in-memory budget.

| # | Request | Expected |
| - | ------- | -------- |
| 1 | no `Authorization` header; a wrong secret; a malformed token; an unknown id | `401 unauthenticated` for all four, same body, `WWW-Authenticate` set |
| 2 | `TEXT_KEY` posting `format: "image"` | `403 forbidden`, `params.right = "messages.send.image"` |
| 3 | `KEY=$TEXT_KEY` with `to` = G (not in its list), then with both a missing right and a foreign `to` | `403 recipient_not_allowed` (never echoing the number); the second case answers `forbidden` first (right before policy) |
| 4 | `to` = `$BOTNUM` with `qs-all` (it lists the number), then with `TEXT_KEY` | `422 validation_failed`, `fields.to = { code: "not_allowed" }`; for `TEXT_KEY` `403 recipient_not_allowed` first (the policy is judged before the self check) |
| 5 | `to` = a LID or `...@s.whatsapp.net` | `422`, `fields.to = { code: "invalid_format" }` |
| 6 | `READ_KEY` posting any message; `TEXT_KEY` on `GET /openapi.json` | `403 forbidden` with the right named (`messages.send.<format>`, `api.docs`); `qs-all` on the same path gets `200` |
| 7 | the key in the query: `curl "$BASE/messages?api_key=$OWB_KEY" -H "Authorization: Bearer $OWB_KEY"`; the key in the path | `400 key_in_url`, the key is not used |
| 8 | any request with `-H 'Origin: https://evil.example'` or `Sec-Fetch-Site: cross-site`; `OPTIONS /messages` | `403 browser_not_allowed`; `405 method_not_allowed`; no `Access-Control-*` header anywhere |
| 9 | the panel session cookie alone (copied from the browser); `OWB_KEY` presented to `curl -si http://127.0.0.1:3000/admin/api/api -H "Authorization: Bearer $OWB_KEY"` | `401 unauthenticated` on the API; the panel route is `401` too (the key is inert there) |
| 10 | each in its own request: unknown field `"foo": 1`; `text` of 4,097 characters; `mentions` on a private chat; `Idempotency-Key: bad key`; `?wait=31` and `?wait=true`; invalid JSON; `Content-Type: text/plain` | `422` with `fields` listing each fault (`$unknown`/`unknown_field`, `text`/`too_long`, `mentions`/`not_allowed`, `idempotency-key`/`invalid_format`, `wait`/`out_of_range` and `invalid_format`); `400 bad_request`; `415 unsupported_media_type` |
| 11 | O sends the `ban` command inside G, then a send to G; the `unban` command afterwards | `409 chat_disabled`; the send works again after `unban` |
| 12 | `to` = X (valid-looking, not on WhatsApp) | `202`, then `failed` with `failure.code = not_on_whatsapp`; nothing delivered |
| 13 | `to` = G3 (B left), G2 (announce-only, B not admin) | `202`, then `failed` with `not_in_group`, then `failed` with `group_announce_only` |
| 14 | bad-secret requests in a row from this terminal (`KEY=$BAD get messages`), ten failures counted in all, then one with the valid key | the tenth failure starts the block; the next request, **even with the valid key**, is `429 origin_blocked` with `Retry-After` up to 900; O receives the `api_origin_blocked` WhatsApp alert once; the block ends after 15 minutes or at a restart (the budget is in memory) |
| 15 | revoke `qs-text` in the panel while it has queued messages (stop the bot's connection or queue many first), then call with it | `401 key_revoked` on the next request; its queued messages become `cancelled` (`key_revoked`); the key leaves the list after `API_RETENTION_DAYS` |
| 16 | give a key an expiry two minutes ahead and wait; then give another key an IP allowlist that excludes `127.0.0.1` | `401 key_expired` (queued messages `cancelled`, `key_expired`); `403 ip_not_allowed` only after the secret matched |

### 3.5 The 13 formats (US2, US5, US6, SC-004)

Each row is one `202`; follow with `get messages/<id>` until `sent` and check the handset (Phone checklist P1-P13 gives the rendering to expect). Files are the samples of the prerequisites; the JSON part is the example block of the format.

| Format | How | File | Notes |
| ------ | --- | ---- | ----- |
| `text` | `sendjson` | none | 3.2 of the contract; add `mentions` in G (digits) with `@digits` in the text |
| `image` | `sendfile` | `sample.jpg` | caption |
| `video` | `sendfile` | `sample.mp4` | caption |
| `gif` | `sendfile` twice | `sample.gif`, then `sample.mp4` | the GIF is converted to a looping MP4 |
| `audio` | `sendfile` | `sample.mp3` | |
| `voice` | `sendfile` | `sample.mp3`, then `sample.ogg` | converted to Ogg/Opus |
| `document` | `sendfile` | `sample.pdf` | caption and `fileName` |
| `sticker` | `sendfile` | `sample.png` | |
| `location` | `sendjson` | none | |
| `contact` | `sendjson` | none | one card, then two cards |
| `poll` | `sendjson` to G | none | `multiple: false`, then `true` |
| `buttons` | `sendjson` | none | 2 buttons, ids from the example |
| `list` | `sendjson` | none | 2 choices |

Also: `get openapi.json` with `qs-all` returns the OpenAPI 3.1 document; `WAIT=30 sendjson ...` returns at `sent` with the status of that moment; `delivered` and `read` never end a wait; with `wait` the headers still carry `Location`. A reply after the quote works: send a text, wait for `sent`, then send another with `"quote": "<first id>"` (a still queued id, another key's id and an unknown id are all `fields.quote = { code: "not_found" }`).

### 3.6 Media by URL (US2.6-2.8) and media refusals (US2.4-2.5)

`media.url` needs a public HTTPS file you control (valid certificate, standard port). Send `format: "image"` with `"media": { "url": "https://<your host>/sample.jpg" }` and `qs-all`: `202`, and the file reaches R. Remove `media.url` from `qs-all` (a narrowing: no password) and repeat: `403 forbidden`, `right: "media.url"`, and the request log of your server shows no hit (nothing fetched); add it back (this asks the password). `linkPreview: true` on a text also needs `media.url`.

| # | Request | Expected |
| - | ------- | -------- |
| 1 | `sendfile` `format: "image"` with `script-as-image.jpg` | `422 media_type_mismatch`, `params.expected` only (never the detected type); no file left under `data/tmp/api/` or `data/api-media/` |
| 2 | `sendfile` `format: "image"` with `too-big.jpg` | `413 media_too_large` with `params.maxBytes`; the upload is cut at the cap, not read to the end |
| 3 | `sendfile` `format: "voice"` with `corrupt.ogg` | `202`, then `failed` with `media_conversion_failed` |
| 4 | both a `file` part and `media.url`; neither; a `file` part on `format: "text"`; a `file` part sent before `message` | `fields.media = not_allowed`; `fields.media = required`; `fields.file = not_allowed`; `fields.file = invalid_order` |
| 5 | `sendfile` `format: "document"` with `fake.pdf` (an executable) | `422 media_type_mismatch` (bytes decide, never the name or the declared type; an executable is never a document) |

### 3.7 SSRF battery (US2.7, SC-007)

Start a listener that logs connections, then post `format: "image"` with each URL below (`qs-all`):

```bash
python3 -m http.server 8099 --bind 127.0.0.1       # in another terminal; its log must stay empty for the whole battery
```

Every row: `422 url_forbidden` (or the stated code), and **no connection reaches the listener or any internal address**. `params.reason` is the first violated rule in the order scheme, credentials, port, host.

| URL | `reason` |
| --- | -------- |
| `http://example.com/x.jpg` | `scheme` |
| `http://127.0.0.1:8099/x.jpg` | `scheme` |
| `https://127.0.0.1:8099/x.jpg` | `port` |
| `https://user:pass@example.com/x.jpg` | `credentials` |
| `https://example.com:8443/x.jpg` | `port` |
| `https://127.0.0.1/x.jpg`, `https://[::1]/x.jpg`, `https://2130706433/x.jpg`, `https://0x7f.1/x.jpg`, `https://127.1/x.jpg`, `https://169.254.169.254/latest/meta-data/` | `host` (IP literals are refused outright) |
| `https://localhost/x.jpg`, `https://foo.localhost/x.jpg`, `https://metadata.google.internal/x`, `https://printer.local/x` | `host` |
| a public name that resolves to a private address, e.g. `https://127.0.0.1.nip.io/x.jpg` | `host` (every resolved address must be public) |
| a name that does not resolve, e.g. `https://no-such-name.invalid/x.jpg` | `host` (not `url_unreachable`: no oracle on internal names) |
| a public HTTPS URL that answers `302` to `https://169.254.169.254/` (a redirect service or your own server) | `host` on the second hop |
| a public chain of more than 3 redirects | `redirects` |
| a public HTTPS URL that answers `200` with a non-image | `422 media_type_mismatch` |
| a reachable public URL answering `404` or resetting the connection | `502 url_unreachable` |

Slow servers, a lying `Content-Length`, a name that changes address between the check and the connection, and the IPv6 and mapped forms are exercised by `url-fetch.test.js` with a spy on the request function (Auto only). After the battery, the **History** tab shows no new message for any of these requests.

### 3.8 Plain-HTTP rule (FR-003, US1.8, U1)

From the loopback address everything above ran over plain HTTP, which is allowed. To prove the refusal from "another machine" on one machine, restart the sandbox with `PANEL_HOST=0.0.0.0` and call it by its LAN address (the host's own interface addresses are deliberately not local):

```bash
LAN=<the host's private LAN address, e.g. 192.168.1.20>
curl -si -X POST "http://$LAN:3000/api/v1/messages" -H "Authorization: Bearer $OWB_KEY" -H 'Content-Type: application/json' -d '{}'
curl -si -X POST "http://$LAN:3000/api/v1/messages" -H "Authorization: Bearer $BAD" -H 'Content-Type: application/json' -d '{}'
curl -si -X POST "http://$LAN:3000/api/v1/messages" -H 'X-Forwarded-Proto: https' -H "Authorization: Bearer $OWB_KEY" -d '{}'
```

Expected: `403 https_required` for all three, identical, before the key is read (a valid and an invalid key answer the same; a spoofed `X-Forwarded-Proto` is ignored without `PANEL_TRUST_PROXY`). Then, in **API > Keys > Plain-HTTP networks**:

1. Add `$LAN/32`: the password is asked (widening, `plain_http`); after Save, the first command above passes transport and authentication (`422 validation_failed` for the empty body) and the second answers `401 unauthenticated`, without a restart. (The password is asked only when the session is not confirmed.)
2. Try to add `8.8.8.8/32`, `127.0.0.0/8` and `0.0.0.0/0`: refused under their rows (`not_private`); the list stays unchanged. More than 20 rows is refused.
3. Remove the entry: no password is asked (narrowing); the next request is `403 https_required` again.

If the host has no private LAN address (a VPS), run the same from a second container or machine on a private network instead. With a trusted reverse proxy (`PANEL_TRUST_PROXY` set) in front, a request carrying `X-Forwarded-Proto: https` from the proxy is accepted; that path is covered by `api-transport.test.js`.

### 3.9 Status, list, idempotency (US3, US1.4, SC-006)

```bash
sendjson "{\"format\":\"text\",\"to\":\"$R\",\"text\":\"once\"}" -H 'Idempotency-Key: qs-1'   # twice, identical
sendjson "{\"format\":\"text\",\"to\":\"$R\",\"text\":\"other\"}" -H 'Idempotency-Key: qs-1'   # same key, other content
get "messages?status=sent&format=text&limit=2"
get "messages?limit=2&after=<next from the previous page>"
```

Expected: the second identical request returns `202` with the same id, `Idempotent-Replayed: true`, and R receives **one** message; the other content is `409 idempotency_conflict` and sends nothing; a request refused with a 4xx leaves the key free for a corrected retry. The list shows only this key's messages, newest first, `next` is the last id of the page, an `after` that is not this key's gives `422 fields.after = { code: "not_found" }`. Another key reading this key's id (`KEY=$READ_KEY get messages/<a qs-all id>`) and a malformed id both give `404 not_found`. A message to X shows `not_on_whatsapp`; a message accepted while B is disconnected stays `queued` and becomes `expired` at the expiry (set `API_QUEUE_EXPIRY_MIN` to 1 in **Settings** to see it) and is never sent later.

### 3.10 Quotas, pacing, restart (SC-005, SC-006)

Edit a key's limits in the editor: per minute 5, per day 1000, pending 2 (limits are not widenings, no password).

| # | Do | Expected |
| - | -- | -------- |
| 1 | 8 text requests within a minute | 5 times `202` then `429 rate_limited` (`scope: "minute"`, `limit`, `retryAfterMs`), `Retry-After` set, `RateLimit-*` headers on every answer |
| 2 | set per day 3, send 4 | the 4th is `429 daily_quota_exceeded`, retry at the next local midnight of the bot's `TIMEZONE`; a replay and a refused request do not count |
| 3 | with B disconnected, per pending 2, send 3 | the 3rd is `429 pending_limit_reached` |
| 4 | `qs-all` with per minute 1000, 30 requests in a loop to R | all `202`; `jq` on `get "messages?limit=100"`: consecutive `steps.sent` are at least 2 s apart, at most about 2.4 s plus the loop; spread over about a minute (SC-005; the 100-message burst is Auto in `messaging-outbox.test.js`) |
| 5 | start a panel **Broadcast** to a few contacts during step 4 | no two automatic sends, API or broadcast, closer than 2 s (shared gate) |
| 6 | raise **Settings > SEND_MIN_SPACING_MS** to 4000, then try 1000 | accepted; refused below 2000 (up only) |
| 7 | queue 20 messages, `kill -9` the bot after about 5 have left, restart | messages `queued` resume (those past their expiry become `expired`); a message that was `sending` is `unknown` (`interrupted`) and is never resent; R's phone shows no message twice (SC-006) |

### 3.11 Availability (public-api.md section 9)

| Do | Expected |
| -- | -------- |
| API > **Disable** with messages queued (confirm, no password) | `Disable` reports the cancelled count; the queued messages are `cancelled` (`api_disabled`); the next request is the unknown-URL answer of 3.1; no queue or timer remains (debug log) |
| Enable again | keys are kept; the queue is empty; requests work |
| Start the bot and call within the first second | `503 unavailable` + `Retry-After: 5` while the database is not ready (a narrow window: Auto in `api-availability.test.js`) |
| Backup > Export, revoke a key, then restore that backup | the revoked key stays revoked, the keys, history and the switch are untouched (the four tables are not exported); the API is not re-enabled by a restore |
| Cut B's connection (phone airplane mode) | requests still `202`; messages wait and expire at the expiry |

## 4. Panel walkthrough (US4)

Logged in as the owner; the page is **API**.

1. **Keys.** The list shows name, state, rights (first three + count), recipient badge (`anyone` in red), limits (defaults muted), access (IPs, expiry), last use with IP, actions. There is no reactivate action anywhere. Remove `messages.send.video` from `qs-all` and Save (no password: narrowing): the next video request is `403 forbidden` at once (US4.1). Lower its day quota; set an expiry (setting one, or moving it earlier, asks nothing; moving an existing expiry **later** or removing it asks the password).
2. **Widenings ask the password** (US4.7): add a right back, add a recipient (in any mode), widen the IP list or empty it, extend the expiry, switch the mode to `known` or `anyone`, create or duplicate a key, enable the API, add a plain-HTTP network. Each shows a dialog listing the reasons; a wrong password stays on the dialog, saves nothing and never logs you out; five wrong ones lock it (the right password is refused during the lock, like the login). **Narrowings never ask:** revoke, remove a right or a recipient, narrow the mode, shrink the IP list, disable the API.
3. **`anyone`** (US4.6): choosing it shows the ban-risk confirmation; declining restores the radio; accepting shows a persistent banner; the body carries the confirmation only on the change. Setting it back to `list` keeps the recipient list.
4. **Window.** A successful login starts the 5-minute confirmation: right after logging in, create a key: no password dialog. Past 5 minutes the next widening asks; after confirming, further widenings within 5 minutes ask nothing; a second browser (another session) is asked on its own. Restarting the bot clears every confirmation (safe direction).
5. **Duplicate** (US4.3, FR-015): password asked; a new key `<name> (2)` with the same rights, policy, limits, IP list and expiry appears with its own secret, shown once; the source stays valid. An expired key can be edited (extend the expiry, which asks) but not duplicated.
6. **Revoke** (US4.2): the confirmation names the number of queued messages; confirming needs no password; the toast reports how many were cancelled; History shows them `cancelled`; the old key then gets `401 key_revoked`. A revoked key opens read-only and offers History only. Two keys cannot share a name (case-insensitive) unless one is revoked.
7. **Test form** (FR-082): the **Test** tab shows one form per format built from the descriptor (a `list` of rows for buttons, contacts, options; a file or URL control for media; a number or a group picker for `to`). Send one of each of the 13 formats to R/G, with the same refusals as the API (`chat_disabled`, own number, `url_forbidden`, `media_type_mismatch`); the result card polls the status; the `curl` preview shows `$OWB_KEY` and `@./file`, never a real key. A refused test keeps its uploaded file; a `202` consumes it. Sent rows appear in History with source "panel" and use the same 2 s spacing.
8. **History and detail**: filters by key (including "panel"), status, format and day; the table has no content column; the detail shows the public id with Copy, the steps timeline, and for buttons, lists and polls the responses (poll: one row per voter and the totals bars). No auto-refresh timer on the list; the detail polls for a few minutes and then shows "stopped" with a Refresh button.
9. **Usage**: per key and day, `sent` (sent, delivered, read) and `failed` (failed, expired, unknown); the day edge follows `TIMEZONE`.
10. **Docs**: quick start, endpoints (English summaries), one example per format with Copy, "Try it" opens the Test tab on that format; **Download** gives `openwhatsappbot-api-v1.openapi.json` even while the API is disabled; a client generated from it (any OpenAPI 3.1 tool) can send a text.
11. **Audit** (FR-020): the panel's **History** page (the audit log, not the API tab of the same name) lists `api.enable`, `api.disable`, `api.plainhttp.update`, `api.key.create`, `api.key.update` (with the `widened` reasons), `api.key.duplicate`, `api.key.revoke`, `api.test` and `account.confirm` rows under the `api` and `account` prefixes; no row holds a secret, a recipient or a message text.
12. **Alerts** page: three new types (`api_origin_blocked` on, `api_key_new_ip` off, `api_paused` on). Turn `api_key_new_ip` on, call a key from a new address (the LAN address of 3.8): O receives the alert once; the first address a key ever uses never alerts.
13. At 360 px: chips wrap, the editor is one column, tables are cards, `pre` blocks wrap, no horizontal scroll; tab order and labels work with the keyboard only.
14. **Settings**: the 11 new entries sit in the Limits and Alerts themes; `API_REPLY_WINDOW_DAYS` above `API_RETENTION_DAYS` is refused; a changed quota applies to the next request and never to rows already queued; there is no entry that can switch the API on.

## 5. Success criteria

| SC | Target | Auto | Manual or Phone |
| -- | ------ | ---- | --------------- |
| SC-001 | key created and first text received in under 5 minutes from the Docs tab | `admin-view-api.test.js` (flows), `api-openapi.test.js` | 3.3 stopwatch |
| SC-002 | every request without a valid key, right, recipient or IP is refused and nothing is sent | `api-security.test.js` (route-table enumeration), `api-pipeline.test.js`, `admin-security.test.js` (no widening without the password) | 3.4 rows 1-9, 14-16 |
| SC-003 | no secret, text or media in logs, history, audit or error bodies | `api-leak-scan.test.js`, `admin-api-leak.test.js`, `admin-logging.test.js`, secret-dialog canary in `admin-view-api.test.js` | 3.2 `grep` of the sandbox for the key |
| SC-004 | the 13 formats render correctly; buttons and lists usable by their numbered text | `messaging-formats.test.js` (real Baileys content) | Phone checklist P1-P13, R4 |
| SC-005 | 100 accepted: no two sends under 2 s; over-quota requests get the delay | `messaging-outbox.test.js`, `send-gate.test.js`, `api-quotas.test.js` | 3.10 rows 1-6 |
| SC-006 | nothing sent twice (replay or restart) | `api-idempotency.test.js`, `messaging-outbox.test.js` (two crash windows) | 3.9, 3.10 row 7 |
| SC-007 | 100 % of the trapped URLs refused, no connection to an internal address | `url-fetch.test.js` (spy never called), `api-multipart.test.js` | 3.7 with the listener log empty |
| SC-008 | no API text is ever executed | `messaging-never-command.test.js` | 3.3 `.eval`, `.restart` |
| SC-009 | a demo format or endpoint appears with no edit outside the catalogs | `api-openapi.test.js`, `messaging-formats.test.js`, `api-panel-texts.test.js`, `admin-view-api-test.test.js` | optional: drop a copy of `formats/text.js` renamed, add its texts, restart, find it in Docs, Keys and Test; remove it |
| SC-010 | an accepted text answers in under 1 s | `api-messages.test.js` (latency guard) | 3.3 `time` |
| SC-011 | API off: no extra memory; on and idle: under 20 MiB more | `admin-memory.test.js` | `node tools/measure-panel-memory.js` |

## 6. Edge cases by hand

| # | Check | Expected |
| - | ----- | -------- |
| 1 | `mentions` of a member of G in a text to G, and of a non-member | the member is mentioned; the non-member is ignored and the message still goes (LID members: Phone checklist R3) |
| 2 | `linkPreview: true` with `qs-text` (no `media.url`) | `403 forbidden`, `right: "media.url"`; a text with a link and no flag fetches nothing |
| 3 | `linkPreview: true` with `qs-all` and a public HTTPS link | the text goes out, with or without a preview; the message never fails because of the preview |
| 4 | a phone number written `+237 690-00 00 01`, `00237690000001`, `(237) 690.000.001` | all normalise to the same digits; the response `to` is the normalised number |
| 5 | rights added by a new module | unchecked on every existing key (deny by default) |
| 6 | the API with the bot unpaired | requests accepted (`202`), no `503`, messages expire |
| 7 | queue 272+ pending with the defaults | refused with `queue_full`, `scope: "wait"`, `retryAfterMs` (Auto: `messaging-submit.test.js`); `queue_full` `scope: "disk"` when pending media bytes exceed twice `MAX_UPLOAD` |
| 8 | stop the bot while a long upload is in progress | the temp `.part` file is gone after the next boot (`data/tmp` sweep); no orphan under `data/api-media/` after the daily sweep (Auto: `api-retention.test.js`) |
| 9 | `sqlite3 database.db "select count(*) from api_messages where payload is not null and status not in ('queued','sending')"` (sandbox only) | `0`: content is erased at the terminal status; no text, caption or file name in any other column (SC-003) |

## 7. Phone checklist (real devices)

Record the handset, the WhatsApp version and the result for each line; a line that cannot be run is written "not run". Statuses come from `GET /messages/<id>`; responses from the same call.

### 7.1 Rendering of the 13 formats (SC-004)

| # | Format | Expected on the handset |
| - | ------ | ----------------------- |
| P1 | `text` to R, and to G | arrives from B; a link is plain text with no preview; `.eval 1+1` shows as text |
| P2 | `image` with caption | image with its caption, opens full size |
| P3 | `video` with caption | plays, caption shown |
| P4 | `gif` from a GIF and from an MP4 | plays in a loop, silent, with the GIF badge |
| P5 | `audio` (MP3) | an audio file with a player, **not** a voice note |
| P6 | `voice` (from MP3, from Ogg) | a voice note (microphone icon), plays; the waveform is flat (known, v1) |
| P7 | `document` (PDF) with `fileName` and caption | shows the given file name, size and type, opens; the caption is shown |
| P8 | `sticker` (from a PNG) | a sticker with B's pack and author, 512 x 512, usable in the sticker tray |
| P9 | `location` with name and address | a native map card that opens the map app |
| P10 | `contact` with one card, then two | one contact card with Save / Message actions; a contact list for two |
| P11 | `poll` (single, then multiple) | a native poll with the right choice mode |
| P12 | `buttons` on R and on R2 | R: native buttons, **and** the numbered text under them (accepted redundancy, U14); R2: the numbered text with the hint line |
| P13 | `list` on R and on R2 | R: a button that opens the list with titles and descriptions; R2: the numbered text |

### 7.2 Risks settled only on a phone (research.md section 3)

| # | Risk | How | Expected, and what to record |
| - | ---- | --- | ---------------------------- |
| R1 | Poll-vote voter forms and multiple answers (X19) | R votes in a private poll; change the vote; clear it; a multiple-choice poll with two options; in G, three voters incl. L; the same voter votes twice; `get messages/<id>` after each | one item per voter whose latest vote replaced the earlier one; a cleared vote stays with `choices: []`; multiple options listed; totals per option correct; `author` is the digits (or `<number>@lid` for L). Record which JID forms arrived (PN or LID) and whether any vote was never recorded (then check the debug log counter for the decode failure and note the form) |
| R2 | The quote bubble with an empty shell (U13) | send a text A, wait for `sent`, then send B with `quote` = A's id; repeat with A being each of an image, a video, an audio, a document, a location, a contact, a poll, buttons and a list | B arrives in every case. Record how the bubble looks per type: blank text, a type placeholder ("Photo", "Document"), or no bubble. The first two are acceptable; "no bubble" or a crash of the chat view is a defect to report |
| R3 | Mentions in LID groups | in G, send `{"mentions": [<digits of L>]}` with `@<digits>` in the text, then the same for a member with a visible number | the member with a visible number is highlighted and notified; record what L sees (highlight, raw number, or plain text) |
| R4 | Native-flow response quoting | on R tap a button, a list row, and (on R2) answer `1` while quoting the message; also answer `1` **without** quoting | each tap is recorded as `via: "tap"` and the quoted number as `via: "number"`; the unquoted number is an ordinary message and is **not** recorded; a tap or a quoted number triggers no reply, no command and no auto-responder. Record whether the tap's reply bubble shows the original message as a quote |
| R5 | Size limits taken from documentation | send: image 15 MB, video 15 MB, audio 15 MB, a document near 99 MB (slow), a text of 4,096 characters, a poll with 12 options of 100 characters, buttons with 3 labels of 20 characters, a list with 10 choices (24-character titles, 72-character descriptions) | each arrives; a WhatsApp refusal ends as `failed` (`send_failed` or `whatsapp_rejected`): record the exact limit where it fails and compare with the contract (16 MB, 100 MB, 4,096, 12, 3, 10, 24, 72) |
| R6 | Behaviour of `463` (restricted account) | do **not** try to get the account restricted. Send **one** message to N (never-contacted number) with a temporary key whose policy is `anyone` (its ban-risk confirmation applies; revoke the key afterwards); read the status and the debug log | the message ends `sent`, or `failed` with `whatsapp_rejected` for that one message only; the queue is **not** paused by a single refusal, no `api_paused` alert, the panel shows no pause banner. Record the exact ack code seen. If three such refusals ever happen within 10 minutes: the panel shows the pause banner until `pausedUntil`, O receives one `api_paused` alert, queued messages keep their expiry |
| R7 | Receipts | send to R, open the chat on R; send to G | `sent`, then `delivered`, then `read` in private (a played voice note counts as read); a group message stops at `sent` |
| R8 | Voice, GIF and sticker conversions | use a 30-second MP3, a 5 MB GIF, a 4 MB PNG | all arrive; the sticker stays under 900 KB; an unreadable file ends `failed` with `media_conversion_failed` |

When every line is filled, attach the table to the PR; any "not run" or defect line is listed in the PR description instead of being ticked.

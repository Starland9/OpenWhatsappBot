# Audit findings (raw, consolidated from 5 audit batches + core review)

Working document for implementation agents. Severity: CRITIQUE = security hole, crash, dead feature, dead service; majeur = wrong behaviour; mineur = polish. Line numbers refer to the code as of commit aea9b7c. The user-facing French report (`docs/AUDIT_COMMANDES.md`) is generated from this file at the end.


## Cross-cutting
- registry: ownerOnly not stored; regex `^a|b$`; first match wins; error reply leaks error.message
- index: getPlugin("trackmessages") always null (trackmessages has no command) -> tracking dead
- unwired hooks: afk.handleAfkResponse/checkAfkReturn, notify.checkNotifications, banchat.isBanned, Filter model (no trigger), welcome/goodbye (group-participants.update unhandled)
- panel.js pipeline copy diverged
- getLang(key) || "fallback" never falls back (getLang returns key)
- local env: node_modules stale (no @ryuu-reinzz/button-helper), node 22 < 24

## Per plugin
- addfilter (filter): group+admin checked inline; hardcoded EN; Filter never triggered. Uses "list|get" subcommands. pattern raw stored.
- afk: NOT sudo -> anyone can set owner AFK; global in-memory state; botJid not normalized (user.id has :device) -> mention match fails; hooks unwired; hardcoded EN
- alive: OK; desc i18n; body hardcoded EN
- antidelete: sudo; i18n mostly; error leaks message; OK
- apk: Aptoide ws75 API; downloads first result automatically (up to 100MB) every search -> heavy; hardcoded EN
- ar (autorespond): sudo; i18n; ok; error leaks message
- bmenu: needs buttons; getLang||fallback dead; handleReply ok (menu: prefix)
- gpt (chatgpt): desc uses plugins.groq.desc (wrong key); gpt-4o-mini; hardcoded EN; leaks error.message; no-arg handled
- buttons.js helper: fallback text "Reply with the number" but handlers expect ids -> numeric replies unhandled (verify agent 3)

## Cross-check results (static)
- collision: lyrics (lyrics.js, music.js)
- regex false positives proven: .kiss/.class/.boss -> statussave ("ss" anywhere); .export/.expire -> level ("xp"); .giftcard -> imagesearch ("gif"); .faq/.iq -> quote ("q$"); .display -> music ("play$"); .topng/.topdf may hit leaderboard ("^top"); .imagen may hit imagesearch; .guess both quiz & statussave
- pollplus pattern "poll\\+" relies on regex escaping -> must become literal "poll+"
- lang: en/fr 397 keys each, in sync. extra only has group_cmd. Missing keys used in code: extra.instance_close/reconnect/connected (client.js), common.not_admin/status_enabled/status_disabled (truthdare), plugins.notify.list_title; dynamic keys level.top_*, rps.* to check
- no runtime language switch -> require-time desc OK
- User model has afkReason/afkTime (per-user AFK intended, unused). User.isBlocked unused?
- Group model: welcome(bool), welcomeMsg ("Welcome @user to @group"), goodbyeMsg ("Goodbye @user"), no goodbye bool; mute, antilink, antibot unused?
- No model for banned chats -> new BannedChat model (covers PM + groups)

## Decisions (draft)
D1 registry exact alias map, sorted load, dup warning, flags incl. ownerOnly, banned-chat gate
D2 generic error reply (common.error) + owner DM stack
D3 lib/core pipeline shared by index.js & panel.js
D4 plugin hook contract: onMessage, onGroupParticipants, onReady (+ existing handleButtonReply)
D5 filters via hook, AFK per-user via User model, ban via BannedChat
D6 scheduler unified persisted (await agent 5)
D7 i18n via per-plugin fragments + deterministic merge script (avoid parallel edits on lang/*.json)
D8 smoke test node:test, fake Message/socket, axios+fetch stubbed to fail

## Batch 1 (owner/WA) — agent report condensed
- installed baileys rc.9 (pkg asks ^rc13); makeInMemoryStore not exported -> client.store is stub
- CROSS: no LID handling: Message.sender from key.participant/remoteJid; v7 puts PN in participantAlt/remoteJidAlt -> isSudo fails for owner in LID chats. Fix: resolve sender to PN (participantAlt/remoteJidAlt) + isSudo accepts both
- CROSS: getSudoJids() helper (SUDO split + @s.whatsapp.net reimplemented in save, vv, viewOnceHandler, antiDeleteHandler, statusSaver, feedback, registry)
- CROSS: settingsCache.invalidate() zero callers -> setvv/antidelete/ar changes stale 5 min
- CROSS: registry collapses whitespace in args (split/join) -> pass raw remainder too (eval, feedback multi-line)
- CROSS: message.quoted has no key -> add quoted.key {remoteJid,id,participant}
- CROSS: view-once unwrap duplicated -> use extractMessageContent helper
- CROSS: media downloads no size cap (save, vv, statusSaver, antiDelete)
- CROSS: sticker cmd DB query per sticker -> cache
- exec(eval): sudo inline OK; usage says .eval (add alias eval); onlyPm (config secrets); util.inspect; raw args; mineur
- update: majeur: untracked files block update (filter '?'), pull without --ff-only, --frozen-lockfile->--immutable, simpleGit timeout, lock flag, truncate stderr
- exportcontacts: CRITIQUE dead (no store in v7) -> collect contacts.upsert/update/messaging-history.set into Map/DB or export group participants; CRITIQUE privacy: sends to group -> onlyPm or DM sender; CSV injection; jid undefined
- save: fromMe ok; quoted.key undefined (reupload path); send to message.sender not SUDO[0]; mineur
- statussave: majeur: env AUTO_STATUS_SAVE overrides off; list union file+env (rm ineffective); empty list = all contacts no warning; no number normalization; LID participant; statusSaver key.from nonexistent; FileType.fromBuffer -> fileTypeFromBuffer (file-type>=17) -> crash when mime null
- setvv(viewonce): majeur no cache invalidate; viewOnceHandler indexes raw message with unwrapped type -> misses viewOnceMessage/V2/V2Extension wrappers -> use extractMessageContent; sudo jid build; isValidJid no @lid
- getvv: OK (cosmetic always enabled branch)
- vv: CRITIQUE no fromMe -> anyone unveils view-once into group; no size cap; V2Extension missed; quoted.key
- getantidelete: plugin OK; CRITIQUE antiDeleteHandler.js:112 checks message.protocolMessage.type but baileys emits update {message:null, messageStubType: REVOKE} -> never forwards. Fix messageStubType===REVOKE + key.id; sudo mode no jidNormalizedUser
- delcmd/getcmd OK (getcmd unpaginated); setcmd: strips only .!/ not PREFIX; no command validation; FR hardcoded
- unban: CRITIQUE no-op; ban: CRITIQUE no-op (isBanned unused, in-memory)
- feedback: majeur forward expects {key,message} -> throws silently; "anonymous" but sends number; no cooldown/length cap; send failures swallowed

## Batch 2 (group) — condensed
- CROSS CRITIQUE: button-helper sends nativeFlow (quick_reply/single_select) -> replies arrive as interactiveResponseMessage.nativeFlowResponseMessage.paramsJson {id}; Message.js reads only selectedButtonId/selectedRowId -> body "" -> NO button handler ever fires. Fix in Message ctor: parse paramsJson.id, set isButtonReply/isListReply
- CROSS CRITIQUE: registry stores only execute, calls plugin.execute on entry -> `this` unbound -> role.js _list crash, leaderboard execute w/ category crash; index dispatcher calls handler(message) detached -> leaderboard handleReply this._showCategory crash. Fix: call with plugin as this / module-level fns
- CROSS: plugins.common.not_admin = "Bot must be admin" used as sender-not-admin in 8 places -> add common.sender_not_admin
- CROSS: groupParticipantsUpdate returns [{status,jid}] no throw -> kick/promote/demote/warn report success on 403. check status==="200"
- CROSS: no target guard (bot, sudo, creator, self) -> guardTarget helper
- CROSS: isBotAdmin compares PN vs p.id (@lid) -> fails in LID groups; match user.lid, p.phoneNumber, p.lid
- CROSS: groupMetadata per admin check 2-3/cmd -> memoize + TTL cache invalidated on groups.update/participants
- CROSS: registry collapses whitespace -> multiline welcome/goodbye/filter/tagall impossible
- CROSS: getLang concat emoji/{0} double "❌ ❌ ...{0}" -> pass args
- CROSS: index ignores upsert type (notify vs append) -> history batches processed -> skip append
- CROSS: config.env.example WARN_MESSAGE \n unquoted -> literal \n; config.js replace \\n
- kick/promote/demote: majeur unchecked status, no target guard (demote self), mentions[0] not normalized, empty quoted.sender
- tagall: majeur flood ceil(N/50) msgs no delay, header repeated -> single msg or delay; LID ids
- warn: majeur target only from quote (support mention), no guard, kick status unchecked destroys row, RMW count race (increment), replace only first placeholder
- goodbye: CRITIQUE dead; majeur no goodbye bool -> on/off stored as text. Add Group.goodbye BOOLEAN default false
- welcome: CRITIQUE dead; preview raw; findOrCreate
- delfilter: exact case-sensitive; support index; filters dead
- groupinfo: depends on UserStats (dead tracking); buttons unreachable; peak hours wrong (lastActiveAt) -> drop or hourly; sendButtons no mentions
- vote(poll.js): majeur pattern vote but lang says .poll |; .poll unregistered (pollplus is poll+) -> pattern poll|vote; split first '?'; dead manual fallback + unbounded polls Map; "❌ ❌ {0}"
- poll+: majeur close open to anyone; native votes never tallied (pollUpdates) -> drop tally or getAggregateVotesInPollMessage; in-memory; quoted in wrong arg
- role: CRITIQUE crash this._list; CRITIQUE roles never enforced (muted/banned/vip) -> enforce in pipeline or relabel cosmetic; no try/catch
- stats: CRITIQUE dead in-memory duplicate -> rebuild on UserStats; words map unbounded; accents dropped
- trackmessages: CRITIQUE not wired; majeur RMW race -> increment; no isGroup guard (DM rows pollute global rank); counts reactions/protocol msgs + append -> whitelist types; XP cooldown
- DATA welcome: Group.welcome bool, welcomeMsg "Welcome @user to @group", goodbyeMsg "Goodbye @user", placeholders @user @group @desc(welcome only); event {id, author, authorPn?, participants:[{id,phoneNumber?,lid?}] (objects in rc.9!), action add|remove|promote|demote|modify}; one msg mentioning all new; skip bot; same id in text & mentions; cache via settingsCache + invalidate
- DATA filters: pattern STRING trimmed case-preserved, response TEXT, groupJid, isGlobal unused; no unique index; match case-insensitive whole msg or word boundary escaped (no raw regex); cooldown 10s/(group,pattern); stop pipeline when replied; skip fromMe & commands
- DATA tracking: UserStats PK(jid,groupJid) messageCount commandCount mediaCount xp level lastActiveAt; computeLevel=floor(sqrt(xp/100)); level.js xpForLevel=l²*100; XP 5 text/10 cmd/15 media; stats.js in-memory obsolete

## Dependencies (npm view 2026-10-27, Node 24.20 via nvm ~/.nvm/versions/node/v24.20.0/bin)
USED + major bump: openai 6->7 (chatgpt, voice); simple-git 3->4 (update); dotenv 17->18 (config)
USED minor/patch: @google/genai 2.8->2.31; axios 1.18->1.21; file-type 22.0->22.2 (ESM; API fileTypeFromBuffer); pdfkit 0.19->0.20; sharp 0.35.1->0.35.5 (postinstall pins sharp@0.33.5 -> fix script); pino 10.4; html-entities 2.6; cron 4.4 (5 beta: stay); qrcode 1.5.4; qrcode-terminal 0.12; sequelize 6.37.8 (v7 alpha? stay 6); pg 8.23.1; sqlite3 6.0.1; pino-pretty 13.2; pm2 7.1.1; @hapi/boom 10 (11 rc: stay)
EXCEPTION: baileys ^7.0.0-rc13 -> 7.0.0-rc14 (latest=rc14, legacy=6.7.24; v7 only prerelease) — installed locally rc.9!
DEPRECATED: fluent-ffmpeg (tts.js) -> replace by child_process spawn helper lib/utils/ffmpeg.js
UNMAINTAINED used: play-dl 1.9.7 (2023, youtube.js) -> youtubei.js 18 (maintained, already dep) or @distube/ytdl-core 5; google-tts-api 2.0.2 (2022, tts, voice) — check liveness (agent4); @vitalets/google-translate-api 9.2.1 (tts, translate) ok-ish
UNUSED (remove): @distube/ytdl-core, @google/generative-ai, audio-decode, browser-id3-writer, cheerio, cookie, fastq, form-data, fs-extra, googleapis, heroku-client, jimp, link-preview-js, moment, node-fetch, node-webpmux, qrcode-reader, translate-google-api, youtubei.js (unless used as play-dl replacement)
IMPLICIT keep: pg, sqlite3 (sequelize dialects), pino-pretty (transport), pm2 (scripts)
@ryuu-reinzz/button-helper 2.2.3 (dist-tag public=2.2.5) — check 2.2.5 changelog/nativeFlow

## Batch 3 (games/economy) — condensed
- dice: CRITIQUE money printer (1d1/0d5 always 5x, 5d0 2x; all modes +EV: d6 1.84, 2d6 1.53, d20 1.25) -> count>=1 sides>=2, house edge; CRITIQUE line116 `econ` block-scoped -> every losing bet ReferenceError after stake deducted; majeur non-atomic check/save double-spend; majeur PM bets free coins (deduct gated isGroup) -> onlyGroup; mineur unused consts, heads/tails EN
- economy(balance|bal|coins|wallet): mineur returns reply obj not true; no mentions in sendQuickReplies; findOrCreate phantom rows ("" jid); not onlyGroup; EN card
- daily: majeur race double claim -> conditional UPDATE lastDailyAt; streak reset to 0 not 1; uncapped reward; per (group,user)
- give: majeur RMW 2 saves no tx -> tx + conditional decrement; give to bot/non-member; raw mention vs normalized sender; mention-first parse NaN
- leaderboard: CRITIQUE this._showCategory unbound (.top xp crash, top:nav/top:cat clicks throw); CRITIQUE no data (tracker dead); majeur page unbounded negative offset SQL error -> clamp; raw column names
- level: majeur no data; findOrCreate phantom rows; global rank counts rows not users; "xp" regex
- hangman: majeur tells `.guess <letter>` (belongs to quiz); consumes command replies (add PREFIX check); "yo-yo" unwinnable + dup words -> filter /^[a-z]+$/ dedupe; no expiry/stop; dead axios
- quiz: majeur handleReply eats commands/empty bodies as attempts -> ignore PREFIX/empty; majeur subcommand detection case-sensitive split(" ") -> .quiz2 (trivia alias) hijacked; 5 EN questions; no expiry; called twice (special case + loop)
- rps: majeur vs-bot player's pick random (buttons unused); wrong keys rps.tie/win -> tie_game/win_game; first pick returns false (not consumed); picks visible publicly -> DM; timer no identity check; gameId from button id not message.jid
- tictactoe: majeur calls sendInteractiveMessage directly (no fallback); .ttt overwrites others' game, no stop; occupied cell returns false; renderBoard ignores marks; chatId not validated; LID p2
- trivia: majeur html-entities has no htmlToText -> use decode; wrong answer reveals answer & game continues; score dropped always 1/1; ids no nonce; opentdb 200 alive (rate limit 1/5s, check response_code); .quiz2 unreachable
- truthdare(av): majeur keys common.* should be plugins.common.*; dead fallback; Group row for PM; adult gating OK (default off/mild, admin to change); FR-only content, typos
- CONTRACT proposal: ids `<plugin>:<action>[:<nonce>][:<arg>]`, no JIDs in ids, chat from message.jid; first stmt prefix check; explicit true for owned ids, never throw; free-text replies own only if game exists & quoted.id===botMessageId & body non-empty & !PREFIX; shared lib/utils/gameStore.js TTL Map + single unref sweeper + max size, refuse new game while active; normalize JIDs, reject self/bot/non-member; no `this`; numeric fallback: buttons.js registers {sentMsgId->[ids]}, pipeline rewrites quoted digit into id; economy atomic SQL conditional; generic error
- CROSS: this-binding also in quote.js (_add/_random/_list), idea.js (_list/_top)
- CROSS: alias hijacks present: .quiz2->quiz, .lyrics->lyrics.js, .quoteof->quote.js

## Batch 5 (AI/info/utility) — condensed
- installed @google/genai 1.42 (lock 2.8), file-type 21.3 -> yarn install needed
- gemini: majeur response.text undefined -> "undefined" reply; leaks raw API error JSON; no timeout (httpOptions.timeout 30000); react before validation; quoted no key; FileType.fromBuffer; GEMINI_MODEL env not in config.js; no cooldown. model gemini-2.5-flash ok (no shutdown)
- imagen: CRITIQUE model imagen-4.0-fast shut down 2026-08-17 -> Gemini native image model (gemini-nano-banana-2.1 / gemini-3.1-flash-lite-image — confirm via models.list); params must be in config:{numberOfImages,aspectRatio}; CRITIQUE response shape generatedImages[0].image.imageBytes not images[0].data -> always no_image; caption truncate
- fact: api-ninjas demo dead (remove); uselessfacts v2 url direct; no i18n, EN content
- fancy: majeur String.fromCharCode truncates >U+FFFF -> fromCodePoint; wrong offsets (bases: Bold 1D400/1D41A, Italic 1D434/1D44E (h->210E), Script 1D49C/1D4B6 (holes), Mono 1D670/1D68A, DoubleStruck 1D538/1D552 (holes), Circled 24B6/24D0, Squared 1F130, NegSquared 1F170, BlackCircled 1F150); Array.from; cap 500
- joke: alive; EN; no i18n
- quote: CRITIQUE this._add etc; `^quote|q$` hijacks quoteof; Save button can't work (quotes bot menu) -> drop; captions not saved
- quoteof: CRITIQUE shadowed; quotable.io DEAD -> ZenQuotes (filter a==="zenquotes.io" rate-limit) then dummyjson.com/quotes/random then local list
- news: majeur "❌ ❌ {0}: msg" + leak; console.error(axiosError) leaks apiKey in logs; free text into country= -> validate 2-letter else q=; split(" ") cmd detection; AlphaVantage quota 200 Information/Note; crypto id vs ticker, cache 60s; NEWS fallback RSS (bbc, lemonde) optional
- weather: majeur same error format + key in logs; lang=config.LANG, icons by code; Open-Meteo keyless fallback (geocoding + forecast) 200
- translate(trt): majeur reply to plain conversation fails (use extractMessageContent); 2-letter first word parsed as lang (validate ISO list); usage says .translate but only trt -> pattern trt|translate|tr; default target config.LANG; error format; MyMemory fallback
- notify: CRITIQUE hook unwired; CRITIQUE privacy once wired (scans all chats, DMs to non-members) -> scope keyword to registration chat + membership, never forward PMs; in-memory; list_title missing key; cap 20 keywords, min 3 chars, word boundary, DM rate limit
- reminder: majeur captured sock stale after reconnect; in-memory, no list/cancel; `j` unit missing; timezone ignored (config.TIMEZONE, luxon via cron); limits
- task: majeur todo/remind branches unreachable (dead handleReminder) -> delete; in-memory -> Task table; anyone clears list -> createdBy
- help: arg normalization; prints raw pattern -> main name + aliases; EN
- menu: unused icons; only first alias; lists sudo cmds to everyone -> hide; unused axios; FR hardcoded
- idea: CRITIQUE this._* (even bare .idea fails); top only latest 50; vote RMW; unused CATEGORIES
- autoResponderHandler: majeur generationConfig wrong -> config:{maxOutputTokens,temperature,systemInstruction}; persona as role model -> systemInstruction; empty body/reactions trigger Gemini; response.text undefined poisons context 30min; global rate limit -> per-JID recorded at start; holds pipeline up to 13s (blocks batch) -> don't await typing in pipeline; ar no cache invalidate; LID ignore list
- conversationManager: majeur addMessage reads DB not pending -> loses user turn; upsert; interval unref + flush SIGTERM; no purge TTL
- DEAD SERVICES table: quotable DEAD, api-ninjas demo DEAD, imagen-4 DEAD; alive: uselessfacts v2, zenquotes, dummyjson, openmeteo, coingecko (cache), coinpaprika alt, alphavantage, vitalets translate (scraper), mymemory, joke apis
- SCHEDULER design: Reminder model {id, chatJid, creatorJid, text<=500, dueAt idx, status pending|sent|cancelled|missed|failed, attempts, lastError, sentAt, repeat?, kind?, taskId?}; luxon parse s/m/h/d/j + HH:MM in config.TIMEZONE; lib/utils/scheduler.js poll 20s on ready (guard double start), getSocket at send, idempotent UPDATE WHERE status=pending, retry backoff; restart: overdue <6h send "delayed", older missed; limits 20/user, min 5s, max 1y; list/cancel cmds. Task table {chatJid,text,done,createdBy,doneBy}. NotifyKeyword {userJid, keyword, scopeJid, enabled} + onMessage hook
- CROSS: client.js emits messages for append (history) -> filter type==="notify"
- CROSS: hot-reload resets module state

## Batch 4 (media/downloaders) — condensed
- convert: majeur sendImage recompresses (png/webp lost) -> sendDocument; mp3/ogg labeled audio/mp4, ogg vorbis not opus; leaks ffmpeg banner; documents downloaded fully (2GB) before reject -> fileLength guard; webp/gif to pdf fails -> sharp png first; exec no timeout -> execFile; alpha->black (flatten); Date.now temp names collide
- sticker: majeur temp leak on error; no -t 10 cap (2.6MB webp) -> -t 10 + size loop ~900KB; packname/author ignored by baileys -> EXIF via node-webpmux (STICKER_PACKNAME dead config); EN hardcoded; react before validation
- imagesearch(image|img|gif|giphy): CRITIQUE giphy default key BANNED 403 -> require GIPHY_API_KEY; CRITIQUE sends .gif as video -> images.original.mp4; no maxContentLength; unsplash needs key
- insta: CRITIQUE both providers NXDOMAIN; quoted link bug (message.body is the command); unanchored url check; dup of socialdl
- socialdl(dl|socialdl|sdl): CRITIQUE backend api.socialdl.starland9.dev self-signed Traefik default cert + 404 (OWNER'S OWN INFRA); images sent as video; audio mimetype; MAX_UPLOAD unused (100MB hardcoded); isAudio includes("audio"); hosts list incomplete
- youtube(ytdl|ytv|yta|yts): CRITIQUE play-dl hangs forever on 429; CRITIQUE play.stream audio-only -> .ytv sends audio as mp4; audio saved .mp3 actually opus/m4a; pipe no source error; temp leak; yt_validate "search" passes; size checked after download -> REPLACE with yt-dlp (execFile, -f best[height<=720][ext=mp4], --no-playlist, --max-filesize, timeout); yt-dlp not in Dockerfile; must be fresh
- music: lyrics alias dead (remove + handleLyrics); temp leak -> arraybuffer; caption on audio ignored; preview 30s only (say so); undefined collectionName
- lyrics: CRITIQUE lyrics.ovh needs /v1/artist/title -> 404; some-random-api 403 -> LRCLIB https://lrclib.net/api/search?q= (200, plainLyrics); quoted message object [object Object]
- pinterest: CRITIQUE 403 no keyless alt -> "service indisponible" + point to .image
- reddit: CRITIQUE 403 Blocked -> Reddit OAuth client-credentials (REDDIT_CLIENT_ID/SECRET) else not_configured; subreddit not validated (path traversal); majeur over_18 not checked + SSRF (allow i.redd.it, preview.redd.it, i.imgur.com)
- voice(transcribe|speak): majeur speak >200 chars throws -> getAllAudioUrls; mp3 sent as ogg/opus ptt -> transcode libopus; quoted.key; leaks (OpenAI key fragment!); OpenAI timeout 60s maxRetries 0; Whisper 25MB guard
- tts: majeur vitalets import shape {translate} -> detection dead; use raw.src; mp3 as ptt audio/mp4 -> opus; EN hardcoded; good mkdtemp
- pdf: majeur getMediaType/downloadMedia on current msg not quoted -> never image branch; newlines lost (raw args); temp leak -> in-memory; webp unsupported; Helvetica no emoji
- qr: level H caps ~1273 bytes -> cap/level M + friendly msg; caption truncate; newlines lost
- CROSS helpers: Message.getQuotedMedia() {buffer,type,mimetype,fileLength} w/ pre-download guard; Message.getQuotedText() (extractMessageContent, tts getQuotedText pattern); registry pass command word + raw args (newlines preserved); lib/utils/ffmpeg.js runFfmpeg(args,{timeout}) execFile -y -nostdin -loglevel error; withTempDir(fn) mkdtemp+rm finally; downloadBuffer(url,{maxBytes,timeoutMs}) with AbortSignal.timeout; config.MAX_UPLOAD wire; sendAudioFile sniff type / voice transcode ogg opus; wrapExternal classify 401/403/429/timeout; withTimeout(promise,ms) for SDKs; per-user cooldown for heavy/paid cmds
- leftover media/temp/1761798928108_CIEL.m4a ; no periodic media/temp cleanup

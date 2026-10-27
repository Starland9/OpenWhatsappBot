# Contract: plugin module

Every file in `plugins/*.js` is a CommonJS module. The loader requires the files **in sorted file-name order** and registers each one that exports at least one of the members below. A file that exports none of them (for example `plugins/buttons.js`, a shared helper) is skipped silently.

## Command

```js
module.exports = {
  command: {
    pattern: "name|alias1|alias2", // literal names, NOT a regex; lower-case; separated by "|"
    desc: getLang("plugins.<name>.desc"),
    type: "general",               // menu category
    fromMe: false,                 // true = owner (SUDO) only
    ownerOnly: false,              // synonym of fromMe; either one restricts to owner
    onlyGroup: false,
    onlyPm: false,
    adminOnly: false,              // NEW: group admins or owner only; implies onlyGroup
  },
  // called with `this` = the plugin module (R2)
  // argsString: words after the command, single-spaced (legacy)
  // ctx.command: the alias that matched, lower-case; ctx.rawArgs: text after the command word, newlines kept
  async execute(message, argsString, ctx) {},
};
```

Prefer module-level helper functions over `this._helper()`: the registry now binds `this`, but module functions are simpler to test.

Messages from a disabled chat (`BannedChat`) never reach the registry: the pipeline drops them, except `unban` sent by an owner (see [pipeline.md](pipeline.md), step 4).

Rules enforced by the registry before `execute` is called, in this order:

| # | Check | Outcome when it fails |
| --- | ------- | ----------------------- |
| 1 | `fromMe` or `ownerOnly` and sender is not owner | Reply `common.owner_only` |
| 2 | `onlyGroup` or `adminOnly`, and the chat is not a group | Reply `extra.group_cmd` |
| 3 | `onlyPm` and the chat is a group | Reply `common.pm_only` |
| 4 | `adminOnly`, and the sender is neither a group admin nor an owner | Reply `common.sender_not_admin` |

The plugin is still responsible for checking `await message.isBotAdmin()` before a group action that needs it, and replying `common.bot_not_admin` if it isn't.

Matching (see [registry-matching.md](registry-matching.md)): the word after the prefix is lower-cased and looked up in an alias map, so only an exact name or alias matches.

Errors: if `execute` throws, the user receives `common.error` (no `error.message`, no stack). The full stack is logged and sent to the first owner by DM.

## Hooks (all optional)

| Export | Called when | Return value | Notes |
| -------- | ------------- | -------------- | ------- |
| `handleButtonReply(message)` | The message is a button/list reply, or quotes another message | `true` = consumed, stop processing | Claim **only** ids with your own prefix (`<plugin>:`) or a quoted message id you sent in the same chat. Return `false` fast otherwise. `handleReply` is accepted as a legacy name. |
| `onMessage(message)` | Every non-status message, before command dispatch, including the bot's own messages (`message.fromMe`) | `true` = consumed (stop: no command, no auto-responder) / falsy = continue | Must be cheap (cache DB reads) and must never throw: the pipeline isolates it, but a slow hook delays every message. Used by: afk, filters (`addfilter`), trackmessages. |
| `onGroupParticipants(update, client)` | Baileys `group-participants.update` (`{ id, participants, action: "add"\|"remove"\|"promote"\|"demote" }`) | ignored | Used by: welcome/goodbye. |
| `onReady(client)` | Once each time the WhatsApp connection opens | ignored | Must be idempotent (connection can reopen). Used by: scheduler restore. |

Hook order inside the pipeline is defined in [pipeline.md](pipeline.md).

Within one hook type, plugins run by `hookPriority[name]` (lower first, default 100), then in load order: export `hookPriority: { onMessage: 20 }`. Current `onMessage` order: role (10, moderation) → trackmessages (20) → afk (30) → notify (40) → addfilter (90, consumes the message).

## Messages and translations

- Every user-facing string goes through `getLang("plugins.<name>.<key>", ...args)` with `{0}`, `{1}` placeholders. Strings shared across plugins live under `common.*`.
- Keys exist in **both** `lang/en.json` and `lang/fr.json`. Other locales fall back to `en`.
- Do not use `getLang(key) || "fallback"`: `getLang` returns the key itself when the translation is missing, so the fallback never runs.

## Shared helpers (to use instead of re-implementing)

| Helper | Purpose |
| -------- | --------- |
| `message.getQuotedMedia({ maxBytes })` | NEW: `{buffer, type, mimetype, fileLength}` of the quoted media, or `null`; rejects before downloading when it is over the cap |
| `message.getQuotedText()` | NEW: text of the quoted message (conversation, extended text, caption), or `""` |
| `message.quoted.key` | NEW: `{remoteJid, id, participant}` |
| `message.sender` / `message.senderLid` | Phone-number JID when known / LID (R9) |
| `message.isSudo()`, `message.isBotAdmin()`, `message.isSenderAdmin()` | LID-aware; group metadata memoized |
| `message.sendAudioFile(buffer)` / `message.sendVoice(buffer)` | NEW: mimetype sniffed / transcoded to ogg-opus |
| `lib/utils/permissions.js` → `getOwnerJids()`, `guardTarget(message, jid)`, `assertParticipantResult(res)` | NEW (R9, R10) |
| `plugins/buttons.js` → `sendQuickReplies`, `sendList` | Interactive messages with a text fallback; ids must be `<plugin>:<action>[:<nonce>][:<arg>]`, with no JIDs; a numeric fallback is handled by the pipeline (R8) |
| `lib/utils/http.js` → `fetchJson`, `fetchBuffer`, `classifyError`, `withTimeout` | NEW: total timeout (default 30 s) plus size cap (`config.MAX_UPLOAD` MB); errors classified as `service_unavailable` / `not_configured` / `rate_limited` |
| `lib/utils/ffmpeg.js` → `runFfmpeg(args, {timeout})`, `toOpusVoice(buffer)`; `lib/utils/media.js` → `withTempDir(fn)` | NEW: no shell, no banner in errors, temp files always removed |
| `lib/utils/downloader.js` → `download(url, {audio})`, `search(query)` | NEW: wraps `yt-dlp` (youtube, insta, dl) |
| `lib/utils/gameStore.js`, `lib/utils/cooldown.js` | NEW: per-chat TTL game state; per-(user, key) cooldowns |
| `common.service_unavailable`, `common.not_configured`, `common.rate_limited`, `common.error`, `common.owner_only`, `common.admin_only`, `common.sender_not_admin`, `common.pm_only`, `common.bot_not_admin`, `common.cooldown` | Standard replies |

# Contract: shared message pipeline

A single module `lib/core/pipeline.js` exports:

```js
attachHandlers(client)        // subscribes to every client event below
processMessage(msg, client)   // exported for the smoke test
```

`index.js` and `panel.js` both call `attachHandlers(client)` **before** `client.initialize()`, so that no early `ready` event or message is missed. Neither keeps its own copy of the pipeline (FR-022).

## Events

| Client event | Handling |
| -------------- | ---------- |
| `messages` | Batches of `MESSAGE_CONCURRENCY_LIMIT`, `Promise.allSettled(processMessage)` |
| `messages.update` | `antiDeleteHandler.handleMessageDelete` for each update |
| `group-participants.update` | Every plugin's `onGroupParticipants(update, client)`, each isolated in try/catch |
| `ready` | Every plugin's `onReady(client)`, each isolated in try/catch |

## `processMessage` order

| # | Step | Stops processing when |
| --- | ------ | ----------------------- |
| 1 | `status@broadcast` → `statusSaver.handleStatus` | always |
| 2 | Build `Message`; set `message.isCommand = body.startsWith(PREFIX)`; cache for anti-delete (`setImmediate`) | — |
| 3 | **Disabled-chat gate**: if `BannedChat` contains the chat (cached) → stop, unless the sender is an owner and the command is `unban` | chat disabled |
| 4 | `viewOnceHandler.handleMessage` (after the gate: a disabled chat is fully ignored) | never |
| 5 | If quoted or interactive reply: each plugin's `handleButtonReply` (or legacy `handleReply`), in load order | a handler returns `true` |
| 6 | Each plugin's `onMessage(message)`, in load order, isolated | a hook returns `true` |
| 7 | Sticker bound to a command (`StickerCommand`) → `body = PREFIX + command`, dispatch | sticker matched |
| 8 | Not a command, not `fromMe`, not interactive → `autoResponderHandler.handleMessage`, started without being awaited (it waits seconds on purpose) | always (a message without the prefix can't be a command) |
| 9 | `executeCommand(message)` | — |

Notes:
- The special case for `quiz` disappears: quiz is an ordinary step-5 handler.
- Step 6 replaces the hard-coded `getPlugin("trackmessages")` call. Tracking, AFK and filters run as `onMessage` hooks.
- Every step is wrapped so that a failure in one plugin's hook never prevents the following steps or other messages from being processed.

# Contract: command matching

## Current behaviour (bug)

`new RegExp("^" + pattern + "$", "i")`: because of how `|` binds, the first alias only has to be a prefix of the word, the last alias a suffix, and any middle alias can appear anywhere in it. Examples, verified:

| Sent | Triggered command | Why |
| ------ | ------------------- | ----- |
| `.kiss`, `.class`, `.boss`, `.guess` | `statussave` (`statussave\|ss`) | `ss` anywhere |
| `.export`, `.expire` | `level` (`level\|xp\|rank`) | `xp` anywhere |
| `.giftcard` | `imagesearch` (`image\|img\|gif\|giphy`) | `gif` anywhere |
| `.faq`, `.iq` | `quote` (`quote\|q`) | ends with `q` |
| `.display` | `music` (`…\|play`) | ends with `play` |
| `.topng`, `.topdf` | `leaderboard` or `convert` (load order) | `^top` |
| `.lyrics` | `lyrics` or `music` (load order) | duplicate alias |

The load order comes from `fs.readdir`, which is not guaranteed to be sorted, so which command wins can change from one machine to another.

## Target behaviour

1. At registration, `pattern.split("|").map(s => s.trim().toLowerCase()).filter(Boolean)` → aliases.
2. Each alias is stored in `aliasMap: Map<alias, CommandEntry>`. If an alias is already taken, log `warn` with both files; the **first registered** keeps it. Plugin files load in sorted order, so the result is deterministic.
3. Dispatch: `cmdText = body.slice(prefix.length).trim().split(/\s+/)[0].toLowerCase()` → `aliasMap.get(cmdText)`. No regex.
4. Patterns are literal: `poll\\+` becomes `poll+`.
5. `getCommandByPattern(name)` and `getPlugin(name)` use the same alias map.
6. `getCommands()` returns each command once, with `aliases: string[]` (the menu uses `aliases[0]` as the display name).

## Resolved conflicts

| Alias | Kept by | Removed from | Reason |
| ------- | --------- | -------------- | -------- |
| `lyrics` | `lyrics.js` | `music.js` | dedicated plugin; `music` keeps `music\|song\|spotify\|play` |

Any further conflict found by the smoke test is resolved the same way: the dedicated plugin keeps the alias, and the change is recorded in the audit report.

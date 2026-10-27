"use strict";
/**
 * T022: every command responds (FR-007 to FR-010).
 *
 * With stubNetwork() (axios, http(s), fetch, child_process all fail like on an offline machine without
 * ffmpeg / yt-dlp), every registered command is called WITHOUT argument by the owner, in a group where the
 * bot and the sender are admins (private chat for onlyPm commands). Each command gets its own chat JID, its
 * own fake socket, and runs through registry.executeCommand (permissions included). Expected:
 *
 *   - at least one sendMessage (reactions and deletions do not count) within 5 s;
 *   - execute did not throw (a throw shows as the registry's "Error in .cmd" DM to the owner);
 *   - no sent text contains a raw translation key (plugins.x.y, common.x, extra.x);
 *   - no sent text leaks an error (Error:, a stack frame, ECONN..., "status code").
 *
 * Then a curated table of commands with arguments reaching an external service checks that a dead dependency
 * gives common.service_unavailable or common.not_configured (and no call at all when the key is missing).
 *
 * One test per plugin file, so a failure names the command and shows what was sent.
 * The commands run one after the other (TEST_CONCURRENCY=n to overlap them; see CONCURRENCY below).
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const fakes = require("./helpers/fakes");

const { IDS, ROOT } = fakes;
fakes.setupEnv({ sudo: "111,112" }); // 112 is used for the "with arguments" phase (separate cooldowns)
const net = fakes.stubNetwork();
const exits = fakes.stubProcessExit();
// commands that persist to the repository (e.g. the status-save list) must not alter it
const restoreFiles = fakes.snapshotFiles(["data/status_save.json"]);

const { getLang } = require("../lib/utils/language");

const PER_COMMAND_TIMEOUT_MS = 5000;
const SETTLE_MS = 300; // after the first reply, wait for the command to finish (or this long) to collect the rest
// 1 = sequential. The in-memory SQLite database has a single connection: concurrent commands that open a
// transaction (daily, give...) would collide with each other, which no real deployment does.
const CONCURRENCY = Math.max(1, parseInt(process.env.TEST_CONCURRENCY, 10) || 1);
const RUNTIME_BUDGET_MS = 60000;

const RAW_KEY = /\b(plugins|common|extra)\.[a-z_]+\.?[a-z_]*/;
const LEAK = /Error:|at .*\.js:\d+|ECONN|status code/;
const OWNER_JIDS = [IDS.OWNER_PN, IDS.OWNER2_PN];

/**
 * Commands that reach an external service, called WITH arguments. Matched by plugin file.
 *   expect "dead"   -> reply contains common.service_unavailable or common.not_configured
 *   expect "keyed"  -> reply contains common.not_configured and NO network call was attempted (FR-008)
 *   expect "reply"  -> any proper reply (the command has a documented offline fallback)
 */
const WITH_ARGS = [
  { file: "weather.js", args: "Paris", expect: "dead" },
  { file: "lyrics.js", args: "queen bohemian rhapsody", expect: "dead" },
  { file: "pinterest.js", args: "cats", expect: "dead" },
  { file: "reddit.js", args: "memes", expect: "keyed" },
  { file: "imagesearch.js", alias: "gif", args: "cats", expect: "keyed" }, // GIPHY_API_KEY
  { file: "imagesearch.js", alias: "image", args: "cats", expect: "dead" },
  { file: "imagen.js", args: "a red cat", expect: "keyed" }, // GEMINI_API_KEY
  { file: "chatgpt.js", args: "hello", expect: "keyed" }, // OPENAI_API_KEY
  { file: "gemini.js", args: "hello", expect: "keyed" }, // GEMINI_API_KEY
  { file: "translate.js", args: "fr hello", expect: "dead" },
  { file: "news.js", args: "", expect: "dead" },
  { file: "news.js", alias: "crypto", args: "bitcoin", expect: "dead" },
  { file: "tts.js", args: "hello world", expect: "dead" },
  { file: "voice.js", alias: "speak", args: "hello world", expect: "dead" },
  { file: "trivia.js", args: "general", expect: "dead" }, // without a category it only shows the picker
  { file: "apkdownload.js", args: "whatsapp", expect: "dead" },
  { file: "socialdl.js", args: "https://www.tiktok.com/@someone/video/7234567890123456789", expect: "dead" },
  { file: "instagram.js", args: "https://www.instagram.com/reel/ABCDEFGHIJK/", expect: "dead" },
  { file: "youtube.js", args: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", expect: "dead" },
  { file: "music.js", args: "daft punk one more time", expect: "dead" },
  // documented offline fallbacks (research §C): a proper reply is enough
  { file: "fact.js", args: "", expect: "reply" },
  { file: "quoteof.js", args: "", expect: "reply" },
  { file: "joke.js", args: "", expect: "reply" },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let registry;
let commands;
let loadFailures;
let phaseMs = 0;
const noArg = new Map(); // file -> result
const withArgs = new Map(); // "file alias" -> result

const firstLines = (text, n) => String(text).split("\n").slice(0, n).join(" / ");
const excerpt = (text, n = 200) => String(text).replace(/\s+/g, " ").slice(0, n);

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Run one command and collect what happened.
 * @returns {{ entry, alias, body, context, problems: string[], sent: object[], texts: string[], elapsed: number, timedOut: boolean }}
 */
async function runOne({ entry, alias, args = "", sender = IDS.OWNER_PN, index }) {
  const inGroup = !entry.onlyPm;
  const chat = `1203630000${String(100000 + index)}@g.us`; // one chat per command: no shared state
  const sock = fakes.fakeSocket({ admins: ["111", "112"] }); // the bot is admin by default
  const client = fakes.fakeClient(sock);
  const body = `.${alias}${args ? ` ${args}` : ""}`;
  const message = fakes.makeMessage({ client, body, from: sender, group: inGroup ? chat : false, admin: inGroup ? true : undefined });

  const isCrashReport = (s) => OWNER_JIDS.includes(s.jid) && s.text.startsWith("⚠️ Error in ");
  const isReply = (s) => s.kind !== "react" && s.kind !== "delete" && !isCrashReport(s);

  const started = Date.now();
  let finished = false;
  const done = registry.executeCommand(message).then(
    () => {
      finished = true;
    },
    (error) => {
      finished = true;
      sock.sent.push({ jid: OWNER_JIDS[0], kind: "text", text: `⚠️ Error in ${body} (executeCommand rejected)\n${error?.stack || error}`, strings: [] });
    },
  );

  await fakes.waitFor(() => sock.sent.some(isReply) || finished, { timeout: PER_COMMAND_TIMEOUT_MS, interval: 4 });
  if (!finished && sock.sent.some(isReply)) await Promise.race([done, fakes.sleep(SETTLE_MS)]);
  const elapsed = Date.now() - started;
  const timedOut = !finished && !sock.sent.some(isReply);

  const sent = sock.sent.slice();
  const replies = sent.filter(isReply);
  const crashes = sent.filter(isCrashReport);
  const problems = [];

  if (replies.length === 0) {
    problems.push(
      timedOut
        ? `no reply within ${PER_COMMAND_TIMEOUT_MS / 1000} s (still running)`
        : `no reply: execute returned after ${elapsed} ms without sendMessage (sent: ${JSON.stringify(sent.map((s) => s.kind))})`,
    );
  }
  for (const crash of crashes.slice(0, 1)) {
    // header (command, chat, sender) then the error and the first stack frames
    const lines = crash.text.split("\n").filter((l) => l.trim());
    problems.push(`execute threw: ${lines.slice(3, 6).map((l) => l.trim()).join(" / ")}`);
  }
  for (const reply of replies) {
    for (const text of reply.strings) {
      const key = text.match(RAW_KEY);
      if (key) problems.push(`raw translation key "${key[0]}" sent: "${excerpt(text)}"`);
      const leak = text.match(LEAK);
      if (leak) problems.push(`error leak /${leak[0]}/ sent: "${excerpt(text)}"`);
    }
  }

  return {
    entry,
    alias,
    args,
    body,
    context: inGroup ? "group, owner+bot admin" : "private chat (onlyPm)",
    problems,
    sent,
    replies,
    texts: replies.map((s) => s.text),
    elapsed,
    timedOut,
  };
}

before(async () => {
  const setup = await fakes.setup();
  registry = setup.registry;
  commands = setup.commands;
  loadFailures = setup.failed;

  const started = Date.now();

  // Phase 1: every command, no argument, plus the non-"keyed" calls with arguments
  const jobs = commands.map((entry, i) => ({ entry, alias: entry.aliases[0], index: i, kind: "noarg" }));
  let n = commands.length;
  const keyedJobs = [];
  for (const spec of WITH_ARGS) {
    const entry = commands.find((c) => c.file === spec.file);
    if (!entry) continue; // reported by the test of that row
    const job = { entry, alias: spec.alias || entry.aliases[0], args: spec.args, sender: IDS.OWNER2_PN, index: n++, kind: "args", spec };
    (spec.expect === "keyed" ? keyedJobs : jobs).push(job);
  }
  const results = await pool(jobs, CONCURRENCY, runOne);
  results.forEach((r, i) => {
    if (jobs[i].kind === "noarg") noArg.set(jobs[i].entry.file, r);
    else withArgs.set(`${jobs[i].spec.file} ${jobs[i].alias}`, r);
  });

  // Phase 2: commands that need a missing API key, one at a time to count network attempts
  await fakes.sleep(150);
  for (const job of keyedJobs) {
    const callsBefore = net.calls.filter((c) => c.kind !== "exec").length;
    const r = await runOne(job);
    await fakes.sleep(50);
    r.networkCalls = net.calls.filter((c) => c.kind !== "exec").slice(callsBefore);
    withArgs.set(`${job.spec.file} ${job.alias}`, r);
  }
  phaseMs = Date.now() - started;
});

after(() => {
  restoreFiles();
  exits.restore();
  net.restore();
});

const describeSent = (r) =>
  r.sent.length
    ? r.sent.map((s) => `${s.kind}->${s.jid.split("@")[0]}: "${excerpt(s.text, 120)}"`).join(" | ")
    : "(nothing sent)";

// ---------------------------------------------------------------------------
// One test per plugin file: no argument
// ---------------------------------------------------------------------------

const pluginFiles = fs
  .readdirSync(path.join(ROOT, "plugins"))
  .filter((f) => f.endsWith(".js"))
  .sort();

for (const file of pluginFiles) {
  test(`no argument: ${file}`, (t) => {
    const r = noArg.get(file);
    if (!r) {
      const failure = (loadFailures || []).find((f) => f.file === file);
      if (failure) assert.fail(`${file} failed to load: ${failure.error.split("\n")[0]}`);
      t.skip("no command in this module (hooks / helpers only)");
      return;
    }
    fakes.assertNone(r.problems, `${r.body} [${r.context}] ${r.elapsed} ms\n  sent: ${describeSent(r)}`);
  });
}

// ---------------------------------------------------------------------------
// Dead dependencies
// ---------------------------------------------------------------------------

for (const spec of WITH_ARGS) {
  test(`dead dependency (${spec.expect}): ${spec.file}${spec.alias ? ` .${spec.alias}` : ""}`, (t) => {
    const entry = commands.find((c) => c.file === spec.file);
    if (!entry) {
      const failure = (loadFailures || []).find((f) => f.file === spec.file);
      if (failure) assert.fail(`${spec.file} failed to load: ${failure.error.split("\n")[0]}`);
      t.skip(`${spec.file} registers no command (renamed? update WITH_ARGS in this test)`);
      return;
    }
    const alias = spec.alias || entry.aliases[0];
    const r = withArgs.get(`${spec.file} ${alias}`);
    assert.ok(r, `${spec.file} .${alias} was not run`);

    const problems = [...r.problems];
    const unavailable = getLang("common.service_unavailable");
    const notConfigured = getLang("common.not_configured");
    const said = (text) => r.texts.some((x) => x.includes(text));
    if (spec.expect === "keyed") {
      if (!said(notConfigured)) problems.push(`expected common.not_configured ("${excerpt(notConfigured, 60)}") when the API key is missing`);
      if (r.networkCalls && r.networkCalls.length) {
        problems.push(`the key is missing, yet ${r.networkCalls.length} network call(s) were attempted: ${r.networkCalls.map((c) => `${c.kind}:${c.target}`).join(", ")} (FR-008: check the key before calling)`);
      }
    } else if (spec.expect === "dead") {
      if (!said(unavailable) && !said(notConfigured)) {
        problems.push(`expected common.service_unavailable ("${excerpt(unavailable, 60)}") or common.not_configured with the service dead`);
      }
    }
    fakes.assertNone(problems, `${r.body} [${r.context}] ${r.elapsed} ms\n  sent: ${describeSent(r)}`);
  });
}

// ---------------------------------------------------------------------------
// Whole run
// ---------------------------------------------------------------------------

test("every registered command was exercised, and none restarts the process", () => {
  const missing = commands.filter((c) => !noArg.has(c.file)).map((c) => c.file);
  assert.deepEqual(missing, [], "commands not run");
  assert.deepEqual(exits.calls, [], "process.exit() was called by a command");
});

test(`the whole run takes less than ${RUNTIME_BUDGET_MS / 1000} s`, (t) => {
  const slow = [...noArg.values()]
    .filter((r) => r.elapsed > 1000)
    .sort((a, b) => b.elapsed - a.elapsed)
    .slice(0, 5)
    .map((r) => `${r.body}: ${r.elapsed} ms`);
  t.diagnostic(`${noArg.size} commands + ${withArgs.size} calls with arguments in ${phaseMs} ms; ${net.calls.length} blocked outside accesses${slow.length ? `; slowest: ${slow.join(", ")}` : ""}`);
  assert.ok(phaseMs < RUNTIME_BUDGET_MS, `took ${phaseMs} ms`);
});

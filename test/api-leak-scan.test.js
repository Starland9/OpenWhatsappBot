"use strict";
/**
 * Feature 004 (messaging API), SC-003, public side (contracts/public-api.md section 11, data-model.md section 9,
 * contracts/runtime.md RT-05): after the security and send scenarios (text, media by file and by URL, interactive,
 * replies, refusals, cancellations) run with a canary key, text, caption, file name, URL, question, labels and
 * recipient, the log output, the log ring, the console, the audit rows, the alerts, EVERY response (body and headers)
 * and a dump of the four API tables hold none of them: not the token, not its secret part, not the lookup id, nothing
 * shaped like `owbk_<16 hex>_`; no text or JSON column outside `ApiMessage.payload` (rows in `queued|sending` only),
 * `ApiMessage.choices` (the short labels) and `ApiKey.name` / `recipients` holds the content; and no response, audit
 * detail or log line contains a column of the never-serialised list.
 * The scan has teeth: a canary logged on purpose is found in each captured channel.
 */

const { test, describe, before, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111" });

const { createApiHarness } = require("./helpers/apiHarness");

const SEC = 1000;
const MIN = 60 * SEC;
const RUN = crypto.randomBytes(3).toString("hex");
const C = {
  text: `CANARY-TEXT-${RUN}`,
  caption: `CANARY-CAPTION-${RUN}`,
  file: `CANARY-FILE-${RUN}`,
  url: `CANARY-URL-${RUN}`,
  question: `CANARY-QUESTION-${RUN}`,
  body: `CANARY-BODY-${RUN}`,
  desc: `CANARY-DESC-${RUN}`,
  place: `CANARY-PLACE-${RUN}`,
  contact: `CANARY-CONTACT-${RUN}`,
  email: `canary-mail-${RUN}`,
  badValue: `CANARY-BADVALUE-${RUN}`,
  // the short labels a message keeps for its replies (<= 100 characters) are allowed in ApiMessage.choices only
  option: `CANARY-OPT-${RUN}`,
  button: `CANARY-BTN-${RUN}`.slice(0, 20),
  row: `CANARY-ROW-${RUN}`,
  idem: `CANARY-IDEM-${RUN}`,
};
const CONTENT = [C.text, C.caption, C.file, C.url, C.question, C.body, C.desc, C.place, C.contact, C.email, C.badValue];
const LABELS = [C.option, C.button, C.row];
const RECIPIENT = "237699881122";
const MENTIONED = "237699883344";
const CARD_PHONE = "237699884455";

let h;
let key;
let consoleLines;
before(async () => {
  h = await createApiHarness({});
  h.captureLogs();
  h.record = [];
  consoleLines = [];
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    mock.method(console, level, (...args) => {
      consoleLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
  key = await h.createKey({ name: "Canary key", rights: "all", limits: { perMinute: 1000, perDay: 100000, pending: 5000 } });
  await runScenarios();
});
after(async () => {
  mock.restoreAll();
  await h.close();
});

const sample = (format) => h.sampleFor(format);

async function runScenarios() {
  const ok = [];
  const keep = (res) => {
    assert.equal(res.status, 202, res.text);
    ok.push(res.json.message.id);
    return res.json.message;
  };

  // ---- security scenarios ------------------------------------------------------------------------------------------
  const revoked = await h.createKey({ name: "revoked canary", revokedAt: new Date(h.now() - MIN) });
  const expired = await h.createKey({ name: "expired canary", expiresAt: new Date(h.now() - SEC) });
  const fenced = await h.createKey({ name: "fenced canary", ipAllow: ["192.0.2.0/24"] });
  const narrow = await h.createKey({ name: "narrow canary", rights: ["messages.read"] });
  const listed = await h.createKey({ name: "listed canary", policy: "list", recipients: ["237690000777@s.whatsapp.net"] });
  const body = { format: "text", to: RECIPIENT, text: C.text };
  const wrongSecret = `owbk_${key.lookupId}_${"Q".repeat(43)}`;
  for (const who of [{ token: wrongSecret }, { token: `owbk_${"0".repeat(16)}_${"R".repeat(43)}` }, { key: revoked }, { key: expired }, { key: fenced }, {}, { token: "garbage" }]) {
    await h.request("POST", "/api/v1/messages", { ...who, body, fresh: true });
  }
  await h.request("POST", "/api/v1/messages", { key: narrow, body }); // forbidden
  await h.request("POST", "/api/v1/messages", { key: listed, body }); // recipient_not_allowed
  await h.request("POST", "/api/v1/messages", { key, body: { ...body, to: h.OWN_NUMBER } }); // own number
  await h.request("GET", `/api/v1/messages?api_key=${key.token}`, { key }); // a key in the URL
  await h.request("GET", `/api/v1/${key.token}/messages`, { key });
  await h.request("POST", "/api/v1/messages", { key, body, headers: { Origin: "https://evil.example" }, fresh: true });
  await h.request("POST", "/api/v1/messages", { key, body, remote: "203.0.113.9", https: false });
  // an origin that fails authentication ten times is blocked: the alert and the audit row exist
  for (let i = 0; i < 11; i += 1) await h.request("GET", "/api/v1/messages", { token: wrongSecret, remote: "198.51.100.20" });
  assert.ok(h.alerts.calls.some((c) => c.type === "api_origin_blocked"));

  // ---- refusals that carry canary values ----------------------------------------------------------------------------
  await h.send(key, { format: "text", to: C.badValue, text: C.text });
  await h.send(key, { format: "text", to: RECIPIENT, text: "x".repeat(5000) + C.text });
  await h.send(key, { format: "location", to: RECIPIENT, latitude: C.badValue, longitude: 1, name: C.place });
  await h.send(key, { format: "text", to: RECIPIENT, text: C.text, [C.badValue]: 1 });
  await h.send(key, { format: C.badValue, to: RECIPIENT });
  await h.send(key, { format: "text", to: RECIPIENT, text: C.text, quote: `msg_${"K".repeat(22)}` });
  await h.send(key, { format: "image", to: RECIPIENT, caption: C.caption, media: { url: `https://user:pass@${C.url}.example.com/a.png` } });
  await h.send(key, { format: "image", to: RECIPIENT, caption: C.caption, media: { url: `http://${C.url}.example.com/${C.url}.png` } });
  await h.send(key, { format: "image", to: RECIPIENT, caption: C.caption, media: { url: `https://127.0.0.1/${C.url}.png` } });
  await h.sendFile(key, { format: "document", to: RECIPIENT, caption: C.caption, fileName: `${C.file}.pdf` }, { data: h.samples.exe(), name: `${C.file}.pdf`, type: "application/pdf" });
  await h.sendFile(key, { format: "text", to: RECIPIENT, text: C.text }, { data: h.samples.pdf(), name: `${C.file}.pdf` });
  await h.request("POST", "/api/v1/messages", { key, rawBody: `{"text":"${C.text}`, contentType: "application/json" });
  await h.request("POST", "/api/v1/messages", { key, rawBody: JSON.stringify({ ...body, text: C.text + "x".repeat(70000) }), contentType: "application/json" });
  await h.get(`/api/v1/messages/${"msg_" + "N".repeat(22)}`, key);
  await h.get(`/api/v1/messages?after=${C.badValue}`, key);

  // ---- sends -------------------------------------------------------------------------------------------------------
  const sent = [];
  sent.push(keep(await h.send(key, body, { headers: { "Idempotency-Key": C.idem } })));
  await h.send(key, body, { headers: { "Idempotency-Key": C.idem } }); // replay
  await h.send(key, { ...body, text: C.text + "different" }, { headers: { "Idempotency-Key": C.idem } }); // conflict
  sent.push(keep(await h.send(key, { format: "text", to: "120363000000000001@g.us", text: `${C.text} @${MENTIONED}`, mentions: [MENTIONED] })));
  sent.push(keep(await h.send(key, { format: "location", to: RECIPIENT, latitude: 4.05, longitude: 9.76, name: C.place, address: C.place })));
  sent.push(keep(await h.send(key, { format: "contact", to: RECIPIENT, contacts: [{ name: C.contact, phones: [`+${CARD_PHONE}`], email: `${C.email}@canary.example` }] })));
  sent.push(keep(await h.send(key, { format: "poll", to: RECIPIENT, question: C.question, options: [`${C.option}-a`, `${C.option}-b`], multiple: true })));
  sent.push(keep(await h.send(key, { format: "buttons", to: RECIPIENT, text: C.body, buttons: [{ id: "yes", label: C.button }, { id: "no", label: "No" }] })));
  sent.push(keep(await h.send(key, { format: "list", to: RECIPIENT, text: C.body, buttonLabel: "Open", choices: [{ id: "r1", title: C.row, description: C.desc }, { id: "r2", title: "Other" }] })));
  sent.push(keep(await h.sendFile(key, { format: "document", to: RECIPIENT, caption: C.caption, fileName: `${C.file}.pdf` }, { ...(await sample("document")), name: `${C.file}.pdf` }, { headers: { "Idempotency-Key": `${C.idem}-file` } })));
  sent.push(keep(await h.sendFile(key, { format: "image", to: RECIPIENT, caption: C.caption }, { ...(await sample("image")), name: `${C.file}.png` })));
  sent.push(keep(await h.sendFile(key, { format: "sticker", to: RECIPIENT }, { ...(await sample("sticker")), name: `${C.file}.png` })));
  h.web.serve((await sample("image")).data, { "Content-Type": "image/png" });
  sent.push(keep(await h.send(key, { format: "image", to: RECIPIENT, caption: C.caption, media: { url: `https://files-${RUN}.example.com/${C.url}.png` } })));
  await h.send(key, { format: "text", to: RECIPIENT, text: C.text, linkPreview: true });

  // a wait that ends, a disabled chat, a failure after acceptance
  const waiting = h.request("POST", "/api/v1/messages?wait=30", { key, body: { ...body, text: `${C.text} waiting` } });
  await fakes.sleep(30);
  await h.drain();
  const waited = await h.until(waiting, { advance: false });
  assert.equal(waited.status, 202);
  h.engine.banned.add(`${RECIPIENT}@s.whatsapp.net`);
  await h.send(key, body); // chat_disabled (409)
  h.engine.banned.delete(`${RECIPIENT}@s.whatsapp.net`);
  const corrupt = (await h.samples.png()).subarray(0, 41);
  keep(await h.sendFile(key, { format: "sticker", to: RECIPIENT }, { data: corrupt, name: `${C.file}.png`, type: "image/png" }));
  await h.drain();

  // ---- replies ------------------------------------------------------------------------------------------------------
  const polls = (await h.rows()).filter((r) => r.format === "poll");
  const buttons = (await h.rows()).filter((r) => r.format === "buttons");
  const lists = (await h.rows()).filter((r) => r.format === "list");
  await h.recordReply(polls[0].publicId, { kind: "vote", author: `${RECIPIENT}@s.whatsapp.net`, choiceIds: ["0"] });
  await h.recordReply(buttons[0].publicId, { kind: "choice", author: `${RECIPIENT}@s.whatsapp.net`, choiceIds: ["yes"], via: "tap" });
  await h.recordReply(lists[0].publicId, { kind: "choice", author: `${RECIPIENT}@s.whatsapp.net`, choiceIds: ["r1"], via: "number" });
  for (const id of ok) await h.get(`/api/v1/messages/${id}`, key);
  await h.get("/api/v1/messages?limit=100", key);
  await h.get("/api/v1/openapi.json", key);

  // ---- cancellations --------------------------------------------------------------------------------------------------
  h.setConnected(false);
  const queuedA = keep(await h.send(key, { ...body, text: `${C.text} queued A` }));
  const victim = await h.createKey({ name: "victim canary" });
  await h.send(victim, { ...body, text: `${C.text} queued victim` });
  await h.revokeKey(victim);
  await h.setEnabled(false);
  assert.ok(queuedA);
  await h.setEnabled(true);
  h.setConnected(true);
  await h.drain();
}

// ---------------------------------------------------------------------------------------------------------------------
const everything = () => ({
  // the answers only: the request line is the caller's own text (a key in a URL, a canary value) and not part of an answer
  responses: h.record.map(({ res }) => `${res.rawHeaders.join("\n")}\n${res.text}`).join("\n=====\n"),
  logs: [h.logText(), consoleLines.join("\n")].join("\n"),
  audit: JSON.stringify(h.audit.rows),
  alerts: JSON.stringify(h.alerts.calls),
});

const has = (haystack, needle) => haystack.includes(needle);

describe("the scan has teeth: a canary put in a channel is found in it", () => {
  test("log output, ring, console, audit and alerts are all read", async () => {
    const probe = `CANARY-PROBE-${RUN}`;
    require("../lib/utils/logger").createLogger("leak-probe").info({ probe }, `probe ${probe}`);
    h.logLines.push({ level: "info", args: [probe] });
    consoleLines.push(probe);
    const text = everything();
    assert.ok(has(text.logs, probe));
    const ring = require("../lib/admin/logs/ring").list({ limit: 1000 });
    assert.ok(ring.some((entry) => String(entry.msg).includes(probe)), "the ring holds it");
    assert.ok((h.logText().match(new RegExp(probe, "g")) || []).length >= 3, "raw API logger, final output and ring");
    h.audit.rows.push({ action: "probe", detail: { probe } });
    assert.ok(has(everything().audit, probe));
    h.audit.rows.pop();
    assert.ok(h.record.length > 60, `${h.record.length} answers recorded`);
  });
});

describe("secrets: the token, its secret part and the lookup id", () => {
  test("none is in a log, the ring, the console, an audit row, an alert, an answer or a table", async () => {
    const seen = everything();
    const dump = JSON.stringify(await h.dumpTables());
    const tokens = [key.token];
    for (const k of [key]) tokens.push(k.secret);
    for (const channel of ["responses", "logs", "audit", "alerts"]) {
      for (const needle of [key.token, key.secret]) assert.equal(has(seen[channel], needle), false, `${channel} holds the token or its secret`);
      assert.equal(has(seen[channel], key.lookupId), false, `${channel} holds the lookup id`);
      assert.doesNotMatch(seen[channel], /owbk_[0-9a-f]{16}_/, `${channel} holds something shaped like a key`);
    }
    assert.equal(has(dump, key.token) || has(dump, key.secret), false, "the tables hold neither the token nor the secret");
    assert.doesNotMatch(dump, /owbk_[0-9a-f]{16}_/);
    // the lookup id is stored once, in its own column, and nowhere else
    const keys = (await h.dumpTables()).ApiKey;
    for (const row of keys) {
      for (const [column, value] of Object.entries(row)) {
        if (column !== "lookupId") assert.equal(has(JSON.stringify(value), row.lookupId), false, `ApiKey.${column}`);
      }
    }
    for (const other of ["secretHash"]) {
      for (const row of keys) assert.equal(has(seen.responses + seen.logs + seen.audit + seen.alerts, row[other]), false, `${other} of key ${row.id} leaked`);
    }
    assert.ok(tokens.length);
  });

  test("a key in the URL is refused without ever being written down", () => {
    const seen = everything();
    assert.equal(has(seen.logs, "api_key="), false);
    assert.equal(has(seen.logs, "/api/v1/owbk_"), false);
  });
});

describe("content: text, caption, file name, URL, question, body, description, place, contact", () => {
  test("no channel holds any of it", () => {
    const seen = everything();
    for (const channel of ["responses", "logs", "audit", "alerts"]) {
      for (const needle of CONTENT) assert.equal(has(seen[channel], needle), false, `${channel} holds ${needle}`);
    }
    for (const channel of ["logs", "audit", "alerts"]) {
      for (const needle of [...LABELS, C.idem]) assert.equal(has(seen[channel], needle), false, `${channel} holds ${needle}`);
    }
    assert.equal(has(seen.responses, C.idem), false, "the Idempotency-Key never comes back");
    // a fake host name and the words of the URL are not echoed either
    assert.equal(has(seen.responses + seen.logs, `files-${RUN}`), false);
  });

  test("the labels of a reply are in the answers of the owning key only (the responses of PUB-2), nowhere else", () => {
    const answers = h.record.map(({ method, path, res }) => ({ method, path, text: res.text }));
    for (const label of LABELS) {
      const where = answers.filter((a) => has(a.text, label));
      for (const a of where) assert.match(a.path, /^\/api\/v1\/messages\/msg_/, `${label} only on PUB-2`);
    }
    assert.ok(answers.some((a) => has(a.text, C.button)), "the owner reads the label of the button it sent");
  });

  test("the recipient: in an answer to the owner as `to`, never in an error, a log or an audit row", () => {
    for (const { res } of h.record) {
      if (res.status >= 400) assert.equal(has(res.text, RECIPIENT), false, "an error never echoes the number");
    }
    const seen = everything();
    for (const channel of ["logs", "audit", "alerts"]) {
      assert.equal(has(seen[channel], RECIPIENT), false, `${channel} holds the number`);
      assert.equal(has(seen[channel], MENTIONED), false, `${channel} holds a mentioned number`);
      assert.equal(has(seen[channel], CARD_PHONE), false, `${channel} holds a card number`);
    }
    // the owner sees it normalised in `to`
    assert.ok(h.record.some(({ res }) => res.status === 202 && res.json && res.json.message && res.json.message.to === RECIPIENT));
  });

  test("error answers carry codes and numbers, never a submitted value", () => {
    for (const { res } of h.record) {
      if (res.status < 400 || !res.json) continue;
      for (const needle of [C.badValue, ...CONTENT]) assert.equal(has(res.text, needle), false);
      assert.deepEqual(Object.keys(res.json), ["error"]);
    }
  });
});

describe("the tables", () => {
  test("only payload (queued|sending), choices (short labels) and ApiKey.name / recipients may hold content", async () => {
    const dump = await h.dumpTables();
    assert.ok(dump.ApiMessage.length > 15);
    for (const row of dump.ApiMessage) {
      for (const [column, value] of Object.entries(row)) {
        const text = JSON.stringify(value) ?? "";
        if (column === "payload") {
          if (!["queued", "sending"].includes(row.status)) assert.equal(value, null, `payload of a ${row.status} message`);
          continue;
        }
        if (column === "choices") {
          for (const needle of CONTENT) assert.equal(has(text, needle), false, `choices hold ${needle}`);
          continue;
        }
        for (const needle of [...CONTENT, ...LABELS]) assert.equal(has(text, needle), false, `ApiMessage.${column} holds ${needle}`);
        if (column !== "idempotencyKey") assert.equal(has(text, C.idem), false, `ApiMessage.${column} holds the Idempotency-Key`);
      }
    }
    for (const row of dump.ApiMessageResponse) {
      for (const [column, value] of Object.entries(row)) {
        const text = JSON.stringify(value) ?? "";
        for (const needle of [...CONTENT, ...LABELS]) assert.equal(has(text, needle), false, `ApiMessageResponse.${column} holds ${needle}`);
      }
    }
    for (const row of dump.ApiKey) {
      for (const [column, value] of Object.entries(row)) {
        if (["name", "recipients", "nameKey"].includes(column)) continue;
        for (const needle of [...CONTENT, ...LABELS]) assert.equal(has(JSON.stringify(value) ?? "", needle), false, `ApiKey.${column} holds ${needle}`);
      }
    }
    assert.equal(has(JSON.stringify(dump.ApiState), "CANARY"), false);
  });

  test("a message that is still queued keeps its content in payload; once it leaves, payload is NULL and the staged file is gone", async () => {
    h.setConnected(false);
    const pending = (await h.send(key, { format: "text", to: RECIPIENT, text: `${C.text} still queued` })).json.message;
    const row = await h.row(pending.id);
    assert.equal(row.status, "queued");
    assert.ok(JSON.stringify(row.payload).includes(C.text), "the content waits in the payload");
    assert.equal(has(JSON.stringify(pending), C.text), false, "and does not come back in the answer");
    h.setConnected(true);
    await h.drain();
    const after = await h.row(pending.id);
    assert.equal(after.status, "sent");
    assert.equal(after.payload, null);
    assert.deepEqual((await h.engine.stage.list()).map((entry) => entry.name), []);
  });

  test("each row's payload is NULL on every message that has left or ended", async () => {
    const rows = await h.rows();
    const ended = rows.filter((r) => !["queued", "sending"].includes(r.status));
    assert.ok(ended.length > 10);
    for (const row of ended) assert.equal(row.payload, null, `${row.format} ${row.status}`);
    const statuses = new Set(rows.map((r) => r.status));
    for (const status of ["sent", "failed", "cancelled"]) assert.ok(statuses.has(status), `the scan saw a ${status} message`);
  });
});

describe("the never-serialised columns: secretHash, lookupId, seenIps, pollSecret, payload, replyData, mediaPath, requestHash, idempotencyKey", () => {
  test("their values appear in no answer, no audit row, no alert and no log line", async () => {
    const seen = everything();
    const dump = await h.dumpTables();
    const values = [];
    for (const row of dump.ApiKey) {
      values.push(["secretHash", row.secretHash], ["lookupId", row.lookupId]);
      for (const ip of row.seenIps || []) values.push(["seenIps", ip]);
    }
    for (const row of dump.ApiMessage) {
      for (const column of ["pollSecret", "replyData", "mediaPath", "requestHash", "idempotencyKey"]) {
        const value = row[column];
        if (value !== null && value !== undefined && value !== "") values.push([column, typeof value === "string" ? value : JSON.stringify(value)]);
      }
    }
    assert.ok(values.some(([column]) => column === "requestHash"), "an idempotent message exists");
    assert.ok(values.some(([column]) => column === "pollSecret"), "a poll was sent");
    assert.ok(values.some(([column]) => column === "idempotencyKey"));
    // (the OpenAPI document names the host the request came in on in `servers`: that is the caller's own address)
    const messageAnswers = h.record.filter(({ path }) => !path.startsWith("/api/v1/openapi.json")).map(({ res }) => `${res.rawHeaders.join("\n")}\n${res.text}`).join("\n=====\n");
    const channels = { answers: messageAnswers, audit: seen.audit, alerts: seen.alerts, logs: seen.logs };
    for (const [column, value] of values) {
      for (const [name, text] of Object.entries(channels)) {
        // a loopback address is the origin of nearly every request: audit rows and alerts name origins on purpose
        if (column === "seenIps" && (name === "audit" || name === "alerts" || name === "logs")) continue;
        assert.equal(has(text, value), false, `${name} holds ${column}`);
      }
    }
    // the key view of the public API never carries any of these (there is none: no endpoint describes a key)
    for (const column of ["secretHash", "lookupId", "seenIps", "pollSecret", "payload", "replyData", "mediaPath", "requestHash", "idempotencyKey"]) {
      for (const { res } of h.record) {
        if (res.json && res.status < 400) assert.equal(JSON.stringify(res.json).includes(`"${column}"`), false, `a success carries the field ${column}`);
      }
    }
  });
});

describe("the audit trail and the alerts hold facts, not content", () => {
  test("the audit rows of the public API are the origin blocks only, with a closed detail", () => {
    assert.ok(h.audit.rows.length >= 1);
    for (const row of h.audit.rows) {
      assert.equal(row.action, "api.origin.block");
      assert.deepEqual(Object.keys(row.detail), ["retryAfterMs"]);
      assert.equal(row.result, "blocked");
      assert.equal(row.origin, row.target);
    }
  });

  test("the alerts carry an origin and a delay, or the name of a key, never a token", () => {
    for (const call of h.alerts.calls) {
      assert.ok(["api_origin_blocked", "api_key_new_ip", "api_paused"].includes(call.type), call.type);
      for (const [name, value] of Object.entries(call.payload || {})) {
        assert.ok(["origin", "retryAfterMs", "keyId", "keyName", "ip", "minutes"].includes(name), name);
        assert.equal(typeof value === "string" ? value.includes("owbk_") : false, false);
      }
    }
  });
});

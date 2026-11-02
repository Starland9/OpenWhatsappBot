"use strict";
/**
 * Feature 004 (messaging API): documentation, code and registries cannot drift. This test READS
 * specs/004-messaging-api/contracts/public-api.md with the machine-read parsers of its first section and compares it with
 * the live registries: endpoint rows with `api.routes()`, right rows with `api.rights()`, format rows with
 * `formats.list()`, every `json example=<format>` block posted through the harness, status rows with the nine statuses,
 * failure rows with the failure codes, error rows with `API_STATUS` plus `MESSAGING_STATUS`; and the heading guarantees
 * of the file. Contract: public-api.md "Machine-read format" and section 11.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111" });

const { createApiHarness } = require("./helpers/apiHarness");
const formats = require("../lib/messaging/formats");
const { API_STATUS } = require("../lib/api/errors");
const { MESSAGING_STATUS, STATUSES, CODE_STATUS } = require("../lib/messaging/errors");

const CONTRACT = fs.readFileSync(path.join(__dirname, "..", "specs", "004-messaging-api", "contracts", "public-api.md"), "utf8");

/** the text between two level-2 headings `## <from>. ` and `## <to>. ` */
function slice(from, to) {
  const start = CONTRACT.search(new RegExp(`^## ${from}\\. `, "m"));
  const end = CONTRACT.search(new RegExp(`^## ${to}\\. `, "m"));
  assert.ok(start >= 0 && end > start, `headings ${from} and ${to}`);
  return CONTRACT.slice(start, end);
}

const rows = (text, pattern) => [...text.matchAll(new RegExp(pattern, "gm"))];
const FORMAT_NAMES = formats.list().map((row) => row.name);

let h;
let key;
before(async () => {
  h = await createApiHarness({});
  key = await h.createKey({ name: "contract", rights: "all", limits: { perMinute: 1000, perDay: 100000, pending: 5000 } });
});
after(async () => {
  await h.close();
});

describe("the heading guarantees of the contract file", () => {
  test("each of the headings 2 to 7 appears once as a line start, and no prose spells one with its hashes", () => {
    for (let n = 2; n <= 7; n += 1) {
      assert.equal(rows(CONTRACT, `^## ${n}\\. `).length, 1, `## ${n}.`);
      const inProse = CONTRACT.split("\n").filter((line) => !line.startsWith(`## ${n}. `) && line.includes(`## ${n}. `));
      assert.deepEqual(inProse, [], `## ${n}. spelled in prose`);
    }
  });

  test("the slices hold exactly the rows the parsers should see (no other row starts like a parsed one)", () => {
    assert.equal(rows(slice(2, 3), "^\\| (PUB-\\d+) \\| `([A-Z]+) (\\/[^`?]*)`").length, 4);
    assert.equal(rows(slice(2, 3), "^\\| `([a-z][a-z0-9_.]*)` \\| (send|read|media|docs) \\|").length, 16);
    assert.equal(rows(slice(3, 4), "^\\| `([a-z_]+)` \\| (\\d+) \\| `(messages\\.send\\.[a-z_]+)` \\|").length, 13);
    assert.equal(rows(slice(4, 5), "^\\| `(queued|sending|sent|delivered|read|failed|expired|cancelled|unknown)` \\|").length, 9);
    assert.equal(rows(slice(4, 5), "^\\| `([a-z_]+)` \\| `(failed|cancelled|unknown)` \\|").length, 14);
    assert.equal(rows(slice(6, 7), "^\\| `([a-z_]+)` \\| (\\d{3}) \\|").length, Object.keys(API_STATUS).length + Object.keys(MESSAGING_STATUS).length);
  });
});

describe("endpoints and rights", () => {
  test("endpoint rows equal api.routes(): method, path, registry id and rights (<format> expanded to the 13 names)", () => {
    const section = slice(2, 3);
    const parsed = [];
    for (const match of rows(section, "^\\| (PUB-\\d+) \\| `([A-Z]+) (\\/[^`?]*)`([^\\n]*)$")) {
      const cells = match[0].split("|").map((cell) => cell.trim());
      // | id | endpoint | right | registry id | body | success |
      const rightCell = cells[3];
      const registryId = /`([a-z]+\.[a-z]+)`/.exec(cells[4])[1];
      const rights = new Set();
      for (const token of rightCell.matchAll(/`([a-z][a-z0-9_]*(?:\.[a-z0-9_<>]+)+)`/g)) {
        if (token[1].includes("<format>")) FORMAT_NAMES.forEach((name) => rights.add(token[1].replace("<format>", name)));
        else rights.add(token[1]);
      }
      parsed.push({ ref: match[1], method: match[2], path: match[3], id: registryId, rights: [...rights].sort() });
    }
    const live = h.api.routes().map((route) => ({ method: route.method, path: route.path, id: route.id, rights: [...route.rights].sort() }));
    const sortKey = (row) => `${row.path} ${row.method}`;
    assert.deepEqual(
      parsed.map(({ ref, ...row }) => row).sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
      live.sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
    );
    assert.deepEqual(parsed.map((row) => row.ref), ["PUB-1", "PUB-2", "PUB-3", "PUB-4"]);
  });

  test("right rows equal api.rights(): id and group, in the catalogue order", () => {
    const parsed = rows(slice(2, 3), "^\\| `([a-z][a-z0-9_.]*)` \\| (send|read|media|docs) \\|").map((match) => ({ id: match[1], group: match[2] }));
    assert.deepEqual(parsed, h.api.rights().map((row) => ({ id: row.id, group: row.group })));
  });

  test("the rights of the send endpoint are the formats' rights plus media.url, and nothing else is public", () => {
    const create = h.api.routes().find((route) => route.id === "messages.create");
    assert.deepEqual(create.rights, [...formats.rights(), "media.url"]);
    assert.equal(create.dynamic, true);
    for (const route of h.api.routes()) assert.ok(route.rights.length > 0, route.id);
  });
});

describe("formats and examples", () => {
  test("format rows equal formats.list(): name, order and right", () => {
    const parsed = rows(slice(3, 4), "^\\| `([a-z_]+)` \\| (\\d+) \\| `(messages\\.send\\.[a-z_]+)` \\|").map((match) => ({ name: match[1], order: Number(match[2]), right: match[3] }));
    assert.deepEqual(parsed, formats.list().map(({ name, order, right }) => ({ name, order, right })));
  });

  const examples = rows(slice(3, 4), "^```json example=([a-z_]+)\\n([\\s\\S]*?)\\n```$").map((match) => ({ format: match[1], body: JSON.parse(match[2]) }));

  test("one executable example per format", () => {
    assert.deepEqual(examples.map((e) => e.format).sort(), [...FORMAT_NAMES].sort());
    for (const example of examples) assert.equal(example.body.format, example.format);
  });

  for (const example of examples) {
    test(`the ${example.format} example is accepted (202) for a key holding the needed rights with policy "anyone"`, async () => {
      await h.drain();
      const needed = formats.rightsFor(example.format, example.body);
      const own = await h.createKey({ name: `example ${example.format}`, rights: needed, policy: "anyone", limits: { perMinute: 1000 } });
      const sample = await h.sampleFor(example.format);
      const res = sample ? await h.sendFile(own, example.body, sample) : await h.send(own, example.body);
      assert.equal(res.status, 202, res.text);
      assert.equal(res.json.message.format, example.format);
      assert.equal(res.headers.location, `/api/v1/messages/${res.json.message.id}`);
      // the format module's own first example is the one the contract shows (no drift between the two)
      assert.deepEqual(formats.doc(example.format).examples[0], example.body);
      // a key without the format's right is refused with that right named
      const without = await h.createKey({ name: `no right ${example.format}`, rights: h.allRights().filter((r) => r !== `messages.send.${example.format}`) });
      const refused = sample ? await h.sendFile(without, example.body, sample) : await h.send(without, example.body);
      assert.equal(refused.status, 403);
      assert.deepEqual(refused.json.error.params, { right: `messages.send.${example.format}` });
    });
  }
});

describe("statuses, failure codes and errors", () => {
  test("status rows equal the nine statuses of MessageStatus, in order", () => {
    const parsed = rows(slice(4, 5), "^\\| `(queued|sending|sent|delivered|read|failed|expired|cancelled|unknown)` \\|").map((match) => match[1]);
    assert.deepEqual(parsed, [...STATUSES]);
    assert.deepEqual(h.api.openapi().components.schemas.MessageStatus.enum, parsed);
  });

  test("failure rows equal the FailureCode enum with its status", () => {
    const parsed = Object.fromEntries(rows(slice(4, 5), "^\\| `([a-z_]+)` \\| `(failed|cancelled|unknown)` \\|").map((match) => [match[1], match[2]]));
    assert.deepEqual(parsed, { ...CODE_STATUS });
    assert.deepEqual(Object.keys(parsed), Object.keys(CODE_STATUS), "same order");
    assert.deepEqual([...h.api.openapi().components.schemas.FailureCode.enum], Object.keys(parsed));
  });

  test("error rows equal API_STATUS plus MESSAGING_STATUS: code and HTTP status, nothing more, nothing less", () => {
    const parsed = Object.fromEntries(rows(slice(6, 7), "^\\| `([a-z_]+)` \\| (\\d{3}) \\|").map((match) => [match[1], Number(match[2])]));
    assert.deepEqual(parsed, { ...API_STATUS, ...MESSAGING_STATUS });
    assert.equal(Object.keys(API_STATUS).filter((code) => Object.hasOwn(MESSAGING_STATUS, code)).length, 0, "one source per code (RT-21)");
    assert.deepEqual([...h.api.openapi().components.schemas.Error.properties.error.properties.code.enum].sort(), Object.keys(parsed).sort());
  });

  test("the field error codes of 6.1 are those of the schema dialect and of the OpenAPI FieldError", () => {
    const section = CONTRACT.slice(CONTRACT.indexOf("### 6.1 Field errors"), CONTRACT.indexOf("## 7. "));
    const parsed = [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]);
    assert.deepEqual([...h.api.openapi().components.schemas.FieldError.properties.code.enum].sort(), [...parsed].sort());
  });
});

describe("the guarantees of the headings", () => {
  test("PUB-1 answers 202 and the three readers 200, with Location only on PUB-1", async () => {
    await h.drain();
    const created = await h.send(key, { format: "text", to: "237690000001", text: "hello" });
    assert.equal(created.status, 202);
    assert.ok(created.headers.location);
    const id = created.json.message.id;
    for (const [path, status] of [[`/api/v1/messages/${id}`, 200], ["/api/v1/messages", 200], ["/api/v1/openapi.json", 200]]) {
      const res = await h.get(path, key);
      assert.equal(res.status, status, path);
      assert.equal(res.headers.location, undefined);
    }
  });

  test("the headers of 1.4 that the contract names exist on a success", async () => {
    const res = await h.get("/api/v1/messages", key);
    for (const name of ["x-request-id", "cache-control", "content-security-policy", "x-content-type-options", "referrer-policy", "cross-origin-resource-policy"]) {
      assert.ok(res.headers[name], name);
    }
    assert.match(res.headers["content-type"], /^application\/json; charset=utf-8$/);
  });
});

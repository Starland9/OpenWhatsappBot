"use strict";
/**
 * Multipart reception of the messaging API (feature 004, contracts/runtime.md section 15.11, public-api.md 3.4 and 11):
 * the hand-written restricted parser (a random-split fuzz of about 2,800 splits, the grammar refusals), the uploader
 * (streamed `.part` file, caps, early type check, concurrency, idle timeout, disk guard, cleanup) and the whole path
 * through the pipeline over real HTTP (declared lengths, file/URL sources, idempotency of a multipart request).
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

const { boundaryOf, createReader, parseMultipart, readMessagePart } = require("../lib/api/multipart");
const { createUploader } = require("../lib/api/upload");
const { ApiError } = require("../lib/api/errors");
const { MessagingError } = require("../lib/messaging/errors");
const { createApiKit, fakeSniff } = require("./helpers/apiHttpKit");

const BOUNDARY = "----owbTestBoundary7MA4YWxk";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const MESSAGE = JSON.stringify({ format: "image", to: "237690000001", caption: "Your receipt" });

// ---- helpers ---------------------------------------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A multipart body; a part is { name, filename, type, body } or { raw } (the part bytes as written, headers included) */
function build(parts, { boundary = BOUNDARY, preamble = "", epilogue = "", closing = true } = {}) {
  const chunks = [Buffer.from(preamble)];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.raw) {
      chunks.push(Buffer.isBuffer(part.raw) ? part.raw : Buffer.from(part.raw));
    } else {
      let head = `Content-Disposition: form-data; name="${part.name}"`;
      if (part.filename !== undefined) head += `; filename="${part.filename}"`;
      if (part.type) head += `\r\nContent-Type: ${part.type}`;
      chunks.push(Buffer.from(`${head}\r\n\r\n`), Buffer.from(part.body || ""), Buffer.from("\r\n"));
    }
  }
  if (closing) chunks.push(Buffer.from(`--${boundary}--\r\n${epilogue}`));
  return Buffer.concat(chunks);
}

async function* chunked(buffer, cuts) {
  let from = 0;
  for (const cut of [...cuts, buffer.length]) {
    if (cut > from) yield buffer.subarray(from, cut);
    from = Math.max(from, cut);
  }
}
const randomCuts = (length, random, count) => Array.from({ length: count }, () => Math.floor(random() * length)).sort((a, b) => a - b);

async function readAll(source, boundary = BOUNDARY) {
  const out = [];
  await parseMultipart(source, boundary, async (part) => {
    const chunks = [];
    for await (const chunk of part.stream) chunks.push(Buffer.from(chunk));
    out.push({ name: part.name, filename: part.filename, contentType: part.contentType, body: Buffer.concat(chunks) });
  });
  return out;
}

const refused = async (promise, code, fields) => {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ApiError, `expected an ApiError, got ${err && err.name}: ${err && err.message}`);
    assert.equal(err.code, code);
    if (fields) assert.deepEqual(err.fields, fields);
    return err;
  }
  return assert.fail("should have been refused");
};

// ---- boundaryOf -----------------------------------------------------------------------------------------------------
describe("boundaryOf", () => {
  test("1 to 70 RFC 2046 characters, quoted or not", () => {
    assert.equal(boundaryOf(`multipart/form-data; boundary=${BOUNDARY}`), BOUNDARY);
    assert.equal(boundaryOf(`Multipart/Form-Data; Boundary="${BOUNDARY}"`), BOUNDARY);
    assert.equal(boundaryOf("multipart/form-data; charset=utf-8; boundary=abc"), "abc");
    assert.equal(boundaryOf(`multipart/form-data; boundary=${"a".repeat(70)}`), "a".repeat(70));
    for (const bad of [undefined, "", "application/json", "multipart/mixed; boundary=abc", "multipart/form-data", "multipart/form-data; boundary=",
      `multipart/form-data; boundary=${"a".repeat(71)}`, "multipart/form-data; boundary=a b", 'multipart/form-data; boundary="a;b"',
      "multipart/form-data; boundary=a; boundary=b", "multipart/form-data; boundary=é", "multipart/form-data; boundary=a\r\nb"]) {
      assert.equal(boundaryOf(bad), null, String(bad));
    }
  });
});

// ---- the parser -------------------------------------------------------------------------------------------------------
describe("parser: random splits give exact parts", () => {
  const delimiter = `\r\n--${BOUNDARY}`;
  const random = mulberry32(20261102);
  const binary = crypto.randomBytes(100 * 1024);
  const cases = {
    "a message and a small file": [{ name: "message", body: MESSAGE }, { name: "file", filename: "r.png", type: "image/png", body: PNG }],
    "data holding CRLF, dashes, a boundary prefix and boundary-like text": [
      { name: "message", body: MESSAGE },
      { name: "file", filename: "x.bin", body: Buffer.from(`a\r\n--b\r\n--${BOUNDARY.slice(0, 10)}\r\n${delimiter}X\r\n${delimiter.slice(0, -1)}\r\n--\r\n\r\n-${delimiter}zz${delimiter.slice(2)}Q`) },
    ],
    "empty message and empty file": [{ name: "message", body: "" }, { name: "file", filename: "", body: "" }],
    "100 KiB of binary": [{ name: "message", body: MESSAGE }, { name: "file", filename: "b.bin", body: binary }],
    "a file ending with CR and CRLF": [{ name: "message", body: MESSAGE }, { name: "file", filename: "c", body: Buffer.from("data\r\n\r") }],
    "the delimiter minus its last character, repeated": [{ name: "message", body: MESSAGE }, { name: "file", filename: "d", body: Buffer.from(delimiter.slice(0, -1).repeat(20)) }],
    "a message only": [{ name: "message", body: MESSAGE }],
  };

  let splits = 0;
  for (const [label, parts] of Object.entries(cases)) {
    test(label, async () => {
      const body = build(parts, { preamble: "preamble text\r\n" });
      const expected = parts.map((p) => ({ name: p.name, filename: p.filename === undefined ? null : p.filename, body: Buffer.from(p.body || "") }));
      const check = (got) => {
        assert.equal(got.length, expected.length);
        got.forEach((part, i) => {
          assert.equal(part.name, expected[i].name);
          assert.equal(part.filename, expected[i].filename);
          assert.ok(part.body.equals(expected[i].body), `part ${i} differs (${part.body.length} vs ${expected[i].body.length} bytes)`);
        });
      };
      check(await readAll(chunked(body, [])));
      for (let i = 0; i < 400; i++) {
        const cuts = randomCuts(body.length, random, 1 + Math.floor(random() * 12));
        check(await readAll(chunked(body, cuts)));
        splits += 1;
      }
    });
  }

  test("1-byte chunks and cuts around every boundary byte", async () => {
    const parts = cases["data holding CRLF, dashes, a boundary prefix and boundary-like text"];
    const body = build(parts);
    const everyByte = Array.from({ length: body.length }, (_, i) => i);
    const got = await readAll(chunked(body, everyByte));
    assert.ok(got[1].body.equals(Buffer.from(parts[1].body)));
    const first = body.indexOf(Buffer.from(delimiter), 10);
    for (let offset = -3; offset <= delimiter.length + 3; offset++) {
      const second = await readAll(chunked(body, [first + offset]));
      assert.ok(second[1].body.equals(Buffer.from(parts[1].body)), `cut at ${offset}`);
    }
  });

  test("about 2,800 splits were exercised", () => {
    assert.ok(splits >= 2800, `${splits} splits`);
  });

  test("an epilogue after the closing boundary is ignored, and is never read", async () => {
    let pulled = 0;
    async function* counting() {
      const body = build([{ name: "message", body: MESSAGE }], { epilogue: "ignored trailer" });
      for await (const b of chunked(body, [10, 40])) {
        pulled += 1;
        yield b;
      }
      pulled += 1000; // would only be reached by a reader that wants more
      yield Buffer.from("never");
    }
    const got = await readAll(counting());
    assert.equal(got.length, 1);
    assert.ok(pulled < 1000);
  });

  test("parts keep their Content-Type text; a message part may carry any type or none", async () => {
    const body = build([{ name: "message", type: "application/json; charset=utf-8", body: MESSAGE }, { name: "file", filename: "a.png", type: "image/png", body: PNG }]);
    const got = await readAll(chunked(body, []));
    assert.equal(got[0].contentType, "application/json; charset=utf-8");
    assert.equal(got[1].contentType, "image/png");
    const plain = await readAll(chunked(build([{ name: "message", body: MESSAGE }]), []));
    assert.equal(plain[0].contentType, null);
  });

  test("an unconsumed part is drained when the next one is requested", async () => {
    const reader = createReader(chunked(build([{ name: "message", body: MESSAGE }, { name: "file", filename: "f", body: "payload" }]), [7, 99]), BOUNDARY);
    await reader.nextPart();
    const file = await reader.nextPart();
    assert.equal(file.name, "file");
    assert.equal(await reader.nextPart(), null, "the file part was never read: it is drained, then the end");
  });
});

describe("parser: the grammar (violations are 400 bad_request)", () => {
  const msg = { name: "message", body: MESSAGE };
  const file = { name: "file", filename: "f", body: "data" };
  const run = (buffer, boundary = BOUNDARY) => readAll(chunked(buffer, []), boundary);
  const raw = (headers, body = "x") => ({ raw: `${headers}\r\n\r\n${body}\r\n` });

  test("a duplicate header, a folded header, Content-Transfer-Encoding, any other header", async () => {
    await refused(run(build([raw('Content-Disposition: form-data; name="message"\r\nContent-Disposition: form-data; name="message"')])), "bad_request");
    await refused(run(build([raw('Content-Disposition: form-data; name="message"\r\nContent-Type: a/b\r\nContent-Type: a/c')])), "bad_request");
    await refused(run(build([raw('Content-Disposition: form-data;\r\n name="message"')])), "bad_request");
    await refused(run(build([raw('Content-Disposition: form-data; name="message"\r\nContent-Transfer-Encoding: base64')])), "bad_request");
    await refused(run(build([raw('Content-Disposition: form-data; name="message"\r\nX-Custom: 1')])), "bad_request");
    await refused(run(build([raw("Content-Type: text/plain")])), "bad_request");
    await refused(run(build([raw("")])), "bad_request");
  });

  test("a malformed or unexpected disposition", async () => {
    for (const disposition of ["attachment; name=\"message\"", "form-data", "form-data; name=message; name=other", "form-data; name=\"message\"; extra=\"1\"",
      "form-data; name=\"message\"; filename=\"a\"; filename=\"b\"", "form-data; name=\"mess\u0000age\""]) {
      await refused(run(build([raw(`Content-Disposition: ${disposition}`)])), "bad_request", undefined);
    }
  });

  test("an unknown part name, a second `message`, a third part", async () => {
    await refused(run(build([{ name: "other", body: "x" }])), "bad_request");
    await refused(run(build([msg, { name: "message", body: "again" }])), "bad_request");
    await refused(run(build([msg, file, { name: "extra", body: "x" }])), "bad_request");
    await refused(run(build([msg, file, file])), "bad_request");
    await refused(run(build([msg, file, msg])), "bad_request");
  });

  test("a missing closing boundary, a truncated body, no boundary at all, an empty form", async () => {
    await refused(run(build([msg, file], { closing: false })), "bad_request");
    await refused(run(build([msg, file]).subarray(0, 120)), "bad_request");
    await refused(run(Buffer.from("just some text, no boundary here")), "bad_request");
    await refused(run(Buffer.from(`--${BOUNDARY}--\r\n`)), "bad_request");
    await refused(run(Buffer.alloc(0)), "bad_request");
    await refused(run(Buffer.from(`--${BOUNDARY}`)), "bad_request");
  });

  test("a preamble over 1 KiB, a header block over 4 KiB, garbage after a delimiter", async () => {
    await refused(run(build([msg], { preamble: `${"p".repeat(1100)}\r\n` })), "bad_request");
    assert.equal((await run(build([msg], { preamble: `${"p".repeat(1000)}\r\n` }))).length, 1, "1000 bytes of preamble are fine");
    await refused(run(build([raw(`Content-Disposition: form-data; name="message"\r\nContent-Type: ${"a".repeat(4200)}`)])), "bad_request");
    await refused(run(Buffer.from(`--${BOUNDARY}garbage\r\n\r\n`)), "bad_request");
    await refused(run(Buffer.from(`--${BOUNDARY}  \r\nContent-Disposition: form-data; name="message"\r\n\r\nx\r\n--${BOUNDARY}--\r\n`)), "bad_request");
  });

  test("a bad boundary is refused when the reader is created", () => {
    assert.throws(() => createReader(chunked(Buffer.alloc(0), []), ""), (err) => err.code === "bad_request");
    assert.throws(() => createReader(chunked(Buffer.alloc(0), []), "a b"), (err) => err.code === "bad_request");
  });

  test("a source that fails while being read is bad_request", async () => {
    async function* failing() {
      yield Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="message"\r\n\r\nabc`);
      throw new Error("socket hang up");
    }
    await refused(readAll(failing()), "bad_request");
  });

  test("`file` before `message` is 422 validation_failed with fields.file = invalid_order", async () => {
    await refused(run(build([file, msg])), "validation_failed", { file: { code: "invalid_order" } });
    await refused(run(build([file])), "validation_failed", { file: { code: "invalid_order" } });
  });
});

describe("readMessagePart", () => {
  const requestOf = (buffer, cuts = [], header = `multipart/form-data; boundary=${BOUNDARY}`) => {
    const req = chunked(buffer, cuts);
    req.headers = { "content-type": header };
    return req;
  };

  test("reads the message whole, then hands over the file part", async () => {
    const result = await readMessagePart(requestOf(build([{ name: "message", body: MESSAGE }, { name: "file", filename: "r.png", body: PNG }]), [30, 90]), { limit: 65536 });
    assert.equal(result.raw.toString(), MESSAGE);
    const file = await result.next();
    assert.equal(file.name, "file");
    assert.equal(file.filename, "r.png");
    const chunks = [];
    for await (const chunk of file.stream) chunks.push(chunk);
    assert.ok(Buffer.concat(chunks).equals(PNG));
    assert.equal(await result.next(), null);
  });

  test("a message-only request ends after the message", async () => {
    const result = await readMessagePart(requestOf(build([{ name: "message", body: MESSAGE }])), { limit: 65536 });
    assert.equal(await result.next(), null);
  });

  test("a message over the limit is 413 payload_too_large with maxBytes", async () => {
    const err = await refused(readMessagePart(requestOf(build([{ name: "message", body: "x".repeat(2000) }])), { limit: 1000 }), "payload_too_large");
    assert.deepEqual(err.params, { maxBytes: 1000 });
    assert.equal((await readMessagePart(requestOf(build([{ name: "message", body: "x".repeat(1000) }])), { limit: 1000 })).raw.length, 1000);
  });

  test("a missing or invalid boundary is bad_request", async () => {
    await refused(readMessagePart(requestOf(build([{ name: "message", body: "x" }]), [], "multipart/form-data"), { limit: 10 }), "bad_request");
    await refused(readMessagePart(requestOf(Buffer.alloc(0)), { limit: 10 }), "bad_request");
  });
});

// ---- the uploader -----------------------------------------------------------------------------------------------------
describe("upload.receive", () => {
  let root;
  let dir;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-upload-"));
    dir = path.join(root, "tmp", "api");
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  const config = { MAX_UPLOAD: 230 };
  const uploader = (extra = {}) => createUploader({ sniff: fakeSniff, config, idleMs: 200, ...extra });
  const partOf = (chunks, filename = "r.png") => ({
    filename,
    stream: (async function* () {
      for (const c of chunks) yield c;
    })(),
  });
  const leftovers = () => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  const opts = (extra = {}) => ({ keyId: 1, maxBytes: 1024 * 1024, kinds: ["image"], dir, ...extra });

  test("streams to <dir>/<random>.part (0600), counts, hashes and returns the descriptor", async () => {
    const result = await uploader().receive(partOf([PNG.subarray(0, 100), PNG.subarray(100)]), opts());
    assert.equal(path.dirname(result.path), dir);
    assert.match(path.basename(result.path), /^[0-9a-f]{32}\.part$/);
    assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
    assert.ok(fs.readFileSync(result.path).equals(PNG));
    assert.equal(result.size, PNG.length);
    assert.equal(result.sha256, crypto.createHash("sha256").update(PNG).digest("hex"));
    assert.equal(result.name, "r.png");
    assert.equal(result.mime, "image/png");
    fs.rmSync(result.path);
  });

  test("an overflow stops the reception within the cap plus one chunk and deletes the file (413 media_too_large)", async () => {
    let pulled = 0;
    const chunk = Buffer.alloc(16 * 1024, 1);
    chunk.set(PNG.subarray(0, 8));
    const part = {
      filename: "big.png",
      stream: (async function* () {
        for (let i = 0; i < 1000; i++) {
          pulled += chunk.length;
          yield chunk;
        }
      })(),
    };
    try {
      await uploader().receive(part, opts({ maxBytes: 100 * 1024 }));
      assert.fail("should overflow");
    } catch (err) {
      assert.ok(err instanceof MessagingError);
      assert.equal(err.code, "media_too_large");
      assert.deepEqual(err.params, { maxBytes: 100 * 1024 });
    }
    assert.ok(pulled <= 100 * 1024 + 64 * 1024, `${pulled} bytes read`);
    assert.deepEqual(leftovers(), []);
  });

  test("a recognised wrong type ends the upload after the first chunk (422 media_type_mismatch, nothing echoed)", async () => {
    let pulled = 0;
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(5000, 65)]);
    const part = {
      stream: (async function* () {
        for (let i = 0; i < 100; i++) {
          pulled += pdf.length;
          yield pdf;
        }
      })(),
    };
    try {
      await uploader().receive(part, opts());
      assert.fail("should mismatch");
    } catch (err) {
      assert.equal(err.code, "media_type_mismatch");
      assert.deepEqual(err.params, { expected: ["image"] });
      assert.ok(!JSON.stringify(err.params).includes("pdf"));
    }
    assert.ok(pulled <= 2 * pdf.length, `stopped early (${pulled} bytes)`);
    assert.deepEqual(leftovers(), []);
  });

  test("a content that cannot be decided early is left to inspectMedia; kinds = null skips the check", async () => {
    const text = Buffer.from("plain text\n".repeat(10));
    const done = await uploader().receive(partOf([text]), opts());
    assert.equal(done.mime, null);
    fs.rmSync(done.path);
    const pdf = Buffer.from("%PDF-1.7 hello");
    const skipped = await uploader().receive(partOf([pdf]), opts({ kinds: null }));
    assert.equal(skipped.mime, "application/pdf");
    fs.rmSync(skipped.path);
  });

  test("at most 2 uploads in flight per key and 4 in all (429 rate_limited, scope uploads, retry 5 s)", async () => {
    const up = uploader({ idleMs: 5000 });
    const release = [];
    const hanging = (keyId) => {
      let gate;
      const wait = new Promise((resolve) => (gate = resolve));
      release.push(gate);
      const part = { stream: (async function* () { yield PNG.subarray(0, 50); await wait; })() };
      return up.receive(part, opts({ keyId }));
    };
    const running = [hanging(1), hanging(1)];
    await new Promise((r) => setTimeout(r, 30));
    const third = await up.receive(partOf([PNG]), opts({ keyId: 1 })).catch((e) => e);
    assert.equal(third.code, "rate_limited");
    assert.deepEqual(third.params, { scope: "uploads", limit: 2, retryAfterMs: 5000 });
    running.push(hanging(2), hanging(3));
    await new Promise((r) => setTimeout(r, 30));
    const fifth = await up.receive(partOf([PNG]), opts({ keyId: 4 })).catch((e) => e);
    assert.deepEqual([fifth.code, fifth.params.scope, fifth.params.limit], ["rate_limited", "uploads", 4]);
    release.forEach((gate) => gate());
    for (const result of await Promise.all(running)) fs.rmSync(result.path, { force: true });
    const after = await up.receive(partOf([PNG]), opts({ keyId: 1 }));
    fs.rmSync(after.path);
    assert.deepEqual(leftovers(), []);
  });

  test("a pause of 30 s (idleMs) without a byte ends the upload and deletes the file", async () => {
    const part = { stream: (async function* () { yield PNG; await new Promise((r) => setTimeout(r, 2000)); })() };
    const started = Date.now();
    await assert.rejects(uploader({ idleMs: 100 }).receive(part, opts()), (err) => err.code === "bad_request");
    assert.ok(Date.now() - started < 1500);
    assert.deepEqual(leftovers(), []);
  });

  test("pending media bytes plus uploads beyond 2 x MAX_UPLOAD are 503 queue_full, scope disk", async () => {
    const small = { MAX_UPLOAD: 1 };
    const err = await uploader({ config: small }).receive(partOf([PNG]), opts({ pendingBytes: async () => 2 * 1048576 })).catch((e) => e);
    assert.deepEqual([err.code, err.params], ["queue_full", { scope: "disk", retryAfterMs: 5000 }]);
    const during = await uploader({ config: small }).receive(partOf([Buffer.alloc(1048576, 1), Buffer.alloc(1048576, 1), Buffer.alloc(10, 1)]), opts({ maxBytes: 10 * 1048576, kinds: null })).catch((e) => e);
    assert.deepEqual([during.code, during.params.scope], ["queue_full", "disk"], "also while receiving");
    const fine = await uploader({ config: small }).receive(partOf([PNG]), opts({ pendingBytes: async () => 100 }));
    fs.rmSync(fine.path);
    assert.deepEqual(leftovers(), []);
  });

  test("an abort signal ends a blocked reception and removes the file", async () => {
    const controller = new AbortController();
    const part = { stream: (async function* () { yield PNG; await new Promise((r) => setTimeout(r, 5000)); })() };
    const pending = uploader({ idleMs: 10000 }).receive(part, opts({ signal: controller.signal }));
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    await assert.rejects(pending);
    assert.deepEqual(leftovers(), []);
  });

  test("a source that fails midway removes the file", async () => {
    const part = { stream: (async function* () { yield PNG; throw new ApiError("bad_request"); })() };
    await assert.rejects(uploader().receive(part, opts()), (err) => err.code === "bad_request");
    assert.deepEqual(leftovers(), []);
  });
});

/** The bytes of a request up to the start of the file part: the message part is complete, the file never comes */
const headOf = (message) =>
  Buffer.concat([build([{ name: "message", body: message }], { closing: false }), Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="f.png"\r\n\r\n`)]);

// ---- through the pipeline, over HTTP ------------------------------------------------------------------------------------
describe("multipart through the pipeline", () => {
  let kit;
  let uploads;
  before(async () => {
    kit = await createApiKit();
    uploads = path.join(kit.tmp, "tmp", "api");
  });
  after(async () => {
    await kit.close();
  });

  const leftovers = () => (fs.existsSync(uploads) ? fs.readdirSync(uploads) : []);
  const multipart = (parts, boundary = BOUNDARY) => ({ body: build(parts, { boundary }), contentType: `multipart/form-data; boundary=${boundary}` });
  const post = (token, parts, extra = {}) => kit.request("/api/v1/messages", { method: "POST", token, ...multipart(parts), ...extra });
  const imageMessage = (extra = {}) => JSON.stringify({ format: "image", to: "237690000001", caption: "Your receipt", ...extra });
  const imageParts = (file = PNG, message = imageMessage()) => [{ name: "message", body: message }, { name: "file", filename: "r.png", type: "image/png", body: file }];
  const err = (res) => (res.json || {}).error || {};

  test("an image upload: 202, the engine got the staged file (path, size, hash), the temp dir is clean", async () => {
    const { token } = await kit.makeKey({ rights: ["messages.send.image"] });
    const before = kit.engine.calls.length;
    const res = await post(token, imageParts());
    assert.equal(res.status, 202, res.text.slice(0, 200));
    const submit = kit.engine.calls.slice(before).find((c) => c.name === "submit").args[0];
    assert.equal(submit.media.size, PNG.length);
    assert.equal(submit.media.name, "r.png");
    assert.equal(submit.media.sha256, crypto.createHash("sha256").update(PNG).digest("hex"));
    assert.deepEqual(kit.engine.calls.slice(before).map((c) => c.name).filter((n) => n === "inspectMedia"), ["inspectMedia"]);
    assert.deepEqual(leftovers(), [], "moved by the engine (the fake deletes it), nothing left");
  });

  test("a refused upload leaves nothing behind: a type mismatch and an overflow", async () => {
    const { token } = await kit.makeKey({ rights: ["messages.send.image"] });
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(3000, 66)]);
    const mismatch = await post(token, imageParts(pdf));
    assert.deepEqual([mismatch.status, err(mismatch).code, err(mismatch).params], [422, "media_type_mismatch", { expected: ["image"] }]);
    assert.deepEqual(leftovers(), []);

    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024, 9)]);
    const overflow = await post(token, imageParts(big)).catch((e) => ({ status: "socket", error: e }));
    if (overflow.status !== "socket") {
      assert.deepEqual([overflow.status, err(overflow).code, err(overflow).params], [413, "media_too_large", { maxBytes: 1024 * 1024 }]);
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(leftovers(), []);
  });

  test("a declared Content-Length beyond 64 KiB + the file bound + 16 KiB is refused before anything is read", async () => {
    const { token } = await kit.makeKey({ rights: ["messages.send.image"] });
    const res = await new Promise((resolve, reject) => {
      const req = http.request(`${kit.base}/api/v1/messages`, {
        method: "POST",
        agent: false,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`, "Content-Length": String(500 * 1024 * 1024) },
      }, (response) => {
        const chunks = [];
        response.on("data", (c) => chunks.push(c));
        response.on("end", () => resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()), headers: response.headers }));
      });
      req.on("error", reject);
      req.write("--x"); // a few bytes, never the declared 500 MB
    });
    assert.deepEqual([res.status, res.json.error.code, res.headers.connection], [413, "media_too_large", "close"]);
    assert.equal(res.json.error.params.maxBytes, 230 * 1048576 < 100 * 1048576 ? 230 * 1048576 : 100 * 1048576);
  });

  test("the format cap applies once the message part is known: Content-Length above message + cap + 16 KiB", async () => {
    const { token } = await kit.makeKey({ rights: ["messages.send.image"] });
    const res = await new Promise((resolve, reject) => {
      const head = headOf(imageMessage());
      const req = http.request(`${kit.base}/api/v1/messages`, {
        method: "POST",
        agent: false,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`, "Content-Length": String(head.length + 1024 * 1024 + 20 * 1024) },
      }, (response) => {
        const chunks = [];
        response.on("data", (c) => chunks.push(c));
        response.on("end", () => resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.on("error", reject);
      req.write(head);
    });
    assert.deepEqual([res.status, res.json.error.code, res.json.error.params], [413, "media_too_large", { maxBytes: 1024 * 1024 }]);
  });

  test("a message part over 64 KiB is 413 payload_too_large", async () => {
    const { token } = await kit.makeKey({ rights: ["messages.send.image"] });
    const res = await post(token, [{ name: "message", body: imageMessage({ caption: "c".repeat(70000) }) }]);
    assert.deepEqual([res.status, err(res).code, err(res).params], [413, "payload_too_large", { maxBytes: 65536 }]);
  });

  test("file before message is 422 invalid_order; grammar violations are 400; wrong Content-Type kinds are 415", async () => {
    const { token } = await kit.makeKey({ rights: ["messages.send.image"] });
    const order = await post(token, [{ name: "file", filename: "r.png", body: PNG }, { name: "message", body: imageMessage() }]);
    assert.deepEqual([order.status, err(order).fields], [422, { file: { code: "invalid_order" } }]);
    const third = await post(token, [...imageParts(), { name: "extra", body: "x" }]);
    assert.deepEqual([third.status, err(third).code], [400, "bad_request"]);
    const noClose = await kit.request("/api/v1/messages", { method: "POST", token, body: build(imageParts(), { closing: false }), contentType: `multipart/form-data; boundary=${BOUNDARY}` });
    assert.deepEqual([noClose.status, err(noClose).code], [400, "bad_request"]);
    const noBoundary = await kit.request("/api/v1/messages", { method: "POST", token, body: "x", contentType: "multipart/form-data" });
    assert.deepEqual([noBoundary.status, err(noBoundary).code], [400, "bad_request"]);
    const notJson = await post(token, [{ name: "message", body: "{broken" }]);
    assert.deepEqual([notJson.status, err(notJson).code], [400, "bad_request"]);
    assert.deepEqual(leftovers(), []);
  });

  test("the sources: a file on a format without media, a file and media.url together, neither", async () => {
    const { token } = await kit.makeKey({ rights: ["messages.send.text", "messages.send.image", "media.url"] });
    const text = await post(token, [{ name: "message", body: JSON.stringify({ format: "text", to: "237690000001", text: "hi" }) }, { name: "file", filename: "r.png", body: PNG }]);
    assert.deepEqual([text.status, err(text).fields], [422, { file: { code: "not_allowed" } }]);
    const both = await post(token, imageParts(PNG, imageMessage({ media: { url: "https://files.example.com/a.png" } })));
    assert.deepEqual([both.status, err(both).fields], [422, { media: { code: "not_allowed" } }]);
    const neither = await post(token, [{ name: "message", body: imageMessage() }]);
    assert.deepEqual([neither.status, err(neither).fields], [422, { media: { code: "required" } }]);
    assert.deepEqual(leftovers(), []);
  });

  test("the right and the policy are judged before the file is read: a forbidden upload is refused at once", async () => {
    const { token } = await kit.makeKey({ rights: ["messages.send.text"] });
    const res = await new Promise((resolve, reject) => {
      const req = http.request(`${kit.base}/api/v1/messages`, {
        method: "POST",
        agent: false,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/form-data; boundary=${BOUNDARY}` },
      }, (response) => {
        const chunks = [];
        response.on("data", (c) => chunks.push(c));
        response.on("end", () => resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.on("error", reject);
      req.write(headOf(imageMessage()));
    });
    assert.deepEqual([res.status, res.json.error.code, res.json.error.params], [403, "forbidden", { right: "messages.send.image" }]);
  });

  test("a multipart replay is found after the upload: same key and file = replay, another file = 409, quota check skipped", async () => {
    const { token } = await kit.makeKey({ rights: ["messages.send.image"], limitPerMinute: 1 });
    const headers = { "Idempotency-Key": "upload-1" };
    const first = await post(token, imageParts(), { headers });
    assert.equal(first.status, 202);
    const admissions = kit.engine.count("checkAdmission");
    const replay = await post(token, imageParts(), { headers });
    assert.equal(replay.status, 202, "the minute quota (1) is used up, a replay still passes");
    assert.equal(replay.headers["idempotent-replayed"], "true");
    assert.equal(replay.json.message.id, first.json.message.id);
    assert.equal(kit.engine.count("checkAdmission"), admissions, "step 16 was skipped for a known key");
    const other = await post(token, imageParts(Buffer.concat([PNG, Buffer.from("different")])), { headers });
    assert.deepEqual([other.status, err(other).code], [409, "idempotency_conflict"]);
    assert.deepEqual(leftovers(), [], "the files of the replay and the conflict were deleted");
  });

  test("the filename and the declared type of the file part are not part of the fingerprint", async () => {
    const { token } = await kit.makeKey({ rights: ["messages.send.image"] });
    const headers = { "Idempotency-Key": "upload-2" };
    const first = await post(token, imageParts(), { headers });
    const renamed = await post(token, [{ name: "message", body: imageMessage() }, { name: "file", filename: "another-name.bin", type: "application/octet-stream", body: PNG }], { headers });
    assert.equal(renamed.status, 202);
    assert.equal(renamed.headers["idempotent-replayed"], "true");
    assert.equal(renamed.json.message.id, first.json.message.id);
  });

  test("a failure after the upload (reserve refused) deletes the file", async () => {
    const { token } = await kit.makeKey({ rights: ["messages.send.image"], limitPerMinute: 1 });
    assert.equal((await post(token, imageParts())).status, 202);
    const limited = await post(token, imageParts());
    assert.equal(err(limited).code, "rate_limited", "refused at the early check, before the upload");
    assert.deepEqual(leftovers(), []);
  });
});

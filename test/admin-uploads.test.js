"use strict";
/**
 * Raw uploads (admin-http-api.md sections 1.7 and 2.12, UP-1 and UP-2): Content-Length rules, caps, quota, one
 * upload in flight per session, content sniffing, file mode, the janitor with a fake clock, ownership, and the
 * consume() helper used by the backup and broadcast services.
 *
 * Real HTTP on 127.0.0.1:0, the authentication stubbed, temporary directories only.
 */

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { createUploads, TTL_MS, JANITOR_MS } = require("../lib/admin/http/uploads");
const { startStubAdmin } = require("./helpers/adminStub");
const { createClock } = require("./helpers/fakeClock");

const CAP = 1000; // bytes: the live MAX_UPLOAD, tiny for the tests
const MAGIC = "OWBBACKUP\n";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x1a, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(18)]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
const ZIP = Buffer.from("504b0506000000000000000000000000000000000000", "hex");
const GIF = Buffer.from("GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;", "latin1");
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(56)]);

describe("uploads", () => {
  let t;
  let clock;
  let uploads;
  let dir;
  let uploadDir;

  const files = () => (fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir).sort() : []);

  /** PUT /admin/api/uploads with a fully valid guard; `body` is a Buffer or a string. */
  function put({ query = "purpose=broadcast", body, headers = {}, name = "good", length, chunks } = {}) {
    const base = t.session(name).headers;
    const merged = { ...base, "Content-Type": "application/octet-stream", ...headers };
    const size = length !== undefined ? length : body === undefined ? undefined : Buffer.byteLength(body);
    if (size !== undefined) merged["Content-Length"] = size;
    for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key];
    return t.raw({ method: "PUT", path: `/admin/api/uploads?${query}`, headers: merged, body, chunks });
  }

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-uploads-test-"));
    uploadDir = path.join(dir, "admin-uploads");
    clock = createClock(Date.now());
    uploads = createUploads({ dir: uploadDir, now: clock.now, timers: clock.timers, maxBytes: () => CAP });
    t = await startStubAdmin({ clock, timers: clock.timers, uploads, dataDir: dir });
    t.auth.addSession("other");
  });

  after(async () => {
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // a clean slate: drop every upload and file left by the previous test
    await clock.advance(TTL_MS + 1000);
    await uploads.sweep();
    for (const name of files()) fs.rmSync(path.join(uploadDir, name), { force: true });
  });

  test("the directory is created by the first upload, not before", async () => {
    fs.rmSync(uploadDir, { recursive: true, force: true });
    assert.equal(fs.existsSync(uploadDir), false);
    const res = await put({ query: "purpose=backup", body: `${MAGIC}data` });
    assert.equal(res.status, 201);
    assert.equal(fs.statSync(uploadDir).mode & 0o777, 0o700);
  });

  test("a backup is streamed to disk, stored with mode 0600 and answered with 201 and its metadata", async () => {
    const body = `${MAGIC}${"x".repeat(100)}`;
    const res = await put({ query: "purpose=backup&name=my%20backup.owb", body });
    assert.equal(res.status, 201);
    const { uploadId, purpose, kind, mime, size, name, expiresAt } = res.json;
    assert.match(uploadId, /^[0-9a-f]{32}$/);
    assert.deepEqual({ purpose, kind, mime, size, name }, {
      purpose: "backup",
      kind: "backup",
      mime: "application/octet-stream",
      size: Buffer.byteLength(body),
      name: "my backup.owb",
    });
    assert.equal(Date.parse(expiresAt), clock.now() + TTL_MS);

    assert.deepEqual(files(), [`${uploadId}.dat`], "renamed on success: no .part left");
    const file = path.join(uploadDir, `${uploadId}.dat`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(file, "utf8"), body);
    assert.equal(res.headers["cache-control"], "no-store");
  });

  test("the content is sniffed, not trusted: allowed image and document types for a broadcast", async () => {
    const cases = [
      [PNG, "image", "image/png"],
      [JPEG, "image", "image/jpeg"],
      [WEBP, "image", "image/webp"],
      [PDF, "document", "application/pdf"],
      [ZIP, "document", "application/zip"],
      [Buffer.from("hello, world\nline 2\n"), "document", "text/plain"],
    ];
    for (const [buffer, kind, mime] of cases) {
      const res = await put({ query: "purpose=broadcast&name=file.bin", body: buffer });
      assert.equal(res.status, 201, mime);
      assert.equal(res.json.kind, kind, mime);
      assert.equal(res.json.mime, mime);
    }
    const csv = await put({ query: "purpose=broadcast&name=table.CSV", body: Buffer.from("a,b\n1,2\n") });
    assert.equal(csv.json.mime, "text/csv");
  });

  test("anything else is 422 unsupported_file_type and leaves no file: executables, GIF, binary, empty, wrong purpose", async () => {
    const rejected = [
      ["purpose=broadcast", ELF],
      ["purpose=broadcast", GIF],
      ["purpose=broadcast", Buffer.concat([Buffer.from("text then"), Buffer.from([0, 1, 2]), Buffer.from("binary")])],
      ["purpose=broadcast", Buffer.alloc(0)],
      ["purpose=backup", PNG],
      ["purpose=backup", Buffer.from("OWBBACKUP")], // magic without the newline
      ["purpose=backup", Buffer.from("owbbackup\nlower case")],
      ["purpose=backup", Buffer.alloc(0)],
    ];
    for (const [query, buffer] of rejected) {
      const res = await put({ query, body: buffer });
      assert.equal(res.status, 422, `${query} ${buffer.subarray(0, 8).toString("hex")}`);
      assert.equal(res.json.error.code, "unsupported_file_type");
    }
    assert.deepEqual(files(), []);
    assert.equal(uploads.pendingBytes(), 0);
  });

  test("the type is never taken from a header: a lying Content-Type or name changes nothing", async () => {
    const res = await put({ query: "purpose=broadcast&name=photo.png", body: ELF });
    assert.equal(res.status, 422);
    const ok = await put({ query: "purpose=broadcast&name=photo.exe", body: PNG });
    assert.equal(ok.json.mime, "image/png");
  });

  test("411 without Content-Length (chunked), checked before anything is stored", async () => {
    const res = await put({ headers: { "Transfer-Encoding": "chunked" }, chunks: [PNG.subarray(0, 20), PNG.subarray(20)] });
    assert.equal(res.status, 411);
    assert.equal(res.json.error.code, "length_required");
    assert.deepEqual(files(), []);
  });

  test("413 over the cap, decided from Content-Length alone (the body is not read)", async () => {
    const res = await put({ body: Buffer.alloc(CAP + 1, 0x61) });
    assert.equal(res.status, 413);
    assert.equal(res.json.error.code, "payload_too_large");
    assert.deepEqual(res.json.error.params, { maxBytes: CAP });
    assert.deepEqual(files(), []);
    const exact = await put({ body: Buffer.alloc(CAP, 0x61) });
    assert.equal(exact.status, 201, "exactly the cap is fine");
  });

  test("507 over the pending quota of twice the cap; consuming or deleting frees it", async () => {
    const big = Buffer.alloc(900, 0x61);
    const first = await put({ body: big });
    const second = await put({ body: big });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(uploads.pendingBytes(), 1800);
    const third = await put({ body: Buffer.alloc(300, 0x61) });
    assert.equal(third.status, 507);
    assert.equal(third.json.error.code, "quota_exceeded");
    assert.deepEqual(files().length, 2);

    const del = await t.send("DELETE", `/admin/api/uploads/${first.json.uploadId}`, { headers: { "Content-Type": "application/json" } });
    assert.equal(del.status, 200);
    assert.equal((await put({ body: Buffer.alloc(300, 0x61) })).status, 201);
  });

  test("409 upload_in_progress for a second upload of the same session; other sessions are not blocked", async () => {
    const session = t.session().headers;
    const first = http.request({
      host: "127.0.0.1",
      port: t.port,
      method: "PUT",
      path: "/admin/api/uploads?purpose=broadcast",
      headers: { ...session, "Content-Type": "application/octet-stream", "Content-Length": 200 },
      agent: false,
    });
    const finished = new Promise((resolve, reject) => {
      first.on("response", (res) => {
        const parts = [];
        res.on("data", (c) => parts.push(c));
        res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(parts).toString()) }));
      });
      first.on("error", reject);
    });
    first.write(PNG); // 67 of the 200 declared bytes
    assert.ok(await fakes.waitFor(() => files().some((f) => f.endsWith(".part"))), "the first upload is streaming to a .part file");

    const second = await put({ body: PNG });
    assert.equal(second.status, 409);
    assert.equal(second.json.error.code, "upload_in_progress");
    const otherSession = await put({ body: PNG, name: "other" });
    assert.equal(otherSession.status, 201, "another session uploads in parallel");

    first.end(Buffer.alloc(200 - PNG.length, 0x20));
    const done = await finished;
    assert.equal(done.status, 201);
    assert.equal((await put({ body: PNG })).status, 201, "free again");
  });

  test("a client that goes away mid-upload leaves no .part file and frees the slot", async () => {
    const session = t.session().headers;
    const req = http.request({
      host: "127.0.0.1",
      port: t.port,
      method: "PUT",
      path: "/admin/api/uploads?purpose=broadcast",
      headers: { ...session, "Content-Type": "application/octet-stream", "Content-Length": 500 },
      agent: false,
    });
    req.on("error", () => {});
    req.write(Buffer.alloc(100, 0x61));
    assert.ok(await fakes.waitFor(() => files().some((f) => f.endsWith(".part"))));
    req.destroy();
    assert.ok(await fakes.waitFor(() => files().length === 0), "the partial file is removed");
    assert.equal((await put({ body: PNG })).status, 201, "the session is free again");
  });

  test("the query is validated: purpose is required and one of backup|broadcast; the name is display metadata only", async () => {
    const missing = await put({ query: "name=x", body: PNG });
    assert.equal(missing.status, 422);
    assert.deepEqual(missing.json.error.fields, { purpose: { code: "required" } });
    const other = await put({ query: "purpose=avatar", body: PNG });
    assert.deepEqual(other.json.error.fields, { purpose: { code: "not_allowed", params: { allowed: ["backup", "broadcast"] } } });

    const nasty = await put({ query: `purpose=broadcast&name=${encodeURIComponent("../../etc/pass\nwd\u0000" + "n".repeat(200))}`, body: PNG });
    assert.equal(nasty.status, 201);
    assert.ok(nasty.json.name.length <= 120);
    assert.ok(!/[\u0000-\u001f]/.test(nasty.json.name));
    assert.deepEqual(files(), [`${nasty.json.uploadId}.dat`], "the name never reaches the file system");
  });

  test("the unsafe-request guard applies: octet-stream only, CSRF token and Origin required, GET is 405", async () => {
    assert.equal((await put({ body: PNG, headers: { "Content-Type": "application/json" } })).status, 415);
    assert.equal((await put({ body: PNG, headers: { "Content-Type": null } })).status, 415);
    assert.equal((await put({ body: PNG, headers: { "X-CSRF-Token": "nope" } })).status, 403);
    assert.equal((await put({ body: PNG, headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await t.raw({ method: "PUT", path: "/admin/api/uploads?purpose=broadcast", headers: { "Content-Length": 1 }, body: "x" })).status, 401);
    assert.equal((await t.get("/admin/api/uploads")).status, 405);
    assert.deepEqual(files(), []);
  });

  test("DELETE removes your own upload; a foreign, unknown or malformed id is 404", async () => {
    const mine = await put({ body: PNG });
    const theirs = await put({ body: PNG, name: "other" });
    const json = { "Content-Type": "application/json" };

    const foreign = await t.send("DELETE", `/admin/api/uploads/${theirs.json.uploadId}`, { headers: json });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.json.error.code, "not_found");
    assert.equal(files().length, 2, "a foreign upload is untouched");

    for (const id of ["0".repeat(32), "123", "../../x", "A".repeat(32)]) {
      assert.equal((await t.send("DELETE", `/admin/api/uploads/${id}`, { headers: json })).status, 404, id);
    }
    const own = await t.send("DELETE", `/admin/api/uploads/${mine.json.uploadId}`, { headers: json });
    assert.equal(own.status, 200);
    assert.deepEqual(own.json, { deleted: true });
    assert.deepEqual(files(), [`${theirs.json.uploadId}.dat`]);
    assert.equal((await t.send("DELETE", `/admin/api/uploads/${mine.json.uploadId}`, { headers: json })).status, 404, "already gone");
    const confirmNeeded = await t.send("DELETE", `/admin/api/uploads/${theirs.json.uploadId}`, { name: "other", headers: json });
    assert.equal(confirmNeeded.status, 200);
  });

  test("peek() reads without consuming; ownership and purpose are checked", async () => {
    const res = await put({ body: PNG });
    const id = res.json.uploadId;
    const record = uploads.peek(id, "session-good", { purpose: "broadcast" });
    assert.equal(record.id, id);
    assert.equal(record.kind, "image");
    assert.equal(record.path, path.join(uploadDir, `${id}.dat`));
    assert.equal(uploads.peek(id, "session-other"), null, "another session");
    assert.equal(uploads.peek(id, "session-good", { purpose: "backup" }), null, "another purpose");
    assert.equal(uploads.peek("f".repeat(32), "session-good"), null);
    assert.equal(files().length, 1);
  });

  test("consume() takes the upload out of the registry and removes its file", async () => {
    const res = await put({ body: PNG });
    const id = res.json.uploadId;
    assert.equal(await uploads.consume(id, "session-other"), null, "a foreign session cannot consume it");
    assert.equal(await uploads.consume(id, "session-good", { purpose: "backup" }), null);
    assert.equal(files().length, 1);

    const record = await uploads.consume(id, "session-good", { purpose: "broadcast" });
    assert.equal(record.id, id);
    assert.deepEqual(files(), [], "consume() removes the file");
    assert.equal(await uploads.consume(id, "session-good"), null, "only once");
    assert.equal(uploads.peek(id, "session-good"), null);
    assert.equal(uploads.pendingBytes(), 0);
  });

  test("consume(id, session, fn): the file is there while fn runs and gone afterwards, also when fn throws or moves it", async () => {
    const a = await put({ body: PNG });
    let seen;
    await uploads.consume(a.json.uploadId, "session-good", async (record) => {
      seen = fs.readFileSync(record.path);
    });
    assert.deepEqual(seen, PNG);
    assert.deepEqual(files(), []);

    const b = await put({ body: PNG });
    await assert.rejects(
      uploads.consume(b.json.uploadId, "session-good", () => {
        throw new Error("service failed");
      }),
      /service failed/,
    );
    assert.deepEqual(files(), [], "the file is removed even when the service fails");

    const c = await put({ body: PNG });
    const moved = path.join(dir, "moved.bin");
    await uploads.consume(c.json.uploadId, "session-good", (record) => fs.renameSync(record.path, moved));
    assert.deepEqual(files(), []);
    assert.deepEqual(fs.readFileSync(moved), PNG, "a service may keep the file by moving it");
    fs.rmSync(moved);
  });

  test("an upload lives one hour: after that it is unknown and its file is removed by the janitor", async () => {
    const res = await put({ body: PNG });
    const id = res.json.uploadId;
    await clock.advance(TTL_MS - 1000);
    assert.notEqual(uploads.peek(id, "session-good"), null);
    await clock.advance(2000);
    assert.equal(uploads.peek(id, "session-good"), null, "expired uploads cannot be used even before the sweep runs");
    assert.equal((await t.send("DELETE", `/admin/api/uploads/${id}`, { headers: { "Content-Type": "application/json" } })).status, 404);
    assert.equal(await uploads.consume(id, "session-good"), null);
    assert.equal(await uploads.sweep(), 1);
    assert.deepEqual(files(), []);
  });

  test("start() arms an unref'd janitor (every 5 minutes) that removes expired uploads and old leftovers; stop() clears it", async () => {
    const res = await put({ body: PNG });
    const leftover = path.join(uploadDir, `${"a".repeat(32)}.dat`);
    const recent = path.join(uploadDir, `${"b".repeat(32)}.dat`);
    const unrelated = path.join(uploadDir, "notes.txt");
    fs.writeFileSync(leftover, "left by an earlier process");
    fs.writeFileSync(recent, "recent");
    fs.writeFileSync(unrelated, "not ours");
    // file times are real; the fake clock has moved on, so write them relative to the fake clock
    const old = new Date(clock.now() - 2 * TTL_MS);
    const fresh = new Date(clock.now());
    fs.utimesSync(leftover, old, old);
    fs.utimesSync(recent, fresh, fresh);

    const before = clock.pending();
    uploads.start();
    uploads.start(); // idempotent
    assert.equal(clock.pending(), before + 1);
    assert.equal(uploads.janitorArmed(), true);
    await fakes.waitFor(() => !fs.existsSync(leftover));
    assert.ok(fs.existsSync(recent), "a recent leftover may belong to a running upload");
    assert.ok(fs.existsSync(unrelated), "files that are not ours are never touched");

    await clock.advance(TTL_MS + JANITOR_MS);
    assert.ok(await fakes.waitFor(() => !files().includes(`${res.json.uploadId}.dat`)), "the expired upload is swept by the timer");
    uploads.stop();
    assert.equal(uploads.janitorArmed(), false);
    assert.equal(clock.pending(), before);
    fs.rmSync(unrelated);
  });
});

"use strict";

/**
 * lib/utils/secretBox.js (contracts/runtime.md section 2): AES-256-GCM tokens, the key file, and the
 * failure codes. Every test works in its own temporary directory.
 */

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createSecretBox, SecretBoxError } = require("../lib/utils/secretBox");

let root;
let dir; // the "data" directory: it does not exist yet
let box;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-secretbox-"));
  dir = path.join(root, "data");
  box = createSecretBox({ dir });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const keyFile = () => path.join(dir, "panel.key");
const mode = (file) => fs.statSync(file).mode & 0o777;

describe("encrypt / decrypt", () => {
  test("round trip with a context; the token has the documented shape", () => {
    const token = box.encrypt("sk-secret-value-123", "setting:OPENAI_API_KEY");
    assert.match(token, /^enc:v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]*$/);
    const [, , iv, tag] = token.split(":");
    assert.equal(Buffer.from(iv, "base64url").length, 12);
    assert.equal(Buffer.from(tag, "base64url").length, 16);
    assert.equal(box.isEncrypted(token), true);
    assert.equal(token.includes("sk-secret-value-123"), false);
    assert.deepEqual(box.decrypt(token, "setting:OPENAI_API_KEY"), { ok: true, value: "sk-secret-value-123" });
  });

  test("two encryptions of one value differ (random IV); unicode survives", () => {
    const a = box.encrypt("clé-ünïcode-✓", "c");
    const b = box.encrypt("clé-ünïcode-✓", "c");
    assert.notEqual(a, b);
    assert.equal(box.decrypt(b, "c").value, "clé-ünïcode-✓");
  });

  test("an empty plain text round-trips", () => {
    assert.equal(box.decrypt(box.encrypt("", "c"), "c").value, "");
  });

  test("a ciphertext copied to another context fails with auth_failed", () => {
    const token = box.encrypt("value-for-key-a", "setting:KEY_A");
    assert.deepEqual(box.decrypt(token, "setting:KEY_B"), { ok: false, code: "auth_failed" });
  });

  test("a tampered token fails with auth_failed", () => {
    const token = box.encrypt("value-to-protect", "ctx");
    const [prefix, version, iv, tag, body] = token.split(":");
    const flipped = Buffer.from(body, "base64url");
    flipped[0] ^= 0xff;
    const tamperedBody = [prefix, version, iv, tag, flipped.toString("base64url")].join(":");
    assert.deepEqual(box.decrypt(tamperedBody, "ctx"), { ok: false, code: "auth_failed" });

    const badTag = Buffer.from(tag, "base64url");
    badTag[0] ^= 0xff;
    const tamperedTag = [prefix, version, iv, badTag.toString("base64url"), body].join(":");
    assert.deepEqual(box.decrypt(tamperedTag, "ctx"), { ok: false, code: "auth_failed" });
  });

  test("malformed and unsupported tokens", () => {
    for (const bad of ["", "plain", "enc:", "enc:v1:", "enc:v1:aa:bb", "enc:v1:a:b:c:d", "enc:v1:!!:??:##", null, undefined, 42]) {
      assert.deepEqual(box.decrypt(bad, "c"), { ok: false, code: "malformed" }, String(bad));
    }
    assert.deepEqual(box.decrypt("enc:v2:aaaa:bbbb:cccc", "c"), { ok: false, code: "unsupported_version" });
    assert.equal(box.isEncrypted("enc:v9:x"), true);
    assert.equal(box.isEncrypted("plain"), false);
    assert.equal(box.isEncrypted(undefined), false);
  });

  test("the context is part of the authentication even when undefined", () => {
    const token = box.encrypt("value-without-context");
    assert.equal(box.decrypt(token).value, "value-without-context");
    assert.equal(box.decrypt(token, "other").ok, false);
  });
});

describe("key file", () => {
  test("nothing is created before the first encrypt; decrypt never creates a key", () => {
    assert.equal(fs.existsSync(dir), false);
    assert.deepEqual(box.status(), { keyPresent: false, keyValid: false });
    assert.deepEqual(box.decrypt("enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AA", "c"), { ok: false, code: "key_missing" });
    assert.equal(fs.existsSync(dir), false);
    assert.equal(fs.existsSync(keyFile()), false);
  });

  test("the first encrypt creates data/ (0700) and panel.key (32 bytes, 0600)", () => {
    box.encrypt("first-secret-value", "c");
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(keyFile()), 0o600);
    assert.equal(fs.readFileSync(keyFile()).length, 32);
    assert.deepEqual(box.status(), { keyPresent: true, keyValid: true });
    // no temporary file is left behind
    assert.deepEqual(fs.readdirSync(dir), ["panel.key"]);
  });

  test("an existing data directory keeps its mode; an existing key is never overwritten", () => {
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    box.encrypt("one-secret-value", "c");
    assert.equal(mode(dir), 0o755);
    const before = fs.readFileSync(keyFile());
    const token = box.encrypt("two-secret-value", "c");
    assert.deepEqual(fs.readFileSync(keyFile()), before);
    // a second box on the same directory reads the same key
    assert.equal(createSecretBox({ dir }).decrypt(token, "c").value, "two-secret-value");
  });

  test("a lost key is not regenerated by decrypt: key_missing", () => {
    const token = box.encrypt("value-to-lose", "c");
    fs.unlinkSync(keyFile());
    assert.deepEqual(box.decrypt(token, "c"), { ok: false, code: "key_missing" });
    assert.equal(fs.existsSync(keyFile()), false);
    assert.deepEqual(box.status(), { keyPresent: false, keyValid: false });
  });

  test("another key fails the authentication of an old token", () => {
    const token = box.encrypt("value-of-key-one", "c");
    fs.writeFileSync(keyFile(), Buffer.alloc(32, 7), { mode: 0o600 });
    assert.deepEqual(box.decrypt(token, "c"), { ok: false, code: "auth_failed" });
  });

  test("an invalid key file: decrypt says key_invalid, encrypt renames it and creates a new key", () => {
    const token = box.encrypt("value-of-old-key", "c");
    fs.writeFileSync(keyFile(), Buffer.from("too short"));
    assert.deepEqual(box.status(), { keyPresent: true, keyValid: false });
    assert.deepEqual(box.decrypt(token, "c"), { ok: false, code: "key_invalid" });
    assert.equal(fs.readFileSync(keyFile()).toString(), "too short"); // decrypt left it alone

    const fresh = box.encrypt("value-of-new-key", "c");
    const names = fs.readdirSync(dir).sort();
    assert.equal(names.length, 2);
    assert.ok(names.some((name) => /^panel\.key\.invalid-\d+$/.test(name)), names.join(","));
    assert.equal(fs.readFileSync(keyFile()).length, 32);
    assert.equal(box.decrypt(fresh, "c").value, "value-of-new-key");
    assert.equal(mode(keyFile()), 0o600);
    // the old token cannot be read with the new key
    assert.equal(box.decrypt(token, "c").ok, false);
  });

  test("concurrent first encrypt calls create exactly one key", async () => {
    const boxes = [box, createSecretBox({ dir }), createSecretBox({ dir })];
    const tokens = await Promise.all(
      Array.from({ length: 30 }, (_, i) => Promise.resolve().then(() => boxes[i % 3].encrypt(`secret-number-${i}`, "c"))),
    );
    assert.deepEqual(fs.readdirSync(dir), ["panel.key"]);
    tokens.forEach((token, i) => assert.equal(box.decrypt(token, "c").value, `secret-number-${i}`));
  });

  test("two creators racing for the key: the loser uses the winner's key", () => {
    // the exclusive link keeps a second creator from replacing a key that appeared meanwhile
    const winner = Buffer.alloc(32, 9);
    const racing = createSecretBox({
      dir,
      fs: {
        ...fs,
        // the key shows up between "missing" and the link
        linkSync(from, to) {
          fs.writeFileSync(to, winner, { mode: 0o600 });
          return fs.linkSync(from, to);
        },
      },
    });
    const token = racing.encrypt("raced-secret-value", "c");
    assert.deepEqual(fs.readFileSync(keyFile()), winner);
    assert.deepEqual(fs.readdirSync(dir), ["panel.key"]);
    assert.equal(createSecretBox({ dir }).decrypt(token, "c").value, "raced-secret-value");
  });

  test("a directory that cannot be written: SecretBoxError key_unavailable", () => {
    fs.writeFileSync(path.join(root, "data"), "i am a file, not a directory");
    assert.throws(
      () => box.encrypt("nowhere-to-store", "c"),
      (error) => error instanceof SecretBoxError && error.code === "key_unavailable" && !/nowhere-to-store/.test(error.message),
    );
    assert.equal(box.status().keyPresent, false);
  });

  test("configure({ dir }) moves the box", () => {
    const other = path.join(root, "elsewhere");
    box.configure({ dir: other });
    box.encrypt("moved-secret-value", "c");
    assert.equal(fs.existsSync(path.join(other, "panel.key")), true);
    assert.equal(fs.existsSync(dir), false);
  });
});

describe("status()", () => {
  test("leaks no byte and no path", () => {
    box.encrypt("some-secret-value", "c");
    const key = fs.readFileSync(keyFile());
    const status = box.status();
    assert.deepEqual(Object.keys(status).sort(), ["keyPresent", "keyValid"]);
    const text = JSON.stringify(status);
    assert.equal(text.includes(root), false);
    assert.equal(text.includes(key.toString("hex")), false);
    assert.equal(text.includes(key.toString("base64")), false);
    for (const value of Object.values(status)) assert.equal(typeof value, "boolean");
  });

  test("an error carries a code, never key material or a path", () => {
    fs.mkdirSync(dir);
    fs.mkdirSync(keyFile()); // a directory where the key file should be
    let caught;
    try {
      box.encrypt("secret-that-fails", "c");
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof SecretBoxError);
    assert.equal(caught.code, "key_unavailable");
    assert.equal(caught.message.includes(root), false);
    assert.equal(caught.message.includes("secret-that-fails"), false);
    assert.deepEqual(box.status(), { keyPresent: true, keyValid: false });
  });
});

"use strict";
/**
 * Feature 004 (messaging API): media inspection and staging
 * (specs/004-messaging-api/contracts/runtime.md section 10; RT-100, RT-101).
 * `sniff` decides by the bytes (never the declared type or extension); `stage` keeps every staged file inside
 * data/api-media/<publicId>/ and refuses a malformed id BEFORE any path is built.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const fakes = require("./helpers/fakes");

const config = fakes.setupEnv({ sudo: "111" });

const sniff = require("../lib/messaging/sniff");
const stage = require("../lib/messaging/stage");
const { MessagingError } = require("../lib/messaging/errors");
const { LIMITS } = require("../lib/messaging/limits");

const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-media-"));
const samples = path.join(root, "samples");
const ID = "msg_" + "A".repeat(22);
const ID2 = "msg_" + "B_-".repeat(7) + "B";

after(() => fs.rmSync(root, { recursive: true, force: true }));

// ---------------------------------------------------------------------------------------------------------
// Generated samples: magic bytes by hand, real encodes through sharp and ffmpeg
// ---------------------------------------------------------------------------------------------------------

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const GIF_1X1 = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
const ZIP = Buffer.from("504b03040a0000000000000000000000000000000000000000000000", "hex");
const ELF = Buffer.concat([Buffer.from("7f454c46020101000000000000000000", "hex"), Buffer.alloc(64)]);
const PE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(128)]);

function ffmpeg(args) {
  return spawnSync("ffmpeg", ["-y", "-nostdin", "-loglevel", "error", ...args], { stdio: "ignore" }).status === 0;
}

const files = {};

before(async () => {
  fs.mkdirSync(samples, { recursive: true });
  const put = (name, buffer) => {
    files[name] = path.join(samples, name);
    fs.writeFileSync(files[name], buffer);
  };
  put("a.png", PNG_1X1);
  put("a.gif", GIF_1X1);
  put("a.pdf", PDF);
  put("a.zip", ZIP);
  put("a.elf", ELF);
  put("a.exe", PE);
  put("a.txt", "Hello, a plain text file\nwith two lines — and an accent.\n");
  put("a.csv", "name,phone\nAwa,237690000001\n");
  put("noext", "just text without any extension\n");
  put("script.sh", "#!/bin/sh\necho hi\n");
  put("binary.bin", Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]));
  put("empty", Buffer.alloc(0));
  put("latin1.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])); // not UTF-8
  const sharp = require("sharp");
  const base = { create: { width: 16, height: 16, channels: 3, background: { r: 200, g: 20, b: 20 } } };
  put("a.jpg", await sharp(base).jpeg().toBuffer());
  put("a.webp", await sharp(base).webp().toBuffer());
  if (HAS_FFMPEG) {
    const tone = ["-f", "lavfi", "-i", "sine=frequency=440:duration=1"];
    const picture = ["-f", "lavfi", "-i", "testsrc=duration=1:size=64x48:rate=5"];
    const make = (name, args) => {
      if (ffmpeg([...args, path.join(samples, name)])) files[name] = path.join(samples, name);
    };
    make("a.mp3", [...tone]);
    make("a.ogg", [...tone, "-c:a", "libopus"]);
    make("a.vorbis.ogg", [...tone, "-c:a", "libvorbis"]);
    make("a.m4a", [...tone, "-c:a", "aac"]);
    make("a.wav", [...tone]);
    make("a.flac", [...tone]);
    make("a.aac", [...tone, "-c:a", "aac", "-f", "adts"]);
    make("a.amr", [...tone, "-ar", "8000", "-ac", "1", "-c:a", "libopencore_amrnb"]);
    make("a.webm", [...tone, "-c:a", "libopus"]);
    make("a.mp4", [...picture, "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
    make("a.mov", [...picture, "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
    make("a.3gp", [...picture, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "3gp"]);
  }
});

const need = (name) => (files[name] ? false : `ffmpeg sample ${name} not generated`);

// ---------------------------------------------------------------------------------------------------------
// sniff
// ---------------------------------------------------------------------------------------------------------

describe("sniff.KINDS", () => {
  test("the six kinds and their mimes", () => {
    assert.deepEqual(Object.keys(sniff.KINDS).sort(), ["animated", "audio", "audio_or_container", "document", "image", "video"]);
    assert.deepEqual([...sniff.KINDS.image].sort(), ["image/jpeg", "image/png", "image/webp"]);
    assert.deepEqual([...sniff.KINDS.animated], ["image/gif"]);
    for (const mime of ["video/mp4", "video/quicktime", "video/3gpp"]) assert.ok(sniff.KINDS.video.has(mime), mime);
    for (const mime of ["audio/mpeg", "audio/ogg", "audio/ogg; codecs=opus", "audio/x-m4a", "audio/wav", "audio/flac", "audio/aac", "audio/amr"]) {
      assert.ok(sniff.KINDS.audio.has(mime), mime);
      assert.ok(sniff.KINDS.audio_or_container.has(mime), mime);
    }
    assert.ok(!sniff.KINDS.audio.has("video/webm"), "WebM is refused as an audio file");
    assert.ok(sniff.KINDS.audio_or_container.has("video/webm"));
    assert.ok(sniff.KINDS.audio_or_container.has("video/mp4"));
  });

  test("document: the broadcast whitelist plus plain text and CSV; never an executable", () => {
    for (const mime of [
      "application/pdf",
      "application/zip",
      "application/x-cfb",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.oasis.opendocument.text",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/vnd.oasis.opendocument.presentation",
      "text/plain",
      "text/csv",
    ]) {
      assert.ok(sniff.KINDS.document.has(mime), mime);
    }
    for (const mime of ["application/x-msdownload", "application/x-elf", "application/x-sh", "application/x-executable", "text/html", "application/javascript", "image/svg+xml"]) {
      assert.ok(!sniff.KINDS.document.has(mime), mime);
    }
  });
});

describe("sniff.classifyHead and classify: the bytes decide", () => {
  test("images and animated", async () => {
    assert.deepEqual((await sniff.classifyHead(fs.readFileSync(files["a.png"]))).mime, "image/png");
    assert.deepEqual((await sniff.classifyHead(fs.readFileSync(files["a.jpg"]))).mime, "image/jpeg");
    assert.deepEqual((await sniff.classifyHead(fs.readFileSync(files["a.webp"]))).mime, "image/webp");
    assert.deepEqual((await sniff.classifyHead(fs.readFileSync(files["a.gif"]))).mime, "image/gif");
    assert.deepEqual(await sniff.classify(files["a.png"], { name: "a.png" }), { mime: "image/png", ext: "png" });
    assert.equal((await sniff.classify(files["a.jpg"], {})).mime, "image/jpeg");
    assert.equal((await sniff.classify(files["a.gif"], {})).mime, "image/gif");
  });

  test("documents by content: PDF, ZIP, text, CSV", async () => {
    assert.equal((await sniff.classify(files["a.pdf"], {})).mime, "application/pdf");
    assert.equal((await sniff.classify(files["a.zip"], {})).mime, "application/zip");
    assert.deepEqual(await sniff.classify(files["a.txt"], { name: "a.txt" }), { mime: "text/plain", ext: "txt" });
    assert.deepEqual(await sniff.classify(files["noext"], { name: "noext" }), { mime: "text/plain", ext: "txt" });
    assert.deepEqual(await sniff.classify(files["a.csv"], { name: "report.csv" }), { mime: "text/csv", ext: "csv" });
    assert.equal((await sniff.classify(files["a.csv"], { name: "report.txt" })).mime, "text/plain", "only the name tells a CSV from a text");
    assert.equal((await sniff.classifyHead(fs.readFileSync(files["a.txt"]))).mime, "text/plain");
  });

  test("a script, a binary, an empty file and invalid UTF-8 are nothing; an executable is no document", async () => {
    assert.equal(await sniff.classify(files["script.sh"], { name: "script.sh" }), null, "#! script");
    assert.equal(await sniff.classify(files["binary.bin"], {}), null);
    assert.equal(await sniff.classify(files["empty"], {}), null);
    assert.equal(await sniff.classify(files["latin1.txt"], {}), null);
    assert.equal(await sniff.classifyHead(Buffer.alloc(0)), null);
    assert.equal(await sniff.classifyHead("not a buffer"), null);
    for (const sample of ["a.elf", "a.exe"]) {
      const detected = await sniff.classify(files[sample], { name: sample });
      assert.equal(sniff.accepts(["document"], detected), false, sample);
      assert.equal(sniff.accepts(["image", "animated", "video", "audio", "audio_or_container"], detected), false, sample);
    }
  });

  test("the declared type and the extension are ignored (RT-100)", async () => {
    const disguised = path.join(samples, "photo.png");
    fs.writeFileSync(disguised, fs.readFileSync(files["a.pdf"]));
    const detected = await sniff.classify(disguised, { name: "photo.png" });
    assert.equal(detected.mime, "application/pdf");
    assert.equal(sniff.accepts(["image"], detected), false);
    const named = path.join(samples, "evil.pdf");
    fs.writeFileSync(named, fs.readFileSync(files["a.elf"]));
    assert.equal(sniff.accepts(["document"], await sniff.classify(named, { name: "evil.pdf" })), false);
  });

  test("audio and video containers (ffmpeg samples)", { skip: !HAS_FFMPEG && "ffmpeg missing" }, async () => {
    const expected = {
      "a.mp3": "audio/mpeg",
      "a.ogg": "audio/ogg; codecs=opus",
      "a.vorbis.ogg": "audio/ogg",
      "a.m4a": "audio/x-m4a",
      "a.wav": "audio/wav",
      "a.flac": "audio/flac",
      "a.aac": "audio/aac",
      "a.amr": "audio/amr",
      "a.webm": "video/webm",
      "a.mp4": "video/mp4",
      "a.mov": "video/quicktime",
      "a.3gp": "video/3gpp",
    };
    for (const [name, mime] of Object.entries(expected)) {
      if (need(name)) continue;
      const detected = await sniff.classify(files[name], { name });
      assert.equal(detected && detected.mime, mime, name);
      assert.equal((await sniff.classifyHead(fs.readFileSync(files[name]))).mime, mime, `${name} head`);
    }
  });

  test("accepts(): audio files take no WebM; voice takes WebM and MP4; video takes MOV and 3GP", { skip: !HAS_FFMPEG && "ffmpeg missing" }, async () => {
    const kindOf = async (name) => (need(name) ? null : sniff.classify(files[name], { name }));
    const webm = await kindOf("a.webm");
    if (webm) {
      assert.equal(sniff.accepts(["audio"], webm), false);
      assert.equal(sniff.accepts(["audio_or_container"], webm), true);
    }
    const mp4 = await kindOf("a.mp4");
    if (mp4) {
      assert.equal(sniff.accepts(["video"], mp4), true);
      assert.equal(sniff.accepts(["audio_or_container"], mp4), true);
      assert.equal(sniff.accepts(["audio"], mp4), false);
      assert.equal(sniff.accepts(["animated", "video"], mp4), true, "gif accepts GIF, MP4 and MOV");
    }
    const mov = await kindOf("a.mov");
    if (mov) assert.equal(sniff.accepts(["animated", "video"], mov), true);
    const gif = { mime: "image/gif", ext: "gif" };
    assert.equal(sniff.accepts(["animated", "video"], gif), true);
    assert.equal(sniff.accepts(["image"], gif), false, "a GIF is not an image for the image format");
    assert.equal(sniff.accepts(["video"], gif), false);
  });
});

describe("sniff.accepts and sniff.check", () => {
  test("accepts(): false for null, an unknown kind, or a mime outside every listed kind", () => {
    assert.equal(sniff.accepts(["image"], null), false);
    assert.equal(sniff.accepts(["nope"], { mime: "image/png" }), false);
    assert.equal(sniff.accepts([], { mime: "image/png" }), false);
    assert.equal(sniff.accepts(["image", "document"], { mime: "application/pdf" }), true);
  });

  test("check() throws media_type_mismatch with params.expected only: the detected type is never echoed (Y17)", () => {
    assert.doesNotThrow(() => sniff.check(["image"], { mime: "image/png", ext: "png" }));
    for (const detected of [{ mime: "application/pdf", ext: "pdf" }, null]) {
      assert.throws(
        () => sniff.check(["image", "animated"], detected),
        (err) => {
          assert.ok(err instanceof MessagingError);
          assert.equal(err.code, "media_type_mismatch");
          assert.deepEqual(err.params, { expected: ["image", "animated"] });
          assert.doesNotMatch(JSON.stringify({ code: err.code, params: err.params, fields: err.fields }), /pdf|application/);
          assert.doesNotMatch(err.message, /pdf|application/);
          return true;
        },
      );
    }
  });
});

describe("sniff.effectiveMax: min(format cap, MAX_UPLOAD MB) read at call time", () => {
  const format = { media: { maxBytes: 16 * LIMITS.MB } };
  let original;
  before(() => {
    original = config.MAX_UPLOAD;
  });
  after(() => {
    config.MAX_UPLOAD = original;
  });

  test("the format cap when MAX_UPLOAD is larger; MAX_UPLOAD when smaller; a change applies at once", () => {
    config.MAX_UPLOAD = 230;
    assert.equal(sniff.effectiveMax(format), 16 * LIMITS.MB);
    config.MAX_UPLOAD = 5;
    assert.equal(sniff.effectiveMax(format), 5 * LIMITS.MB);
    config.MAX_UPLOAD = 1;
    assert.equal(sniff.effectiveMax({ media: { maxBytes: 100 * LIMITS.MB } }), LIMITS.MB);
    config.MAX_UPLOAD = 230;
    assert.equal(sniff.effectiveMax({ media: { maxBytes: 100 * LIMITS.MB } }), 100 * LIMITS.MB);
  });
});

// ---------------------------------------------------------------------------------------------------------
// stage
// ---------------------------------------------------------------------------------------------------------

describe("stage", () => {
  let dataDir;
  let repo;
  let s;

  before(() => {
    repo = path.join(root, "repo");
    dataDir = path.join(repo, "data");
    fs.mkdirSync(repo, { recursive: true });
    s = stage.createStage({ rootDir: repo, dataDir });
  });

  const temp = (name, content = "payload") => {
    const file = path.join(root, `tmp-${name}`);
    fs.writeFileSync(file, content);
    return file;
  };

  test("rootDir() is data/api-media, computed at call time; the default instance points at the repository's data/", () => {
    assert.equal(s.rootDir(), path.join(dataDir, "api-media"));
    assert.equal(stage.rootDir(), path.join(path.resolve(__dirname, ".."), "data", "api-media"));
  });

  test("dirOf() validates the id BEFORE building any path", () => {
    for (const bad of ["", "msg_", "msg_" + "A".repeat(21), "msg_" + "A".repeat(23), "../" + ID, ID + "/..", "msg_" + "A".repeat(21) + "/", `${ID}\0`, "msg_" + ".".repeat(22), "/etc/passwd", null, undefined, 12, {}, ["x"]]) {
      assert.throws(() => s.dirOf(bad), (err) => err.code === "invalid_public_id", String(bad));
    }
    assert.equal(s.dirOf(ID), path.join(s.rootDir(), ID));
    assert.equal(s.dirOf(ID2), path.join(s.rootDir(), ID2));
    assert.equal(path.relative(s.rootDir(), s.dirOf(ID)), ID);
  });

  test("adopt() moves the file to <dir>/source with mode 0600 in a 0700 directory; the name is never caller-controlled", async () => {
    const source = temp("move.bin", "moved bytes");
    const result = await s.adopt(ID, source, { mode: "move" });
    assert.equal(result.mediaPath, `data/api-media/${ID}/source`);
    const staged = path.join(repo, result.mediaPath);
    assert.equal(fs.readFileSync(staged, "utf8"), "moved bytes");
    assert.ok(!fs.existsSync(source), "moved");
    assert.equal(fs.statSync(staged).mode & 0o777, 0o600);
    assert.equal(fs.statSync(s.dirOf(ID)).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(s.dirOf(ID)), ["source"]);
  });

  test("adopt() in copy mode keeps the source (the panel's upload record is consumed after acceptance)", async () => {
    const source = temp("copy.bin", "copied bytes");
    const result = await s.adopt(ID2, source, { mode: "copy" });
    assert.equal(fs.readFileSync(path.join(repo, result.mediaPath), "utf8"), "copied bytes");
    assert.ok(fs.existsSync(source), "the source stays");
    assert.equal(fs.statSync(path.join(repo, result.mediaPath)).mode & 0o777, 0o600);
  });

  test("adopt() defaults to move; an EXDEV rename falls back to copy plus unlink", async () => {
    const id = "msg_" + "C".repeat(22);
    const source = temp("default.bin", "default move");
    const fallback = stage.createStage({
      rootDir: repo,
      dataDir,
      fs: {
        ...fsp,
        rename: async () => {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        },
      },
    });
    const result = await fallback.adopt(id, source);
    assert.equal(fs.readFileSync(path.join(repo, result.mediaPath), "utf8"), "default move");
    assert.ok(!fs.existsSync(source), "unlinked after the copy");
  });

  test("adopt() refuses a bad id before touching the disk, and a source that is not a regular file", async () => {
    const before = fs.existsSync(s.rootDir()) ? fs.readdirSync(s.rootDir()).sort() : [];
    await assert.rejects(s.adopt("../escape", temp("bad.bin")), (err) => err.code === "invalid_public_id");
    await assert.rejects(s.adopt(ID, path.join(root, "missing")), (err) => err.code === "ENOENT" || err.code === "not_a_file");
    const link = path.join(root, "link-to-pdf");
    fs.symlinkSync(files["a.pdf"], link);
    await assert.rejects(s.adopt("msg_" + "D".repeat(22), link), (err) => err.code === "not_a_file");
    await assert.rejects(s.adopt("msg_" + "D".repeat(22), root), (err) => err.code === "not_a_file");
    const after = fs.readdirSync(s.rootDir()).sort();
    assert.deepEqual(after.filter((n) => !before.includes(n)), [], "no directory was created for a refused adoption");
  });

  test("a symlinked stage directory is refused (assertInside)", async () => {
    const id = "msg_" + "E".repeat(22);
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(s.rootDir(), { recursive: true });
    fs.symlinkSync(outside, path.join(s.rootDir(), id));
    await assert.rejects(s.adopt(id, temp("sym.bin")), (err) => err.code === "outside_root");
    assert.deepEqual(fs.readdirSync(outside), [], "nothing written outside the root");
    await assert.rejects(s.remove(id), (err) => err.code === "outside_root");
    assert.ok(fs.existsSync(outside), "the target of the link survives");
    fs.unlinkSync(path.join(s.rootDir(), id));
  });

  test("list() reports each staged directory { name, mtimeMs, bytes } and ignores strangers", async () => {
    fs.writeFileSync(path.join(s.rootDir(), "stray-file"), "x");
    fs.mkdirSync(path.join(s.rootDir(), "not-a-public-id"));
    const rows = await s.list();
    const names = rows.map((row) => row.name);
    assert.ok(names.includes(ID) && names.includes(ID2));
    assert.ok(!names.includes("stray-file") && !names.includes("not-a-public-id"));
    const first = rows.find((row) => row.name === ID);
    assert.equal(first.bytes, "moved bytes".length);
    assert.equal(typeof first.mtimeMs, "number");
    assert.ok(Math.abs(first.mtimeMs - Date.now()) < 60000);
  });

  test("remove() is idempotent and validates the id", async () => {
    await s.remove(ID);
    assert.ok(!fs.existsSync(s.dirOf(ID)));
    await s.remove(ID);
    await s.remove("msg_" + "Z".repeat(22));
    await assert.rejects(s.remove("../.."), (err) => err.code === "invalid_public_id");
    assert.ok(fs.existsSync(s.dirOf(ID2)), "other messages are untouched");
  });

  test("list() and remove() on a data directory that does not exist yet", async () => {
    const fresh = stage.createStage({ rootDir: path.join(root, "nothing"), dataDir: path.join(root, "nothing", "data") });
    assert.deepEqual(await fresh.list(), []);
    await fresh.remove(ID);
  });

  test("RT-101: the path handed to Baileys is inside the stage directory and never an http(s) string", () => {
    const dir = s.dirOf(ID);
    const file = path.join(dir, "source");
    assert.equal(stage.assertStaged(file, dir), file);
    assert.equal(stage.assertStaged(path.join(dir, "prepared.mp4"), dir), path.join(dir, "prepared.mp4"));
    for (const bad of [
      "https://example.com/a.png",
      "http://127.0.0.1/a",
      "file:///etc/passwd",
      "relative/source",
      path.join(dir, "..", "other", "source"),
      path.join(dir, "..", "source"),
      "/etc/passwd",
      `${file}\0`,
      "",
      null,
      undefined,
      42,
    ]) {
      assert.throws(() => stage.assertStaged(bad, dir), (err) => err.code === "outside_root", String(bad));
    }
    // without a directory only the shape is checked: absolute, no URL, no traversal
    assert.equal(stage.assertStaged(file), file);
    assert.throws(() => stage.assertStaged("https://example.com/a.png"), (err) => err.code === "outside_root");
    assert.throws(() => stage.assertStaged("/tmp/../etc/passwd"), (err) => err.code === "outside_root");
  });

  test("preparedFile() names the converted file inside the directory with a safe extension", () => {
    const dir = s.dirOf(ID);
    assert.equal(stage.preparedFile(dir, "mp4"), path.join(dir, "prepared.mp4"));
    assert.equal(stage.preparedFile(dir, ".ogg"), path.join(dir, "prepared.ogg"));
    for (const bad of ["", "../x", "mp4/../../x", "a b", "toolongextension", null]) {
      assert.throws(() => stage.preparedFile(dir, bad), (err) => err.code === "invalid_extension", String(bad));
    }
  });

  test("absolute(): a stored mediaPath back to a file inside the stage root, nothing else", () => {
    assert.equal(s.absolute(`data/api-media/${ID}/source`), path.join(s.rootDir(), ID, "source"));
    assert.equal(s.absolute(`data/api-media/${ID}/prepared.mp4`), path.join(s.rootDir(), ID, "prepared.mp4"));
    for (const bad of ["data/api-media/../../etc/passwd", "etc/passwd", `data/api-media/${ID}/other`, `data/api-media/x/source`, "", null]) {
      assert.throws(() => s.absolute(bad), (err) => err.code === "outside_root", String(bad));
    }
  });
});

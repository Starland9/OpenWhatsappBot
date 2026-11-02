"use strict";
/**
 * lib/utils/stickerMaker.js (feature 004, contracts/runtime.md section 14.4): `imageToWebp`, `buildExif` and
 * `withStickerExif` and their constants moved unchanged out of plugins/sticker.js so the messaging engine's
 * `sticker` format can build a sticker without loading a plugin. The plugin requires them back; `videoToWebp`
 * stays in the plugin and imports the constants. `withStickerExif` keeps reading STICKER_PACKNAME and
 * STICKER_AUTHOR at call time.
 *
 * A generated 64x64 PNG (sharp), no network, no ffmpeg. The first test pins the values the plugin has today.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const fakes = require("./helpers/fakes");

const config = fakes.setupEnv();

const sticker = require("../lib/utils/stickerMaker");

let png;
let sharp;
let webp;

before(async () => {
  sharp = require("sharp");
  webp = require("node-webpmux");
  png = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } } })
    .png()
    .toBuffer();
});

/** The EXIF JSON of a sticker buffer, through node-webpmux (the reader WhatsApp-compatible tools use). */
async function exifOf(buffer) {
  const image = new webp.Image();
  await image.load(buffer);
  const exif = image.exif;
  assert.ok(Buffer.isBuffer(exif), "the sticker carries an EXIF block");
  const length = exif.readUInt32LE(14);
  return { exif, json: JSON.parse(exif.subarray(22, 22 + length).toString("utf8")) };
}

describe("exports and constants (the values plugins/sticker.js has today)", () => {
  test("the three functions and the four constants", () => {
    for (const name of ["imageToWebp", "buildExif", "withStickerExif"]) assert.equal(typeof sticker[name], "function", name);
    for (const name of ["STICKER_SIZE", "MAX_STICKER_BYTES", "IMAGE_QUALITIES", "EXIF_HEADER"]) assert.notEqual(sticker[name], undefined, name);
  });

  test("STICKER_SIZE 512, MAX_STICKER_BYTES 900 KiB, IMAGE_QUALITIES 80/60/40", () => {
    assert.equal(sticker.STICKER_SIZE, 512);
    assert.equal(sticker.MAX_STICKER_BYTES, 900 * 1024);
    assert.deepEqual([...sticker.IMAGE_QUALITIES], [80, 60, 40]);
  });

  test("EXIF_HEADER is the 22-byte TIFF header WhatsApp expects", () => {
    assert.ok(Buffer.isBuffer(sticker.EXIF_HEADER));
    assert.equal(sticker.EXIF_HEADER.length, 22);
    assert.equal(
      sticker.EXIF_HEADER.toString("hex"),
      Buffer.from([
        0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
      ]).toString("hex"),
    );
  });

  test("no heavy module is loaded at require (sharp and node-webpmux are required inside the functions, RT-04)", () => {
    const source = fs.readFileSync(require.resolve("../lib/utils/stickerMaker"), "utf8");
    assert.doesNotMatch(source, /^(const|let|var)[^\n]*require\("(sharp|node-webpmux|baileys)"\)/m);
    assert.doesNotMatch(source, /require\([^)]*(admin|\/api\/)/);
  });
});

describe("imageToWebp", () => {
  test("a 64x64 PNG becomes a 512x512 WebP of at most MAX_STICKER_BYTES", async () => {
    const out = await sticker.imageToWebp(png);
    assert.ok(Buffer.isBuffer(out));
    assert.ok(out.length > 0 && out.length <= sticker.MAX_STICKER_BYTES);
    assert.equal(out.subarray(0, 4).toString("latin1"), "RIFF");
    assert.equal(out.subarray(8, 12).toString("latin1"), "WEBP");
    const meta = await sharp(out).metadata();
    assert.equal(meta.format, "webp");
    assert.equal(meta.width, 512);
    assert.equal(meta.height, 512);
  });

  test("a non-square image is padded to 512x512, not stretched or cropped", async () => {
    const wide = await sharp({ create: { width: 200, height: 50, channels: 3, background: { r: 0, g: 120, b: 255 } } }).jpeg().toBuffer();
    const out = await sticker.imageToWebp(wide);
    const meta = await sharp(out).metadata();
    assert.deepEqual([meta.width, meta.height], [512, 512]);
    assert.equal(meta.hasAlpha, true, "transparent padding");
  });

  test("a buffer that is not an image rejects (the caller turns it into media_conversion_failed)", async () => {
    await assert.rejects(sticker.imageToWebp(Buffer.from("not an image at all")));
  });

  test("null when no quality fits, after trying 80, 60 and 40 once each", async () => {
    const sharpPath = require.resolve("sharp");
    const original = require.cache[sharpPath].exports;
    const qualities = [];
    const fake = () => {
      const chain = {
        rotate: () => chain,
        resize: () => chain,
        webp: ({ quality }) => {
          qualities.push(quality);
          return chain;
        },
        toBuffer: async () => Buffer.alloc(sticker.MAX_STICKER_BYTES + 1),
      };
      return chain;
    };
    require.cache[sharpPath].exports = fake;
    try {
      assert.equal(await sticker.imageToWebp(png), null);
    } finally {
      require.cache[sharpPath].exports = original;
    }
    assert.deepEqual(qualities, [80, 60, 40]);
  });

  test("a lighter quality is tried when the first output is too heavy", async () => {
    const sharpPath = require.resolve("sharp");
    const original = require.cache[sharpPath].exports;
    const qualities = [];
    const fake = () => {
      let quality;
      const chain = {
        rotate: () => chain,
        resize: () => chain,
        webp: (o) => {
          quality = o.quality;
          qualities.push(quality);
          return chain;
        },
        toBuffer: async () => Buffer.alloc(quality === 80 ? sticker.MAX_STICKER_BYTES + 1 : 1000, 7),
      };
      return chain;
    };
    require.cache[sharpPath].exports = fake;
    try {
      const out = await sticker.imageToWebp(png);
      assert.equal(out.length, 1000);
    } finally {
      require.cache[sharpPath].exports = original;
    }
    assert.deepEqual(qualities, [80, 60]);
  });
});

describe("buildExif", () => {
  test("EXIF_HEADER, then the JSON; the length is written little-endian at offset 14", () => {
    const exif = sticker.buildExif("Pack", "Author");
    assert.ok(Buffer.isBuffer(exif));
    assert.deepEqual([...exif.subarray(0, 14)], [...sticker.EXIF_HEADER.subarray(0, 14)]);
    assert.deepEqual([...exif.subarray(18, 22)], [...sticker.EXIF_HEADER.subarray(18, 22)]);
    const length = exif.readUInt32LE(14);
    assert.equal(exif.length, 22 + length);
    const json = JSON.parse(exif.subarray(22).toString("utf8"));
    assert.deepEqual(Object.keys(json).sort(), ["emojis", "sticker-pack-id", "sticker-pack-name", "sticker-pack-publisher"]);
    assert.equal(json["sticker-pack-name"], "Pack");
    assert.equal(json["sticker-pack-publisher"], "Author");
    assert.deepEqual(json.emojis, []);
  });

  test("the pack id is the sha1 of pack NUL author, so every sticker of the bot is one pack", () => {
    const a = sticker.buildExif("Pack", "Author");
    const id = JSON.parse(a.subarray(22).toString("utf8"))["sticker-pack-id"];
    assert.equal(id, crypto.createHash("sha1").update("Pack\u0000Author").digest("hex"));
    assert.deepEqual(sticker.buildExif("Pack", "Author"), a, "deterministic");
    const other = JSON.parse(sticker.buildExif("Pack", "Someone").subarray(22).toString("utf8"))["sticker-pack-id"];
    assert.notEqual(other, id);
  });

  test("multi-byte names: the length is in bytes, not characters", () => {
    const exif = sticker.buildExif("Pâck é", "Auteur \u{1F600}");
    const bytes = exif.subarray(22);
    assert.equal(exif.readUInt32LE(14), bytes.length);
    assert.equal(JSON.parse(bytes.toString("utf8"))["sticker-pack-name"], "Pâck é");
  });
});

describe("withStickerExif", () => {
  test("embeds the pack name and author of STICKER_PACKNAME / STICKER_AUTHOR", async () => {
    const saved = [config.STICKER_PACKNAME, config.STICKER_AUTHOR];
    try {
      config.STICKER_PACKNAME = "Pack One";
      config.STICKER_AUTHOR = "Author One";
      const base = await sticker.imageToWebp(png);
      const out = await sticker.withStickerExif(base);
      const { json } = await exifOf(out);
      assert.equal(json["sticker-pack-name"], "Pack One");
      assert.equal(json["sticker-pack-publisher"], "Author One");
      assert.equal(out.subarray(8, 12).toString("latin1"), "WEBP", "still a WebP");
    } finally {
      [config.STICKER_PACKNAME, config.STICKER_AUTHOR] = saved;
    }
  });

  test("the settings are read at call time: change the config between two calls, the EXIF differs", async () => {
    const saved = [config.STICKER_PACKNAME, config.STICKER_AUTHOR];
    try {
      const base = await sticker.imageToWebp(png);
      config.STICKER_PACKNAME = "First";
      config.STICKER_AUTHOR = "A1";
      const first = await exifOf(await sticker.withStickerExif(base));
      config.STICKER_PACKNAME = "Second";
      config.STICKER_AUTHOR = "A2";
      const second = await exifOf(await sticker.withStickerExif(base));
      assert.notDeepEqual(first.exif, second.exif);
      assert.equal(first.json["sticker-pack-name"], "First");
      assert.equal(second.json["sticker-pack-name"], "Second");
      assert.notEqual(first.json["sticker-pack-id"], second.json["sticker-pack-id"]);
    } finally {
      [config.STICKER_PACKNAME, config.STICKER_AUTHOR] = saved;
    }
  });

  test("an empty pack name and author are written as empty strings, not undefined", async () => {
    const saved = [config.STICKER_PACKNAME, config.STICKER_AUTHOR];
    try {
      config.STICKER_PACKNAME = "";
      config.STICKER_AUTHOR = "";
      const { json } = await exifOf(await sticker.withStickerExif(await sticker.imageToWebp(png)));
      assert.equal(json["sticker-pack-name"], "");
      assert.equal(json["sticker-pack-publisher"], "");
    } finally {
      [config.STICKER_PACKNAME, config.STICKER_AUTHOR] = saved;
    }
  });

  test("a buffer that is not a WebP rejects", async () => {
    await assert.rejects(sticker.withStickerExif(Buffer.from("nope")));
  });
});

describe("plugins/sticker.js after the move", () => {
  let plugin;
  after(() => {
    plugin = null;
  });

  test("still loads with the same command definition", () => {
    plugin = require("../plugins/sticker");
    assert.equal(plugin.command.pattern, "sticker");
    assert.equal(plugin.command.type, "media");
    assert.equal(typeof plugin.execute, "function");
    assert.deepEqual(Object.keys(plugin).sort(), ["command", "execute"]);
  });

  test("requires the helpers back; videoToWebp stays in the plugin and imports the constants", () => {
    const source = fs.readFileSync(require.resolve("../plugins/sticker"), "utf8");
    assert.match(source, /require\("\.\.\/lib\/utils\/stickerMaker"\)/);
    assert.match(source, /function videoToWebp\(/);
    for (const name of ["STICKER_SIZE", "MAX_STICKER_BYTES"]) assert.match(source, new RegExp(`\\b${name}\\b`));
    // the moved definitions are gone from the plugin
    assert.doesNotMatch(source, /(async )?function imageToWebp\(/);
    assert.doesNotMatch(source, /function buildExif\(/);
    assert.doesNotMatch(source, /(async )?function withStickerExif\(/);
    assert.doesNotMatch(source, /^const EXIF_HEADER\b/m);
    assert.doesNotMatch(source, /^const IMAGE_QUALITIES\b/m);
    assert.doesNotMatch(source, /require\("node-webpmux"\)/);
  });

  test("the command still turns a quoted image into a sticker with the pack and author", async () => {
    plugin = require("../plugins/sticker");
    const saved = [config.STICKER_PACKNAME, config.STICKER_AUTHOR];
    config.STICKER_PACKNAME = "Plugin Pack";
    config.STICKER_AUTHOR = "Plugin Author";
    try {
      const message = fakes.makeMessage({ body: ".sticker", quoted: { media: "image" } });
      message.getQuotedMedia = async () => ({ buffer: png, type: "image", mimetype: "image/png", fileLength: png.length });
      await plugin.execute(message);
      const sent = message.client.getSocket().sent.filter((s) => s.kind === "sticker");
      assert.equal(sent.length, 1);
      const buffer = sent[0].content.sticker;
      assert.ok(Buffer.isBuffer(buffer));
      const { json } = await exifOf(buffer);
      assert.equal(json["sticker-pack-name"], "Plugin Pack");
      assert.equal(json["sticker-pack-publisher"], "Plugin Author");
    } finally {
      [config.STICKER_PACKNAME, config.STICKER_AUTHOR] = saved;
    }
  });
});

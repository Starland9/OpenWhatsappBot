"use strict";
/**
 * BAILEYS_DEVICE: the device type the bot declares to WhatsApp (advanced setting, effect "restart",
 * default "web").
 *
 * WhatsApp sends view-once media only to devices it trusts to block screenshots (Android, even when it is
 * not the primary phone) and an empty placeholder to the others (`<unavailable type="view_once">`). Baileys 7
 * has an experimental Android mode, chosen by `browser[1]` containing "android" (UserAgent ANDROID, DeviceProps
 * ANDROID_PHONE, no webInfo). "web" keeps the historical ["Open Whatsapp Bot", "Chrome", "5.0.0"].
 *
 * No network and no WhatsApp: Baileys is replaced by test/helpers/fakeBaileys.js.
 */

const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fakes = require("./helpers/fakes");
const { loadClientWithFakeBaileys } = require("./helpers/fakeBaileys");

fakes.setupEnv();

const config = require("../config");
const catalog = require("../lib/utils/settingsCatalog");

/** A fake Baileys, a quiet console and a client on a temporary sessions root */
function makeEnv(t) {
  const log = mock.method(console, "log", () => {});
  const error = mock.method(console, "error", () => {});
  const env = loadClientWithFakeBaileys();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-device-"));
  t.after(() => {
    env.restore();
    log.mock.restore();
    error.mock.restore();
    fs.rmSync(root, { recursive: true, force: true });
    config.BAILEYS_DEVICE = undefined;
  });
  env.newClient = () => new env.WhatsAppClient("main", { sessionsRoot: root });
  return env;
}

/** The `browser` option of the socket created for the given setting value */
async function browserFor(t, device) {
  const env = makeEnv(t);
  config.BAILEYS_DEVICE = device;
  const client = env.newClient();
  await client.initialize();
  const browser = env.last().sockOpts.browser;
  await client.stop();
  return browser;
}

test("catalog: advanced enum web|android, default web, applied on restart, editable, not secret", () => {
  const entry = catalog.byKey.get("BAILEYS_DEVICE");
  assert.ok(entry, "BAILEYS_DEVICE is a catalog entry");
  assert.equal(entry.theme, "advanced");
  assert.equal(entry.type, "enum");
  assert.deepEqual(entry.rules.enum, ["web", "android"]);
  assert.equal(entry.default, "web");
  assert.equal(entry.effect, "restart");
  assert.equal(entry.readonly, false);
  assert.equal(entry.secret, false);
  assert.ok(entry.validate("ios"), "an unknown value is refused");
  assert.equal(config.BAILEYS_DEVICE, "web");
});

test("web (default): the socket declares the historical Chrome browser", async (t) => {
  assert.deepEqual(await browserFor(t, undefined), ["Open Whatsapp Bot", "Chrome", "5.0.0"]);
});

test("android: the socket declares an Android device (the condition Baileys tests)", async (t) => {
  const browser = await browserFor(t, "android");
  assert.equal(browser[0], "Open Whatsapp Bot");
  assert.ok(browser[1].toLocaleLowerCase().includes("android"), `browser[1] = ${browser[1]}`);
});

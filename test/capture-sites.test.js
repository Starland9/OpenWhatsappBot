"use strict";

/**
 * Capture sites fixed for live settings (specs/002-admin-panel T032, T033, T037;
 * contracts/runtime.md section 3):
 *
 *  - imagesearch reads MAX_UPLOAD per call;
 *  - the auto responder drops its Gemini client when GEMINI_API_KEY changes;
 *  - the Spotify and Reddit tokens are dropped when their credentials change;
 *  - conversationManager, antiDeleteHandler and memoryManager re-arm exactly one unref()'d timer on
 *    reconfigure() and read batch size, max cache age and memory threshold through getters.
 *
 * The process-wide settings store runs over the in-memory database and a temporary secret-box
 * directory; HTTP goes through a fake axios adapter, nothing leaves the machine.
 */

const { test, describe, before, after, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const fakes = require("./helpers/fakes");

const config = fakes.setupEnv();
const net = fakes.stubNetwork();
const axios = require(require.resolve("axios", { paths: [path.resolve(__dirname, "..")] }));
const settingsStore = require("../lib/utils/settingsStore");
const secretBox = require("../lib/utils/secretBox");

let db;
let tmp;
let originalAdapter;
let httpCalls;
let routes;

before(async () => {
  db = await fakes.syncDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-capture-"));
  secretBox.configure({ dir: path.join(tmp, "data") });
  await settingsStore.load({ models: db });

  // fake HTTP: routes[url] -> body; every call is recorded
  originalAdapter = axios.defaults.adapter;
  axios.defaults.adapter = async (cfg) => {
    httpCalls.push({ url: cfg.url, method: String(cfg.method).toUpperCase(), headers: cfg.headers ? cfg.headers.toJSON() : {} });
    const body = routes[cfg.url];
    if (body === undefined) {
      const error = new axios.AxiosError("no route", "ECONNREFUSED", cfg, null, undefined);
      throw error;
    }
    return { data: typeof body === "function" ? body(cfg) : body, status: 200, statusText: "OK", headers: {}, config: cfg, request: {} };
  };
});

after(() => {
  axios.defaults.adapter = originalAdapter;
  settingsStore.clearRuntime();
  net.restore();
  fs.rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  mock.restoreAll();
  settingsStore.clearRuntime();
});

const resetHttp = () => {
  httpCalls = [];
  routes = {};
};
resetHttp();

const basic = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
const callsTo = (url) => httpCalls.filter((call) => call.url === url);

// ---------------------------------------------------------------------------
// T032: credential caches and MAX_UPLOAD
// ---------------------------------------------------------------------------

describe("imagesearch: MAX_UPLOAD is read per call", () => {
  test("a change is seen by the next call, capped at 16 MB", async () => {
    const { mediaMaxBytes } = require("../plugins/imagesearch");
    await settingsStore.set({ MAX_UPLOAD: 5 });
    assert.equal(mediaMaxBytes(), 5 * 1024 * 1024);
    await settingsStore.set({ MAX_UPLOAD: 2 });
    assert.equal(mediaMaxBytes(), 2 * 1024 * 1024);
    await settingsStore.set({ MAX_UPLOAD: 100 });
    assert.equal(mediaMaxBytes(), 16 * 1024 * 1024);
    await settingsStore.unset(["MAX_UPLOAD"]);
    assert.equal(mediaMaxBytes(), 16 * 1024 * 1024);
    config.MAX_UPLOAD = 3; // a runtime assignment counts too
    assert.equal(mediaMaxBytes(), 3 * 1024 * 1024);
  });

  test("the size cap handed to the download is the live one", async () => {
    const plugin = require("../plugins/imagesearch");
    await settingsStore.set({ UNSPLASH_API_KEY: "unsplash-key-0123456789", MAX_UPLOAD: 4 });
    routes["https://api.unsplash.com/search/photos"] = {
      results: [{ urls: { regular: "https://images.unsplash.com/photo-1" }, user: { name: "A" } }],
    };
    const bodies = [];
    routes["https://images.unsplash.com/photo-1"] = (cfg) => {
      bodies.push(cfg.maxContentLength);
      return Buffer.from("image-bytes");
    };
    const message = fakes.makeMessage({ body: ".image cats" });
    await plugin.execute(message, "cats", { command: "image" });
    await settingsStore.set({ MAX_UPLOAD: 9 });
    await plugin.execute(fakes.makeMessage({ body: ".image cats" }), "cats", { command: "image" });
    assert.deepEqual(bodies, [4 * 1024 * 1024, 9 * 1024 * 1024]);
    await settingsStore.unset(["UNSPLASH_API_KEY", "MAX_UPLOAD"]);
    resetHttp();
  });
});

describe("auto responder: the Gemini client follows GEMINI_API_KEY", () => {
  test("a changed key rebuilds the client, an unrelated change keeps it", async () => {
    const handler = require("../lib/utils/autoResponderHandler");
    assert.equal(handler.initializeAI(), null, "no key, no client");

    await settingsStore.set({ GEMINI_API_KEY: "gemini-key-aaaa-0123456789" });
    const first = handler.initializeAI();
    assert.ok(first, "a client exists once a key is set");
    assert.equal(handler.initializeAI(), first, "cached while the key does not change");

    await settingsStore.set({ PREFIX: "!" });
    assert.equal(handler.genAI, first, "an unrelated setting leaves the client alone");

    await settingsStore.set({ GEMINI_API_KEY: "gemini-key-bbbb-0123456789" });
    assert.equal(handler.genAI, null, "the cached client is dropped");
    const second = handler.initializeAI();
    assert.ok(second);
    assert.notEqual(second, first, "and rebuilt with the new key");

    await settingsStore.set({ GEMINI_API_KEY: "" });
    assert.equal(handler.genAI, null);
    assert.equal(handler.initializeAI(), null, "a cleared key means no client");
    await settingsStore.unset(["GEMINI_API_KEY", "PREFIX"]);
  });
});

describe("music: the Spotify token follows the credentials", () => {
  const TOKEN_URL = "https://accounts.spotify.com/api/token";
  const SEARCH_URL = "https://api.spotify.com/v1/search";

  test("changed credentials drop the cached token; other changes keep it", async () => {
    const plugin = require("../plugins/music");
    resetHttp();
    routes[TOKEN_URL] = { access_token: "spotify-token", expires_in: 3600 };
    routes[SEARCH_URL] = { tracks: { items: [] } };
    const run = () => plugin.execute(fakes.makeMessage({ body: ".spotify abc" }), "abc", { command: "spotify" });

    await settingsStore.set({ SPOTIFY_CLIENT_ID: "spotify-id-aaaa1111", SPOTIFY_CLIENT_SECRET: "spotify-secret-aaaa1111" });
    await run();
    await run();
    assert.equal(callsTo(TOKEN_URL).length, 1, "the token is cached");
    assert.equal(callsTo(TOKEN_URL)[0].headers.Authorization, basic("spotify-id-aaaa1111", "spotify-secret-aaaa1111"));
    assert.equal(callsTo(SEARCH_URL).length, 2);

    await settingsStore.set({ PREFIX: "!" });
    await run();
    assert.equal(callsTo(TOKEN_URL).length, 1, "an unrelated change keeps the token");

    await settingsStore.set({ SPOTIFY_CLIENT_SECRET: "spotify-secret-bbbb2222" });
    await run();
    assert.equal(callsTo(TOKEN_URL).length, 2, "a new secret asks for a new token");
    assert.equal(callsTo(TOKEN_URL)[1].headers.Authorization, basic("spotify-id-aaaa1111", "spotify-secret-bbbb2222"));

    await settingsStore.set({ SPOTIFY_CLIENT_ID: "spotify-id-cccc3333" });
    await run();
    assert.equal(callsTo(TOKEN_URL).length, 3, "and so does a new client id");
    assert.equal(callsTo(TOKEN_URL)[2].headers.Authorization, basic("spotify-id-cccc3333", "spotify-secret-bbbb2222"));

    await settingsStore.unset(["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "PREFIX"]);
    resetHttp();
  });
});

describe("reddit: the OAuth token follows the credentials", () => {
  const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
  const LISTING_URL = "https://oauth.reddit.com/r/memes/hot";

  test("the User-Agent constant is exported and used for the token request", async () => {
    const plugin = require("../plugins/reddit");
    assert.equal(typeof plugin.USER_AGENT, "string");
    assert.match(plugin.USER_AGENT, /open-whatsapp-bot/);
    resetHttp();
    routes[TOKEN_URL] = { access_token: "reddit-token", expires_in: 3600 };
    routes[LISTING_URL] = { data: { children: [] } };
    await settingsStore.set({ REDDIT_CLIENT_ID: "reddit-id-aaaa1111", REDDIT_CLIENT_SECRET: "reddit-secret-aaaa1111" });
    await plugin.execute(fakes.makeMessage({ body: ".reddit r/memes" }), "r/memes");
    assert.equal(callsTo(TOKEN_URL)[0].headers["User-Agent"], plugin.USER_AGENT);
    assert.equal(callsTo(TOKEN_URL)[0].headers.Authorization, basic("reddit-id-aaaa1111", "reddit-secret-aaaa1111"));
    assert.equal(callsTo(LISTING_URL)[0].headers["User-Agent"], plugin.USER_AGENT);
    await settingsStore.unset(["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"]);
    resetHttp();
  });

  test("changed credentials drop tokenCache; other changes keep it", async () => {
    const plugin = require("../plugins/reddit");
    resetHttp();
    routes[TOKEN_URL] = { access_token: "reddit-token", expires_in: 3600 };
    routes[LISTING_URL] = { data: { children: [] } };
    const run = () => plugin.execute(fakes.makeMessage({ body: ".reddit r/memes" }), "r/memes");

    await settingsStore.set({ REDDIT_CLIENT_ID: "reddit-id-aaaa1111", REDDIT_CLIENT_SECRET: "reddit-secret-aaaa1111" });
    await run();
    await run();
    assert.equal(callsTo(TOKEN_URL).length, 1, "the token is cached");

    await settingsStore.set({ MAX_UPLOAD: 10 });
    await run();
    assert.equal(callsTo(TOKEN_URL).length, 1);

    await settingsStore.set({ REDDIT_CLIENT_SECRET: "reddit-secret-bbbb2222" });
    await run();
    assert.equal(callsTo(TOKEN_URL).length, 2);
    assert.equal(callsTo(TOKEN_URL)[1].headers.Authorization, basic("reddit-id-aaaa1111", "reddit-secret-bbbb2222"));

    await settingsStore.set({ REDDIT_CLIENT_ID: "reddit-id-cccc3333" });
    await run();
    assert.equal(callsTo(TOKEN_URL).length, 3);

    await settingsStore.unset(["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "MAX_UPLOAD"]);
    resetHttp();
  });
});

// ---------------------------------------------------------------------------
// T033: interval singletons
// ---------------------------------------------------------------------------

describe("interval singletons: reconfigure() and live getters", () => {
  /** reconfigure() must clear the old timer and arm exactly one new unref()'d interval */
  function checkReconfigure(manager, timerProp, configKey, nextValue) {
    const old = manager[timerProp];
    assert.ok(old, `${timerProp} exists after construction`);
    assert.equal(old.hasRef(), false, "the construction-time timer is unref()'d");

    config[configKey] = nextValue;
    const setIntervalSpy = mock.method(globalThis, "setInterval");
    const clearIntervalSpy = mock.method(globalThis, "clearInterval");
    manager.reconfigure();

    assert.equal(setIntervalSpy.mock.callCount(), 1, "exactly one interval is created");
    assert.equal(setIntervalSpy.mock.calls[0].arguments[1], nextValue, "from the current config value");
    assert.equal(clearIntervalSpy.mock.callCount(), 1, "the old one is cleared");
    assert.equal(clearIntervalSpy.mock.calls[0].arguments[0], old);
    assert.notEqual(manager[timerProp], old);
    assert.equal(manager[timerProp].hasRef(), false, "the new timer is unref()'d");

    manager.reconfigure();
    assert.equal(setIntervalSpy.mock.callCount(), 2);
    assert.equal(clearIntervalSpy.mock.callCount(), 2, "every reconfigure clears the previous timer");
    mock.restoreAll();
  }

  test("conversationManager: timer re-armed from CONVERSATION_UPDATE_INTERVAL, batch size live", async () => {
    const manager = require("../lib/utils/conversationManager");
    checkReconfigure(manager, "batchTimer", "CONVERSATION_UPDATE_INTERVAL", 1234);
    assert.equal(manager.updateInterval, 1234);
    settingsStore.clearRuntime();
    assert.equal(manager.batchSize, 5);
    await settingsStore.set({ CONVERSATION_BATCH_SIZE: 8 });
    assert.equal(manager.batchSize, 8);
    config.CONVERSATION_BATCH_SIZE = 3;
    assert.equal(manager.batchSize, 3);
    await settingsStore.unset(["CONVERSATION_BATCH_SIZE"]);
  });

  test("antiDeleteHandler: sweeper re-armed from CACHE_CLEANUP_INTERVAL, max cache age live", async () => {
    const handler = require("../lib/utils/antiDeleteHandler");
    checkReconfigure(handler, "cleanupTimer", "CACHE_CLEANUP_INTERVAL", 45678);
    assert.equal(handler.cacheCleanupInterval, 45678);
    settingsStore.clearRuntime();
    assert.equal(handler.maxCacheAge, 3600000);
    await settingsStore.set({ CACHE_MAX_AGE: 120000 });
    assert.equal(handler.maxCacheAge, 120000);
    await settingsStore.unset(["CACHE_MAX_AGE"]);
    assert.equal(handler.maxCacheAge, 3600000);
  });

  test("memoryManager: cleanup re-armed from MEMORY_CLEANUP_INTERVAL, threshold live", async () => {
    const manager = require("../lib/utils/memoryManager");
    checkReconfigure(manager, "cleanupTimer", "MEMORY_CLEANUP_INTERVAL", 98765);
    assert.equal(manager.cleanupInterval, 98765);
    settingsStore.clearRuntime();
    assert.equal(manager.memoryWarnThreshold, 400);
    await settingsStore.set({ MEMORY_WARN_THRESHOLD: 800 });
    assert.equal(manager.memoryWarnThreshold, 800);
    await settingsStore.unset(["MEMORY_WARN_THRESHOLD"]);
  });

  test("the sweeper of antiDeleteHandler uses the max age at tick time", async () => {
    const handler = require("../lib/utils/antiDeleteHandler");
    const realNow = Date.now();
    handler.messageCache.set("chat@s.whatsapp.net", new Map([["m1", { timestamp: realNow - 5000 }]]));
    let tick;
    mock.method(globalThis, "setInterval", (fn) => {
      tick = fn;
      return { unref() {}, hasRef: () => false };
    });
    mock.method(globalThis, "clearInterval", () => {});
    handler.reconfigure();
    config.CACHE_MAX_AGE = 1000; // changed after the timer was armed
    tick();
    assert.equal(handler.messageCache.has("chat@s.whatsapp.net"), false, "the live max age applies without re-arming");
    mock.restoreAll();
    handler.reconfigure();
  });

  test("none of the three files builds its own pino logger any more", () => {
    for (const file of ["conversationManager", "antiDeleteHandler", "memoryManager"]) {
      const source = fs.readFileSync(path.join(__dirname, "..", "lib", "utils", `${file}.js`), "utf8");
      assert.equal(/\bpino\s*\(/.test(source), false, file);
      assert.match(source, /createLogger\(/, file);
    }
  });
});

test("nothing tried to leave the machine", () => {
  assert.deepEqual(net.calls, []);
});

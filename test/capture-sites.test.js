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

// ---------------------------------------------------------------------------
// Feature 004: the settings of the messaging API are read where they are used (data-model 8.1, runtime RT-03)
// ---------------------------------------------------------------------------

describe("messaging API settings: a change applies to the next request or message, never to rows already queued", () => {
  const { createQuotas } = require("../lib/api/limits");
  const { ApiError } = require("../lib/api/errors");
  const { createEngineKit } = require("./helpers/messagingKit");
  const T0 = Date.UTC(2026, 4, 12, 10, 0, 0);

  test("API_RATE_PER_MINUTE and API_RATE_PER_DAY: the next check of a key without its own limit sees the new value", async () => {
    await db.ApiMessage.destroy({ where: {} });
    const quotas = createQuotas({ now: () => T0, models: db }); // the real config: nothing copied
    const key = { id: 4040, limits: { perMinute: null, perDay: null, maxPending: null } };
    await quotas.hydrate(key);
    quotas.reserve(key);
    quotas.reserve(key);
    await quotas.check(key); // the defaults (30 per minute, 1000 per day) are far away

    settingsStore.setRuntime("API_RATE_PER_MINUTE", 2);
    await assert.rejects(quotas.check(key), (err) => err instanceof ApiError && err.code === "rate_limited" && err.params.limit === 2);
    settingsStore.setRuntime("API_RATE_PER_MINUTE", 30);
    await quotas.check(key);

    settingsStore.setRuntime("API_RATE_PER_DAY", 2);
    await assert.rejects(quotas.check(key), (err) => err instanceof ApiError && err.code === "daily_quota_exceeded" && err.params.limit === 2);
    settingsStore.setRuntime("API_RATE_PER_DAY", 1000);
    await quotas.check(key);

    const own = { id: 4040, limits: { perMinute: 1, perDay: null, maxPending: null } };
    await assert.rejects(quotas.check(own), (err) => err.code === "rate_limited", "a limit of the key itself wins over the setting");
  });

  test("API_MAX_PENDING: the next admission of a key without its own limit sees the new value", async () => {
    const kit = await createEngineKit({ realConfig: true });
    try {
      const key = await kit.key();
      await kit.db.ApiMessage.bulkCreate(
        [1, 2, 3].map((n) => ({
          publicId: `msg_${String(n).padStart(22, "P")}`,
          apiKeyId: key.id,
          recipient: "237690000001@s.whatsapp.net",
          format: "text",
          status: "queued",
          acceptedAt: new Date(T0),
          expiresAt: new Date(T0 + 600000),
          payload: { v: 1, input: { text: "x" }, media: null, quote: null },
        })),
      );
      await kit.messaging.checkAdmission({ apiKeyId: key.id }); // 3 pending, the default limit is 100
      settingsStore.setRuntime("API_MAX_PENDING", 3);
      await assert.rejects(kit.messaging.checkAdmission({ apiKeyId: key.id }), (err) => err.code === "pending_limit_reached" && err.params.limit === 3);
      settingsStore.setRuntime("API_MAX_PENDING", 4);
      await kit.messaging.checkAdmission({ apiKeyId: key.id });
    } finally {
      await kit.close();
    }
  });

  test("API_QUEUE_EXPIRY_MIN: the expiry is a snapshot taken at acceptance, a queued row never moves", async () => {
    const kit = await createEngineKit({ realConfig: true });
    try {
      const key = await kit.key();
      const first = await kit.send({ apiKeyId: key.id, now: T0 });
      settingsStore.setRuntime("API_QUEUE_EXPIRY_MIN", 1);
      const second = await kit.send({ apiKeyId: key.id, now: T0 });
      assert.equal((await kit.row(first.message.publicId)).expiresAt.getTime(), T0 + 10 * 60000);
      assert.equal((await kit.row(second.message.publicId)).expiresAt.getTime(), T0 + 60000);
      assert.equal((await kit.row(first.message.publicId)).expiresAt.getTime(), T0 + 10 * 60000, "still");
    } finally {
      await kit.close();
    }
  });

  test("API_REPLY_WINDOW_DAYS: a sent message keeps its window, the next message gets the new one", async () => {
    const kit = await createEngineKit({ realConfig: true });
    try {
      const key = await kit.key();
      await kit.start();
      const buttons = { format: "buttons", fields: { text: "Ok?", buttons: [{ id: "a", label: "A" }] } };
      const a = await kit.send({ apiKeyId: key.id, ...buttons });
      await kit.tick();
      settingsStore.setRuntime("API_REPLY_WINDOW_DAYS", 3);
      const b = await kit.send({ apiKeyId: key.id, ...buttons });
      await kit.tick(3000);
      const rowA = await kit.row(a.message.publicId);
      const rowB = await kit.row(b.message.publicId);
      assert.equal(rowA.repliesUntil.getTime() - rowA.sentAt.getTime(), 7 * 86400000);
      assert.equal(rowB.repliesUntil.getTime() - rowB.sentAt.getTime(), 3 * 86400000);
    } finally {
      await kit.close();
    }
  });

  test("SEND_MIN_SPACING_MS: raised, the very next gap is longer; it never goes below the 2 s floor", async () => {
    const kit = await createEngineKit({ realConfig: true });
    try {
      const key = await kit.key();
      await kit.start();
      await kit.send({ apiKeyId: key.id, fields: { text: "one" } });
      await kit.send({ apiKeyId: key.id, fields: { text: "two" } });
      await kit.send({ apiKeyId: key.id, fields: { text: "three" } });
      await kit.tick();
      assert.equal(kit.sock.sent.length, 1);
      settingsStore.setRuntime("SEND_MIN_SPACING_MS", 10000);
      await kit.tick(9000);
      assert.equal(kit.sock.sent.length, 1);
      await kit.tick(1000);
      assert.equal(kit.sock.sent.length, 2);
      settingsStore.setRuntime("SEND_MIN_SPACING_MS", 100);
      assert.equal(kit.messaging.spacingMs(), 2000);
      await kit.tick(2000);
      assert.equal(kit.sock.sent.length, 3);
    } finally {
      await kit.close();
    }
  });

  describe("static scan: nothing copies a setting at load, nothing in the engine subscribes to the store", () => {
    const { scan } = require("./helpers/jsScan");
    const ROOT = path.resolve(__dirname, "..");
    const filesOf = (dir) => {
      const out = [];
      const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const file = path.join(current, entry.name);
          if (entry.isDirectory()) walk(file);
          else if (entry.name.endsWith(".js")) out.push(file);
        }
      };
      walk(path.join(ROOT, dir));
      return out;
    };
    const masked = (file) => scan(fs.readFileSync(file, "utf8")).masked;
    const watched = [...filesOf("lib/api"), ...filesOf("lib/messaging"), path.join(ROOT, "lib", "utils", "apiState.js")];

    test("no top-level `= config.X`, no class field, no default parameter copies a setting (lib/api, lib/messaging, apiState)", () => {
      assert.ok(watched.length > 20);
      for (const file of watched) {
        const code = masked(file);
        const where = path.relative(ROOT, file);
        assert.doesNotMatch(code, /^(?:const|let|var)\s+[\w$]+\s*=\s*config\s*\.\s*\w+/m, `${where}: a module-level constant copies a setting`);
        assert.doesNotMatch(code, /^(?:const|let|var)\s+[\w$]+\s*=\s*require\([^)]*config[^)]*\)\s*\.\s*\w+/m, `${where}: a module-level constant copies a setting`);
        assert.doesNotMatch(code, /\bthis\s*\.\s*[\w$]+\s*=\s*config\s*\./, `${where}: a field copies a setting`);
        assert.doesNotMatch(code, /\(\s*(?:[^()]*,\s*)?[\w$]+\s*=\s*config\s*\.\s*[A-Z_]+/, `${where}: a default parameter copies a setting`);
      }
    });

    test("lib/messaging has no reconfigure() and no settingsStore subscription: the numbers are read where they are used", () => {
      for (const file of filesOf("lib/messaging")) {
        const code = masked(file);
        const where = path.relative(ROOT, file);
        assert.doesNotMatch(code, /reconfigure/, where);
        assert.doesNotMatch(code, /settingsStore/, where);
        assert.doesNotMatch(code, /\.onChange\s*\(\s*\[/, `${where}: onChange([...keys]) is the settings-store subscription`);
      }
    });
  });
});

test("nothing tried to leave the machine", () => {
  assert.deepEqual(net.calls, []);
});

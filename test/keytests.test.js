"use strict";
/**
 * API-key tests of the panel (T107, FR-022, SC-004; settings-catalog.md section 7, admin-http-api.md SET-3,
 * runtime.md section 14 "keyTests").
 *
 *  - the verdict mapping of section 7 for the 8 testable services, with a stubbed `fetchJson` (no network, fake keys);
 *  - the 9 request recipes: the key travels where the table says (the Gemini key in a header, never in the URL);
 *  - the key never reaches the answer, the logs or the audit rows; upstream bodies are never forwarded;
 *  - 1 test per service per 10 s through cooldown.hit("panel", "keytest:<service>", 10000): 429 with retryAfterMs;
 *  - 409 not_configured, 422 not_testable (Alpha Vantage, unused keys), 404 for an unknown service;
 *  - a refused test does not raise the key_refused alert;
 *  - every testService id of the catalog has a row in section 7 of the contract (section 8 item 8).
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, beforeEach, afterEach, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { createTestAdmin } = require("./helpers/adminHarness");
const catalog = require("../lib/utils/settingsCatalog");
const settingsStore = require("../lib/utils/settingsStore");
const secretBox = require("../lib/utils/secretBox");
const bus = require("../lib/utils/events");
const realCooldown = require("../lib/utils/cooldown");
const reddit = require("../plugins/reddit");
const { createKeyTestsService, RECIPES, UNUSED_SERVICES } = require("../lib/admin/services/keyTests");

const KEY = "sk-test-FAKE0000-KEY1111";
const ID = "fake-client-id-0001";
const SECRET = "fake-client-secret-0002";

/** An axios-looking failure; `message` deliberately carries the key like a careless upstream would */
function httpError(status, data, extra = {}) {
  const error = new Error(`Request failed with status code ${status} for https://example.test/?key=${KEY}`);
  error.isAxiosError = true;
  error.response = { status, data };
  return Object.assign(error, extra);
}
const networkError = (code) => Object.assign(new Error(`connect ${code} while using ${KEY}`), { code });

/** What each service needs saved, how its OK answer looks, and what its refusals look like */
const SERVICES = {
  openai: { keys: { OPENAI_API_KEY: KEY }, ok: { object: "list", data: [] }, refused: [[401, { error: { code: "invalid_api_key", message: `Incorrect API key provided: ${KEY}` } }]], quota: [[429, { error: { code: "insufficient_quota" } }]] },
  gemini: { keys: { GEMINI_API_KEY: KEY }, ok: { models: [] }, refused: [[400, { error: { status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }], [403, { error: { status: "PERMISSION_DENIED" } }]], quota: [[429, { error: { status: "RESOURCE_EXHAUSTED" } }]] },
  weather: { keys: { WEATHER_API_KEY: KEY }, ok: { current: {} }, refused: [[401, { error: { code: 2006 } }], [403, { error: { code: 2008 } }], [403, { error: { code: 2009 } }]], quota: [[403, { error: { code: 2007 } }]] },
  news: { keys: { NEWS_API_KEY: KEY }, ok: { status: "ok", sources: [] }, refused: [[401, { status: "error", code: "apiKeyInvalid" }]], quota: [[429, { status: "error", code: "rateLimited" }]] },
  unsplash: { keys: { UNSPLASH_API_KEY: KEY }, ok: { total: 0, results: [] }, refused: [[401, { errors: ["OAuth error: The access token is invalid"] }]], quota: [[403, "Rate Limit Exceeded"]] },
  giphy: { keys: { GIPHY_API_KEY: KEY }, ok: { data: [] }, refused: [[401, { message: "No API key found in request" }], [403, { message: "forbidden" }]], quota: [[429, { message: "slow down" }]] },
  spotify: { keys: { SPOTIFY_CLIENT_ID: ID, SPOTIFY_CLIENT_SECRET: SECRET }, ok: { access_token: "discarded-token-value", token_type: "Bearer" }, refused: [[400, { error: "invalid_client" }], [401, { error: "invalid_client" }]], quota: [[429, { error: "rate" }]] },
  reddit: { keys: { REDDIT_CLIENT_ID: ID, REDDIT_CLIENT_SECRET: SECRET }, ok: { access_token: "discarded-token-value" }, refused: [[401, { message: "Unauthorized", error: 401 }]], quota: [] },
};

function recordingLogger() {
  const lines = [];
  const log = (level) => (...args) => lines.push({ level, args });
  return { lines, debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
}

/** A service wired to a scripted fetchJson; `script` is what the next request answers or throws */
function makeService(name, { script, extra = {} } = {}) {
  const calls = [];
  const logger = recordingLogger();
  const fetchJson = async (url, options) => {
    calls.push({ url, options });
    const next = typeof script === "function" ? script(url, options) : script;
    if (next instanceof Error) throw next;
    return next;
  };
  const service = createKeyTestsService({
    fetchJson,
    config: { ...SERVICES[name].keys },
    cooldown: { hit: () => 0 },
    logger,
    clock: { now: () => Date.UTC(2026, 0, 1, 12, 0, 0) },
    ...extra,
  });
  return { service, calls, logger, test: () => service.test(name) };
}

const everythingLogged = (logger) => JSON.stringify(logger.lines);

// ---------------------------------------------------------------------------
// The verdict mapping (section 7)
// ---------------------------------------------------------------------------

describe("verdict mapping, per service", () => {
  for (const name of Object.keys(SERVICES)) {
    const spec = SERVICES[name];

    describe(name, () => {
      test("2xx with the expected body is accepted", async () => {
        const { test: run, calls } = makeService(name, { script: spec.ok });
        const result = await run();
        assert.deepEqual(Object.keys(result).sort(), ["checkedAt", "detail", "verdict"], "only the verdict leaves the service");
        assert.deepEqual([result.verdict, result.detail], ["accepted", null]);
        assert.equal(result.checkedAt, "2026-01-01T12:00:00.000Z");
        assert.equal(calls.length, 1, "one fixed request");
        assert.equal(calls[0].options.timeoutMs, 10000, "10 s limit");
      });

      for (const [status, body] of spec.refused) {
        test(`HTTP ${status} on the fixed request is refused`, async () => {
          const { test: run } = makeService(name, { script: httpError(status, body) });
          assert.deepEqual(await run(), { verdict: "refused", detail: null, checkedAt: "2026-01-01T12:00:00.000Z" });
        });
      }

      for (const [status, body] of spec.quota) {
        test(`HTTP ${status} (quota) is accepted with detail "quota": the key was recognised`, async () => {
          const { test: run } = makeService(name, { script: httpError(status, body) });
          const result = await run();
          assert.deepEqual([result.verdict, result.detail], ["accepted", "quota"]);
        });
      }

      const unreachable = {
        "no response (ECONNRESET)": networkError("ECONNRESET"),
        "DNS failure (ENOTFOUND)": networkError("ENOTFOUND"),
        "timeout (ETIMEDOUT)": networkError("ETIMEDOUT"),
        "TLS error": networkError("CERT_HAS_EXPIRED"),
        "HTTP 500": httpError(500, { error: "boom" }),
        "HTTP 503": httpError(503, "<html>maintenance</html>"),
        "HTTP 408": httpError(408, ""),
        "an HTML page (ERR_BAD_RESPONSE_FORMAT)": Object.assign(new Error("Unexpected non-JSON response"), { code: "ERR_BAD_RESPONSE_FORMAT", status: 200 }),
        "an HTTP status the table does not list (404)": httpError(404, { error: "nope" }),
      };
      for (const [label, error] of Object.entries(unreachable)) {
        test(`${label} is unreachable`, async () => {
          const { test: run, logger } = makeService(name, { script: error });
          const result = await run();
          assert.deepEqual([result.verdict, result.detail], ["unreachable", null]);
          assert.ok(!everythingLogged(logger).includes(KEY), "an upstream message is never logged");
        });
      }

      test("a 2xx answer that is not the expected body is unreachable", async () => {
        const { test: run } = makeService(name, { script: "<html>captive portal</html>" });
        assert.equal((await run()).verdict, "unreachable");
      });
    });
  }

  describe("vendor details", () => {
    test("weather: 403 code 2007 is the monthly quota, 2008 and 2009 are refusals", async () => {
      assert.equal((await makeService("weather", { script: httpError(403, { error: { code: 2007 } }) }).test()).detail, "quota");
      assert.equal((await makeService("weather", { script: httpError(403, { error: { code: 2009 } }) }).test()).verdict, "refused");
    });

    test("news: a rateLimited or apiKeyExhausted body is a quota answer whatever the status", async () => {
      const result = await makeService("news", { script: httpError(429, { code: "apiKeyExhausted" }) }).test();
      assert.deepEqual([result.verdict, result.detail], ["accepted", "quota"]);
    });

    test("openai: an insufficient_quota body is a quota answer even outside 429", async () => {
      const result = await makeService("openai", { script: httpError(403, { error: { type: "insufficient_quota" } }) }).test();
      assert.deepEqual([result.verdict, result.detail], ["accepted", "quota"]);
    });

    test("unsplash: 403 is a refusal unless the body says Rate Limit Exceeded", async () => {
      assert.equal((await makeService("unsplash", { script: httpError(403, "Rate Limit Exceeded") }).test()).detail, "quota");
      assert.equal((await makeService("unsplash", { script: httpError(403, { errors: ["forbidden"] }) }).test()).verdict, "refused");
    });

    test("spotify and reddit: a 2xx answer without access_token is not an acceptance; with an error field it is a refusal", async () => {
      assert.equal((await makeService("spotify", { script: { token_type: "Bearer" } }).test()).verdict, "unreachable");
      assert.equal((await makeService("spotify", { script: { error: "invalid_client" } }).test()).verdict, "refused");
      assert.equal((await makeService("reddit", { script: { error: "invalid_grant" } }).test()).verdict, "refused");
    });

    test("reddit: datacenter addresses get 403/429 without a clear body: unreachable, never a refusal", async () => {
      for (const error of [httpError(403, "<html>blocked</html>"), httpError(403, { message: "Forbidden" }), httpError(429, "<html>slow down</html>"), httpError(429, { message: "Too Many Requests" })]) {
        assert.equal((await makeService("reddit", { script: error }).test()).verdict, "unreachable");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// The request recipes
// ---------------------------------------------------------------------------

describe("the fixed requests", () => {
  const request = async (name) => {
    const { test: run, calls } = makeService(name, { script: SERVICES[name].ok });
    await run();
    return calls[0];
  };

  test("openai: GET /v1/models with a Bearer header", async () => {
    const { url, options } = await request("openai");
    assert.equal(url, "https://api.openai.com/v1/models");
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
    assert.ok(!url.includes(KEY));
  });

  test("gemini: the key is in the x-goog-api-key header, never in the URL, the query or the body", async () => {
    const { url, options } = await request("gemini");
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1");
    assert.equal(options.headers["x-goog-api-key"], KEY);
    assert.ok(!url.includes(KEY));
    assert.equal(options.params, undefined, "no query parameter carries it");
    assert.equal(options.data, undefined, "no body carries it");
  });

  test("weather and giphy: the key goes in the query parameters (never in a logged URL)", async () => {
    let call = await request("weather");
    assert.equal(call.url, "https://api.weatherapi.com/v1/current.json");
    assert.deepEqual(call.options.params, { key: KEY, q: "Paris", aqi: "no" });
    call = await request("giphy");
    assert.equal(call.url, "https://api.giphy.com/v1/gifs/trending");
    assert.deepEqual(call.options.params, { api_key: KEY, limit: 1 });
  });

  test("news: X-Api-Key header on the sources listing; unsplash: Client-ID header on a one-photo search", async () => {
    let call = await request("news");
    assert.equal(call.url, "https://newsapi.org/v2/top-headlines/sources");
    assert.equal(call.options.headers["X-Api-Key"], KEY);
    call = await request("unsplash");
    assert.equal(call.url, "https://api.unsplash.com/search/photos");
    assert.deepEqual(call.options.params, { query: "test", per_page: 1 });
    assert.equal(call.options.headers.Authorization, `Client-ID ${KEY}`);
  });

  test("spotify: client-credentials token request with Basic auth of id:secret", async () => {
    const { url, options } = await request("spotify");
    assert.equal(url, "https://accounts.spotify.com/api/token");
    assert.equal(options.method, "POST");
    assert.equal(options.data, "grant_type=client_credentials");
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from(`${ID}:${SECRET}`).toString("base64")}`);
    assert.equal(options.headers["Content-Type"], "application/x-www-form-urlencoded");
  });

  test("reddit: the same token request with the User-Agent the plugin uses", async () => {
    const { url, options } = await request("reddit");
    assert.equal(url, "https://www.reddit.com/api/v1/access_token");
    assert.equal(options.method, "POST");
    assert.equal(options.headers["User-Agent"], reddit.USER_AGENT);
    assert.match(reddit.USER_AGENT, /^nodejs:open-whatsapp-bot/);
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from(`${ID}:${SECRET}`).toString("base64")}`);
  });

  test("the key is trimmed, and the saved value of the settings store is read when no test double is given", async () => {
    const calls = [];
    const service = createKeyTestsService({
      fetchJson: async (url, options) => {
        calls.push(options);
        return SERVICES.openai.ok;
      },
      settingsStore: { get: (key) => (key === "OPENAI_API_KEY" ? `  ${KEY}  ` : "") },
      cooldown: { hit: () => 0 },
      logger: recordingLogger(),
    });
    assert.equal((await service.test("openai")).verdict, "accepted");
    assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
  });
});

// ---------------------------------------------------------------------------
// Errors, services(), the cooldown, secrecy
// ---------------------------------------------------------------------------

describe("errors and limits", () => {
  const codeOf = (promise) => promise.then(() => null, (error) => ({ code: error.code, params: error.params }));

  test("services() lists the 8 testable services and Alpha Vantage as not testable", () => {
    const list = makeService("openai", { script: {} }).service.services();
    assert.deepEqual(list.map((s) => s.id), ["openai", "gemini", "weather", "news", "unsplash", "giphy", "spotify", "reddit", "alphavantage"]);
    assert.deepEqual(list.find((s) => s.id === "spotify").settings, ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"]);
    assert.deepEqual(list.filter((s) => !s.testable).map((s) => s.id), ["alphavantage"]);
  });

  test("alphavantage and the services of unused keys are not_testable, an unknown id is not_found", async () => {
    const { service, calls } = makeService("openai", { script: {} });
    assert.equal((await codeOf(service.test("alphavantage"))).code, "not_testable");
    for (const id of UNUSED_SERVICES) assert.equal((await codeOf(service.test(id))).code, "not_testable", id);
    const unknown = await codeOf(service.test("nope"));
    assert.equal(unknown.code, "not_found");
    assert.deepEqual(unknown.params, { resource: "service" });
    assert.equal(calls.length, 0, "no request was sent");
  });

  test("nothing saved is not_configured; for spotify and reddit both values are needed", async () => {
    const calls = [];
    const make = (config) => createKeyTestsService({ fetchJson: async (...args) => calls.push(args), config, cooldown: { hit: () => 0 }, logger: recordingLogger() });
    assert.equal((await codeOf(make({ OPENAI_API_KEY: "" }).test("openai"))).code, "not_configured");
    assert.equal((await codeOf(make({ OPENAI_API_KEY: "   " }).test("openai"))).code, "not_configured");
    assert.equal((await codeOf(make({ SPOTIFY_CLIENT_ID: ID, SPOTIFY_CLIENT_SECRET: "" }).test("spotify"))).code, "not_configured");
    assert.equal((await codeOf(make({ REDDIT_CLIENT_ID: "", REDDIT_CLIENT_SECRET: SECRET }).test("reddit"))).code, "not_configured");
    assert.equal(calls.length, 0);
  });

  test("a not_configured answer does not start the cooldown", async () => {
    const hits = [];
    const service = createKeyTestsService({ fetchJson: async () => ({}), config: { OPENAI_API_KEY: "" }, cooldown: { hit: (...args) => (hits.push(args), 0) }, logger: recordingLogger() });
    await codeOf(service.test("openai"));
    assert.deepEqual(hits, []);
  });

  test("the limit is cooldown.hit('panel', 'keytest:<service>', 10000): rate_limited with retryAfterMs", async () => {
    const hits = [];
    let wait = 0;
    const service = createKeyTestsService({
      fetchJson: async () => SERVICES.openai.ok,
      config: SERVICES.openai.keys,
      cooldown: { hit: (...args) => (hits.push(args), wait) },
      logger: recordingLogger(),
    });
    await service.test("openai");
    assert.deepEqual(hits, [["panel", "keytest:openai", 10000]]);
    wait = 7300;
    const limited = await codeOf(service.test("openai"));
    assert.deepEqual(limited, { code: "rate_limited", params: { retryAfterMs: 7300 } });
  });

  test("with the real cooldown: one test per service per 10 s, services are independent", async () => {
    mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 1) });
    try {
      realCooldown.hit("panel", "keytest:openai", 0); // clears any entry left by another test
      realCooldown.hit("panel", "keytest:gemini", 0);
      const service = createKeyTestsService({
        fetchJson: async (url) => (url.includes("openai") ? SERVICES.openai.ok : SERVICES.gemini.ok),
        config: { ...SERVICES.openai.keys, ...SERVICES.gemini.keys },
        logger: recordingLogger(),
      });
      assert.equal((await service.test("openai")).verdict, "accepted");
      const limited = await codeOf(service.test("openai"));
      assert.equal(limited.code, "rate_limited");
      assert.equal(limited.params.retryAfterMs, 10000);
      assert.equal((await service.test("gemini")).verdict, "accepted", "another service has its own cooldown");
      mock.timers.tick(10000);
      assert.equal((await service.test("openai")).verdict, "accepted");
    } finally {
      mock.timers.reset();
    }
  });

  test("the key never reaches the answer or the logs, whatever the outcome", async () => {
    for (const name of Object.keys(SERVICES)) {
      for (const script of [SERVICES[name].ok, httpError(500, { error: KEY }), networkError("ETIMEDOUT"), httpError(401, { error: { message: KEY } })]) {
        const { service, logger } = makeService(name, { script });
        const result = await service.test(name);
        assert.ok(!JSON.stringify(result).includes(KEY), `${name}: answer`);
        assert.ok(!JSON.stringify(result).includes(SECRET), `${name}: answer`);
        assert.ok(!everythingLogged(logger).includes(KEY), `${name}: logs`);
        assert.ok(!everythingLogged(logger).includes(SECRET), `${name}: logs`);
      }
    }
  });

  test("an unreachable service is logged as service, status and code only", async () => {
    const { test: run, logger } = makeService("weather", { script: httpError(503, "<html>down</html>") });
    await run();
    const warn = logger.lines.filter((line) => line.level === "warn");
    assert.equal(warn.length, 1);
    assert.deepEqual(warn[0].args[0], { service: "weather", status: 503, code: undefined });
  });

  test("a test never goes through classifyError: the key_refused alert is not raised", async () => {
    const seen = [];
    const listener = (payload) => seen.push(payload);
    bus.on("key:refused", listener);
    try {
      for (const name of Object.keys(SERVICES)) {
        for (const [status, body] of SERVICES[name].refused) await makeService(name, { script: httpError(status, body) }).test();
      }
      assert.deepEqual(seen, []);
    } finally {
      bus.off("key:refused", listener);
    }
  });
});

// ---------------------------------------------------------------------------
// The contract table
// ---------------------------------------------------------------------------

describe("settings-catalog.md section 7", () => {
  const contract = fs.readFileSync(path.join(__dirname, "..", "specs", "002-admin-panel", "contracts", "settings-catalog.md"), "utf8");
  const section = contract.slice(contract.indexOf("## 7. API-key tests"), contract.indexOf("## 8. Alignment"));
  const rows = [...section.matchAll(/^\| `([a-z]+)` \| ([^|]+)\|/gm)].map((m) => ({ id: m[1], settings: [...m[2].matchAll(/`([A-Z_]+)`/g)].map((s) => s[1]) }));

  test("the table has one row per service of the recipes, with the same settings", () => {
    assert.deepEqual(rows.map((r) => r.id), RECIPES.map((r) => r.id));
    for (const row of rows) assert.deepEqual(row.settings, RECIPES.find((r) => r.id === row.id).settings, row.id);
  });

  test("every testService id of the catalog has a row, and the settings of a row name that service", () => {
    const ids = new Set(rows.map((r) => r.id));
    const used = new Set(catalog.entries.filter((e) => e.testService).map((e) => e.testService));
    for (const id of used) assert.ok(ids.has(id), `${id} has no row in section 7`);
    for (const entry of catalog.entries.filter((e) => e.testService)) {
      const recipe = RECIPES.find((r) => r.id === entry.testService);
      assert.ok(recipe && recipe.settings.includes(entry.key), `${entry.key} -> ${entry.testService}`);
    }
    // Alpha Vantage has a row but no key is attached to a test
    assert.ok(!used.has("alphavantage"));
    assert.equal(catalog.byKey.get("ALPHA_VANTAGE_KEY").testService, null);
  });

  test("each service id a plugin passes to classifyError({ service }) is a testable row of the table (section 8, item 8)", () => {
    const dir = path.join(__dirname, "..", "plugins");
    const used = [];
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".js"))) {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      for (const match of source.matchAll(/classifyError\(([^;]*?)\bservice:\s*["']([a-z]+)["']/g)) {
        used.push({ file, service: match[2], call: match[1] });
      }
    }
    for (const { file, service, call } of used) {
      const recipe = RECIPES.find((candidate) => candidate.id === service);
      assert.ok(recipe && recipe.testable !== false, `${file}: service "${service}" has no testable row`);
      // when the same call names the key (hasKey: !!config.KEY), it is one of the row's settings
      const named = [...call.matchAll(/config\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]);
      for (const key of named) assert.ok(recipe.settings.includes(key), `${file}: ${key} is not a setting of "${service}"`);
    }
  });

  test("an inactive entry has no testService", () => {
    for (const entry of catalog.entries.filter((e) => e.inactive)) assert.equal(entry.testService, null, entry.key);
  });
});

// ---------------------------------------------------------------------------
// SET-3 through the real router
// ---------------------------------------------------------------------------

describe("SET-3: POST /admin/api/settings/keys/:service/test", () => {
  let tmp;
  let t;
  let client;
  let requests;
  let nextAnswer;
  let clockNow;
  const hits = [];

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-keytests-"));
    secretBox.configure({ dir: path.join(tmp, "data") });
    await fakes.syncDb();
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const db = await fakes.syncDb();
    await db.SettingOverride.destroy({ where: {} });
    fs.rmSync(path.join(tmp, "data"), { recursive: true, force: true });
    settingsStore._rows.clear();
    settingsStore._lastVersion.clear();
    await settingsStore.load({ models: db });
    requests = [];
    hits.length = 0;
    nextAnswer = SERVICES.openai.ok;
    clockNow = 0;
    t = await createTestAdmin({
      deps: {
        fetchJson: async (url, options) => {
          requests.push({ url, options });
          if (nextAnswer instanceof Error) throw nextAnswer;
          return nextAnswer;
        },
        cooldown: {
          hit: (user, key, ms) => {
            hits.push([user, key, ms]);
            return clockNow;
          },
        },
      },
    });
    await t.admin.start();
    client = await t.loginClient();
  });

  afterEach(async () => {
    await t.close();
    settingsStore.clearRuntime();
  });

  const test3 = (service) => client.api("POST", `/admin/api/settings/keys/${service}/test`);
  const save = (key, value) => client.api("PATCH", "/admin/api/settings", { changes: [{ key, op: "set", value, version: settingsStore.version(key) }] });

  test("requires a session and a CSRF token", async () => {
    assert.equal((await t.client().api("POST", "/admin/api/settings/keys/openai/test")).status, 401);
    const forged = await client.api("POST", "/admin/api/settings/keys/openai/test", undefined, { headers: { "X-CSRF-Token": "wrong" } });
    assert.equal(forged.status, 403);
    assert.equal(requests.length, 0);
  });

  test("tests the saved key (the panel value wins) and answers { service, verdict, detail, checkedAt } only", async () => {
    assert.equal((await save("OPENAI_API_KEY", KEY)).status, 200);
    const answer = await test3("openai");
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    assert.deepEqual(Object.keys(answer.json).sort(), ["checkedAt", "detail", "service", "verdict"]);
    assert.deepEqual([answer.json.service, answer.json.verdict, answer.json.detail], ["openai", "accepted", null]);
    assert.match(answer.json.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.headers.Authorization, `Bearer ${KEY}`, "read server-side from the saved value");
    assert.deepEqual(hits, [["panel", "keytest:openai", 10000]]);
    assert.ok(!answer.text.includes(KEY));
  });

  test("refused and unreachable verdicts, a quota answer", async () => {
    await save("OPENAI_API_KEY", KEY);
    nextAnswer = httpError(401, { error: { code: "invalid_api_key", message: `Incorrect API key provided: ${KEY}` } });
    let answer = await test3("openai");
    assert.deepEqual([answer.status, answer.json.verdict], [200, "refused"]);
    assert.ok(!answer.text.includes(KEY), "OpenAI echoes a masked key: it is never forwarded");

    nextAnswer = networkError("ENOTFOUND");
    assert.equal((await test3("openai")).json.verdict, "unreachable");

    nextAnswer = httpError(429, { error: { code: "insufficient_quota" } });
    answer = await test3("openai");
    assert.deepEqual([answer.json.verdict, answer.json.detail], ["accepted", "quota"]);
  });

  test("no saved key: 409 not_configured, nothing sent; Alpha Vantage and unused keys: 422 not_testable; unknown: 404", async () => {
    let answer = await test3("openai");
    assert.equal(answer.status, 409);
    assert.equal(answer.json.error.code, "not_configured");
    answer = await test3("alphavantage");
    assert.equal(answer.status, 422);
    assert.equal(answer.json.error.code, "not_testable");
    answer = await test3("groq");
    assert.equal(answer.status, 422);
    assert.equal(answer.json.error.code, "not_testable");
    answer = await test3("nope");
    assert.equal(answer.status, 404);
    assert.equal(answer.json.error.code, "not_found");
    assert.equal(requests.length, 0);
    assert.equal((await t.db.AuditLog.findAll({ where: { action: "setting.test" } })).length, 0, "a test that did not run is not audited");
  });

  test("the cooldown: 429 rate_limited with params.retryAfterMs and a Retry-After header", async () => {
    await save("OPENAI_API_KEY", KEY);
    clockNow = 6200;
    const answer = await test3("openai");
    assert.equal(answer.status, 429);
    assert.equal(answer.json.error.code, "rate_limited");
    assert.equal(answer.json.error.params.retryAfterMs, 6200);
    assert.equal(answer.headers.get("retry-after"), "7");
    assert.equal(requests.length, 0);
  });

  test("a body is refused: the key never travels in the request", async () => {
    await save("OPENAI_API_KEY", KEY);
    const answer = await client.api("POST", "/admin/api/settings/keys/openai/test", { apiKey: "x" });
    assert.equal(answer.status, 422);
    assert.equal(answer.json.error.fields.$unknown.code, "unknown_field");
    assert.equal(requests.length, 0);
  });

  test("audit setting.test with the service as target and the verdict only; no key in the audit, the logs or the alerts", async () => {
    await save("OPENAI_API_KEY", KEY);
    nextAnswer = httpError(401, { error: { message: KEY } });
    await test3("openai");
    const rows = await t.db.AuditLog.findAll({ where: { action: "setting.test" }, raw: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target, "openai");
    assert.deepEqual(JSON.parse(rows[0].detail), { verdict: "refused", detail: null });
    assert.ok(!JSON.stringify(await t.db.AuditLog.findAll({ raw: true })).includes(KEY));
    assert.ok(!JSON.stringify(t.logger.lines).includes(KEY));
    assert.deepEqual(t.alerts.calls, [], "a refused test does not raise the key_refused alert");
  });

  test("spotify: both values saved are needed, then the token request is made", async () => {
    await save("SPOTIFY_CLIENT_ID", ID);
    assert.equal((await test3("spotify")).json.error.code, "not_configured");
    await save("SPOTIFY_CLIENT_SECRET", SECRET);
    nextAnswer = SERVICES.spotify.ok;
    const answer = await test3("spotify");
    assert.equal(answer.json.verdict, "accepted");
    assert.equal(requests[0].url, "https://accounts.spotify.com/api/token");
    assert.ok(!answer.text.includes("discarded-token-value"), "the token is discarded");
  });
});

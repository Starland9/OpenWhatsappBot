"use strict";

/**
 * API-key tests of the panel (SET-3 of admin-http-api.md section 2.5, settings-catalog.md section 7,
 * contracts/runtime.md section 14 "keyTests"). The factory never touches `req`/`res`:
 *
 *   const keyTests = createKeyTestsService(deps);
 *   keyTests.services()                         -> [{ id, settings: [KEY...], testable }]
 *   await keyTests.test("openai")               -> { verdict, detail, checkedAt }
 *
 * The saved key is read here (the panel value wins, like `config[KEY]`) and never travels in the request or the
 * answer. One fixed read-only request is sent through `fetchJson` (10 s total timeout); the answer is only
 * `{ verdict: "accepted" | "refused" | "unreachable", detail: "quota" | null, checkedAt }`. The upstream status and
 * body are read to decide the verdict and are never forwarded or logged (OpenAI echoes a masked key in its 401);
 * a failure is logged as the service id, the status and the error code only.
 *
 * Verdicts (settings-catalog.md section 7):
 *   2xx with the expected body                                   accepted
 *   the refusal statuses of the service (400/401/403 per row)    refused
 *   429, or a quota body (insufficient_quota, rateLimited...)    accepted + detail "quota" (the key was recognised)
 *   no answer, DNS, TLS, timeout, 5xx, 408, an HTML page, a status the table does not list, Reddit 403/429
 *                                                                 unreachable
 *
 * Errors (typed, mapped by the HTTP layer): `not_found` (unknown service), `not_testable` (Alpha Vantage, whose
 * endpoint answers real quotes to a fake key, and the services of unused keys), `not_configured` (nothing saved),
 * `rate_limited` with `params.retryAfterMs` (one test per service per 10 s). A test never raises the `key_refused`
 * alert: it does not go through `classifyError`.
 */

const { AdminError } = require("../http/response");

const TIMEOUT_MS = 10000;
const COOLDOWN_MS = 10000;

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const basic = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

/** Services of unused keys (the `api-keys` entries of the inactive group): no test, `not_testable` */
const UNUSED_SERVICES = Object.freeze(["groq", "rmbg", "cloudmersive", "apyhub", "deepai", "waifupics", "puterjs"]);

/**
 * The 8 request recipes plus Alpha Vantage. `refused`: statuses that mean "the key is refused"; `quota(status, data)`:
 * a vendor quota answer; `judge(body)` (optional): the verdict of a 2xx answer.
 */
const RECIPES = [
  {
    id: "openai",
    settings: ["OPENAI_API_KEY"],
    refused: [401, 403],
    build: ([key]) => ({
      url: "https://api.openai.com/v1/models",
      headers: { Authorization: `Bearer ${key}` },
    }),
    quota: (status, data) =>
      isObject(data) && isObject(data.error) && (data.error.code === "insufficient_quota" || data.error.type === "insufficient_quota"),
  },
  {
    id: "gemini",
    settings: ["GEMINI_API_KEY"],
    // 400 API_KEY_INVALID (observed) and 403 PERMISSION_DENIED: classified on the status, not on the message
    refused: [400, 403],
    build: ([key]) => ({
      url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
      headers: { "x-goog-api-key": key }, // the key stays out of the URL
    }),
  },
  {
    id: "weather",
    settings: ["WEATHER_API_KEY"],
    // 401 code 2006; 403 codes 2008 and 2009 refused, 403 code 2007 is the monthly quota
    refused: [401, 403],
    build: ([key]) => ({
      url: "https://api.weatherapi.com/v1/current.json",
      params: { key, q: "Paris", aqi: "no" },
    }),
    quota: (status, data) => status === 403 && isObject(data) && isObject(data.error) && Number(data.error.code) === 2007,
  },
  {
    id: "news",
    settings: ["NEWS_API_KEY"],
    refused: [401, 403],
    build: ([key]) => ({
      url: "https://newsapi.org/v2/top-headlines/sources",
      headers: { "X-Api-Key": key },
    }),
    quota: (status, data) => isObject(data) && (data.code === "rateLimited" || data.code === "apiKeyExhausted"),
  },
  {
    id: "unsplash",
    settings: ["UNSPLASH_API_KEY"],
    refused: [401, 403],
    build: ([key]) => ({
      url: "https://api.unsplash.com/search/photos",
      params: { query: "test", per_page: 1 },
      headers: { Authorization: `Client-ID ${key}` },
    }),
    // demo apps: 50 requests an hour, answered 403 "Rate Limit Exceeded"
    quota: (status, data) => status === 403 && typeof data === "string" && /rate limit/i.test(data),
  },
  {
    id: "giphy",
    settings: ["GIPHY_API_KEY"],
    refused: [401, 403],
    build: ([key]) => ({
      url: "https://api.giphy.com/v1/gifs/trending",
      params: { api_key: key, limit: 1 },
    }),
  },
  {
    id: "spotify",
    settings: ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"],
    refused: [400, 401],
    build: ([id, secret]) => ({
      url: "https://accounts.spotify.com/api/token",
      method: "POST",
      data: "grant_type=client_credentials",
      headers: { Authorization: basic(id, secret), "Content-Type": "application/x-www-form-urlencoded" },
    }),
    judge: tokenVerdict,
  },
  {
    id: "reddit",
    settings: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"],
    // datacenter addresses often get 403/429 without a clear body: those are `unreachable`, not a refusal
    refused: [401],
    quota429: false,
    build: ([id, secret], deps) => ({
      url: "https://www.reddit.com/api/v1/access_token",
      method: "POST",
      data: "grant_type=client_credentials",
      headers: {
        Authorization: basic(id, secret),
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": deps.redditUserAgent(),
      },
    }),
    judge: tokenVerdict,
  },
  { id: "alphavantage", settings: ["ALPHA_VANTAGE_KEY"], testable: false },
];

/** A token endpoint: the token is discarded; an `error` field in a 2xx answer is a refusal */
function tokenVerdict(body) {
  if (isObject(body) && typeof body.access_token === "string" && body.access_token) return { verdict: "accepted", detail: null };
  if (isObject(body) && body.error) return { verdict: "refused", detail: null };
  return { verdict: "unreachable", detail: null };
}

/** Default reading of a 2xx answer: a JSON object */
function defaultVerdict(body) {
  return isObject(body) ? { verdict: "accepted", detail: null } : { verdict: "unreachable", detail: null };
}

function createKeyTestsService(deps = {}) {
  const http = () => deps.http || require("../../utils/http");
  const cooldown = () => deps.cooldown || require("../../utils/cooldown");
  const store = () => deps.settingsStore || require("../../utils/settingsStore");
  const log = () => deps.logger || require("../../utils/logger").createLogger("admin.keytests");
  const now = () => (deps.clock && typeof deps.clock.now === "function" ? deps.clock.now() : Date.now());
  const fetchJson = (...args) => (deps.fetchJson || http().fetchJson)(...args);

  const requestDeps = {
    // Reddit wants the user agent of the plugin that will use the credentials (constant exported by plugins/reddit.js)
    redditUserAgent: () => deps.redditUserAgent || require("../../../plugins/reddit").USER_AGENT,
  };

  /** The saved value of a setting: a test double first, then the settings store (the panel value wins) */
  function readKey(key) {
    if (deps.config && has(deps.config, key)) return deps.config[key];
    return store().get(key);
  }

  function services() {
    return RECIPES.map((recipe) => ({ id: recipe.id, settings: recipe.settings.slice(), testable: recipe.testable !== false }));
  }

  /** Verdict of a failed request (status and body are only read here) */
  function judgeError(recipe, error) {
    const unreachable = { verdict: "unreachable", detail: null };
    if (!error || error.code === "ERR_BAD_RESPONSE_FORMAT") return unreachable; // an HTML page, not an answer
    const status = http().statusOf(error);
    if (status === null || status === undefined) return unreachable; // no response, DNS, TLS, timeout
    const data = error.response ? error.response.data : undefined;

    if (recipe.quota && recipe.quota(status, data)) return { verdict: "accepted", detail: "quota" };
    if (status === 429) return recipe.quota429 === false ? unreachable : { verdict: "accepted", detail: "quota" };
    if (recipe.refused.includes(status)) return { verdict: "refused", detail: null };
    return unreachable; // 5xx, 408 and every status the table does not list
  }

  /** @returns {Promise<{ verdict: string, detail: string|null, checkedAt: string }>} */
  async function test(serviceId) {
    const recipe = RECIPES.find((candidate) => candidate.id === serviceId);
    if (!recipe) {
      if (UNUSED_SERVICES.includes(serviceId)) throw new AdminError("not_testable");
      throw new AdminError("not_found", { params: { resource: "service" } });
    }
    if (recipe.testable === false) throw new AdminError("not_testable");

    const values = recipe.settings.map((key) => {
      const saved = readKey(key);
      return saved === undefined || saved === null ? "" : String(saved).trim();
    });
    if (values.some((value) => value === "")) throw new AdminError("not_configured");

    const wait = cooldown().hit("panel", `keytest:${recipe.id}`, COOLDOWN_MS);
    if (wait) throw new AdminError("rate_limited", { params: { retryAfterMs: wait } });

    const request = recipe.build(values, requestDeps);
    let outcome;
    try {
      const body = await fetchJson(request.url, {
        method: request.method || "GET",
        params: request.params,
        headers: request.headers,
        data: request.data,
        timeoutMs: TIMEOUT_MS,
      });
      outcome = (recipe.judge || defaultVerdict)(body);
    } catch (error) {
      outcome = judgeError(recipe, error);
      if (outcome.verdict === "unreachable") {
        const { status, code } = http().safeLog(error);
        log().warn({ service: recipe.id, status, code }, "key test: service unreachable");
      }
    }
    return { verdict: outcome.verdict, detail: outcome.detail, checkedAt: new Date(now()).toISOString() };
  }

  return { services, test };
}

module.exports = { createKeyTestsService, RECIPES, UNUSED_SERVICES, TIMEOUT_MS, COOLDOWN_MS };

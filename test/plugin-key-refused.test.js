"use strict";
/**
 * The two plugins that answer a refused key before classifyError (W2-C request) still announce it on the core bus:
 *
 *  - reddit: the token endpoint answers 401/403 (or 200 without a token) -> `key:refused { service: "reddit" }`;
 *  - news:   NewsAPI says `apiKeyInvalid` / `apiKeyDisabled` -> `key:refused { service: "news" }`.
 *
 * The user-facing reply does not change (common.not_configured), and nothing is announced for a missing key, an
 * exhausted quota, a network failure or a service that is simply down. Offline: axios is driven by a scripted adapter.
 */

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

const config = fakes.setupEnv({ sudo: "111", lang: "en" });
fakes.stubNetwork();

const axios = require(require.resolve("axios", { paths: [fakes.ROOT] }));
const bus = require("../lib/utils/events");
const { getLang } = require("../lib/utils/language");
const reddit = require("../plugins/reddit");
const news = require("../plugins/news");

const FAKE_ID = "fake-reddit-id-0000";
const FAKE_SECRET = "fake-reddit-secret-1111";
const FAKE_NEWS_KEY = "fake-news-key-2222";

let events;
let script;
let savedAdapter;
let savedConfig;

/** The adapter replies with what `script(url)` returns: { status, data } (HTTP error from 400 up) */
function installAdapter() {
  savedAdapter = axios.defaults.adapter;
  axios.defaults.adapter = async (requestConfig) => {
    const { status, data } = script(requestConfig.url);
    const response = { status, statusText: "", data, headers: {}, config: requestConfig };
    if (status >= 400) {
      throw new axios.AxiosError(`Request failed with status code ${status}`, "ERR_BAD_REQUEST", requestConfig, null, response);
    }
    return response;
  };
}

beforeEach(() => {
  bus.removeAllListeners();
  events = [];
  bus.on("key:refused", (payload) => events.push(payload));
  savedConfig = { id: config.REDDIT_CLIENT_ID, secret: config.REDDIT_CLIENT_SECRET, news: config.NEWS_API_KEY };
  config.REDDIT_CLIENT_ID = FAKE_ID;
  config.REDDIT_CLIENT_SECRET = FAKE_SECRET;
  config.NEWS_API_KEY = FAKE_NEWS_KEY;
  installAdapter();
});

afterEach(() => {
  axios.defaults.adapter = savedAdapter;
  config.REDDIT_CLIENT_ID = savedConfig.id;
  config.REDDIT_CLIENT_SECRET = savedConfig.secret;
  config.NEWS_API_KEY = savedConfig.news;
  bus.removeAllListeners();
});

/** Run a plugin command and return the replies */
async function run(plugin, body, args, command) {
  const message = fakes.makeMessage({ body });
  const originalError = console.error;
  console.error = () => {}; // the plugins log the refusal; the output is not under test
  try {
    await plugin.execute(message, args, { command, rawArgs: args });
  } finally {
    console.error = originalError;
  }
  return fakes.sentTexts(message.client.getSocket());
}

describe("reddit: the token endpoint refuses the credentials", () => {
  for (const status of [401, 403]) {
    test(`HTTP ${status} emits key:refused for reddit and still answers "not configured"`, async () => {
      script = (url) => {
        assert.match(url, /access_token/);
        return { status, data: { message: "Unauthorized" } };
      };
      const before = Date.now();
      const replies = await run(reddit, ".reddit memes", "memes", "reddit");
      assert.deepEqual(replies, [getLang("common.not_configured")]);
      assert.equal(events.length, 1);
      assert.equal(events[0].service, "reddit");
      assert.ok(events[0].at >= before && events[0].at <= Date.now());
      assert.deepEqual(Object.keys(events[0]).sort(), ["at", "service"]);
    });
  }

  test("a 200 without access_token (invalid_grant) is a refusal too", async () => {
    script = () => ({ status: 200, data: { error: "invalid_grant" } });
    const replies = await run(reddit, ".reddit memes", "memes", "reddit");
    assert.deepEqual(replies, [getLang("common.not_configured")]);
    assert.deepEqual(events.map((e) => e.service), ["reddit"]);
  });

  test("nothing is announced when no credentials are configured, nor for a Reddit outage", async () => {
    config.REDDIT_CLIENT_ID = "";
    script = () => assert.fail("no request without credentials");
    assert.deepEqual(await run(reddit, ".reddit memes", "memes", "reddit"), [getLang("common.not_configured")]);
    assert.deepEqual(events, []);

    config.REDDIT_CLIENT_ID = FAKE_ID;
    // a fresh token request is needed: the cache of the previous tests may hold a token, so fail at the token step
    script = () => ({ status: 503, data: "down" });
    const replies = await run(reddit, ".reddit memes", "memes", "reddit");
    assert.equal(replies.length, 1);
    assert.deepEqual(events, [], "a 503 is not a refused key");
  });
});

describe("news: NewsAPI names the problem in `code`", () => {
  const refused = (code) => () => ({ status: 401, data: { status: "error", code, message: "x" } });

  for (const code of ["apiKeyInvalid", "apiKeyDisabled"]) {
    test(`${code} emits key:refused for news, the reply stays "not configured"`, async () => {
      script = refused(code);
      const before = Date.now();
      const replies = await run(news, ".news", "", "news");
      assert.deepEqual(replies, [getLang("common.not_configured")]);
      assert.equal(events.length, 1);
      assert.equal(events[0].service, "news");
      assert.ok(events[0].at >= before);
    });
  }

  test("apiKeyMissing, a quota error and an outage announce nothing", async () => {
    script = refused("apiKeyMissing");
    assert.deepEqual(await run(news, ".news", "", "news"), [getLang("common.not_configured")]);

    script = () => ({ status: 429, data: { status: "error", code: "rateLimited" } });
    assert.deepEqual(await run(news, ".news", "", "news"), [getLang("common.rate_limited")]);

    script = () => ({ status: 500, data: { status: "error", code: "unexpectedError" } });
    assert.equal((await run(news, ".news", "", "news")).length, 1);
    assert.deepEqual(events, []);
  });

  test("no key configured: the reply comes before any request and nothing is announced", async () => {
    config.NEWS_API_KEY = "";
    script = () => assert.fail("no request without a key");
    assert.deepEqual(await run(news, ".news", "", "news"), [getLang("common.not_configured")]);
    assert.deepEqual(events, []);
  });

  test("the stock command keeps its own path: a 401 is announced once as alphavantage, by classifyError", async () => {
    config.ALPHA_VANTAGE_KEY = "fake-av-key-3333";
    try {
      script = () => ({ status: 401, data: {} });
      await run(news, ".stock AAPL", "AAPL", "stock");
      assert.deepEqual(events.map((e) => e.service), ["alphavantage"]);
    } finally {
      config.ALPHA_VANTAGE_KEY = "";
    }
  });
});

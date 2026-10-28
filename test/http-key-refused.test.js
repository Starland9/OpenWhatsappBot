"use strict";
/**
 * T039: lib/utils/http.js announces a refused API key on the core bus.
 *
 *  - classifyError(err, { service }) emits key:refused { service, at } once per classification
 *    when the error is an authentication failure and hasKey is not false;
 *  - nothing is emitted for a network error, for hasKey === false, without `service`,
 *    or for the quota / rate-limit / size cases that classifyError tests first;
 *  - isAuthFailure / statusOf are exported and the existing classifyError results are unchanged.
 */

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111" });

const bus = require("../lib/utils/events");
const http = require("../lib/utils/http");

const { classifyError, isAuthFailure, statusOf, replyKeyFor } = http;

/** @type {Array<object>} */
let events;

beforeEach(() => {
  bus.removeAllListeners();
  events = [];
  bus.on("key:refused", (payload) => events.push(payload));
});

const httpError = (status, extra = {}) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status }, ...extra });
const networkError = (code) => Object.assign(new Error(`connect ${code}`), { code });

test("exports isAuthFailure and statusOf", () => {
  assert.equal(typeof isAuthFailure, "function");
  assert.equal(typeof statusOf, "function");
});

test("statusOf reads response.status, status, statusCode and causes", () => {
  assert.equal(statusOf(httpError(401)), 401);
  assert.equal(statusOf(Object.assign(new Error("x"), { status: 403 })), 403);
  assert.equal(statusOf(Object.assign(new Error("x"), { statusCode: 502 })), 502);
  assert.equal(statusOf(Object.assign(new Error("x"), { cause: httpError(429) })), 429);
  assert.equal(statusOf(new Error("plain")), null);
  assert.equal(statusOf(null), null);
});

test("isAuthFailure: 401, 403, and a 400 whose message names a bad key", () => {
  assert.equal(isAuthFailure(httpError(401)), true);
  assert.equal(isAuthFailure(httpError(403)), true);
  assert.equal(isAuthFailure(Object.assign(new Error("API key not valid. Please pass a valid API key."), { status: 400 })), true);
  assert.equal(isAuthFailure(Object.assign(new Error("Incorrect API key provided"), { status: 400 })), true);
  assert.equal(isAuthFailure(Object.assign(new Error("bad request"), { status: 400 })), false);
  assert.equal(isAuthFailure(httpError(404)), false);
  assert.equal(isAuthFailure(httpError(500)), false);
  assert.equal(isAuthFailure(networkError("ECONNREFUSED")), false);
  assert.equal(isAuthFailure(null), false);
  assert.equal(isAuthFailure(undefined), false);
});

test("a refused key with a service emits key:refused once", () => {
  const before = Date.now();
  const kind = classifyError(httpError(401), { service: "openai" });
  assert.equal(kind, "service_unavailable");
  assert.equal(events.length, 1);
  assert.equal(events[0].service, "openai");
  assert.ok(events[0].at >= before && events[0].at <= Date.now());
  assert.deepEqual(Object.keys(events[0]).sort(), ["at", "service"]);
});

test("each classification emits its own event (the 24 h dedupe belongs to the alerts engine)", () => {
  classifyError(httpError(403), { service: "gemini", hasKey: true });
  classifyError(httpError(403), { service: "gemini", hasKey: true });
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.service), ["gemini", "gemini"]);
});

test("a 400 with an invalid-key message counts as a refusal", () => {
  const err = Object.assign(new Error("API key not valid. Please pass a valid API key."), { status: 400 });
  assert.equal(classifyError(err, { service: "gemini" }), "service_unavailable");
  assert.equal(events.length, 1);
});

test("no event for a network error", () => {
  for (const code of ["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT"]) {
    assert.equal(classifyError(networkError(code), { service: "openai" }), "service_unavailable");
  }
  assert.equal(events.length, 0);
});

test("no event for a server error, a 404 or a plain error", () => {
  assert.equal(classifyError(httpError(500), { service: "openai" }), "service_unavailable");
  assert.equal(classifyError(httpError(404), { service: "openai" }), "service_unavailable");
  assert.equal(classifyError(new Error("boom"), { service: "openai" }), "error");
  assert.equal(events.length, 0);
});

test("no event when hasKey === false (a missing key is not a refused key)", () => {
  assert.equal(classifyError(httpError(401), { service: "openai", hasKey: false }), "not_configured");
  assert.equal(events.length, 0);
});

test("no event without a service", () => {
  assert.equal(classifyError(httpError(401)), "service_unavailable");
  assert.equal(classifyError(httpError(401), { hasKey: true }), "service_unavailable");
  assert.equal(classifyError(httpError(401), { service: "" }), "service_unavailable");
  assert.equal(events.length, 0);
});

test("no event for the cases classifyError settles before the auth check", () => {
  const quota403 = Object.assign(httpError(403), { code: "insufficient_quota" });
  assert.equal(classifyError(quota403, { service: "openai" }), "rate_limited");
  assert.equal(classifyError(httpError(429), { service: "openai" }), "rate_limited");
  assert.equal(classifyError(httpError(413), { service: "openai" }), "media_too_large");
  assert.equal(classifyError(Object.assign(new Error("x"), { code: "MEDIA_TOO_LARGE" }), { service: "openai" }), "media_too_large");
  assert.equal(events.length, 0);
});

test("a throwing key:refused listener never changes the classification", () => {
  bus.on("key:refused", () => {
    throw new Error("listener boom");
  });
  assert.equal(classifyError(httpError(401), { service: "openai" }), "service_unavailable");
  assert.equal(events.length, 1);
});

test("existing classifyError results are unchanged", () => {
  const rows = [
    [null, undefined, "error"],
    [httpError(401), undefined, "service_unavailable"],
    [httpError(401), { hasKey: false }, "not_configured"],
    [httpError(403), { hasKey: true }, "service_unavailable"],
    [httpError(403), { hasKey: false }, "not_configured"],
    [httpError(429), undefined, "rate_limited"],
    [httpError(413), undefined, "media_too_large"],
    [httpError(404), undefined, "service_unavailable"],
    [httpError(404), { userUrl: true }, "error"],
    [httpError(410), { userUrl: true }, "error"],
    [httpError(408), undefined, "service_unavailable"],
    [httpError(502), undefined, "service_unavailable"],
    [httpError(422), undefined, "error"],
    [Object.assign(new Error("x"), { code: "YTDLP_BUSY" }), undefined, "rate_limited"],
    [Object.assign(new Error("x"), { code: "rate_limit_exceeded" }), undefined, "rate_limited"],
    [new Error("RESOURCE_EXHAUSTED: quota"), undefined, "rate_limited"],
    [Object.assign(new Error("API key not valid"), { status: 400 }), { hasKey: false }, "not_configured"],
    [Object.assign(new Error("API key not valid"), { status: 400 }), undefined, "service_unavailable"],
    [networkError("ENOTFOUND"), undefined, "service_unavailable"],
    [Object.assign(new Error("x"), { name: "AbortError" }), undefined, "service_unavailable"],
    [new TypeError("fetch failed"), undefined, "service_unavailable"],
    [new Error("socket hang up"), undefined, "service_unavailable"],
    [new Error("something else"), undefined, "error"],
  ];
  for (const [err, opts, expected] of rows) {
    assert.equal(classifyError(err, opts), expected, `${err && err.message} ${JSON.stringify(opts)}`);
  }
  assert.equal(events.length, 0, "no event without a service option");
  assert.equal(replyKeyFor("service_unavailable"), "common.service_unavailable");
});

"use strict";
/**
 * Transport rule of the messaging API (feature 004, contracts/runtime.md section 15.10 and 18, public-api.md 1.2):
 * `trustProxy.clientAddress`, the local-request test, the plain-HTTP network list re-read on every request, and the
 * composed `transportAllowed`. Requests are plain objects (`socket.remoteAddress`, `headers`): no network.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { createTrustProxy, keyOf } = require("../lib/admin/http/trustProxy");
const { createTransport, isLoopback } = require("../lib/api/transport");

const req = (peer, headers = {}, extra = {}) => ({ socket: { remoteAddress: peer, ...extra }, headers });

function transportWith({ trust = "", plain = [] } = {}) {
  const state = { trust, plain };
  const proxy = createTrustProxy({ read: () => state.trust });
  const apiState = { plainHttpFrom: () => state.plain };
  return { state, proxy, ...createTransport({ trust: proxy, apiState }) };
}

describe("trustProxy.clientAddress", () => {
  test("is the unmapped socket address when no proxy is trusted", () => {
    const trust = createTrustProxy({ value: "" });
    assert.equal(trust.clientAddress(req("203.0.113.9")), "203.0.113.9");
    assert.equal(trust.clientAddress(req("::ffff:203.0.113.9")), "203.0.113.9");
    assert.equal(trust.clientAddress(req("2001:db8:1:2:aaaa:bbbb:cccc:dddd")), "2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    assert.equal(trust.clientAddress(req("203.0.113.9", { "x-forwarded-for": "198.51.100.1" })), "203.0.113.9", "forwarded headers are ignored");
    assert.equal(trust.clientAddress(req(undefined)), "");
  });

  test("behind a trusted proxy it is the right-most forwarded entry that is not itself trusted", () => {
    const trust = createTrustProxy({ value: "10.0.0.0/8" });
    const peer = "10.0.0.5";
    assert.equal(trust.clientAddress(req(peer, { "x-forwarded-for": "198.51.100.7" })), "198.51.100.7");
    assert.equal(trust.clientAddress(req(peer, { "x-forwarded-for": "1.1.1.1, 198.51.100.7" })), "198.51.100.7");
    assert.equal(trust.clientAddress(req(peer, { "x-forwarded-for": "198.51.100.7, 10.0.0.9" })), "198.51.100.7", "a trusted hop is skipped");
    assert.equal(trust.clientAddress(req(peer, { "x-forwarded-for": "10.0.0.8, 10.0.0.9" })), "10.0.0.8", "all trusted: the left-most");
    assert.equal(trust.clientAddress(req(peer, { "x-forwarded-for": "::ffff:198.51.100.7" })), "198.51.100.7");
  });

  test("garbage from the proxy fails closed on the socket", () => {
    const trust = createTrustProxy({ value: "10.0.0.0/8" });
    for (const header of ["not-an-ip", "198.51.100.7, garbage", "198.51.100.7, "]) {
      const out = trust.clientAddress(req("10.0.0.5", { "x-forwarded-for": header }));
      assert.ok(out === "10.0.0.5" || out === "198.51.100.7", header);
    }
    assert.equal(trust.clientAddress(req("10.0.0.5", { "x-forwarded-for": "198.51.100.7, garbage" })), "10.0.0.5");
    assert.equal(trust.clientAddress(req("10.0.0.5", { "x-forwarded-for": "garbage" })), "10.0.0.5");
  });

  test("originKey(req) equals keyOf(clientAddress(req)) for every shape", () => {
    const trust = createTrustProxy({ value: "10.0.0.0/8" });
    const cases = [
      req("203.0.113.9"),
      req("::ffff:203.0.113.9"),
      req("2001:db8:1:2:aaaa:bbbb:cccc:dddd"),
      req("10.0.0.5", { "x-forwarded-for": "198.51.100.7" }),
      req("10.0.0.5", { "x-forwarded-for": "2001:db8:1:2:aaaa:bbbb:cccc:dddd" }),
      req("10.0.0.5", { "x-forwarded-for": "garbage" }),
      req(undefined),
    ];
    for (const r of cases) assert.equal(trust.originKey(r), keyOf(trust.clientAddress(r)));
    assert.equal(trust.originKey(req("2001:db8:1:2:aaaa:bbbb:cccc:dddd")), "2001:db8:1:2::/64");
  });
});

describe("isLoopback", () => {
  test("127/8, ::1 and mapped forms only", () => {
    for (const ok of ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) assert.equal(isLoopback(ok), true, ok);
    for (const no of ["", "128.0.0.1", "10.0.0.1", "::2", "fe80::1", "172.17.0.1", "0.0.0.0", "localhost", undefined]) assert.equal(isLoopback(no), false, String(no));
  });
});

describe("isLocalRequest", () => {
  test("a direct loopback peer without forwarded headers is local", () => {
    const t = transportWith();
    for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(t.isLocalRequest(req(peer)), true, peer);
  });

  test("an untrusted loopback proxy adding X-Forwarded-* is not local", () => {
    const t = transportWith();
    for (const name of ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "forwarded", "x-real-ip"]) {
      assert.equal(t.isLocalRequest(req("127.0.0.1", { [name]: "127.0.0.1" })), false, name);
    }
  });

  test("a trusted loopback proxy forwarding a public client is not local; forwarding a loopback client it is", () => {
    const t = transportWith({ trust: "loopback" });
    assert.equal(t.isLocalRequest(req("127.0.0.1", { "x-forwarded-for": "203.0.113.9" })), false);
    assert.equal(t.isLocalRequest(req("127.0.0.1", { "x-forwarded-for": "127.0.0.1" })), true);
    assert.equal(t.isLocalRequest(req("127.0.0.1", { "x-forwarded-for": "10.1.2.3" })), false);
  });

  test("the host's own interface addresses and private peers are never local", () => {
    const t = transportWith();
    for (const peer of ["172.17.0.1", "192.168.1.10", "10.0.0.1", "203.0.113.9", "fe80::1", "::2"]) {
      assert.equal(t.isLocalRequest(req(peer)), false, peer);
    }
  });

  test("a non-loopback peer is not local even when a trusted proxy claims a loopback client", () => {
    const t = transportWith({ trust: "10.0.0.0/8" });
    assert.equal(t.isLocalRequest(req("10.0.0.5", { "x-forwarded-for": "127.0.0.1" })), false);
  });
});

describe("isPlainHttpAllowed: the list is read on every request", () => {
  test("an empty list admits nobody (an empty compiled list would mean 'no restriction')", () => {
    const t = transportWith({ plain: [] });
    assert.equal(t.isPlainHttpAllowed(req("10.0.0.5")), false);
    assert.equal(t.isPlainHttpAllowed(req("203.0.113.9")), false);
  });

  test("a listed private address or range is admitted, others are not", () => {
    const t = transportWith({ plain: ["10.0.0.0/8", "192.168.1.20", "fd00::/8"] });
    assert.equal(t.isPlainHttpAllowed(req("10.20.30.40")), true);
    assert.equal(t.isPlainHttpAllowed(req("192.168.1.20")), true);
    assert.equal(t.isPlainHttpAllowed(req("192.168.1.21")), false);
    assert.equal(t.isPlainHttpAllowed(req("fd12::5")), true);
    assert.equal(t.isPlainHttpAllowed(req("::ffff:10.1.1.1")), true, "mapped forms are unmapped");
    assert.equal(t.isPlainHttpAllowed(req("203.0.113.9")), false);
  });

  test("an entry widened or removed between two requests applies at once", () => {
    const t = transportWith({ plain: ["10.0.0.5"] });
    assert.equal(t.isPlainHttpAllowed(req("10.0.0.6")), false);
    t.state.plain = ["10.0.0.0/24"];
    assert.equal(t.isPlainHttpAllowed(req("10.0.0.6")), true, "widened");
    t.state.plain = ["10.0.1.0/24"];
    assert.equal(t.isPlainHttpAllowed(req("10.0.0.6")), false, "narrowed");
    t.state.plain = [];
    assert.equal(t.isPlainHttpAllowed(req("10.0.1.6")), false, "removed");
  });

  test("a non-private entry is dropped, fail closed", () => {
    for (const entry of ["8.8.8.8", "0.0.0.0/0", "::/0", "127.0.0.1", "203.0.113.0/24", "172.15.0.0/16", "not-an-address"]) {
      const t = transportWith({ plain: [entry] });
      assert.equal(t.isPlainHttpAllowed(req("8.8.8.8")), false, entry);
      assert.equal(t.isPlainHttpAllowed(req("127.0.0.1")), false, entry);
      assert.equal(t.isPlainHttpAllowed(req("10.0.0.5")), false, entry);
    }
    const mixed = transportWith({ plain: ["8.8.8.8", "10.0.0.0/8"] });
    assert.equal(mixed.isPlainHttpAllowed(req("10.1.1.1")), true, "the private entry stays");
    assert.equal(mixed.isPlainHttpAllowed(req("8.8.8.8")), false);
  });

  test("an untrusted forwarded header disables the exception; a trusted proxy's forwarded client is judged", () => {
    const t = transportWith({ plain: ["10.0.0.0/8"] });
    assert.equal(t.isPlainHttpAllowed(req("10.0.0.5", { "x-forwarded-for": "10.0.0.6" })), false);
    const trusted = transportWith({ trust: "192.168.0.0/16", plain: ["10.0.0.0/8"] });
    assert.equal(trusted.isPlainHttpAllowed(req("192.168.1.2", { "x-forwarded-for": "10.9.9.9" })), true);
    assert.equal(trusted.isPlainHttpAllowed(req("192.168.1.2", { "x-forwarded-for": "203.0.113.9" })), false);
  });

  test("a broken apiState value is treated as an empty list", () => {
    const proxy = createTrustProxy({ value: "" });
    const t = createTransport({ trust: proxy, apiState: { plainHttpFrom: () => null } });
    assert.equal(t.isPlainHttpAllowed(req("10.0.0.5")), false);
    const none = createTransport({ trust: proxy, apiState: {} });
    assert.equal(none.isPlainHttpAllowed(req("10.0.0.5")), false);
  });
});

describe("transportAllowed", () => {
  test("accepts an encrypted socket, a trusted X-Forwarded-Proto: https, a local request and a plainHttpFrom address", () => {
    const t = transportWith({ trust: "10.0.0.0/8", plain: ["172.16.0.0/12"] });
    assert.equal(t.transportAllowed(req("203.0.113.9", {}, { encrypted: true })), true);
    assert.equal(t.transportAllowed(req("10.0.0.5", { "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9" })), true);
    assert.equal(t.transportAllowed(req("127.0.0.1")), true);
    assert.equal(t.transportAllowed(req("172.20.1.1")), true);
  });

  test("refuses everything else: public plain HTTP, a forged proto from an untrusted peer, plain http behind a proxy", () => {
    const t = transportWith({ trust: "10.0.0.0/8", plain: ["172.16.0.0/12"] });
    assert.equal(t.transportAllowed(req("203.0.113.9")), false);
    assert.equal(t.transportAllowed(req("203.0.113.9", { "x-forwarded-proto": "https" })), false, "an untrusted peer cannot claim https");
    assert.equal(t.transportAllowed(req("10.0.0.5", { "x-forwarded-proto": "http", "x-forwarded-for": "203.0.113.9" })), false);
    assert.equal(t.transportAllowed(req("10.0.0.5", { "x-forwarded-for": "203.0.113.9" })), false);
    assert.equal(t.transportAllowed(req("192.168.1.1")), false);
  });

  test("an entry removed from the list is refused again on the next request", () => {
    const t = transportWith({ plain: ["10.0.0.5"] });
    assert.equal(t.transportAllowed(req("10.0.0.5")), true);
    t.state.plain = [];
    assert.equal(t.transportAllowed(req("10.0.0.5")), false);
  });
});

"use strict";
/**
 * Feature 004 (messaging API): the SSRF battery of the URL fetcher (SC-007; specs/004-messaging-api/contracts/
 * runtime.md section 9, public-api.md 8.1 and 8.2, research.md X16 and X17). No network and no clock: the resolver
 * and the connector are injected, and a spy `request` proves that a refused target NEVER opens a connection
 * (`callCount === 0`, RT-95) and that an accepted one connects to the validated address, never to the name.
 */

const { test, describe, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111" });

const urlFetch = require("../lib/messaging/urlFetch");
const { MessagingError } = require("../lib/messaging/errors");

const { createUrlFetcher, validateUrl, isPublicAddress, PUBLIC_RANGES } = urlFetch;

const PUBLIC_IP = "93.184.216.34";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
const roots = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-urlfetch-"));
  roots.push(dir);
  return dir;
}

after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------
// Fakes: a resolver that records, a connector spy that scripts the responses
// ---------------------------------------------------------------------------------------------------------

/** hosts: name -> address list, or a function (call index) -> list / Error; unknown names resolve to PUBLIC_IP */
function fakeResolver(hosts = {}) {
  const calls = [];
  const resolve = async (host) => {
    calls.push(host);
    const entry = Object.hasOwn(hosts, host) ? hosts[host] : [PUBLIC_IP];
    const value = await (typeof entry === "function" ? entry(calls.filter((h) => h === host).length - 1) : entry);
    if (value instanceof Error) throw value;
    return value.map((address) => (typeof address === "string" ? { address, family: address.includes(":") ? 6 : 4 } : address));
  };
  resolve.calls = calls;
  return resolve;
}

/** A response: Readable body with statusCode and lower-case headers */
function reply({ status = 200, headers = {}, body = Buffer.alloc(0), chunks, stream }) {
  const res = stream || Readable.from(chunks || [body], { objectMode: false });
  res.statusCode = status;
  res.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return res;
}

/** A body that never ends: `count` chunks, then silence */
function hanging(first) {
  const stream = new Readable({ read() {} });
  if (first) stream.push(first);
  return stream;
}

/** An endless body of 64 KiB chunks; `served()` is how many bytes were pulled */
function endless() {
  let served = 0;
  const stream = new Readable({
    read() {
      served += 65536;
      this.push(Buffer.alloc(65536, 0x61));
    },
  });
  stream.served = () => served;
  return stream;
}

/** handler(options, index) -> reply | { error } | Promise of those; spy.calls holds the options of each connection */
function fakeRequest(handler) {
  const calls = [];
  const requests = [];
  const spy = (options, callback) => {
    const index = calls.length;
    calls.push(options);
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = () => {
      req.destroyed = true;
      return req;
    };
    req.end = () => {
      setImmediate(async () => {
        if (req.destroyed) return;
        let out;
        try {
          out = await handler(options, index);
        } catch (err) {
          out = { error: err };
        }
        if (req.destroyed) return;
        if (out && out.error) req.emit("error", out.error);
        else if (out && out.hang) return;
        else callback(out);
      });
    };
    requests.push(req);
    return req;
  };
  Object.defineProperty(spy, "callCount", { get: () => calls.length });
  spy.calls = calls;
  spy.requests = requests;
  return spy;
}

let dir;
beforeEach(() => {
  dir = tmpDir();
});
afterEach(() => {
  // the temporary file is removed on EVERY error path, and a success leaves exactly its own file
  assert.ok(fs.readdirSync(dir).every((name) => name.endsWith(".part")));
});

function fetcher({ hosts, handler, ...options } = {}) {
  const resolve = fakeResolver(hosts);
  const request = fakeRequest(handler || (() => reply({ body: PNG, headers: { "content-type": "image/png" } })));
  const instance = createUrlFetcher({ resolve, request, tmpDir: dir, ...options });
  return { ...instance, resolve, request };
}

async function refused(promise, code, params) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof MessagingError, `MessagingError expected, got ${err && err.name}: ${err && err.message}`);
    assert.equal(err.code, code);
    if (params) assert.deepEqual(err.params, params);
    // RT-96: nothing of the URL, the redirect targets or the headers in the error
    assert.doesNotMatch(JSON.stringify({ message: err.message, params: err.params, fields: err.fields }), /example|localhost|127\.0|10\.0|169\.254|user:|secret/i);
    return err;
  }
  assert.fail(`${code} expected`);
}

const noPartFiles = () => assert.deepEqual(fs.readdirSync(dir), []);

// ---------------------------------------------------------------------------------------------------------
// validateUrl
// ---------------------------------------------------------------------------------------------------------

describe("validateUrl: the syntactic rules, one reason each", () => {
  test("accepted: https, a DNS name with a dot, the default port", () => {
    for (const ok of ["https://example.com/a.png", "https://sub.example.co.uk:443/x?y=1#z", "HTTPS://Example.COM/", "https://example.com./a", "https://xn--bcher-kva.example/", "https://a.b/"]) {
      assert.ok(validateUrl(ok) instanceof URL, ok);
    }
    assert.equal(validateUrl("https://example.com:443/a").port, "");
  });

  const CASES = {
    scheme: ["http://example.com/a", "ftp://example.com/a", "file:///etc/passwd", "//example.com/a", "example.com/a", "javascript:alert(1)", "data:text/plain,hi", "", "   ", "not a url", "HTTP://EXAMPLE.COM"],
    credentials: ["https://user:pass@example.com/", "https://user@example.com/", "https://:pw@example.com/", "https://user:pass@127.0.0.1/"],
    port: ["https://example.com:8443/", "https://example.com:80/", "https://example.com:444/", "https://example.com:0/", "https://example.com:65535/"],
    host: [
      // IP literals of every spelling
      "https://127.0.0.1/",
      "https://2130706433/",
      "https://0x7f.1/",
      "https://127.1/",
      "https://0177.0.0.1/",
      "https://[::1]/",
      "https://[::ffff:127.0.0.1]/",
      "https://[2001:db8::1]/",
      "https://8.8.8.8/",
      "https://[2606:4700:4700::1111]/",
      "https://1.2.3.4.5/",
      // internal names
      "https://localhost/",
      "https://LOCALHOST/",
      "https://localhost./",
      "https://a.localhost/",
      "https://app.local/",
      "https://db.internal/",
      "https://corp.localdomain/",
      "https://x.y.LOCAL./",
      // no dot, too long
      "https://intranet/",
      "https://example/",
      `https://${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(20)}.com/`,
      "https://exa mple.com/",
    ],
  };

  for (const [reason, urls] of Object.entries(CASES)) {
    test(`reason "${reason}"`, () => {
      for (const bad of urls) {
        assert.throws(
          () => validateUrl(bad),
          (err) => {
            assert.ok(err instanceof MessagingError, bad);
            assert.equal(err.code, "url_forbidden", bad);
            assert.deepEqual(err.params, { reason }, bad);
            return true;
          },
          bad,
        );
      }
    });
  }

  test("a non-string is refused", () => {
    for (const bad of [null, undefined, 12, {}, ["https://example.com/"]]) assert.throws(() => validateUrl(bad), (err) => err.code === "url_forbidden");
  });
});

// ---------------------------------------------------------------------------------------------------------
// isPublicAddress
// ---------------------------------------------------------------------------------------------------------

describe("isPublicAddress and PUBLIC_RANGES", () => {
  const BLOCKED = [
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.0.1", "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::2", "::127.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe",
    "64:ff9b::a00:1", "64:ff9b::169.254.169.254", "64:ff9b:1::1", "100::1", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:db8::1", "2002:7f00:1::", "2002:a00:1::1",
    "fc00::1", "fd00::1", "fdff:ffff::1", "fe80::1", "febf::1", "fec0::1", "ff02::1", "ff00::",
  ];
  const ALLOWED = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "11.0.0.1", "192.0.1.1", "198.17.255.255", "198.20.0.1", "223.255.255.255", "2606:4700:4700::1111", "2a00:1450:4007::200e", "::ffff:8.8.8.8", "::ffff:808:808"];

  test("every private, loopback, link-local, CGNAT, multicast, reserved, documentation, NAT64, 6to4, Teredo range is refused, in IPv4 and IPv6 and mapped forms", () => {
    for (const ip of BLOCKED) assert.equal(isPublicAddress(ip), false, ip);
  });

  test("public addresses (and the edges just outside the ranges) are accepted", () => {
    for (const ip of ALLOWED) assert.equal(isPublicAddress(ip), true, ip);
  });

  test("anything unparsable, with a zone id, or not a string is not public", () => {
    for (const bad of ["", "abc", "1.2.3", "999.1.1.1", "1.2.3.4.5", "127.1", "0x7f.0.0.1", "010.0.0.1", "fe80::1%eth0", "::ffff:8.8.8.8%lo", " ", null, undefined, 12, {}, ["8.8.8.8"]]) {
      assert.equal(isPublicAddress(bad), false, String(bad));
    }
  });

  test("PUBLIC_RANGES is frozen data with the exact lists of the contract; ::ffff:0:0/96 is deliberately absent", () => {
    assert.ok(Object.isFrozen(PUBLIC_RANGES) && Object.isFrozen(PUBLIC_RANGES.ipv4) && Object.isFrozen(PUBLIC_RANGES.ipv6));
    assert.deepEqual(PUBLIC_RANGES.ipv4, ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"]);
    assert.deepEqual(PUBLIC_RANGES.ipv6, ["::/128", "::1/128", "::/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/32", "2001:db8::/32", "2002::/16", "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8"]);
    assert.ok(!PUBLIC_RANGES.ipv6.includes("::ffff:0:0/96"));
  });
});

// ---------------------------------------------------------------------------------------------------------
// The battery: a refused target never produces a connection (RT-95, SC-007)
// ---------------------------------------------------------------------------------------------------------

describe("refused targets: request.callCount === 0", () => {
  test("every syntactic refusal fails before the resolver and before any connection", async () => {
    const all = [
      ["scheme", ["http://example.com/a", "ftp://example.com/", "example.com/a"]],
      ["credentials", ["https://user:pass@example.com/"]],
      ["port", ["https://example.com:8443/"]],
      ["host", ["https://2130706433/", "https://0x7f.1/", "https://127.1/", "https://[::1]/", "https://localhost/", "https://a.localhost/", "https://a.local/", "https://a.internal/", "https://a.localdomain/", "https://intranet/", `https://${"a.".repeat(130)}com/`]],
    ];
    for (const [reason, urls] of all) {
      for (const url of urls) {
        const f = fetcher();
        await refused(f.fetchMedia(url), "url_forbidden", { reason });
        assert.equal(f.request.callCount, 0, url);
        assert.equal(f.resolve.calls.length, 0, `${url}: no DNS query either`);
        assert.equal(await f.fetchPreview(url), null);
        assert.equal(f.request.callCount, 0, url);
      }
    }
  });

  const NON_PUBLIC = [
    "10.1.2.3", "127.0.0.1", "169.254.169.254", "100.64.1.1", "224.0.0.251", "240.0.0.1", "192.168.1.10", "172.16.5.5", "198.18.0.9", "192.0.2.55", "203.0.113.9", "0.0.0.0",
    "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::a00:1", "2002:7f00:1::", "2001::1", "::", "ff02::1", "2001:db8::5",
  ];

  test("a name resolving to a non-public address is url_forbidden/host, whatever the range", async () => {
    for (const address of NON_PUBLIC) {
      const f = fetcher({ hosts: { "files.example.com": [address] } });
      await refused(f.fetchMedia("https://files.example.com/a.png"), "url_forbidden", { reason: "host" });
      assert.equal(f.request.callCount, 0, address);
      assert.deepEqual(f.resolve.calls, ["files.example.com"], "resolved once");
      assert.equal(await f.fetchPreview("https://files.example.com/"), null);
      assert.equal(f.request.callCount, 0, address);
    }
  });

  test("one private record among several refuses the whole name (round-robin rebinding)", async () => {
    for (const records of [[PUBLIC_IP, "10.0.0.5"], ["10.0.0.5", PUBLIC_IP], [PUBLIC_IP, "2606:4700:4700::1111", "::1"], [PUBLIC_IP, "169.254.169.254"]]) {
      const f = fetcher({ hosts: { "mixed.example.com": records } });
      await refused(f.fetchMedia("https://mixed.example.com/"), "url_forbidden", { reason: "host" });
      assert.equal(f.request.callCount, 0);
    }
  });

  test("no address, ENOTFOUND, EAI_AGAIN and any other resolver failure are url_forbidden/host, not url_unreachable (no oracle)", async () => {
    const failures = [[], Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }), Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" }), Object.assign(new Error("x"), { code: "ESERVFAIL" }), new Error("boom")];
    for (const failure of failures) {
      const f = fetcher({ hosts: { "gone.example.com": failure } });
      await refused(f.fetchMedia("https://gone.example.com/"), "url_forbidden", { reason: "host" });
      assert.equal(f.request.callCount, 0);
    }
  });

  test("an address given as a plain string, or an entry without an address, is handled", async () => {
    const g = createUrlFetcher({ resolve: async () => [{}], request: fakeRequest(() => reply({})), tmpDir: dir });
    await refused(g.fetchMedia("https://weird.example.com/"), "url_forbidden", { reason: "host" });
    const h = createUrlFetcher({ resolve: async () => "93.184.216.34", request: fakeRequest(() => reply({})), tmpDir: dir });
    await refused(h.fetchMedia("https://weird.example.com/"), "url_forbidden", { reason: "host" });
  });
});

describe("accepted targets: the connection goes to the validated address, never the name", () => {
  test("options of the connection (agent: false pinned), fixed headers, nothing from the caller", async () => {
    const f = fetcher();
    const out = await f.fetchMedia("https://Cdn.Example.com/path/a.png?x=1&y=2#frag", { kinds: ["image"] });
    assert.equal(f.request.callCount, 1);
    assert.deepEqual(f.resolve.calls, ["cdn.example.com"]);
    const o = f.request.calls[0];
    assert.equal(o.host, PUBLIC_IP, "the validated address, not the name");
    assert.notEqual(o.host, "cdn.example.com");
    assert.equal(o.servername, "cdn.example.com");
    assert.equal(o.headers.Host, "cdn.example.com");
    assert.equal(o.agent, false);
    assert.equal(o.rejectUnauthorized, true);
    assert.equal(o.method, "GET");
    assert.equal(o.port, 443);
    assert.equal(o.path, "/path/a.png?x=1&y=2");
    assert.equal(o.maxHeaderSize, 16 * 1024);
    assert.equal(o.headers["Accept-Encoding"], "identity");
    assert.equal(o.headers["User-Agent"], "OpenWhatsappBot");
    assert.deepEqual(Object.keys(o.headers).sort(), ["Accept", "Accept-Encoding", "Host", "User-Agent"]);
    for (const forbidden of ["Cookie", "Authorization", "Proxy-Authorization", "Referer", "X-Forwarded-For"]) assert.ok(!(forbidden in o.headers), forbidden);
    assert.ok(!("proxy" in o) && !("lookup" in o));
    assert.equal(out.size, PNG.length);
    assert.equal(out.contentType, "image/png");
    assert.equal(out.sha256, crypto.createHash("sha256").update(PNG).digest("hex"));
    assert.deepEqual(fs.readFileSync(out.path), PNG);
    assert.ok(out.path.startsWith(dir) && out.path.endsWith(".part"));
    assert.equal(fs.statSync(out.path).mode & 0o777, 0o600);
  });

  test("an IPv6 address is connected to as is; the trailing dot of the name is not sent", async () => {
    const f = fetcher({ hosts: { "v6.example.com": ["2606:4700:4700::1111"] } });
    const out = await f.fetchMedia("https://v6.example.com./a.png");
    assert.equal(f.request.calls[0].host, "2606:4700:4700::1111");
    assert.equal(f.request.calls[0].headers.Host, "v6.example.com");
    assert.equal(f.request.calls[0].servername, "v6.example.com");
    assert.equal(out.size, PNG.length);
  });

  test("an environment proxy is never used: agent is pinned to false even when the environment asks for one", async () => {
    const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY };
    process.env.HTTPS_PROXY = "http://127.0.0.1:1";
    process.env.NODE_USE_ENV_PROXY = "1";
    try {
      const f = fetcher();
      await f.fetchMedia("https://example.com/a.png");
      assert.strictEqual(f.request.calls[0].agent, false);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("a rebinding resolver is consulted ONCE per hop and the connection is to the checked address", async () => {
    // the name answers public the first time and private afterwards: the connection of hop 1 is still the public one
    const f = fetcher({
      hosts: { "rebind.example.com": (n) => (n === 0 ? [PUBLIC_IP] : ["127.0.0.1"]) },
      handler: (options, index) => (index === 0 ? reply({ status: 302, headers: { location: "https://rebind.example.com/next" } }) : reply({ body: PNG })),
    });
    // hop 2 re-resolves the name: the second answer is private, so the redirect is refused with its own reason
    await refused(f.fetchMedia("https://rebind.example.com/start"), "url_forbidden", { reason: "host" });
    assert.equal(f.request.callCount, 1, "only the first (public) hop connected");
    assert.equal(f.request.calls[0].host, PUBLIC_IP);
    assert.deepEqual(f.resolve.calls, ["rebind.example.com", "rebind.example.com"], "one resolution per hop");

    const g = fetcher({ hosts: { "rebind.example.com": (n) => (n === 0 ? [PUBLIC_IP] : ["127.0.0.1"]) } });
    await g.fetchMedia("https://rebind.example.com/once");
    assert.deepEqual(g.resolve.calls, ["rebind.example.com"], "a single hop resolves a single time");
    assert.deepEqual(g.request.calls.map((o) => o.host), [PUBLIC_IP]);
  });

  test("when the first address does not connect the next validated one is tried (never a name, never an unchecked address)", async () => {
    const f = fetcher({
      hosts: { "dual.example.com": ["2606:4700:4700::1111", PUBLIC_IP] },
      handler: (options, index) => (index === 0 ? { error: Object.assign(new Error("ENETUNREACH"), { code: "ENETUNREACH" }) } : reply({ body: PNG })),
    });
    const out = await f.fetchMedia("https://dual.example.com/a.png");
    assert.deepEqual(f.request.calls.map((o) => o.host), ["2606:4700:4700::1111", PUBLIC_IP]);
    assert.equal(out.size, PNG.length);
    const failing = fetcher({ hosts: { "dual.example.com": [PUBLIC_IP, "2606:4700:4700::1111"] }, handler: () => ({ error: new Error("ECONNREFUSED") }) });
    await refused(failing.fetchMedia("https://dual.example.com/a.png"), "url_unreachable");
    assert.equal(failing.request.callCount, 2);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------------------------------------

describe("redirects: manual, at most 3, every hop re-validated from the first rule", () => {
  const redirectTo = (location, status = 302, extra = {}) => reply({ status, headers: { location, ...extra } });

  test("301, 302, 303, 307 and 308 are followed (relative and absolute Location), the final 200 is the body", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const f = fetcher({
        handler: (options, index) => (index === 0 ? redirectTo("/moved?x=1", status) : index === 1 ? redirectTo("https://other.example.org/final.png", status) : reply({ body: PNG })),
      });
      const out = await f.fetchMedia("https://example.com/start");
      assert.equal(out.size, PNG.length, String(status));
      assert.equal(f.request.callCount, 3);
      assert.deepEqual(f.resolve.calls, ["example.com", "example.com", "other.example.org"]);
      assert.equal(f.request.calls[1].path, "/moved?x=1");
      assert.equal(f.request.calls[2].headers.Host, "other.example.org");
      assert.equal(f.request.calls[2].path, "/final.png");
    }
  });

  test("three redirects are followed; the fourth is url_forbidden/redirects", async () => {
    const three = fetcher({ handler: (options, index) => (index < 3 ? redirectTo(`/hop${index + 1}`) : reply({ body: PNG })) });
    assert.equal((await three.fetchMedia("https://example.com/hop0")).size, PNG.length);
    assert.equal(three.request.callCount, 4);

    const four = fetcher({ handler: (options, index) => redirectTo(`/hop${index + 1}`) });
    await refused(four.fetchMedia("https://example.com/hop0"), "url_forbidden", { reason: "redirects" });
    assert.equal(four.request.callCount, 4, "no fifth request");
    const preview = fetcher({ handler: (options, index) => redirectTo(`/hop${index + 1}`) });
    assert.equal(await preview.fetchPreview("https://example.com/hop0"), null);
  });

  test("a refused target gives its own reason, and no connection is opened for it", async () => {
    const targets = {
      scheme: ["http://example.com/a", "ftp://example.com/a"],
      credentials: ["https://user:pw@example.com/a"],
      port: ["https://example.com:8443/a"],
      host: ["https://127.0.0.1/a", "https://localhost/a", "https://[::1]/a", "https://2130706433/a", "https://intranet/a", "https://secret.internal/a"],
    };
    for (const [reason, locations] of Object.entries(targets)) {
      for (const location of locations) {
        const f = fetcher({ handler: () => redirectTo(location) });
        await refused(f.fetchMedia("https://example.com/start"), "url_forbidden", { reason });
        assert.equal(f.request.callCount, 1, `${location}: only the first hop connected`);
      }
    }
  });

  test("a redirect to a name that resolves to a private address is refused after one connection", async () => {
    const f = fetcher({ hosts: { "evil.example.org": ["169.254.169.254"] }, handler: () => redirectTo("https://evil.example.org/latest/meta-data/") });
    await refused(f.fetchMedia("https://example.com/start"), "url_forbidden", { reason: "host" });
    assert.equal(f.request.callCount, 1);
    assert.deepEqual(f.resolve.calls, ["example.com", "evil.example.org"]);
  });

  test("a redirect without a Location is unreachable; a Set-Cookie is ignored and no cookie or credential is forwarded", async () => {
    const none = fetcher({ handler: () => reply({ status: 302 }) });
    await refused(none.fetchMedia("https://example.com/a"), "url_unreachable");
    const f = fetcher({
      handler: (options, index) => (index === 0 ? redirectTo("/next", 302, { "set-cookie": "session=abc; Path=/", authorization: "Bearer x" }) : reply({ body: PNG })),
    });
    await f.fetchMedia("https://example.com/a");
    for (const o of f.request.calls) {
      assert.ok(!("Cookie" in o.headers) && !("Authorization" in o.headers));
      assert.ok(!Object.keys(o.headers).some((k) => /cookie|authorization/i.test(k)));
    }
  });

  test("the redirect body is not read: the response is destroyed", async () => {
    let first;
    const f = fetcher({
      handler: (options, index) => {
        if (index === 0) {
          first = redirectTo("/next");
          return first;
        }
        return reply({ body: PNG });
      },
    });
    await f.fetchMedia("https://example.com/a");
    assert.equal(first.destroyed, true);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Status, encoding, connection errors
// ---------------------------------------------------------------------------------------------------------

describe("responses other than a plain 200", () => {
  test("any status but 200, a Content-Encoding other than identity, resets and TLS failures are url_unreachable", async () => {
    for (const status of [204, 206, 304, 400, 401, 403, 404, 410, 429, 500, 502, 503]) {
      const f = fetcher({ handler: () => reply({ status, body: Buffer.from("x") }) });
      await refused(f.fetchMedia("https://example.com/a"), "url_unreachable");
    }
    for (const encoding of ["gzip", "br", "deflate", "GZIP", "identity, gzip"]) {
      const f = fetcher({ handler: () => reply({ headers: { "content-encoding": encoding }, body: PNG }) });
      await refused(f.fetchMedia("https://example.com/a"), "url_unreachable");
    }
    for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT"]) {
      const f = fetcher({ handler: () => ({ error: Object.assign(new Error(code), { code }) }) });
      await refused(f.fetchMedia("https://example.com/a"), "url_unreachable");
    }
    assert.equal(await fetcher({ handler: () => reply({ status: 404 }) }).fetchPreview("https://example.com/"), null);
  });

  test("identity and an absent Content-Encoding are accepted", async () => {
    for (const headers of [{}, { "content-encoding": "identity" }, { "content-encoding": "" }]) {
      const f = fetcher({ handler: () => reply({ headers, body: PNG }) });
      assert.equal((await f.fetchMedia("https://example.com/a")).size, PNG.length);
    }
  });

  test("a body that fails halfway is url_unreachable and leaves no file", async () => {
    const f = fetcher({
      handler: () => {
        const stream = new Readable({ read() {} });
        stream.push(Buffer.alloc(100, 1));
        setImmediate(() => stream.destroy(new Error("ECONNRESET")));
        return reply({ stream });
      },
    });
    await refused(f.fetchMedia("https://example.com/a"), "url_unreachable");
    noPartFiles();
  });

  test("a request function that throws is url_unreachable", async () => {
    const f = createUrlFetcher({
      resolve: fakeResolver(),
      request: () => {
        throw new Error("boom");
      },
      tmpDir: dir,
    });
    await refused(f.fetchMedia("https://example.com/a"), "url_unreachable");
  });
});

// ---------------------------------------------------------------------------------------------------------
// Body: the cap while streaming, the sniff
// ---------------------------------------------------------------------------------------------------------

describe("the body is counted while it streams", () => {
  test("a Content-Length over the cap short-circuits before a byte is read", async () => {
    let body;
    const f = fetcher({
      handler: () => {
        body = endless();
        return reply({ stream: body, headers: { "content-length": "999999999" } });
      },
    });
    await refused(f.fetchMedia("https://example.com/a", { maxBytes: 1000 }), "media_too_large", { maxBytes: 1000 });
    assert.equal(body.served(), 0, "nothing was pulled");
    assert.equal(body.destroyed, true);
    noPartFiles();
  });

  test("a lying Content-Length does not help: the real bytes are counted and the download stops at the cap", async () => {
    let body;
    const f = fetcher({
      handler: () => {
        body = endless();
        return reply({ stream: body, headers: { "content-length": "10" } });
      },
    });
    await refused(f.fetchMedia("https://example.com/a", { maxBytes: 100000 }), "media_too_large", { maxBytes: 100000 });
    assert.ok(body.served() <= 100000 + 3 * 65536, `stopped soon after the cap (${body.served()} bytes pulled)`);
    assert.equal(body.destroyed, true);
    noPartFiles();
  });

  test("no Content-Length at all (chunked): the same", async () => {
    const f = fetcher({ handler: () => reply({ stream: endless() }) });
    await refused(f.fetchMedia("https://example.com/a", { maxBytes: 70000 }), "media_too_large", { maxBytes: 70000 });
    noPartFiles();
  });

  test("a body of exactly the cap is accepted, one byte more is not", async () => {
    const body = Buffer.alloc(1000, 0x61);
    assert.equal((await fetcher({ handler: () => reply({ body }) }).fetchMedia("https://example.com/a", { maxBytes: 1000 })).size, 1000);
    await refused(fetcher({ handler: () => reply({ body: Buffer.concat([body, Buffer.from("b")]) }) }).fetchMedia("https://example.com/a", { maxBytes: 1000 }), "media_too_large");
  });

  test("M4: onBytes sees every chunk as it arrives (the in-flight download is countable against the disk bound)", async () => {
    const seen = [];
    const body = Buffer.alloc(3000, 0x61);
    const f = fetcher({ handler: () => reply({ chunks: [body.subarray(0, 1000), body.subarray(1000, 2500), body.subarray(2500)] }) });
    const out = await f.fetchMedia("https://example.com/a", { onBytes: (n) => seen.push(n) });
    assert.ok(seen.length >= 1 && seen.every((n) => n > 0), "one call per chunk read");
    assert.equal(seen.reduce((a, b) => a + b, 0), 3000, "every byte written to the disk is counted, once");
    assert.equal(out.size, 3000);
  });

  test("M4: an onBytes that refuses (the disk bound) ends the download at once and removes the file", async () => {
    let body;
    let total = 0;
    const f = fetcher({
      handler: () => {
        body = endless();
        return reply({ stream: body });
      },
    });
    await refused(
      f.fetchMedia("https://example.com/a", {
        onBytes: (n) => {
          total += n;
          if (total > 100000) throw new MessagingError("queue_full", { params: { scope: "disk", retryAfterMs: 5000 } });
        },
      }),
      "queue_full",
      { scope: "disk", retryAfterMs: 5000 },
    );
    assert.ok(body.served() <= 100000 + 3 * 65536, `stopped soon after the bound (${body.served()} bytes pulled)`);
    assert.equal(body.destroyed, true);
    noPartFiles();
  });

  test("the cap is min(caller cap, createUrlFetcher maxBytes, MAX_UPLOAD MB read at call time)", async () => {
    const config = require("../config");
    const original = config.MAX_UPLOAD;
    try {
      config.MAX_UPLOAD = 1; // 1 MB
      const f = fetcher({ handler: () => reply({ stream: endless() }) });
      await refused(f.fetchMedia("https://example.com/a", { maxBytes: 50 * 1048576 }), "media_too_large", { maxBytes: 1048576 });
      const g = fetcher({ maxBytes: 2000, handler: () => reply({ stream: endless() }) });
      await refused(g.fetchMedia("https://example.com/a"), "media_too_large", { maxBytes: 2000 });
    } finally {
      config.MAX_UPLOAD = original;
    }
    noPartFiles();
  });
});

describe("the head is sniffed", () => {
  test("wrong content aborts the download as soon as 4100 bytes are in: media_type_mismatch with expected only", async () => {
    let body;
    const f = fetcher({
      handler: () => {
        body = endless();
        return reply({ stream: body });
      },
    });
    const err = await refused(f.fetchMedia("https://example.com/a", { kinds: ["image"] }), "media_type_mismatch", { expected: ["image"] });
    assert.doesNotMatch(JSON.stringify(err.params), /text|application/);
    assert.ok(body.served() <= 2 * 65536, `aborted early (${body.served()} bytes pulled)`);
    noPartFiles();
  });

  test("a short file is sniffed when the body ends", async () => {
    const wrong = fetcher({ handler: () => reply({ body: PDF }) });
    await refused(wrong.fetchMedia("https://example.com/a", { kinds: ["image"] }), "media_type_mismatch", { expected: ["image"] });
    noPartFiles();
    const empty = fetcher({ handler: () => reply({ body: Buffer.alloc(0) }) });
    await refused(empty.fetchMedia("https://example.com/a", { kinds: ["image"] }), "media_type_mismatch");
    const right = fetcher({ handler: () => reply({ body: PNG }) });
    assert.equal((await right.fetchMedia("https://example.com/a", { kinds: ["image", "animated"] })).size, PNG.length);
    const doc = fetcher({ handler: () => reply({ body: PDF }) });
    assert.equal((await doc.fetchMedia("https://example.com/a", { kinds: ["document"] })).size, PDF.length);
  });

  test("a body split in small chunks is sniffed on its first 4100 bytes", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(9000, 0)]);
    const chunks = [];
    for (let i = 0; i < big.length; i += 100) chunks.push(big.subarray(i, i + 100));
    const f = fetcher({ handler: () => reply({ chunks }) });
    const out = await f.fetchMedia("https://example.com/a", { kinds: ["image"] });
    assert.equal(out.size, big.length);
    assert.deepEqual(fs.readFileSync(out.path), big);
  });

  test("without `kinds` nothing is sniffed", async () => {
    const f = fetcher({ handler: () => reply({ body: Buffer.from("anything at all") }) });
    assert.equal((await f.fetchMedia("https://example.com/a")).size, 15);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The deadline
// ---------------------------------------------------------------------------------------------------------

describe("one deadline for DNS, all hops and the body", () => {
  test("the deadline signal is created once per fetch with the contract's 30 s", async () => {
    const asked = [];
    const f = fetcher({
      timeoutSignal: (ms) => {
        asked.push(ms);
        return new AbortController().signal;
      },
      handler: (options, index) => (index === 0 ? reply({ status: 302, headers: { location: "/next" } }) : reply({ body: PNG })),
    });
    await f.fetchMedia("https://example.com/a");
    assert.deepEqual(asked, [30000], "one signal for the 2 hops");
    await f.fetchPreview("https://example.com/b");
    assert.deepEqual(asked, [30000, 30000]);
  });

  test("aborted during DNS: unreachable, no connection", async () => {
    const controller = new AbortController();
    const f = fetcher({ hosts: { "slow.example.com": () => new Promise(() => {}) } });
    const pending = f.fetchMedia("https://slow.example.com/a", { signal: controller.signal });
    setImmediate(() => controller.abort());
    await refused(pending, "url_unreachable");
    assert.equal(f.request.callCount, 0);
  });

  test("aborted while a hop waits for its response: the request is destroyed", async () => {
    const controller = new AbortController();
    const f = fetcher({ handler: () => ({ hang: true }) });
    const pending = f.fetchMedia("https://example.com/a", { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await refused(pending, "url_unreachable");
    assert.equal(f.request.requests[0].destroyed, true);
  });

  test("aborted during the body: unreachable, the file is removed", async () => {
    const controller = new AbortController();
    let body;
    const f = fetcher({
      handler: () => {
        body = hanging(Buffer.alloc(500, 7));
        return reply({ stream: body });
      },
    });
    const pending = f.fetchMedia("https://example.com/a", { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await refused(pending, "url_unreachable");
    assert.equal(body.destroyed, true);
    noPartFiles();
  });

  test("a signal that is already aborted opens nothing", async () => {
    const f = fetcher();
    await refused(f.fetchMedia("https://example.com/a", { signal: AbortSignal.abort() }), "url_unreachable");
    assert.equal(f.request.callCount, 0);
  });

  test("the real deadline: a resolver and a body that never answer are cut at deadlineMs", async () => {
    const started = Date.now();
    const slowDns = fetcher({ deadlineMs: 40, hosts: { "slow.example.com": () => new Promise(() => {}) } });
    await refused(slowDns.fetchMedia("https://slow.example.com/a"), "url_unreachable");
    const slowBody = fetcher({ deadlineMs: 60, handler: () => reply({ stream: hanging(Buffer.alloc(10)) }) });
    await refused(slowBody.fetchMedia("https://example.com/a"), "url_unreachable");
    noPartFiles();
    assert.ok(Date.now() - started < 3000);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Link preview
// ---------------------------------------------------------------------------------------------------------

describe("fetchPreview (FR-043, X16): HTML only, 256 KiB, <title>, og:title, og:description; a failure is null", () => {
  const html = (head, extra = "") => Buffer.from(`<!doctype html><html><head>${head}</head><body>${extra}</body></html>`);
  const page = (head) => ({ handler: () => reply({ headers: { "content-type": "text/html; charset=utf-8" }, body: html(head) }) });

  test("title and description, with the Accept header of a page fetch", async () => {
    const f = fetcher(page('<title>My   page</title><meta property="og:description" content="About it">'));
    const preview = await f.fetchPreview("https://example.com/post?id=1");
    assert.deepEqual(preview, { "matched-text": "https://example.com/post?id=1", "canonical-url": "https://example.com/post?id=1", title: "My page", description: "About it" });
    assert.equal(f.request.calls[0].headers.Accept, "text/html");
    assert.equal(f.request.calls[0].agent, false);
  });

  test("og:title wins over <title>; attributes in any order and quote style; entities decoded", async () => {
    const f = fetcher(page(`<title>Plain</title><meta content='Caf&eacute; &amp; &quot;Bar&quot; &#39;x&#39;' property="og:title"><META NAME="og:description" CONTENT="A &lt;b&gt; thing">`));
    const preview = await f.fetchPreview("https://example.com/a");
    assert.equal(preview.title, `Café & "Bar" 'x'`);
    assert.equal(preview.description, "A <b> thing");
  });

  test("the canonical URL is the final one after redirects", async () => {
    const f = fetcher({
      handler: (options, index) => (index === 0 ? reply({ status: 301, headers: { location: "https://www.example.com/final" } }) : reply({ headers: { "content-type": "text/html" }, body: html("<title>Final</title>") })),
    });
    const preview = await f.fetchPreview("https://example.com/short");
    assert.equal(preview["matched-text"], "https://example.com/short");
    assert.equal(preview["canonical-url"], "https://www.example.com/final");
  });

  test("no title: null; a description alone is not a preview", async () => {
    assert.equal(await fetcher(page('<meta property="og:description" content="x">')).fetchPreview("https://example.com/a"), null);
    assert.equal(await fetcher(page("")).fetchPreview("https://example.com/a"), null);
  });

  test("only HTML: another content type is null", async () => {
    for (const type of ["image/png", "application/json", "text/plain", ""]) {
      const f = fetcher({ handler: () => reply({ headers: { "content-type": type }, body: html("<title>T</title>") }) });
      assert.equal(await f.fetchPreview("https://example.com/a"), null, type);
    }
    const xhtml = fetcher({ handler: () => reply({ headers: { "content-type": "application/xhtml+xml" }, body: html("<title>X</title>") }) });
    assert.equal((await xhtml.fetchPreview("https://example.com/a")).title, "X");
  });

  test("only the first 256 KiB are read; a title past them is not found, and the read stops", async () => {
    let body;
    const f = fetcher({
      handler: () => {
        body = new Readable({
          read() {
            this.push(Buffer.alloc(65536, 0x20));
          },
        });
        body.push(Buffer.from("<html><head><title>Early</title></head>"));
        return reply({ headers: { "content-type": "text/html" }, stream: body });
      },
    });
    assert.equal((await f.fetchPreview("https://example.com/a")).title, "Early");
    assert.equal(body.destroyed, true);

    const late = fetcher({
      handler: () => reply({ headers: { "content-type": "text/html" }, chunks: [Buffer.alloc(300 * 1024, 0x20), Buffer.from("<title>Late</title>")] }),
    });
    assert.equal(await late.fetchPreview("https://example.com/a"), null);
  });

  test("title and description are cleaned and capped", async () => {
    const f = fetcher(page(`<title>${"T".repeat(400)}\n\u0007tab</title><meta property="og:description" content="${"D".repeat(900)}">`));
    const preview = await f.fetchPreview("https://example.com/a");
    assert.equal(Array.from(preview.title).length, 256);
    assert.equal(Array.from(preview.description).length, 512);
    assert.doesNotMatch(preview.title, /[\u0000-\u001f]/);
  });

  test("every refusal and every failure returns null and never throws", async () => {
    const refusedTargets = ["http://example.com/", "https://127.0.0.1/", "https://localhost/", "https://user:pw@example.com/", "https://example.com:8443/", "not a url", "", null, undefined];
    for (const target of refusedTargets) {
      const f = fetcher();
      assert.equal(await f.fetchPreview(target), null, String(target));
      assert.equal(f.request.callCount, 0, String(target));
    }
    assert.equal(await fetcher({ hosts: { "example.com": ["10.0.0.1"] } }).fetchPreview("https://example.com/"), null);
    assert.equal(await fetcher({ handler: () => ({ error: new Error("ECONNRESET") }) }).fetchPreview("https://example.com/"), null);
    assert.equal(await fetcher({ handler: () => reply({ status: 500 }) }).fetchPreview("https://example.com/"), null);
    const redirectToPrivate = fetcher({ handler: () => reply({ status: 302, headers: { location: "https://127.0.0.1/" } }) });
    assert.equal(await redirectToPrivate.fetchPreview("https://example.com/"), null);
    assert.equal(redirectToPrivate.request.callCount, 1);
    const controller = new AbortController();
    const hangs = fetcher({ handler: () => ({ hang: true }) });
    const pending = hangs.fetchPreview("https://example.com/", { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    assert.equal(await pending, null);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Module-level guarantees
// ---------------------------------------------------------------------------------------------------------

describe("the default instance and the module's hygiene", () => {
  test("the default fetchMedia and fetchPreview refuse a local target without a resolver or a network", async () => {
    await refused(urlFetch.fetchMedia("https://localhost/a"), "url_forbidden", { reason: "host" });
    await refused(urlFetch.fetchMedia("http://example.com/a"), "url_forbidden", { reason: "scheme" });
    assert.equal(await urlFetch.fetchPreview("https://127.0.0.1/"), null);
  });

  test("RT-96: the module logs nothing (no logger, no console), and exports no log-friendly state", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "lib", "messaging", "urlFetch.js"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /console\.|createLogger|logger|process\.std(out|err)/);
  });

  test("RT-04: required without loading sharp, file-type, ffmpeg wrappers or the button helper", () => {
    const loaded = Object.keys(require.cache);
    for (const heavy of ["sharp", "node-webpmux", "file-type", "button-helper", path.join("lib", "utils", "ffmpeg.js")]) {
      assert.ok(!loaded.some((file) => file.includes(`${path.sep}${heavy}${path.sep}`) || file.endsWith(heavy)), heavy);
    }
  });
});

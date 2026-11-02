"use strict";
/**
 * lib/api/ipRules.js: the IP entry grammar of the messaging API (feature 004, contracts/runtime.md 15.9).
 *
 * One grammar for `ApiKey.ipAllow` (up to 50 entries) and `ApiState.plainHttpFrom` (up to 20, private networks only),
 * shared with the admin SPA (lib/admin/public/js/views/api-logic.mjs) through the fixture
 * test/fixtures/api-ip-entries.json: `[{ input, ok, value }]`, `value` only when `ok`. Pure functions, no network.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ipRules = require("../lib/api/ipRules");

const { parse, parseEntry, compile, covers, isPrivateRange, unmap, MAX_ENTRIES, MAX_PLAIN_HTTP } = ipRules;
const FIXTURE_FILE = path.join(__dirname, "fixtures", "api-ip-entries.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8"));

describe("constants and shape of the module", () => {
  test("the limits of the two lists", () => {
    assert.equal(MAX_ENTRIES, 50);
    assert.equal(MAX_PLAIN_HTTP, 20);
  });

  test("a dependency-free leaf: Node's net is the only require, and nothing runs at load", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "lib", "api", "ipRules.js"), "utf8");
    const required = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(required)], ["net"]);
    assert.doesNotMatch(source, /setTimeout|setInterval|process\.on|\.listen\(/);
    for (const name of ["parse", "parseEntry", "compile", "covers", "isPrivateRange", "unmap"]) assert.equal(typeof ipRules[name], "function", name);
  });
});

describe("the shared fixture test/fixtures/api-ip-entries.json", () => {
  test("rows have exactly the shape { input, ok, value }, value only when ok", () => {
    assert.ok(Array.isArray(fixture));
    assert.ok(fixture.length >= 40, `${fixture.length} rows`);
    for (const row of fixture) {
      assert.equal(typeof row.input, "string");
      assert.equal(typeof row.ok, "boolean");
      assert.deepEqual(Object.keys(row), row.ok ? ["input", "ok", "value"] : ["input", "ok"], JSON.stringify(row.input));
      if (row.ok) assert.equal(typeof row.value, "string");
    }
  });

  test("it covers both families, masks, mapped forms, zones, blanks and refusals", () => {
    const valid = fixture.filter((r) => r.ok);
    const invalid = fixture.filter((r) => !r.ok);
    assert.ok(valid.some((r) => /^\d+\.\d+\.\d+\.\d+$/.test(r.value)), "a bare IPv4");
    assert.ok(valid.some((r) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(r.value)), "an IPv4 range");
    assert.ok(valid.some((r) => r.value.includes(":") && !r.value.includes("/")), "a bare IPv6");
    assert.ok(valid.some((r) => r.value.includes(":") && r.value.includes("/")), "an IPv6 range");
    assert.ok(valid.some((r) => r.input.trim() !== r.value && /\/\d+/.test(r.input) && /\/\d+/.test(r.value) && r.input.trim().split("/")[0] !== r.value.split("/")[0]), "host bits masked");
    assert.ok(valid.some((r) => /^::ffff:/i.test(r.input) && !r.value.includes(":")), "an IPv4-mapped address unmapped");
    assert.ok(valid.some((r) => r.input.includes("%")), "a zone id");
    assert.ok(valid.some((r) => r.value === "0.0.0.0/0") && valid.some((r) => r.value === "::/0"), "any-address ranges");
    assert.ok(invalid.some((r) => r.input.trim() === ""), "a blank");
    assert.ok(invalid.some((r) => /^\d/.test(r.input)) && invalid.some((r) => r.input.includes(":")) && invalid.some((r) => /[a-z]{3}/.test(r.input)), "refusals of each kind");
  });

  for (const row of fixture) {
    test(`parseEntry(${JSON.stringify(row.input)}) is ${row.ok ? `ok ${JSON.stringify(row.value)}` : "refused"}`, () => {
      const result = parseEntry(row.input);
      assert.equal(result.ok, row.ok);
      if (row.ok) {
        assert.equal(result.value, row.value);
        // idempotent: a stored entry parses to itself, so an unchanged entry never differs from itself
        const again = parseEntry(row.value);
        assert.equal(again.ok, true);
        assert.equal(again.value, row.value);
        // parse() agrees with parseEntry()
        assert.deepEqual(parse([row.input]), { entries: [row.value], invalid: [], tooMany: false });
        assert.deepEqual(parse([row.value]).entries, [row.value]);
      } else {
        assert.equal(result.value, undefined);
        assert.deepEqual(parse([row.input]), { entries: [], invalid: [{ index: 0 }], tooMany: false });
      }
    });
  }
});

describe("parseEntry details", () => {
  test("family, prefix and the inclusive BigInt range", () => {
    const v4 = parseEntry("10.0.0.0/8");
    assert.deepEqual([v4.family, v4.prefix, v4.start, v4.end], [4, 8, 167772160n, 184549375n]);
    const host = parseEntry("203.0.113.5");
    assert.deepEqual([host.family, host.prefix, host.start === host.end], [4, 32, true]);
    const v6 = parseEntry("2001:db8::/32");
    assert.equal(v6.family, 6);
    assert.equal(v6.prefix, 32);
    assert.equal(v6.start, 0x20010db8n << 96n);
    assert.equal(v6.end, (0x20010db8n << 96n) | ((1n << 96n) - 1n));
    const any = parseEntry("0.0.0.0/0");
    assert.deepEqual([any.start, any.end], [0n, 4294967295n]);
    assert.equal(parseEntry("::/0").end, (1n << 128n) - 1n);
  });

  test("non-strings and oversized text are refused without throwing", () => {
    for (const bad of [null, undefined, 5, {}, [], true]) assert.equal(parseEntry(bad).ok, false);
    assert.equal(parseEntry("1".repeat(5000)).ok, false);
    assert.equal(parseEntry(`${"1.".repeat(40)}1`).ok, false);
  });

  test("unmap: IPv4-mapped forms and zone ids, like the trusted-proxy helper", () => {
    assert.equal(unmap("::ffff:1.2.3.4"), "1.2.3.4");
    assert.equal(unmap("::FFFF:7f00:1"), "127.0.0.1");
    assert.equal(unmap("fe80::1%eth0"), "fe80::1");
    assert.equal(unmap("  203.0.113.5 "), "203.0.113.5");
    assert.equal(unmap("2001:db8::1"), "2001:db8::1");
    assert.equal(unmap(undefined), "");
  });
});

describe("parse(list, { privateOnly, max })", () => {
  test("keeps the order, trims, normalises and removes a repeated entry (the first spelling wins)", () => {
    const result = parse([" 10.1.2.3/8 ", "2001:DB8::1", "10.0.0.0/8", "192.168.1.1", "2001:db8:0:0:0:0:0:1"]);
    assert.deepEqual(result.entries, ["10.0.0.0/8", "2001:db8::1", "192.168.1.1"]);
    assert.deepEqual([result.invalid, result.tooMany], [[], false]);
  });

  test("reports the 0-based index of every refused item, in order, whatever its type", () => {
    const result = parse(["1.2.3.4", "nope", "", null, 5, "10.0.0.0/8", {}, "1.2.3.4/33"]);
    assert.deepEqual(result.entries, ["1.2.3.4", "10.0.0.0/8"]);
    assert.deepEqual(result.invalid, [{ index: 1 }, { index: 2 }, { index: 3 }, { index: 4 }, { index: 6 }, { index: 7 }]);
    for (const item of result.invalid) assert.equal(item.reason, undefined, "a syntax error carries no reason");
  });

  test("an empty list, and anything that is not a list, give nothing", () => {
    assert.deepEqual(parse([]), { entries: [], invalid: [], tooMany: false });
    for (const notAList of [undefined, null, "10.0.0.0/8", {}, 5]) assert.deepEqual(parse(notAList), { entries: [], invalid: [], tooMany: false });
  });

  test("max: the entries stop at the limit and tooMany tells there were more (default 50)", () => {
    const entries = (n) => Array.from({ length: n }, (_, i) => `10.${i >> 8}.${i & 255}.0/24`);
    const fifty = parse(entries(50));
    assert.deepEqual([fifty.entries.length, fifty.tooMany], [50, false]);
    const fiftyOne = parse(entries(51));
    assert.deepEqual([fiftyOne.entries.length, fiftyOne.tooMany], [50, true]);
    assert.deepEqual(fiftyOne.entries, entries(50), "the first ones are kept");

    const plain = parse(entries(21), { max: MAX_PLAIN_HTTP });
    assert.deepEqual([plain.entries.length, plain.tooMany], [20, true]);
    assert.equal(parse(entries(20), { max: MAX_PLAIN_HTTP }).tooMany, false);
    // duplicates do not count towards the limit
    assert.equal(parse([...entries(50), ...entries(50)]).tooMany, false);
  });

  const PRIVATE = ["10.0.0.0/8", "10.1.2.3", "172.16.0.0/12", "172.31.255.255", "192.168.0.0/16", "192.168.5.5/24", "100.64.0.0/10", "100.127.255.255", "fc00::/7", "fd12:3456::/32", "fdff::1", "::ffff:192.168.1.1"];
  const PUBLIC = ["127.0.0.1", "127.0.0.0/8", "::1", "8.8.8.8", "0.0.0.0/0", "::/0", "172.15.255.255", "172.32.0.0", "10.0.0.0/7", "192.168.0.0/15", "100.128.0.0/10", "100.0.0.0/8", "fe80::/10", "fe80::1", "2001:db8::/32", "fc00::/6", "169.254.1.1", "0.0.0.0", "224.0.0.1", "::ffff:8.8.8.8"];

  test("privateOnly accepts RFC 1918, CGNAT and ULA ranges", () => {
    for (const entry of PRIVATE) {
      const result = parse([entry], { privateOnly: true });
      assert.equal(result.entries.length, 1, entry);
      assert.deepEqual(result.invalid, [], entry);
    }
  });

  test("privateOnly marks everything else { reason: not_private }, loopback and any-address included", () => {
    for (const entry of PUBLIC) {
      const result = parse([entry], { privateOnly: true });
      assert.deepEqual(result.entries, [], entry);
      assert.deepEqual(result.invalid, [{ index: 0, reason: "not_private" }], entry);
      // without the option the same entry is a valid one
      assert.equal(parse([entry]).entries.length, 1, `${entry} is valid without privateOnly`);
    }
  });

  test("privateOnly keeps a syntax error apart from a public range, and reports both", () => {
    const result = parse(["10.0.0.0/8", "garbage", "8.8.8.8", "192.168.0.0/16"], { privateOnly: true });
    assert.deepEqual(result.entries, ["10.0.0.0/8", "192.168.0.0/16"]);
    assert.deepEqual(result.invalid, [{ index: 1 }, { index: 2, reason: "not_private" }]);
  });
});

describe("isPrivateRange(entry)", () => {
  test("the edges of each private block", () => {
    const table = [
      ["172.15.255.255", false], ["172.16.0.0", true], ["172.16.0.0/12", true], ["172.31.255.255", true], ["172.32.0.0", false], ["172.16.0.0/11", false],
      ["10.0.0.0/8", true], ["10.255.255.255", true], ["9.255.255.255", false], ["11.0.0.0", false], ["10.0.0.0/7", false],
      ["192.168.0.0/16", true], ["192.167.255.255", false], ["192.169.0.0", false], ["192.168.0.0/15", false],
      ["100.64.0.0/10", true], ["100.63.255.255", false], ["100.127.255.255", true], ["100.128.0.0", false],
      ["fc00::/7", true], ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true], ["fe00::", false], ["fbff::1", false], ["fc00::/6", false],
      ["fe80::/10", false], ["::1", false], ["2001:db8::1", false], ["127.0.0.1", false], ["0.0.0.0/0", false], ["::/0", false],
      ["::ffff:10.1.2.3", true], ["::ffff:8.8.8.8", false],
    ];
    for (const [entry, expected] of table) assert.equal(isPrivateRange(entry), expected, entry);
  });

  test("an unparseable entry, or no entry, is not a private range", () => {
    for (const value of ["nope", "", null, undefined, 5, {}]) assert.equal(isPrivateRange(value), false, String(value));
  });

  test("a parsed entry is accepted as well as its text", () => {
    assert.equal(isPrivateRange(parseEntry("10.0.0.0/8")), true);
    assert.equal(isPrivateRange(parseEntry("8.8.8.8")), false);
  });
});

describe("covers(oldEntries, entry)", () => {
  test("an entry inside one old range is covered, including itself and a host in a range", () => {
    assert.equal(covers(["10.0.0.0/8"], "10.0.0.0/8"), true);
    assert.equal(covers(["10.0.0.0/8"], "10.1.0.0/16"), true);
    assert.equal(covers(["10.0.0.0/8"], "10.255.255.255"), true);
    assert.equal(covers(["203.0.113.5"], "203.0.113.5"), true);
    assert.equal(covers(["2001:db8::/32"], "2001:db8:1::/48"), true);
    assert.equal(covers(["2001:db8::/32"], "2001:db8::1"), true);
    assert.equal(covers(["1.2.3.4/32"], "1.2.3.4"), true, "a /32 is the host");
  });

  test("a wider or partly outside entry is not covered", () => {
    assert.equal(covers(["10.1.0.0/16"], "10.0.0.0/8"), false);
    assert.equal(covers(["10.0.0.0/8"], "10.0.0.0/7"), false);
    assert.equal(covers(["10.0.0.0/8"], "11.0.0.1"), false);
    assert.equal(covers(["203.0.113.5"], "203.0.113.6"), false);
    assert.equal(covers(["203.0.113.5"], "203.0.113.0/24"), false);
    assert.equal(covers(["2001:db8::/32"], "2001:db9::1"), false);
  });

  test("one old range must hold the whole entry: two halves do not cover the whole", () => {
    assert.equal(covers(["10.0.0.0/25", "10.0.0.128/25"], "10.0.0.0/24"), false);
    assert.equal(covers(["10.0.0.0/25", "10.0.0.128/25"], "10.0.0.130"), true);
    assert.equal(covers(["192.168.0.0/16", "10.0.0.0/8"], "10.9.9.9"), true, "any of the old entries");
  });

  test("the two families never cover each other; any-address covers its own family only", () => {
    assert.equal(covers(["0.0.0.0/0"], "8.8.8.8"), true);
    assert.equal(covers(["0.0.0.0/0"], "::1"), false);
    assert.equal(covers(["::/0"], "2001:db8::1"), true);
    assert.equal(covers(["::/0"], "8.8.8.8"), false);
    assert.equal(covers(["10.0.0.0/8"], "::ffff:10.1.2.3"), true, "a mapped entry is an IPv4 entry");
  });

  test("entries are normalised before the comparison; the old list is read as stored", () => {
    assert.equal(covers(["10.1.2.3/8"], "10.9.9.9"), true, "10.1.2.3/8 is 10.0.0.0/8");
    assert.equal(covers(["10.0.0.0/8"], " 10.1.2.3/16 "), true);
    assert.equal(covers(["2001:DB8::/32"], "2001:db8::5"), true);
  });

  test("an unparseable old entry covers nothing, an unparseable entry is not covered, an empty or missing list covers nothing", () => {
    assert.equal(covers(["garbage"], "10.0.0.1"), false);
    assert.equal(covers(["garbage", "10.0.0.0/8"], "10.0.0.1"), true, "the parseable one still counts");
    assert.equal(covers(["10.0.0.0/8"], "garbage"), false);
    assert.equal(covers(["10.0.0.0/8"], ""), false);
    assert.equal(covers([], "10.0.0.1"), false);
    assert.equal(covers(undefined, "10.0.0.1"), false);
    assert.equal(covers(null, "10.0.0.1"), false);
    assert.equal(covers(["10.0.0.0/8", null, 5], "10.0.0.1"), true);
  });
});

describe("compile(entries).check(address)", () => {
  test("an empty list means no restriction: any address passes, whatever it is", () => {
    const open = compile([]);
    assert.equal(open.restricted, false);
    for (const address of ["8.8.8.8", "::1", "2001:db8::1", "garbage", "", undefined]) assert.equal(open.check(address), true, String(address));
    assert.equal(compile(undefined).check("8.8.8.8"), true);
    assert.equal(compile(null).restricted, false);
  });

  test("hosts and ranges, both families", () => {
    const list = compile(["203.0.113.5", "198.51.100.0/24", "2001:db8:aa::1", "2001:db8:bb::/48"]);
    assert.equal(list.restricted, true);
    const pass = ["203.0.113.5", "198.51.100.0", "198.51.100.255", "2001:db8:aa::1", "2001:db8:bb::1", "2001:db8:bb:ffff::1"];
    const refuse = ["203.0.113.6", "198.51.101.1", "198.51.99.255", "2001:db8:aa::2", "2001:db8:bc::1", "2001:db8::1", "8.8.8.8", "::1"];
    for (const address of pass) assert.equal(list.check(address), true, address);
    for (const address of refuse) assert.equal(list.check(address), false, address);
  });

  test("the match is on the full address, never on the /64 the throttle groups callers by", () => {
    const list = compile(["2001:db8:1:2::5"]);
    assert.equal(list.check("2001:db8:1:2::5"), true);
    assert.equal(list.check("2001:db8:1:2::6"), false, "same /64, another address");
    assert.equal(list.check("2001:db8:1:2:ffff:ffff:ffff:ffff"), false);
    const wide = compile(["2001:db8:1:2::/64"]);
    assert.equal(wide.check("2001:db8:1:2:aaaa::1"), true, "a /64 entry written as a range does match its /64");
    assert.equal(wide.check("2001:db8:1:3::1"), false);
  });

  test("an IPv4-mapped client address and a zone id are read as the plain address", () => {
    const list = compile(["203.0.113.0/24", "fe80::/10"]);
    assert.equal(list.check("::ffff:203.0.113.77"), true);
    assert.equal(list.check("::FFFF:cb00:7101"), true);
    assert.equal(list.check("::ffff:203.0.114.1"), false);
    assert.equal(list.check("fe80::1%eth0"), true);
  });

  test("any-address entries match their own family only", () => {
    const v4 = compile(["0.0.0.0/0"]);
    assert.equal(v4.check("8.8.8.8"), true);
    assert.equal(v4.check("::ffff:8.8.8.8"), true);
    assert.equal(v4.check("2001:db8::1"), false);
    const v6 = compile(["::/0"]);
    assert.equal(v6.check("2001:db8::1"), true);
    assert.equal(v6.check("8.8.8.8"), false);
  });

  test("a list that is not empty never lets a non-address through", () => {
    const list = compile(["10.0.0.0/8"]);
    for (const address of ["", "garbage", "10.0.0", "10.0.0.1.1", undefined, null, 5, {}]) assert.equal(list.check(address), false, String(address));
  });

  test("entries as stored are accepted unnormalised; an unreadable entry is skipped, and a list with none readable fails closed", () => {
    assert.equal(compile(["10.1.2.3/8"]).check("10.200.0.1"), true, "host bits masked");
    assert.equal(compile(["::ffff:10.0.0.0/104"]).check("10.200.0.1"), true);

    const mixed = compile(["garbage", "10.0.0.1", 5]);
    assert.equal(mixed.restricted, true);
    assert.equal(mixed.check("10.0.0.1"), true);
    assert.equal(mixed.check("10.0.0.2"), false);

    // a corrupt allowlist must never turn into "no restriction"
    const broken = compile(["garbage", ""]);
    assert.equal(broken.restricted, true);
    for (const address of ["10.0.0.1", "8.8.8.8", "::1"]) assert.equal(broken.check(address), false, address);
  });

  test("fifty entries compile and match", () => {
    const entries = Array.from({ length: MAX_ENTRIES }, (_, i) => `10.${i}.0.0/16`);
    const list = compile(entries);
    assert.equal(list.check("10.49.3.4"), true);
    assert.equal(list.check("10.50.3.4"), false);
  });
});

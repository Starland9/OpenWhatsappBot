"use strict";
/**
 * SC-009, the full measurement as a test (quickstart section 6). Opt-in: it runs three children of each mode with
 * the 20 s idle (about two minutes), so it only runs with MEASURE_MEMORY=1:
 *
 *   MEASURE_MEMORY=1 node --test --test-force-exit test/panel-memory.test.js
 *
 * The median RSS of the panel children must exceed the median of the baseline children by less than 50 MB.
 * The always-on, faster check is test/admin-memory.test.js; the same figures by hand: node tools/measure-panel-memory.js
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.MEASURE_MEMORY === "1";
const MB = 1024 * 1024;

test("SC-009: the idle panel adds under 50 MB of RSS (median of 3 runs of each mode)", { skip: enabled ? false : "set MEASURE_MEMORY=1 to run", timeout: 10 * 60 * 1000 }, async (t) => {
  const { measure } = require("../tools/measure-panel-memory");
  const result = await measure({ runs: 3, idleMs: 20 * 1000 });
  t.diagnostic(
    `baseline RSS ${(result.baseline.rss / MB).toFixed(1)} MB, panel ${(result.panel.rss / MB).toFixed(1)} MB, delta ${(result.delta.rss / MB).toFixed(1)} MB; heap+external delta ${(result.delta.heapExternal / MB).toFixed(1)} MB`,
  );
  for (const sample of result.samples.panel) assert.deepEqual(sample.failed, [], "every page and read-only route answered");
  assert.ok(result.delta.rss < 50 * MB, `RSS grew by ${(result.delta.rss / MB).toFixed(1)} MB`);
});

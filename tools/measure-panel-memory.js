#!/usr/bin/env node
"use strict";

/**
 * Memory the admin panel adds to the bot at rest (SC-009: under 50 MB) and memory the messaging API adds to the panel
 * (SC-011: nothing while it is switched off, under 20 MiB while it is on and idle). Quickstart section 6.
 *
 *   node tools/measure-panel-memory.js [--runs=3] [--idle-ms=20000] [--limit-mb=50] [--api-limit-mb=20] [--json]
 *
 * It runs tools/panel-memory-child.js in four modes, `--runs` times each, every child with --expose-gc, an in-memory
 * database and blank secrets (config.env is never read):
 *   baseline  config, database, plugins (what the bot loads with or without the panel)
 *   panel     the same plus the admin, a login, every page and read-only route fetched once, one SSE stream open, idle
 *   api-off   the panel with the messaging API wired as boot.js wires it, the switch off
 *   api-on    the same with the switch on, idle (the outbox timer and the receipts listener exist, nothing is sent)
 * Each run is baseline then panel, then api-off and api-on side by side (the two compared children see the same machine
 * state, and the whole measure fits in about three and a half minutes). It prints the median RSS of every mode, the
 * deltas, and the same figures for heapUsed + external (the figure the always-on test/admin-memory.test.js asserts).
 *
 * Exit code: 0 when the panel RSS delta (panel minus baseline) is under `--limit-mb` and the API delta (api-on minus
 * api-off) under `--api-limit-mb`; 1 when one is not; 2 when a child failed.
 *
 * The module also exports `runChild`, `median` and `measure` for the tests.
 */

const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const CHILD = path.join(__dirname, "panel-memory-child.js");
const MB = 1024 * 1024;
const DEFAULT_RUNS = 3;
const DEFAULT_IDLE_MS = 20 * 1000;
const DEFAULT_LIMIT_MB = 50;
const DEFAULT_API_LIMIT_MB = 20;

/** The child gets a minimal environment: nothing of the caller's secrets, no config.env */
function childEnv() {
  const env = { OWB_NO_CONFIG_ENV: "1", NODE_ENV: "production" };
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "TZ"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Run one measured child.
 * @param {"baseline"|"panel"|"api-off"|"api-on"} mode
 * @param {{ idleMs?: number, timeoutMs?: number }} [options]
 * @returns {Promise<{ mode, rss, heapUsed, external, arrayBuffers, routes, fetched, failed, api }>}
 */
function runChild(mode, { idleMs = DEFAULT_IDLE_MS, timeoutMs } = {}) {
  const limit = timeoutMs || idleMs + 90 * 1000;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--expose-gc", CHILD, mode, `--idle-ms=${idleMs}`], {
      cwd: ROOT,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), limit);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const line = out.trim().split("\n").reverse().find((text) => text.startsWith("{"));
      if (code !== 0 || !line) {
        reject(new Error(`the ${mode} child failed (exit ${code}${signal ? `, ${signal}` : ""}): ${err.trim().slice(0, 300)}`));
        return;
      }
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`the ${mode} child printed no measure`));
      }
    });
  });
}

/**
 * `runs` children of each mode, interleaved (baseline, panel, then api-off and api-on side by side, and again), then the
 * medians.
 * @returns {Promise<{ baseline, panel, apiOff, apiOn, delta: { rss, heapExternal }, apiDelta: { rss, heapExternal },
 *   apiOffDelta: { rss, heapExternal }, samples }>}  `delta` = panel - baseline (SC-009), `apiDelta` = api-on - api-off
 *   (SC-011, switched on and idle), `apiOffDelta` = api-off - panel (SC-011, switched off)
 */
async function measure({ runs = DEFAULT_RUNS, idleMs = DEFAULT_IDLE_MS, onRun } = {}) {
  const samples = { baseline: [], panel: [], "api-off": [], "api-on": [] };
  const record = (mode, n, sample) => {
    samples[mode].push(sample);
    if (onRun) onRun(mode, n, sample);
  };
  for (let i = 0; i < runs; i += 1) {
    for (const mode of ["baseline", "panel"]) record(mode, i + 1, await runChild(mode, { idleMs }));
    const pair = await Promise.all([runChild("api-off", { idleMs }), runChild("api-on", { idleMs })]);
    record("api-off", i + 1, pair[0]);
    record("api-on", i + 1, pair[1]);
  }
  const summary = (list) => ({
    rss: median(list.map((s) => s.rss)),
    heapUsed: median(list.map((s) => s.heapUsed)),
    external: median(list.map((s) => s.external)),
    heapExternal: median(list.map((s) => s.heapUsed + s.external)),
  });
  const baseline = summary(samples.baseline);
  const panel = summary(samples.panel);
  const apiOff = summary(samples["api-off"]);
  const apiOn = summary(samples["api-on"]);
  const diff = (a, b) => ({ rss: a.rss - b.rss, heapExternal: a.heapExternal - b.heapExternal });
  return {
    baseline,
    panel,
    apiOff,
    apiOn,
    delta: diff(panel, baseline),
    apiDelta: diff(apiOn, apiOff),
    apiOffDelta: diff(apiOff, panel),
    samples,
  };
}

const mb = (bytes) => `${(bytes / MB).toFixed(1)} MB`;

function parseArgs(argv) {
  const options = { runs: DEFAULT_RUNS, idleMs: DEFAULT_IDLE_MS, limitMb: DEFAULT_LIMIT_MB, apiLimitMb: DEFAULT_API_LIMIT_MB, json: false };
  for (const arg of argv) {
    let match;
    if ((match = /^--runs=(\d{1,2})$/.exec(arg))) options.runs = Math.max(1, Number(match[1]));
    else if ((match = /^--idle-ms=(\d{1,7})$/.exec(arg))) options.idleMs = Number(match[1]);
    else if ((match = /^--limit-mb=(\d{1,4})$/.exec(arg))) options.limitMb = Number(match[1]);
    else if ((match = /^--api-limit-mb=(\d{1,4})$/.exec(arg))) options.apiLimitMb = Number(match[1]);
    else if (arg === "--json") options.json = true;
    else {
      process.stderr.write(`unknown argument: ${arg.slice(0, 40)}\nusage: node tools/measure-panel-memory.js [--runs=3] [--idle-ms=20000] [--limit-mb=50] [--api-limit-mb=20] [--json]\n`);
      process.exit(2);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let result;
  try {
    result = await measure({
      runs: options.runs,
      idleMs: options.idleMs,
      onRun: (mode, n, sample) => {
        if (!options.json) process.stdout.write(`  run ${n} ${mode.padEnd(8)} RSS ${mb(sample.rss)}  heap+external ${mb(sample.heapUsed + sample.external)}\n`);
      },
    });
  } catch (error) {
    process.stderr.write(`measure-panel-memory: ${error.message}\n`);
    process.exit(2);
  }
  const limit = options.limitMb * MB;
  const apiLimit = options.apiLimitMb * MB;
  const panelOk = result.delta.rss < limit;
  const apiOk = result.apiDelta.rss < apiLimit;
  const ok = panelOk && apiOk;
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...result, samples: undefined, limitMb: options.limitMb, apiLimitMb: options.apiLimitMb, panelOk, apiOk, ok })}\n`);
  } else {
    const signed = (bytes) => `${bytes < 0 ? "-" : "+"}${mb(Math.abs(bytes))}`;
    process.stdout.write(
      [
        `median of ${options.runs} run(s) per mode, idle ${options.idleMs} ms`,
        `  baseline RSS ${mb(result.baseline.rss)}   heap+external ${mb(result.baseline.heapExternal)}`,
        `  panel    RSS ${mb(result.panel.rss)}   heap+external ${mb(result.panel.heapExternal)}`,
        `  api-off  RSS ${mb(result.apiOff.rss)}   heap+external ${mb(result.apiOff.heapExternal)}`,
        `  api-on   RSS ${mb(result.apiOn.rss)}   heap+external ${mb(result.apiOn.heapExternal)}`,
        `  delta    RSS ${mb(result.delta.rss)}   heap+external ${mb(result.delta.heapExternal)}   (panel minus baseline)`,
        `  api-off  RSS ${signed(result.apiOffDelta.rss)}   heap+external ${signed(result.apiOffDelta.heapExternal)}   (api-off minus panel: the API switched off)`,
        `  api-on   RSS ${signed(result.apiDelta.rss)}   heap+external ${signed(result.apiDelta.heapExternal)}   (api-on minus api-off: the API on and idle)`,
        `SC-009 (RSS delta under ${options.limitMb} MB): ${panelOk ? "OK" : "FAIL"}`,
        `SC-011 (api-on minus api-off under ${options.apiLimitMb} MB RSS): ${apiOk ? "OK" : "FAIL"}`,
        "",
      ].join("\n"),
    );
  }
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { runChild, measure, median, childEnv, DEFAULT_IDLE_MS };

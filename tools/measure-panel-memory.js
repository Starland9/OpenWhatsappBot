#!/usr/bin/env node
"use strict";

/**
 * Memory the admin panel adds to the bot at rest (SC-009: under 50 MB). Quickstart section 6.
 *
 *   node tools/measure-panel-memory.js [--runs=3] [--idle-ms=20000] [--limit-mb=50] [--json]
 *
 * It runs tools/panel-memory-child.js in `baseline` mode (config, database, plugins) and in `panel` mode (the same plus
 * the admin, a login, every page and read-only route fetched once, one SSE stream open, idle), `--runs` times each,
 * interleaved, every child with --expose-gc, an in-memory database and blank secrets (config.env is never read).
 * It prints the median RSS of both modes, the delta, and the same figures for heapUsed + external (the figure the
 * always-on test/admin-memory.test.js asserts under 25 MB).
 *
 * Exit code: 0 when the RSS delta is under the limit, 1 when it is not, 2 when a child failed.
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
 * @param {"baseline"|"panel"} mode
 * @param {{ idleMs?: number, timeoutMs?: number }} [options]
 * @returns {Promise<{ mode, rss, heapUsed, external, arrayBuffers, routes, fetched, failed }>}
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
 * `runs` children of each mode, interleaved (baseline, panel, baseline, panel...), then the medians.
 * @returns {Promise<{ baseline, panel, delta: { rss, heapExternal }, samples }>}
 */
async function measure({ runs = DEFAULT_RUNS, idleMs = DEFAULT_IDLE_MS, onRun } = {}) {
  const samples = { baseline: [], panel: [] };
  for (let i = 0; i < runs; i += 1) {
    for (const mode of ["baseline", "panel"]) {
      const sample = await runChild(mode, { idleMs });
      samples[mode].push(sample);
      if (onRun) onRun(mode, i + 1, sample);
    }
  }
  const summary = (list) => ({
    rss: median(list.map((s) => s.rss)),
    heapUsed: median(list.map((s) => s.heapUsed)),
    external: median(list.map((s) => s.external)),
    heapExternal: median(list.map((s) => s.heapUsed + s.external)),
  });
  const baseline = summary(samples.baseline);
  const panel = summary(samples.panel);
  return {
    baseline,
    panel,
    delta: { rss: panel.rss - baseline.rss, heapExternal: panel.heapExternal - baseline.heapExternal },
    samples,
  };
}

const mb = (bytes) => `${(bytes / MB).toFixed(1)} MB`;

function parseArgs(argv) {
  const options = { runs: DEFAULT_RUNS, idleMs: DEFAULT_IDLE_MS, limitMb: DEFAULT_LIMIT_MB, json: false };
  for (const arg of argv) {
    let match;
    if ((match = /^--runs=(\d{1,2})$/.exec(arg))) options.runs = Math.max(1, Number(match[1]));
    else if ((match = /^--idle-ms=(\d{1,7})$/.exec(arg))) options.idleMs = Number(match[1]);
    else if ((match = /^--limit-mb=(\d{1,4})$/.exec(arg))) options.limitMb = Number(match[1]);
    else if (arg === "--json") options.json = true;
    else {
      process.stderr.write(`unknown argument: ${arg.slice(0, 40)}\nusage: node tools/measure-panel-memory.js [--runs=3] [--idle-ms=20000] [--limit-mb=50] [--json]\n`);
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
  const ok = result.delta.rss < limit;
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...result, samples: undefined, limitMb: options.limitMb, ok })}\n`);
  } else {
    process.stdout.write(
      [
        `median of ${options.runs} run(s) per mode, idle ${options.idleMs} ms`,
        `  baseline RSS ${mb(result.baseline.rss)}   heap+external ${mb(result.baseline.heapExternal)}`,
        `  panel    RSS ${mb(result.panel.rss)}   heap+external ${mb(result.panel.heapExternal)}`,
        `  delta    RSS ${mb(result.delta.rss)}   heap+external ${mb(result.delta.heapExternal)}`,
        `SC-009 (RSS delta under ${options.limitMb} MB): ${ok ? "OK" : "FAIL"}`,
        "",
      ].join("\n"),
    );
  }
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { runChild, measure, median, childEnv, DEFAULT_IDLE_MS };

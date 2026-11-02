"use strict";
/**
 * Static render-loop guards of the API area (feature 004, contracts/panel-ui.md section 9, tasks T053): the files of the
 * area (views/api*.mjs, reauth.mjs, components/reauth-dialog.mjs) are read with the token scanner of
 * test/helpers/jsScan.js, no browser and no DOM.
 *
 *  - every useAsync / useEffect / useMemo / useCallback call has a dependency array as its last argument, an array
 *    literal whose entries are plain identifiers or member paths (primitives, never a call or a closure);
 *  - no setInterval; setTimeout only in views/api-watch.mjs (the bounded poller);
 *  - a file that builds a `${base}` path declares `const base = "/admin/api/api";` exactly once, at the top;
 *  - nothing calls fetch / XMLHttpRequest / EventSource directly (the client of api.mjs is the only door).
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { scan, matchBracket, splitTopLevel } = require("./helpers/jsScan");

const JS = path.resolve(__dirname, "..", "lib", "admin", "public", "js");
const VIEWS = path.join(JS, "views");

const files = [
  ...fs.readdirSync(VIEWS).filter((name) => /^api(-[a-z-]+)?\.mjs$/.test(name)).map((name) => path.join(VIEWS, name)),
  path.join(JS, "reauth.mjs"),
  path.join(JS, "components", "reauth-dialog.mjs"),
];
const rel = (file) => path.relative(JS, file).replace(/\\/g, "/");
const read = (file) => fs.readFileSync(file, "utf8");
const lineOf = (text, index) => text.slice(0, index).split("\n").length;
const ENTRY = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const HOOKS = /(?<![\w$.])(useAsync|useEffect|useMemo|useCallback)\s*\(/g;

test("the scan covers the area: the logic modules, the state, keys, history, test and docs views, the reauth files", () => {
  const names = new Set(files.map(rel));
  for (const needed of ["views/api.mjs", "views/api-logic.mjs", "views/api-form-logic.mjs", "reauth.mjs", "components/reauth-dialog.mjs"]) {
    assert.ok(names.has(needed), `${needed} is scanned`);
  }
  // the views of tasks T072 to T142 (a missing file is a failing test until the view exists)
  for (const view of ["api-state", "api-networks", "api-keys", "api-key-actions", "api-key-editor", "api-rights", "api-recipients", "api-ips", "api-secret", "api-history", "api-message", "api-watch", "api-usage", "api-test", "api-form", "api-docs"]) {
    assert.ok(names.has(`views/${view}.mjs`), `views/${view}.mjs exists`);
  }
});

test("every useAsync / useEffect / useMemo / useCallback has a dependency array of identifiers or member paths as its last argument", () => {
  const problems = [];
  let calls = 0;
  for (const file of files) {
    const src = read(file);
    const { skeleton } = scan(src);
    for (const match of skeleton.matchAll(HOOKS)) {
      const open = match.index + match[0].length - 1;
      const close = matchBracket(skeleton, open);
      const where = `${rel(file)}:${lineOf(src, match.index)}  ${match[1]}`;
      if (close === -1) {
        problems.push(`${where}: unbalanced call`);
        continue;
      }
      calls += 1;
      const args = splitTopLevel(skeleton, open + 1, close);
      const last = args[args.length - 1];
      const text = last ? skeleton.slice(last.start, last.end) : "";
      if (args.length < 2 || !text.startsWith("[") || !text.endsWith("]")) {
        problems.push(`${where}: no dependency array literal as the last argument`);
        continue;
      }
      const inner = splitTopLevel(skeleton, last.start + 1, last.end - 1).map((part) => skeleton.slice(part.start, part.end));
      for (const entry of inner) if (!ENTRY.test(entry)) problems.push(`${where}: dependency "${entry}" is not an identifier or a member path`);
    }
  }
  assert.ok(calls >= 10, `the scan finds the hook calls of the area (${calls})`);
  assert.deepEqual(problems, [], `dependency arrays:\n${problems.join("\n")}`);
});

test("no setInterval anywhere; setTimeout only in views/api-watch.mjs", () => {
  const problems = [];
  for (const file of files) {
    const { masked } = scan(read(file));
    if (/(?<![\w$.])setInterval\s*\(/.test(masked)) problems.push(`${rel(file)}: setInterval`);
    if (rel(file) !== "views/api-watch.mjs" && /(?<![\w$])setTimeout\s*\(/.test(masked)) problems.push(`${rel(file)}: setTimeout`);
  }
  assert.deepEqual(problems, []);
});

test("no direct fetch, XMLHttpRequest or EventSource: every call goes through api.mjs", () => {
  const problems = [];
  for (const file of files) {
    const { masked } = scan(read(file));
    for (const re of [/(?<![\w$.])fetch\s*\(/, /\bXMLHttpRequest\b/, /\bEventSource\b/]) if (re.test(masked)) problems.push(`${rel(file)}: ${re}`);
  }
  assert.deepEqual(problems, []);
});

test('a file that builds a ${base} path declares const base = "/admin/api/api"; exactly once, at the top', () => {
  const problems = [];
  let users = 0;
  for (const file of files) {
    const src = read(file);
    const { masked } = scan(src);
    // the pure logic modules have a local named `base` of their own and never call the panel: only a file that imports the client counts
    if (!/from "\.\.?\/api\.mjs"/.test(masked)) continue;
    const uses = [...masked.matchAll(/\$\{base\}/g)];
    const declarations = [...src.matchAll(/^const base = "\/admin\/api\/api";$/gm)];
    if (uses.length === 0) {
      if (declarations.length > 0 && rel(file) !== "views/api.mjs") problems.push(`${rel(file)}: declares base but never uses it`);
      continue;
    }
    users += 1;
    if (declarations.length !== 1) {
      problems.push(`${rel(file)}: ${declarations.length} declaration(s) of base`);
      continue;
    }
    const at = declarations[0].index;
    const firstFunction = masked.search(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/m);
    if (at > uses[0].index) problems.push(`${rel(file)}: base is declared after its first use`);
    if (firstFunction !== -1 && at > firstFunction) problems.push(`${rel(file)}: base is declared below the first function, not at the top`);
  }
  assert.ok(users >= 6, `the views that call the panel use base (${users})`);
  assert.deepEqual(problems, []);
});

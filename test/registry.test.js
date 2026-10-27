"use strict";
/**
 * T032: exact command matching (FR-019 to FR-021).
 *
 *  - every alias of every command resolves, case-insensitively;
 *  - none of `kiss class boss guess export expire giftcard faq iq display topng2 replay` triggers a command
 *    that does not name it exactly (these used to match as regex / substring);
 *  - no duplicate aliases (the registry would log a warning and drop the later one);
 *  - `poll+` resolves;
 *  - the loader order is sorted.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

const { IDS } = fakes;
fakes.setupEnv({ sudo: "111" });
const net = fakes.stubNetwork();

let registry;
let loader;
let commands;
let loaded;
let failed;
let pendingI18n = 0;
const executed = []; // { file, alias } recorded by the spies

before(async () => {
  const setup = await fakes.setup();
  ({ registry, loader, commands, loaded, failed, pendingI18n } = setup);
  for (const entry of commands) {
    entry.realExecute = entry.execute;
    entry.execute = async function spy(message, args, ctx) {
      executed.push({ file: entry.file, aliases: entry.aliases, alias: ctx?.command });
    };
  }
});

after(() => {
  for (const entry of commands || []) if (entry.realExecute) entry.execute = entry.realExecute;
  net.restore();
});

const FALSE_POSITIVES = "kiss class boss guess export expire giftcard faq iq display topng2 replay".split(" ");

test("every plugin file loads (no load failure)", () => {
  assert.deepEqual(
    failed.map((f) => `${f.file}: ${f.error.split("\n")[0]}`),
    [],
    "plugins that failed to load (FR-011: reported, but they must not stop the others)",
  );
  assert.ok(commands.length > 50, `only ${commands.length} commands registered`);
});

test("the loader requires plugin files in sorted order", () => {
  assert.deepEqual(loaded, [...loaded].sort(), "loadAll() result is not sorted");
  const files = commands.map((c) => c.file);
  assert.deepEqual(files, [...files].sort(), "commands are not registered in sorted file order");
});

test("every alias of every command resolves to its command (case-insensitive, with or without prefix)", () => {
  const problems = [];
  for (const entry of commands) {
    assert.ok(entry.aliases.length > 0, `${entry.file} has no alias`);
    for (const alias of entry.aliases) {
      for (const variant of [alias, alias.toUpperCase(), alias[0].toUpperCase() + alias.slice(1), `.${alias}`, `.${alias.toUpperCase()}`]) {
        const found = registry.getCommandByPattern(variant);
        if (found !== entry) problems.push(`"${variant}" (alias of ${entry.file}) -> ${found ? found.file : "nothing"}`);
      }
      if (registry.getPlugin(alias) !== entry.plugin) problems.push(`getPlugin("${alias}") is not the plugin of ${entry.file}`);
    }
  }
  fakes.assertNone(problems);
});

test("every alias is dispatched by executeCommand to its own command (and only to it)", async () => {
  const problems = [];
  for (const entry of commands) {
    for (const alias of entry.aliases) {
      for (const body of [`.${alias} some args`, `.${alias.toUpperCase()}`]) {
        executed.length = 0;
        const message = fakes.makeMessage({ body, from: IDS.OWNER_PN, group: !entry.onlyPm, admin: true });
        const matched = await registry.executeCommand(message);
        if (!matched || executed.length !== 1 || executed[0].file !== entry.file) {
          problems.push(`"${body}" -> matched=${matched} executed=${JSON.stringify(executed.map((e) => e.file))}, expected ${entry.file}`);
        }
      }
    }
  }
  fakes.assertNone(problems);
});

test(`no false positive: ${FALSE_POSITIVES.join(" ")}`, async () => {
  const problems = [];
  for (const word of FALSE_POSITIVES) {
    const found = registry.getCommandByPattern(word);
    if (found && !found.aliases.includes(word)) problems.push(`getCommandByPattern("${word}") -> ${found.file} (${found.aliases.join("|")}) which does not name it`);

    for (const body of [`.${word}`, `.${word} args`, `.${word.toUpperCase()}`]) {
      executed.length = 0;
      const message = fakes.makeMessage({ body, from: IDS.OWNER_PN, group: true, admin: true });
      await registry.executeCommand(message);
      for (const run of executed) {
        if (!run.aliases.includes(word)) problems.push(`"${body}" ran ${run.file} (${run.aliases.join("|")}), which does not name "${word}"`);
      }
    }
  }
  fakes.assertNone(problems);
});

test("matching is exact: a truncated, extended or embedded alias never triggers a command it does not name", async () => {
  const problems = [];
  const allAliases = new Set(commands.flatMap((c) => c.aliases));
  for (const entry of commands) {
    for (const alias of entry.aliases) {
      const variants = new Set([`${alias}x`, `x${alias}`, `${alias}${alias}`, `${alias}.`, `${alias}-`]);
      if (alias.length > 1) variants.add(alias.slice(0, -1));
      for (const variant of variants) {
        if (allAliases.has(variant)) continue; // that is another command's real name
        const found = registry.getCommandByPattern(variant);
        if (found) problems.push(`"${variant}" resolves to ${found.file} (derived from alias "${alias}" of ${entry.file})`);
      }
    }
  }
  fakes.assertNone(problems);

  // regex-looking input must be inert
  for (const body of [".", ". ", ".*", ".(", ".[a-z]+", ".a|b", ".^ping$", "..ping"]) {
    executed.length = 0;
    const matched = await registry.executeCommand(fakes.makeMessage({ body, from: IDS.OWNER_PN }));
    assert.equal(matched, false, `"${body}" matched a command`);
    assert.equal(executed.length, 0, `"${body}" executed ${JSON.stringify(executed)}`);
  }
});

test("no duplicate aliases: each alias has one owner and no declared alias was dropped", () => {
  const owners = new Map();
  const problems = [];
  for (const entry of commands) {
    for (const alias of entry.aliases) {
      if (owners.has(alias)) problems.push(`alias "${alias}" is registered twice (${owners.get(alias)} and ${entry.file})`);
      owners.set(alias, entry.file);
    }
    // the registry drops an alias already taken and logs "Duplicate alias": it shows as a missing alias here
    const declared = registry.parseAliases(entry.rawPattern);
    const dropped = declared.filter((a) => !entry.aliases.includes(a));
    if (dropped.length) problems.push(`${entry.file}: alias(es) ${dropped.map((a) => `"${a}"`).join(", ")} declared but dropped (already owned by ${dropped.map((a) => registry.getCommandByPattern(a)?.file).join(", ")})`);
  }
  // a plugin whose every alias was taken is unreachable and has no entry at all
  const registered = new Set(commands.map((c) => c.plugin));
  for (const plugin of registry.getPlugins()) {
    if (plugin.command && typeof plugin.execute === "function" && !registered.has(plugin)) {
      problems.push(`${registry.getPluginFile(plugin)}: command "${plugin.command.pattern}" is unreachable (invalid or all aliases already taken)`);
    }
  }
  fakes.assertNone(problems);
});

test("aliases are literal names: no regex syntax, no whitespace, lower-case", () => {
  const problems = [];
  for (const entry of commands) {
    for (const alias of entry.aliases) {
      if (/[\\^$*?()[\]{}\s]/.test(alias)) problems.push(`${entry.file}: alias "${alias}" contains regex syntax or whitespace`);
      if (alias !== alias.toLowerCase()) problems.push(`${entry.file}: alias "${alias}" is not lower-case`);
    }
    if (/[\\^$*?()[\]{}]/.test(entry.rawPattern.replace(/\\\+/g, "+"))) {
      problems.push(`${entry.file}: pattern "${entry.rawPattern}" looks like a regex (patterns are literal names separated by "|")`);
    }
  }
  fakes.assertNone(problems);
});

test("poll+ resolves (and so do its siblings)", async () => {
  const entry = registry.getCommandByPattern("poll+");
  assert.ok(entry, '"poll+" does not resolve to any command');
  assert.equal(registry.getCommandByPattern("POLL+"), entry);
  assert.equal(registry.getCommandByPattern(".poll+"), entry);

  executed.length = 0;
  await registry.executeCommand(fakes.makeMessage({ body: ".poll+ Best? a, b", from: IDS.OWNER_PN, group: true, admin: true }));
  assert.deepEqual(executed.map((e) => e.file), [entry.file]);
});

test("registry lookups are consistent (getCommands, getCommandByPattern, getPlugin, getHooks)", () => {
  assert.equal(new Set(commands).size, commands.length, "a command is listed twice");
  for (const entry of commands) {
    assert.equal(typeof entry.name, "string");
    assert.equal(entry.name, entry.aliases[0]);
    assert.equal(entry.pattern, entry.aliases.join("|"));
    assert.equal(typeof entry.realExecute, "function", `${entry.file} has no execute`);
    assert.equal(registry.getPlugin(entry.file.replace(/\.js$/, "")), entry.plugin, `getPlugin by file name failed for ${entry.file}`);
  }
  for (const hookName of registry.HOOK_NAMES) {
    for (const hook of registry.getHooks(hookName)) {
      assert.equal(typeof hook.fn, "function", `${hook.file}: ${hookName} is not a function`);
    }
  }
  assert.equal(registry.getCommandByPattern(undefined), null);
  assert.equal(registry.getCommandByPattern(""), null);
  assert.equal(registry.getCommandByPattern("definitely-not-a-command"), null);
});

test("every command has a description and a category, and the description is translated (not a raw key)", (t) => {
  // translations come from lang/*.json plus the not-yet-merged i18n fragments (fakes.setup() overlays them)
  const problems = [];
  for (const entry of commands) {
    if (typeof entry.desc !== "string" || entry.desc.trim() === "") problems.push(`${entry.file} (.${entry.name}): empty desc`);
    else if (/^(plugins|common|extra)\.[\w.]+$/.test(entry.desc.trim())) {
      problems.push(`${entry.file} (.${entry.name}): desc is the untranslated key "${entry.desc}"`);
    }
    if (typeof entry.type !== "string" || !entry.type) problems.push(`${entry.file} (.${entry.name}): no type`);
  }
  t.diagnostic(`${pendingI18n} translation key(s) from i18n fragments overlaid on lang/*.json`);
  fakes.assertNone(problems);
});

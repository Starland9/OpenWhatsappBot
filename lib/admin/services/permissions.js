"use strict";

/**
 * Command permissions of the admin panel (feature 003, contracts/admin-permissions-api.md, PERM-1..PERM-7): who may
 * use which command, everywhere or in one group, beyond or instead of its normal level. It never touches `req`/`res`;
 * the HTTP layer is lib/admin/routes/permissions.js and the decision itself is lib/utils/commandPermissions.js.
 *
 *   const permissions = createPermissionsService(deps);
 *   await permissions.overview()                          PERM-1  { items, orphans, limits }
 *   await permissions.commandView(name)                   PERM-2  { command, delegable, lockReason, access, everywhere, groups }
 *   await permissions.putGlobalRule(name, body)           PERM-3  { rule, changed, audit }
 *   await permissions.deleteGlobalRule(name)              PERM-4  { deleted, audit }
 *   await permissions.groupView(jid)                      PERM-5  { rules, everywhere, orphans, members, limits }
 *   await permissions.putGroupRule(jid, name, body)       PERM-6  { rule, changed, audit }
 *   await permissions.deleteGroupRule(jid, name)          PERM-7  { deleted, audit }
 *
 * `audit` is `{ target, detail }` when something changed (the route writes ONE audit row from it) and `null`
 * otherwise. Reads never write. A write is a full replace of the `(command, scope)` row under
 * `mutex.withLock("permissions")`: read the stored row, merge the submitted people into it, compare, write at most
 * once (create, update or destroy), then `commandPermissions.invalidate()` so that the next message obeys.
 * WhatsApp lookups (the other form of a person) run BEFORE the lock, so a slow lookup never holds up other saves.
 *
 * The registry, the engine, the models, the groups service and the socket are resolved lazily from `deps`
 * (`deps.registry`, `deps.commandPermissions`, `deps.models`, `deps.groupsService`, `deps.client`...), so a test can
 * inject a fake. Errors are `AdminError`s of the envelope (codes and parameters, never prose, never a submitted value).
 */

const { Op } = require("sequelize");
const { AdminError } = require("../http/response");
const { accessOf } = require("./commands");
const { parsePhoneNumber } = require("../../utils/permissions");

const GLOBAL_SCOPE = "*";
const LOOKUP_TIMEOUT_MS = 3000; // getLIDForPN may reach the server
const LOOKUP_BATCH = 10; // concurrent PN -> LID lookups
const NAME_CHUNK = 400; // `IN (...)` size of the KnownChat queries (the SQLite variable limit is 999)
const AUDIT_DETAIL_MAX = 1900; // below serializeDetail's 2000, so the ids are never replaced by a summary
const LOCK_KEY = "permissions";

const PN_SERVER = "s.whatsapp.net";
const LID_SERVER = "lid";

const iso = (value) => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const fieldError = (name, code, params) =>
  new AdminError("validation_failed", { fields: { [name]: params ? { code, params } : { code } } });

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// People: parsing (1.3) and merging
// ---------------------------------------------------------------------------

/**
 * One submitted string as a person with a single form: `{ pn, lid }` (the other one `null`), or `{ error }`.
 * A string with `@` is a JID (device suffix dropped, `c.us` mapped; phone number of 8 to 15 digits or LID of 5 to
 * 20 digits, any other server is refused). Without `@` it is a typed number: spaces, `+`, `-`, `.`, parentheses and
 * a leading `00` are stripped, 8 to 15 digits with the country code, never starting with `0`.
 */
function parsePerson(input, normalizeJid) {
  const text = String(input ?? "");
  if (text.includes("@")) {
    const jid = normalizeJid(text);
    const at = jid.indexOf("@");
    const user = at > 0 ? jid.slice(0, at) : "";
    const server = at > 0 ? jid.slice(at + 1) : "";
    if (server === PN_SERVER && /^\d{8,15}$/.test(user)) return { pn: jid, lid: null };
    if (server === LID_SERVER && /^\d{5,20}$/.test(user)) return { pn: null, lid: jid };
    return { error: "invalid_jid" };
  }
  const typed = parsePhoneNumber(text);
  return typed.error ? { error: typed.error } : { pn: typed.pn, lid: null };
}

/** Every submitted string parsed, or a 422 `people` error with the positions (never the values) of the failures */
function parsePeople(list, normalizeJid) {
  const people = [];
  let failure = null;
  const indices = [];
  list.forEach((input, index) => {
    const parsed = parsePerson(input, normalizeJid);
    if (parsed.error) {
      failure = failure || parsed.error; // the first failing code; its positions are listed together
      if (parsed.error === failure) indices.push(index);
    } else {
      people.push(parsed);
    }
  });
  if (failure) throw fieldError("people", failure, { indices });
  return people;
}

/** The stored `people` of a row as a clean list of `{ pn, lid }` (an unreadable element is dropped) */
function storedPeopleOf(row) {
  let list = row ? row.people : [];
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const pn = typeof item.pn === "string" && item.pn ? item.pn : null;
    const lid = typeof item.lid === "string" && item.lid ? item.lid : null;
    if (pn || lid) out.push({ pn, lid });
  }
  return out;
}

const sharesForm = (a, b) => Boolean((a.pn && a.pn === b.pn) || (a.lid && a.lid === b.lid));
const samePerson = (a, b) => a.pn === b.pn && a.lid === b.lid;
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.some((y) => samePerson(x, y)));
const jidOf = (person) => person.pn || person.lid;
/** `237690000001`, or `99000000011@lid` for a person known by LID only (audit ids) */
const compactId = (person) => (person.pn ? person.pn.split("@")[0] : `${person.lid.split("@")[0]}@lid`);
const formKey = (person) => person.pn || person.lid;

/** Merge the groups of forms that share a form (a resolved person may link two earlier inputs) */
function coalesce(groups) {
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = groups.length - 1; j > i; j -= 1) {
      if (!sharesForm(groups[i], groups[j])) continue;
      groups[i].pn = groups[i].pn || groups[j].pn;
      groups[i].lid = groups[i].lid || groups[j].lid;
      groups.splice(j, 1);
      j = groups.length; // the enriched group may now share with one already passed
    }
  }
  return groups;
}

/**
 * The people of the rule after a replace. An input equal (`pn` or `lid`) to a stored person keeps that person and
 * needs no lookup; any other input is completed by `resolve(input)`. Two inputs that end up as the same person are
 * one person. A stored person that no input names is removed. Stored order first, then the new people in body order.
 */
function mergePeople(stored, inputs, resolve) {
  const groups = [];
  for (const input of inputs) {
    const known = stored.find((person) => sharesForm(person, input));
    const base = known ? { pn: known.pn, lid: known.lid } : resolve(input);
    const into = groups.find((group) => sharesForm(group, base));
    if (into) {
      into.pn = into.pn || base.pn;
      into.lid = into.lid || base.lid;
    } else {
      groups.push({ pn: base.pn, lid: base.lid });
    }
  }
  coalesce(groups);

  const used = new Set();
  const merged = [];
  for (const person of stored) {
    const group = groups.find((candidate) => sharesForm(candidate, person));
    if (!group || used.has(group)) continue;
    used.add(group);
    merged.push({ pn: person.pn || group.pn, lid: person.lid || group.lid });
  }
  for (const group of groups) if (!used.has(group)) merged.push(group);
  return merged;
}

/** Who joined and who left, as compact ids; a person who keeps one of his forms appears in neither list */
function diffPeople(before, after) {
  return {
    added: after.filter((person) => !before.some((old) => sharesForm(person, old))).map(compactId),
    removed: before.filter((person) => !after.some((now) => sharesForm(person, now))).map(compactId),
  };
}

/** The audit detail with the degrade rule of 1.7: `removedCount`, then `addedCount`, once over 1900 characters */
function auditDetail({ mode, previousMode, added, removed }) {
  const detail = { mode, previousMode, added, removed };
  const size = () => JSON.stringify(detail).length;
  if (size() > AUDIT_DETAIL_MAX) {
    delete detail.removed;
    detail.removedCount = removed.length;
  }
  if (size() > AUDIT_DETAIL_MAX) {
    delete detail.added;
    detail.addedCount = added.length;
  }
  return detail;
}

// ---------------------------------------------------------------------------
// Warnings (1.5)
// ---------------------------------------------------------------------------

const isKnownAdmin = (person) => person.admin === "admin" || person.admin === "superadmin";

/**
 * The server warnings of a rule, in the fixed order of 1.5.
 * @param {object} p
 * @param {{ owner: boolean, admin: boolean }} p.access  the command's access level
 * @param {string} p.scope
 * @param {string} p.mode
 * @param {object[]} p.people  person views (`admin` set by the group routes, missing otherwise)
 * @param {boolean} p.everywhereOnly  a `*` rule of mode `only` exists for this command
 * @param {boolean} [p.withAdmin=true]  PERM-2 never calls WhatsApp: it leaves `opens_admin_command` out
 */
function computeWarnings({ access, scope, mode, people, everywhereOnly, withAdmin = true }) {
  const warnings = [];
  const everywhere = scope === GLOBAL_SCOPE;
  if (withAdmin && access.admin && people.length > 0) {
    const count = everywhere ? people.length : people.filter((person) => !isKnownAdmin(person)).length;
    if (everywhere || count > 0) warnings.push({ code: "opens_admin_command", tone: "warn", params: { count, everywhere } });
  }
  if (mode === "extra" && people.length > 0 && !access.owner && !access.admin) {
    warnings.push({ code: "extra_on_public", tone: "warn", params: {} });
  }
  if (mode === "only" && people.length === 0) warnings.push({ code: "empty_only", tone: "warn", params: {} });
  if (!everywhere && mode === "extra" && people.length === 0) {
    warnings.push({ code: "normal_here", tone: everywhereOnly ? "info" : "warn", params: {} });
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

function createPermissionsService(deps = {}) {
  const registry = () => deps.registry || require("../../plugins/registry");
  const engine = () => deps.commandPermissions || require("../../utils/commandPermissions");
  const models = () => deps.models || require("../../database");
  const mutex = () => deps.mutex || require("../../utils/mutex");
  const perms = () => deps.permissions || require("../../utils/permissions");
  const http = () => deps.http || require("../../utils/http");
  const groups = () => {
    if (deps.groupsService) return deps.groupsService;
    return require("./groups").groupsServiceOf(deps);
  };
  const MODES = () => engine().MODES;

  /** The open socket, or null when the bot is not connected */
  function openSocket() {
    const client = typeof deps.getClient === "function" ? deps.getClient() : deps.client;
    if (!client) return null;
    try {
      if (typeof client.ready === "function" && !client.ready()) return null;
      return (typeof client.getSocket === "function" && client.getSocket()) || null;
    } catch {
      return null;
    }
  }

  // ---- Commands --------------------------------------------------------------------------------

  const loadedEntries = () => registry().getCommands();
  const entriesByName = () => new Map(loadedEntries().map((entry) => [entry.name, entry]));
  const isDelegable = (entry) => Boolean(entry) && entry.delegable === true;
  const lockReasonOf = (entry) => (isDelegable(entry) ? null : entry.lockReason || null);

  /** The loaded command a path name stands for (an alias or a prefixed name resolves to the first alias) */
  function resolveLoaded(name) {
    const entry = registry().getCommandByPattern(String(name ?? "").trim().toLowerCase());
    if (!entry) throw new AdminError("not_found", { params: { resource: "command" } });
    return entry;
  }

  /** Why a stored row is inert: its command is not loaded, or is loaded but cannot be delegated */
  function orphanReason(command, byName) {
    const entry = byName.get(command);
    if (!entry) return "unknown_command";
    return isDelegable(entry) ? null : "not_delegable";
  }

  // ---- Rows ------------------------------------------------------------------------------------

  const findRow = (command, scope) => models().PermissionRule.findOne({ where: { command, scope } });
  const allRows = () => models().PermissionRule.findAll({ order: [["command", "ASC"], ["scope", "ASC"]] });

  // ---- Names and the other form of a person (1.2, 1.3) -----------------------------------------------

  /** KnownChat rows that name or link any of `forms` (one chunked `IN` query of NAME_CHUNK) */
  async function knownChatRows(forms) {
    const unique = [...new Set(forms.filter(Boolean))];
    const { KnownChat } = models();
    const rows = [];
    for (let i = 0; i < unique.length; i += NAME_CHUNK) {
      const chunk = unique.slice(i, i + NAME_CHUNK);
      rows.push(
        ...(await KnownChat.findAll({
          where: { [Op.or]: [{ jid: { [Op.in]: chunk } }, { pnJid: { [Op.in]: chunk } }] },
          attributes: ["jid", "pnJid", "name"],
          raw: true,
        })),
      );
    }
    return rows;
  }

  /** form -> push name, for every form of every given person */
  async function namesOf(people) {
    const forms = people.flatMap((person) => [person.pn, person.lid]);
    const names = new Map();
    if (!forms.some(Boolean)) return names;
    for (const row of await knownChatRows(forms)) {
      if (!row.name) continue;
      if (!names.has(row.jid)) names.set(row.jid, row.name);
      if (row.pnJid && !names.has(row.pnJid)) names.set(row.pnJid, row.name);
    }
    return names;
  }

  /**
   * The missing form of every person who is not already stored: participants of the group, KnownChat, the Baileys
   * LID mapping (LID -> PN), then `getLIDForPN` (PN -> LID, open socket only, under a 3 s timeout, errors ignored).
   * Never fatal: a person with one form is valid, the engine resolves the other at decision time.
   * @returns {Promise<Map<string, { pn: string|null, lid: string|null }>>} by `formKey` of the input
   */
  async function resolveInputs(inputs, stored, participants) {
    const resolved = new Map();
    const fresh = inputs.filter((input) => !stored.some((person) => sharesForm(person, input)));
    if (!fresh.length) return resolved;

    const index = indexParticipants(participants);
    const links = await knownChatRows(fresh.map(formKey)).catch(() => []);
    const sock = openSocket();
    const { toPnJid, normalizeJid } = perms();

    const complete = async (input) => {
      const out = { pn: input.pn, lid: input.lid };
      // 1. the participants of the group
      const member = index.get(input.pn) || index.get(input.lid);
      if (member) {
        out.pn = out.pn || member.pn;
        out.lid = out.lid || member.lid;
      }
      // 2. KnownChat
      if (!out.pn || !out.lid) {
        for (const row of links) {
          if (input.lid && row.jid === input.lid && row.pnJid && !out.pn) out.pn = normalizeJid(row.pnJid) || null;
          if (input.pn && row.pnJid === input.pn && String(row.jid).endsWith("@lid") && !out.lid) out.lid = normalizeJid(row.jid) || null;
        }
      }
      // 3. LID -> PN through the local Baileys mapping
      if (!out.pn && out.lid && sock) {
        try {
          const found = await toPnJid({ isGroup: false, client: { getSocket: () => sock } }, out.lid);
          if (found && found.endsWith(`@${PN_SERVER}`)) out.pn = found;
        } catch {
          // best effort
        }
      }
      // 4. PN -> LID, only with an open socket
      if (!out.lid && out.pn && sock) {
        try {
          const mapping = sock.signalRepository?.lidMapping;
          const found = mapping && (await http().withTimeout(mapping.getLIDForPN(out.pn), LOOKUP_TIMEOUT_MS, "getLIDForPN"));
          const lid = found ? normalizeJid(found) : "";
          if (lid.endsWith(`@${LID_SERVER}`)) out.lid = lid;
        } catch {
          // best effort: the person is saved with the phone number only
        }
      }
      return out;
    };

    for (let i = 0; i < fresh.length; i += LOOKUP_BATCH) {
      const batch = fresh.slice(i, i + LOOKUP_BATCH);
      const done = await Promise.all(batch.map(complete));
      batch.forEach((input, at) => resolved.set(formKey(input), done[at]));
    }
    return resolved;
  }

  // ---- Participants (group routes) ---------------------------------------------------------------------

  /** form -> participant item, for every PN and LID of the group */
  function indexParticipants(participants) {
    const index = new Map();
    for (const item of participants?.items || []) {
      if (item.pn) index.set(item.pn, item);
      if (item.lid) index.set(item.lid, item);
    }
    return index;
  }

  // ---- Views -------------------------------------------------------------------------------------------------

  /**
   * A person for the browser: `{ jid, name, present?, admin? }`. `present`/`admin` only when `participants` is given
   * (group routes): `null` when the group's members are unknown (bot offline, group left, fetch failed).
   */
  function personView(person, names, participants, index) {
    const view = { jid: jidOf(person), name: names.get(person.pn) || names.get(person.lid) || null };
    if (participants) {
      if (!participants.available) {
        view.present = null;
        view.admin = null;
      } else {
        const hit = index.get(person.pn) || index.get(person.lid);
        view.present = Boolean(hit);
        view.admin = hit && hit.admin ? hit.admin : null;
      }
    }
    return view;
  }

  /** A Rule (1.2) from a stored row */
  function ruleView(row, { entry, names, participants, index, everywhereOnly, withAdmin = true }) {
    const stored = storedPeopleOf(row);
    const people = stored.map((person) => personView(person, names, participants, index));
    return {
      command: row.command,
      scope: row.scope,
      mode: row.mode,
      people,
      warnings: entry
        ? computeWarnings({ access: accessOf(entry), scope: row.scope, mode: row.mode, people, everywhereOnly, withAdmin })
        : [],
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  }

  /** Commands that have a `*` rule of mode `only` */
  const onlyEverywhere = (rows) => new Set(rows.filter((row) => row.scope === GLOBAL_SCOPE && row.mode === MODES().ONLY).map((row) => row.command));

  const orphanView = (row, reason) => ({
    command: row.command,
    scope: row.scope,
    mode: row.mode,
    count: storedPeopleOf(row).length,
    reason,
  });

  // ---- PERM-1 ----------------------------------------------------------------------------------------------------

  /** PERM-1: every loaded command with its rules' counts, and the inert rows. Read straight from the table. */
  async function overview() {
    const rows = await allRows();
    const byName = entriesByName();
    const everywhere = new Map();
    const groupCount = new Map();
    const orphans = [];
    for (const row of rows) {
      const reason = orphanReason(row.command, byName);
      if (reason) {
        orphans.push(orphanView(row, reason));
      } else if (row.scope === GLOBAL_SCOPE) {
        everywhere.set(row.command, { mode: row.mode, count: storedPeopleOf(row).length });
      } else {
        groupCount.set(row.command, (groupCount.get(row.command) || 0) + 1);
      }
    }
    const items = loadedEntries()
      .map((entry) => ({
        name: entry.name,
        delegable: isDelegable(entry),
        lockReason: lockReasonOf(entry),
        everywhere: everywhere.get(entry.name) || null,
        groups: groupCount.get(entry.name) || 0,
      }))
      .sort((a, b) => byText(a.name, b.name));
    orphans.sort((a, b) => byText(a.command, b.command) || byText(a.scope, b.scope));
    return { items, orphans, limits: { peopleMax: engine().MAX_PEOPLE } };
  }

  // ---- PERM-2 ----------------------------------------------------------------------------------------------------

  /** The name the panel knows a group by: the live snapshot, the Group row, then KnownChat */
  async function groupNames(jids) {
    const names = new Map();
    if (!jids.length) return names;
    const { Group, KnownChat } = models();
    const [settings, chats] = await Promise.all([
      Group.findAll({ where: { jid: { [Op.in]: jids } }, attributes: ["jid", "name"], raw: true }),
      KnownChat.findAll({ where: { jid: { [Op.in]: jids } }, attributes: ["jid", "name"], raw: true }),
    ]);
    const live = groups();
    for (const jid of jids) {
      const snapshot = typeof live.nameOf === "function" ? live.nameOf(jid) : null;
      const row = settings.find((x) => x.jid === jid);
      const chat = chats.find((x) => x.jid === jid);
      names.set(jid, snapshot || (row && row.name) || (chat && chat.name) || null);
    }
    return names;
  }

  /** PERM-2: one command's `*` rule and the groups that have a rule of their own */
  async function commandView(name) {
    const entry = resolveLoaded(name);
    const view = {
      command: entry.name,
      delegable: isDelegable(entry),
      lockReason: lockReasonOf(entry),
      access: accessOf(entry),
      everywhere: null,
      groups: [],
    };
    if (!isDelegable(entry)) return view;

    const rows = (await allRows()).filter((row) => row.command === entry.name);
    const global = rows.find((row) => row.scope === GLOBAL_SCOPE) || null;
    const groupRows = rows.filter((row) => row.scope !== GLOBAL_SCOPE);
    const everywhereOnly = Boolean(global && global.mode === MODES().ONLY);

    const names = await namesOf(rows.flatMap(storedPeopleOf));
    if (global) view.everywhere = ruleView(global, { entry, names, everywhereOnly });
    const jidNames = await groupNames(groupRows.map((row) => row.scope));
    view.groups = groupRows
      .map((row) => {
        const rule = ruleView(row, { entry, names, everywhereOnly, withAdmin: false });
        return { jid: row.scope, name: jidNames.get(row.scope) || null, mode: row.mode, count: rule.people.length, warnings: rule.warnings };
      })
      .sort((a, b) => {
        if ((a.name === null) !== (b.name === null)) return a.name === null ? 1 : -1; // unnamed last
        return byText(String(a.name).toLowerCase(), String(b.name).toLowerCase()) || byText(a.jid, b.jid);
      });
    return view;
  }

  // ---- PERM-3 .. PERM-7: writes ----------------------------------------------------------------------------------------

  /**
   * The common pipeline of PERM-3 and PERM-6 after the schema stage (1.6): command, group, delegability, empty-list
   * rule, people, merge, diff, one write.
   */
  async function putRule(scope, name, body) {
    const isGroup = scope !== GLOBAL_SCOPE;
    const entry = resolveLoaded(name); // 3. unknown command
    const participants = isGroup ? await groups().participants(scope) : null; // 3. unknown group
    if (!isDelegable(entry)) throw fieldError("name", "not_allowed"); // 4. cannot be delegated
    const { EXTRA } = MODES();
    if (!isGroup && body.mode === EXTRA && body.people.length === 0) throw fieldError("people", "required"); // 5.
    const inputs = parsePeople(body.people, perms().normalizeJid); // 6.

    const command = entry.name;
    const { PermissionRule } = models();
    // lookups first, outside the lock: a slow WhatsApp answer must not hold up the other saves
    const resolved = await resolveInputs(inputs, storedPeopleOf(await findRow(command, scope)), participants);

    const result = await mutex().withLock(LOCK_KEY, async () => {
      // the group again, under the lock GRP-6 also takes: a group forgotten meanwhile gets no rule back (FR-030)
      if (isGroup) await groups().locate(scope);
      const row = await findRow(command, scope);
      const before = storedPeopleOf(row);
      const after = mergePeople(before, inputs, (input) => resolved.get(formKey(input)) || { pn: input.pn, lid: input.lid });
      const changed = !row || row.mode !== body.mode || !sameSet(before, after);
      const previousMode = row ? row.mode : null;

      let saved = row;
      if (changed) {
        if (row) await row.update({ mode: body.mode, people: after });
        else saved = await PermissionRule.create({ command, scope, mode: body.mode, people: after });
        engine().invalidate();
      }
      return { saved, changed, previousMode, ...diffPeople(before, after) };
    });

    // the answer: the rule as stored, annotated and warned
    const rows = isGroup ? await PermissionRule.findAll({ where: { command, scope: GLOBAL_SCOPE } }) : [];
    const names = await namesOf(storedPeopleOf(result.saved));
    const rule = ruleView(result.saved, {
      entry,
      names,
      participants,
      index: indexParticipants(participants),
      everywhereOnly: rows.some((row) => row.mode === MODES().ONLY),
    });
    return {
      rule,
      changed: result.changed,
      audit: result.changed
        ? {
            target: `${command}:${scope}`,
            detail: auditDetail({ mode: body.mode, previousMode: result.previousMode, added: result.added, removed: result.removed }),
          }
        : null,
    };
  }

  /** PERM-7 / PERM-4: remove one rule. Idempotent; an orphan name (unknown or not delegable command) is accepted. */
  async function deleteRule(scope, name) {
    const isGroup = scope !== GLOBAL_SCOPE;
    const raw = String(name ?? "").trim().toLowerCase();
    const entry = registry().getCommandByPattern(raw);
    let command = entry ? entry.name : raw;

    let row = await findRow(command, scope);
    if (!row && entry && raw !== command) {
      // a row stored under an alias is an orphan the panel lists under that name: it stays removable
      const alias = await findRow(raw, scope);
      if (alias) {
        row = alias;
        command = raw;
      }
    }
    if (!entry && !row) throw new AdminError("not_found", { params: { resource: "command" } });

    if (isGroup) {
      try {
        await groups().locate(scope);
      } catch (err) {
        // a group the panel has never seen: its stale rows stay removable
        if (!(err instanceof AdminError) || err.code !== "not_found") throw err;
        if (!(await models().PermissionRule.count({ where: { scope } }))) throw err;
      }
    }
    if (!row) return { deleted: false, audit: null };

    const { PermissionRule } = models();
    return await mutex().withLock(LOCK_KEY, async () => {
      const current = await findRow(command, scope);
      if (!current) return { deleted: false, audit: null };
      const people = storedPeopleOf(current);
      const mode = current.mode;
      const removed = await PermissionRule.destroy({ where: { command, scope } });
      if (!removed) return { deleted: false, audit: null };
      engine().invalidate();
      return {
        deleted: true,
        audit: { target: `${command}:${scope}`, detail: auditDetail({ mode, previousMode: mode, added: [], removed: people.map(compactId) }) },
      };
    });
  }

  const putGlobalRule = (name, body) => putRule(GLOBAL_SCOPE, name, body);
  const deleteGlobalRule = (name) => deleteRule(GLOBAL_SCOPE, name);

  const putGroupRule = (jid, name, body) => putRule(jid, name, body);
  const deleteGroupRule = (jid, name) => deleteRule(jid, name);

  // ---- PERM-5 ----------------------------------------------------------------------------------------------------------

  /** PERM-5: this group's rules, every `*` rule annotated for this group, the group's inert rows, the members' state */
  async function groupView(jid) {
    const participants = await groups().participants(jid); // 404 for an unknown group; one call for the whole answer
    const index = indexParticipants(participants);
    const rows = await allRows();
    const byName = entriesByName();
    const everywhereOnly = onlyEverywhere(rows);

    const mine = rows.filter((row) => row.scope === jid);
    const global = rows.filter((row) => row.scope === GLOBAL_SCOPE && isDelegable(byName.get(row.command)));
    const live = mine.filter((row) => isDelegable(byName.get(row.command)));
    const names = await namesOf([...live, ...global].flatMap(storedPeopleOf));

    const view = (row) =>
      ruleView(row, { entry: byName.get(row.command), names, participants, index, everywhereOnly: everywhereOnly.has(row.command) });
    return {
      rules: live.map(view).sort((a, b) => byText(a.command, b.command)),
      everywhere: global.map(view).sort((a, b) => byText(a.command, b.command)),
      orphans: mine
        .map((row) => ({ row, reason: orphanReason(row.command, byName) }))
        .filter((x) => x.reason)
        .map(({ row, reason }) => {
          const { scope, ...orphan } = orphanView(row, reason); // the scope is the path's group
          return orphan;
        }),
      members: { available: participants.available, fetchedAt: participants.fetchedAt },
      limits: { peopleMax: engine().MAX_PEOPLE },
    };
  }

  return {
    overview,
    commandView,
    putGlobalRule,
    deleteGlobalRule,
    groupView,
    putGroupRule,
    deleteGroupRule,
  };
}

module.exports = {
  createPermissionsService,
  // pure helpers, exported for the tests
  parsePerson,
  mergePeople,
  diffPeople,
  computeWarnings,
  auditDetail,
};

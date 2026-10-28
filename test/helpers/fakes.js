"use strict";
// FIRST statement of the module: config.js must never read the owner's config.env (secrets) from a test.
// Anything that requires config.js after this file is loaded is covered; test files that load config
// themselves first must set it too.
process.env.OWB_NO_CONFIG_ENV = "1";

/**
 * Shared helpers for the node:test suite (specs/001-audit-fix-commands, T018).
 *
 * Typical use, at the top of a test file:
 *
 *   const fakes = require("./helpers/fakes");
 *   fakes.setupEnv();                    // env first, THEN anything that loads config.js
 *   const net = fakes.stubNetwork();     // before the plugins are required (some capture execFile/axios at load time)
 *   before(async () => { await fakes.setup(); });   // sync DB + fresh registry + loader.loadAll()
 *   ...
 *   const msg = fakes.makeMessage({ body: ".ping", group: true, admin: true });
 *   await registry.executeCommand(msg);
 *   fakes.sentTexts(msg.client.getSocket());
 *
 * Nothing here talks to the network, spawns a process or touches the real DB.
 */

const path = require("path");
const EventEmitter = require("events");
const { Writable, PassThrough } = require("stream");

const ROOT = path.resolve(__dirname, "..", "..");
const rootRequire = (p) => require(path.join(ROOT, p));

/** Well-known identities used by the fake socket and the fake messages. */
const IDS = Object.freeze({
  GROUP: "120363000000000001@g.us",
  OWNER_PN: "111@s.whatsapp.net", // SUDO (first owner)
  OWNER_LID: "777@lid",
  OWNER2_PN: "112@s.whatsapp.net", // second owner (when setupEnv({ sudo: "111,112" }))
  OWNER2_LID: "779@lid",
  MEMBER_PN: "333@s.whatsapp.net", // ordinary member, LID 888@lid
  MEMBER_LID: "888@lid",
  MEMBER2_PN: "444@s.whatsapp.net", // PN-only participant (no LID known)
  CREATOR_PN: "222@s.whatsapp.net", // group creator (superadmin)
  BOT_PN: "999@s.whatsapp.net",
  BOT_LID: "555@lid",
});

// user part (digits) -> LID user part
const LID_OF_USER = { 111: "777", 112: "779", 333: "888", 999: "555" };

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

// Keys that make plugins talk to a service: blanked so that the tests do not depend
// on the developer's config.env (dotenv never overrides a variable already defined).
const SECRET_ENV_KEYS = [
  "SESSION_ID",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "RMBG_KEY",
  "WEATHER_API_KEY",
  "UNSPLASH_API_KEY",
  "GIPHY_API_KEY",
  "NEWS_API_KEY",
  "ALPHA_VANTAGE_KEY",
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
  "REDDIT_CLIENT_ID",
  "REDDIT_CLIENT_SECRET",
  "CLOUDMERSIVE_API_KEY",
  "APYHUB_API_KEY",
  "DEEPAI_API_KEY",
  "WAIFUPICS_API_KEY",
  "PUTERJS_API_KEY",
  "HEROKU_APP_NAME",
  "HEROKU_API_KEY",
  "KOYEB_NAME",
  "KOYEB_API",
  "RENDER_NAME",
  "RENDER_API_KEY",
  "STATUS_SAVE_LIST",
  "PANEL_TOKEN",
];
const FALSE_ENV_KEYS = [
  "ALWAYS_ONLINE",
  "AUTO_READ",
  "AUTO_STATUS_VIEW",
  "AUTO_STATUS_REACT",
  "AUTO_STATUS_SAVE",
  "ANTI_DELETE",
  "AUTO_RESPONDER_ENABLED",
  "KOYEB",
  "VPS",
];

/**
 * Set the process environment BEFORE config.js is loaded, then load it.
 * Synchronous; call `await syncDb()` (or `await setup()`) afterwards for the DB.
 *
 * @param {object} [opts]
 * @param {string} [opts.sudo="111"]   SUDO value ("" = no owner)
 * @param {string} [opts.prefix="."]
 * @param {string} [opts.lang]         BOT_LANG; default: env BOT_LANG or "fr"
 * @param {object} [opts.env]          extra variables, applied last (e.g. { GIPHY_API_KEY: "x" })
 * @returns {object} the config module
 */
function setupEnv(opts = {}) {
  const env = process.env;
  env.DATABASE_URL = ":memory:";
  env.SUDO = opts.sudo !== undefined ? String(opts.sudo) : "111";
  env.PREFIX = opts.prefix || ".";
  env.BOT_LANG = opts.lang || env.BOT_LANG || "fr";
  env.LOG_LEVEL = env.LOG_LEVEL || "silent";
  env.BAILEYS_LOG_LVL = env.BAILEYS_LOG_LVL || "silent";
  for (const key of SECRET_ENV_KEYS) env[key] = "";
  for (const key of FALSE_ENV_KEYS) env[key] = "false";
  env.ENABLE_MESSAGE_REACTIONS = "true"; // so that react() calls show up in the fake socket
  // No test binds a port or starts the update checker by accident: admin tests build the admin explicitly
  env.ADMIN_PANEL = "false";
  env.UPDATE_CHECK = "false";
  Object.assign(env, opts.env || {});

  const config = rootRequire("config");
  if (config.SUDO !== env.SUDO || config.PREFIX !== env.PREFIX) {
    throw new Error(
      "config.js was loaded before setupEnv(): call fakes.setupEnv() before requiring anything from the bot",
    );
  }
  return config;
}

/** Create the tables of the in-memory database. @returns the database module */
async function syncDb() {
  const db = rootRequire("lib/database");
  await db.sync();
  return db;
}

/** Empty every table of the in-memory database (keeps the schema). */
async function clearAllTables() {
  const db = rootRequire("lib/database");
  for (const [name, model] of Object.entries(db)) {
    if (name === "DATABASE" || name === "sync" || typeof model?.destroy !== "function") continue;
    await model.destroy({ where: {}, truncate: true });
  }
  rootRequire("lib/utils/settingsCache").clear();
}

/**
 * Fresh registry: registry._reset(), then loader.loadAll() (sorted file order).
 * @returns {{ loaded: string[], failed: Array<{file,error}>, commands: object[], registry, loader }}
 */
async function loadAllPlugins() {
  const registry = rootRequire("lib/plugins/registry");
  const loader = rootRequire("lib/plugins/loader");
  registry._reset();
  loader.loadedPlugins = [];
  loader.failedPlugins = [];
  const { loaded, failed } = await loader.loadAll();
  return {
    loaded: loaded.slice(),
    failed: failed.slice(),
    commands: registry.getCommands(),
    registry,
    loader,
  };
}

/**
 * Flat dot-keys of the i18n fragments not merged into lang/*.json yet, e.g. { "plugins.kick.usage": "..." }:
 * specs/001-audit-fix-commands/i18n/*.json and the bot texts of specs/002-admin-panel/i18n/bot-*.json
 * (its panel-*.json files belong to the browser catalogs). Fragment values win, like tools/merge-i18n.js.
 * @param {"en"|"fr"} [lang="en"]
 */
function pendingI18nKeys(lang = "en") {
  const fs = require("fs");
  const sources = [
    { dir: path.join(ROOT, "specs", "001-audit-fix-commands", "i18n"), accept: () => true },
    { dir: path.join(ROOT, "specs", "002-admin-panel", "i18n"), accept: (file) => /^bot-.+\.json$/.test(file) },
  ];
  const out = {};
  const flatten = (obj, prefix = "") => {
    for (const [k, v] of Object.entries(obj || {})) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object") flatten(v, key);
      else out[key] = v;
    }
  };
  for (const { dir, accept } of sources) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json") && accept(f)).sort()) {
      try {
        flatten(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))[lang]);
      } catch (_) {
        /* an invalid fragment is reported by i18n.test.js */
      }
    }
  }
  return out;
}

/**
 * Put the i18n fragments (specs/001-audit-fix-commands/i18n/*.json) on top of the language manager's
 * translations, as if `node tools/merge-i18n.js` had been run. Must happen BEFORE the plugins are
 * required (command.desc is evaluated at require time). Idempotent.
 * @returns {number} how many keys were applied
 */
function applyPendingI18n() {
  const { languageManager } = rootRequire("lib/utils/language");
  const lang = String(languageManager.currentLang || "en").substring(0, 2);
  const flat = pendingI18nKeys(lang);
  let applied = 0;
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split(".");
    let node = languageManager.translations;
    let ok = true;
    for (const part of parts.slice(0, -1)) {
      if (node[part] === undefined) node[part] = {};
      if (typeof node[part] !== "object" || node[part] === null) {
        ok = false; // a string already sits there: tools/merge-i18n.js would refuse too
        break;
      }
      node = node[part];
    }
    if (ok && typeof value === "string") {
      node[parts[parts.length - 1]] = value;
      applied++;
    }
  }
  return applied;
}

/**
 * setupEnv must already have been called. DB sync, i18n fragments overlay, then loadAllPlugins.
 * @param {{ i18nFragments?: boolean }} [opts] i18nFragments=false: translations from lang/*.json only
 */
async function setup(opts = {}) {
  const config = rootRequire("config");
  const db = await syncDb();
  const pendingI18n = opts.i18nFragments === false ? 0 : applyPendingI18n();
  const plugins = await loadAllPlugins();
  return { config, db, pendingI18n, ...plugins };
}

// ---------------------------------------------------------------------------
// Fake socket / client
// ---------------------------------------------------------------------------

const userOf = (jid) => String(jid || "").split("@")[0].split(":")[0].split("_")[0];
const digitsOf = (value) => userOf(value).replace(/\D/g, "");

/** What kind of Baileys content was sent. */
function kindOf(content) {
  if (!content || typeof content !== "object") return "other";
  if (content.react) return "react";
  if (content.delete) return "delete";
  if (content.image) return "image";
  if (content.video) return "video";
  if (content.audio) return "audio";
  if (content.sticker) return "sticker";
  if (content.document) return "document";
  if (content.poll) return "poll";
  if (content.location) return "location";
  if (content.contacts) return "contacts";
  if (content.forward) return "forward";
  if (content.interactiveMessage || content.buttons || content.sections || content.listMessage) {
    return "interactive";
  }
  if (typeof content.text === "string") return "text";
  return "other";
}

const IGNORED_STRING_KEYS = new Set(["mimetype", "fileName", "mentions", "mentionedJid", "jid", "url"]);

/** Every user-visible string of a sent content (text, caption, buttons, titles...), deep. */
function stringsOf(content) {
  const out = [];
  const seen = new Set();
  const walk = (value, key) => {
    if (typeof value === "string") {
      if (!IGNORED_STRING_KEYS.has(key)) out.push(value);
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key);
    } else {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  walk(content, "");
  return out;
}

/** Main text of a sent content: text, else caption, else "". */
function textOf(content) {
  if (!content || typeof content !== "object") return "";
  if (typeof content.text === "string") return content.text;
  if (typeof content.caption === "string") return content.caption;
  if (content.interactiveMessage?.body?.text) return String(content.interactiveMessage.body.text);
  return "";
}

/**
 * A Baileys-like socket recording what the bot does.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.admins]        users (digits, PN or LID) who are group admins, e.g. ["333"]
 * @param {boolean} [opts.botAdmin=true]  is the bot a group admin
 * @param {boolean} [opts.lidParticipants=true]  participants carry a LID id + phoneNumber (Baileys 7);
 *                                        false = legacy PN-only participants
 * @param {object[]} [opts.participants]  replaces the default participant list
 * @param {object[]} [opts.extraParticipants]
 * @param {{id:string, lid:string}} [opts.botUser]  default { id: "999:3@s.whatsapp.net", lid: "555:3@lid" }
 * @param {string} [opts.subject]
 * @param {string} [opts.participantStatus="200"]  status returned by groupParticipantsUpdate
 * @param {boolean} [opts.strict=false]   true = unknown methods are undefined instead of recording no-ops
 *
 * Recorders: `sock.sent` (every sendMessage), `sock.participantUpdates`, `sock.calls` (other methods),
 * `sock.groupMetadataCalls`. Mutators: `sock.setAdmin(user, bool)`.
 */
function fakeSocket(opts = {}) {
  const botUser = { id: "999:3@s.whatsapp.net", lid: "555:3@lid", name: "Bot", ...(opts.botUser || {}) };
  const admins = new Set((opts.admins || []).map(digitsOf));
  const lidParticipants = opts.lidParticipants !== false;
  let botAdmin = opts.botAdmin !== false;
  let counter = 0;

  const makeParticipant = (user, { admin, pnOnly } = {}) => {
    const pn = `${user}@s.whatsapp.net`;
    const lidUser = LID_OF_USER[user];
    const role = admin ? "admin" : null;
    if (!lidParticipants || pnOnly || !lidUser) return { id: pn, admin: role };
    return { id: `${lidUser}@lid`, phoneNumber: pn, lid: `${lidUser}@lid`, admin: role };
  };

  const buildParticipants = () => {
    const botUserDigits = digitsOf(botUser.id);
    const list = [
      makeParticipant(botUserDigits, { admin: botAdmin }),
      makeParticipant("111", { admin: admins.has("111") || admins.has("777") }),
      makeParticipant("112", { admin: admins.has("112") || admins.has("779") }),
      makeParticipant("333", { admin: admins.has("333") || admins.has("888") }),
      makeParticipant("444", { admin: admins.has("444"), pnOnly: true }),
      { id: IDS.CREATOR_PN, admin: "superadmin" },
    ];
    return list.concat(opts.extraParticipants || []);
  };
  let participants = opts.participants ? opts.participants.map((p) => ({ ...p })) : buildParticipants();

  const sock = {
    user: botUser,
    sent: [],
    calls: [],
    participantUpdates: [],
    groupMetadataCalls: 0,
    ev: new EventEmitter(),
    ws: new EventEmitter(),
    logger: { level: "silent", info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return this; } },
    config: {},
    authState: { creds: { me: botUser } },
    signalRepository: {
      lidMapping: {
        async getPNForLID(lid) {
          const user = Object.entries(LID_OF_USER).find(([, l]) => l === userOf(lid))?.[0];
          return user ? `${user}@s.whatsapp.net` : null;
        },
        async getLIDForPN(pn) {
          const lid = LID_OF_USER[userOf(pn)];
          return lid ? `${lid}@lid` : null;
        },
      },
    },

    async sendMessage(jid, content, options) {
      const key = { remoteJid: jid, fromMe: true, id: `BOT${++counter}` };
      sock.sent.push({
        jid,
        content,
        options,
        key,
        kind: kindOf(content),
        text: textOf(content),
        strings: stringsOf(content),
      });
      return { key, message: content, status: 1 };
    },

    /**
     * Interactive messages (@ryuu-reinzz/button-helper) go through relayMessage, not sendMessage:
     * recorded as a send too (kind "interactive" / "relay"), with the strings of the whole message.
     */
    async relayMessage(jid, message, options) {
      const key = { remoteJid: jid, fromMe: true, id: options?.messageId || `BOT${++counter}` };
      const strings = stringsOf(message);
      const body =
        message?.interactiveMessage?.body?.text ||
        message?.viewOnceMessage?.message?.interactiveMessage?.body?.text ||
        message?.viewOnceMessageV2?.message?.interactiveMessage?.body?.text ||
        message?.buttonsMessage?.contentText ||
        message?.listMessage?.description ||
        message?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
        strings.find((x) => x.trim()) ||
        "";
      const interactive = JSON.stringify(message || {}).includes("nativeFlowMessage") || /buttonsMessage|listMessage|interactiveMessage/.test(Object.keys(message || {}).join(" ") + JSON.stringify(message || {}).slice(0, 400));
      sock.sent.push({
        jid,
        content: message,
        options,
        key,
        kind: interactive ? "interactive" : "relay",
        text: body,
        strings,
      });
      return key.id;
    },

    async groupMetadata(jid) {
      sock.groupMetadataCalls++;
      return {
        id: jid,
        subject: opts.subject || "Test group",
        desc: opts.desc || "Test description",
        owner: IDS.CREATOR_PN,
        creation: 1700000000,
        size: participants.length,
        announce: false,
        restrict: false,
        participants: participants.map((p) => ({ ...p })),
      };
    },

    async groupFetchAllParticipating() {
      const groups = opts.groups || [IDS.GROUP];
      const entries = await Promise.all(groups.map(async (jid) => [jid, await sock.groupMetadata(jid)]));
      return Object.fromEntries(entries);
    },

    async groupParticipantsUpdate(jid, jids, action) {
      sock.participantUpdates.push({ jid, jids: [...jids], action });
      const status = opts.participantStatus || "200";
      return jids.map((j) => ({ status, jid: j, content: null }));
    },

    async groupInviteCode() {
      return "FAKEINVITECODE";
    },
    async onWhatsApp(...jids) {
      return jids.flat().map((jid) => ({ jid, exists: true }));
    },
    async profilePictureUrl() {
      return null;
    },

    /** Make a participant admin (or not). `user` = digits, PN or LID of that participant. */
    setAdmin(user, isAdmin = true) {
      const wanted = digitsOf(user);
      const lidWanted = LID_OF_USER[wanted] || wanted;
      for (const p of participants) {
        const ids = [p.id, p.phoneNumber, p.lid].filter(Boolean).map(digitsOf);
        if (ids.includes(wanted) || ids.includes(lidWanted)) {
          if (p.admin !== "superadmin") p.admin = isAdmin ? "admin" : null;
        }
      }
      if (wanted === digitsOf(botUser.id)) botAdmin = !!isAdmin;
      // Message.js caches group metadata for 60 s
      try {
        rootRequire("lib/classes/Message").invalidateGroupMetadata();
      } catch (_) {
        /* Message.js not loadable yet: nothing cached */
      }
      return sock;
    },
    getParticipants() {
      return participants.map((p) => ({ ...p }));
    },

    /** Sent entries that are not reactions / deletes. */
    replies(filter) {
      return sock.sent.filter(
        (s) => s.kind !== "react" && s.kind !== "delete" && (!filter || filter(s)),
      );
    },
    reset() {
      sock.sent.length = 0;
      sock.calls.length = 0;
      sock.participantUpdates.length = 0;
    },
  };

  if (opts.strict) return sock;

  // Any other Baileys method (sendPresenceUpdate, readMessages, updateProfileStatus...)
  // is an async no-op that is recorded in `sock.calls`.
  return new Proxy(sock, {
    get(target, prop, receiver) {
      if (prop in target || typeof prop === "symbol") return Reflect.get(target, prop, receiver);
      if (["then", "catch", "toJSON", "inspect", "constructor", "asymmetricMatch", "$$typeof", "nodeType"].includes(prop)) {
        return undefined;
      }
      const recorder = async (...args) => {
        target.calls.push({ method: prop, args });
        return undefined;
      };
      target[prop] = recorder;
      return recorder;
    },
  });
}

/**
 * A WhatsAppClient look-alike (EventEmitter with getSocket()). `client.dispatch(event, ...args)`
 * emits and awaits every async listener (what attachHandlers registers).
 *
 * Lifecycle (contracts/runtime.md section 6): `getState()` returns the settable `client.fakeState`;
 * `client.setState({ status, ... })` merges a change and emits `state`; `client.setQr(qr)` bumps the
 * QR version, moves to status "qr" and emits `qr` then `state`. `restart()`, `requestPairingCode()`,
 * `resetSession()`, `logout()` and `stop()` record their calls in `client.calls` ({ method, args });
 * `client.restartImpl` / `pairingImpl` / `resetImpl` replace their behaviour, `client.restartStatus`
 * is the status `restart()` settles on (default "open", `null` = stays "connecting").
 */
function fakeClient(sock = fakeSocket()) {
  const client = new EventEmitter();
  client.sock = sock;
  client.isReady = true;
  client.store = { contacts: {} };
  client.reactedStatuses = new Set();
  client.calls = [];
  client.fakeState = {
    status: "open",
    since: Date.now(),
    generation: 1,
    registered: true,
    me: { number: "999", name: "Bot" },
    qrVersion: 0,
    hasQr: false,
    pairing: null,
    lastClose: null,
    reconnectAttempt: 0,
  };
  client.restartStatus = "open";
  client.getSocket = () => sock;
  client.ready = () => true;
  client.getState = () => ({ ...client.fakeState });
  client.setState = (changes) => {
    client.fakeState = { ...client.fakeState, ...changes, since: Date.now() };
    client.emit("state", client.getState());
  };
  client.setQr = (qr = "fake-qr-string") => {
    client.fakeQr = qr;
    const qrVersion = client.fakeState.qrVersion + 1;
    client.setState({ status: "qr", qrVersion, hasQr: true });
    client.emit("qr", qr, qrVersion);
  };
  client.getPairingArtifacts = () => ({ qr: client.fakeQr || null, qrVersion: client.fakeState.qrVersion });
  client.initialize = async () => {
    client.calls.push({ method: "initialize", args: [] });
  };
  client.stop = async () => {
    client.calls.push({ method: "stop", args: [] });
  };
  client.restart = async () => {
    client.calls.push({ method: "restart", args: [] });
    if (client.restartImpl) return client.restartImpl();
    client.setState({ status: "connecting" });
    if (client.restartStatus) client.setState({ status: client.restartStatus });
    return sock;
  };
  client.requestPairingCode = async (phone) => {
    client.calls.push({ method: "requestPairingCode", args: [phone] });
    if (client.pairingImpl) return client.pairingImpl(phone);
    return { code: "ABCD-1234", expiresAt: Date.now() + 3 * 60 * 1000 };
  };
  client.resetSession = async () => {
    client.calls.push({ method: "resetSession", args: [] });
    if (client.resetImpl) return client.resetImpl();
    return { removed: 0 };
  };
  client.logout = async () => {
    client.calls.push({ method: "logout", args: [] });
  };
  client.dispatch = async (event, ...args) => {
    await Promise.all(client.listeners(event).map((listener) => listener(...args)));
  };
  return client;
}

// ---------------------------------------------------------------------------
// Fake messages
// ---------------------------------------------------------------------------

let messageSeq = 0;

function lidFor(pn) {
  const user = userOf(pn);
  return `${LID_OF_USER[user] || `${user}9`}@lid`;
}

function contextOf({ quoted, mentions, botPn }) {
  const ctx = {};
  if (quoted) {
    const q = typeof quoted === "string" ? { text: quoted } : quoted;
    let quotedMessage = q.message;
    if (!quotedMessage && q.media) {
      const media = typeof q.media === "string" ? { type: q.media } : q.media;
      const field = `${media.type}Message`;
      quotedMessage = {
        [field]: {
          mimetype: media.mimetype || { image: "image/jpeg", video: "video/mp4", audio: "audio/ogg", document: "application/pdf", sticker: "image/webp" }[media.type],
          fileLength: media.fileLength || 1024,
          ...(media.caption ? { caption: media.caption } : {}),
        },
      };
    }
    if (!quotedMessage) quotedMessage = { conversation: q.text ?? "quoted text" };
    ctx.stanzaId = q.id || `QUOTED${++messageSeq}`;
    ctx.participant = q.sender || (q.fromMe ? botPn : IDS.MEMBER_PN);
    ctx.quotedMessage = quotedMessage;
  }
  if (mentions && mentions.length) ctx.mentionedJid = mentions;
  return Object.keys(ctx).length ? ctx : undefined;
}

/**
 * Build a raw Baileys message (what `sock.ev.on("messages.upsert")` delivers).
 *
 * @param {object} [o]
 * @param {string} [o.body]            text (or caption for `media`)
 * @param {string} [o.from=OWNER_PN]   author (PN or LID)
 * @param {boolean|string} [o.group]   true = IDS.GROUP, string = that group JID
 * @param {boolean|string} [o.lid]     true = the author is addressed by LID (`from` becomes participantAlt /
 *                                     remoteJidAlt); a string = that LID
 * @param {string|null} [o.alt]        override participantAlt / remoteJidAlt (null = none, LID-only author)
 * @param {string|object} [o.quoted]   "text" or { text, id, sender, fromMe, media: "image"|{type,...}, message };
 *                                     the quoted author defaults to a member (333), `fromMe: true` = the bot
 * @param {string[]} [o.mentions]
 * @param {{id:string, kind?:"button"|"list", label?:string, quoted?:string|object}} [o.interactive]
 *                                     native-flow reply: interactiveResponseMessage + paramsJson
 * @param {{sha256?:Buffer|string}} [o.sticker]
 * @param {string|object} [o.media]    "image"|"video"|... or { type, mimetype, fileLength }
 * @param {boolean} [o.fromMe]
 * @param {object} [o.message]         raw `message` override
 * @param {string} [o.id]
 */
function rawMessage(o = {}) {
  const from = o.from || IDS.OWNER_PN;
  const group = o.group === true ? IDS.GROUP : o.group || null;
  const fromIsLid = String(from).endsWith("@lid");
  let primary = from;
  let alt;
  if (o.lid) {
    primary = typeof o.lid === "string" ? o.lid : lidFor(from);
    alt = fromIsLid ? undefined : from;
  } else if (fromIsLid) {
    alt = undefined;
  }
  if (o.alt !== undefined) alt = o.alt || undefined;

  const id = o.id || `IN${++messageSeq}`;
  const key = { remoteJid: group || primary, fromMe: !!o.fromMe, id };
  if (group) {
    key.participant = primary;
    if (alt) key.participantAlt = alt;
  } else if (alt) {
    key.remoteJidAlt = alt;
  }

  let message = o.message;
  if (!message) {
    const botPn = IDS.BOT_PN;
    const body = o.body ?? "";
    if (o.interactive) {
      const it = o.interactive;
      const quotedCtx = contextOf({
        quoted: it.quoted || { text: "menu", id: it.quotedId || "BOT_MENU", fromMe: true, sender: botPn },
        botPn,
      });
      message = {
        interactiveResponseMessage: {
          body: { text: it.label || it.id },
          nativeFlowResponseMessage: {
            name: it.kind === "list" ? "single_select" : "quick_reply",
            paramsJson: JSON.stringify({ id: it.id }),
            version: 3,
          },
          contextInfo: quotedCtx,
        },
      };
    } else if (o.sticker) {
      const sha = o.sticker.sha256 || Buffer.from("abcdef0123", "hex");
      message = {
        stickerMessage: {
          fileSha256: Buffer.isBuffer(sha) ? sha : Buffer.from(String(sha), "hex"),
          mimetype: "image/webp",
          contextInfo: contextOf({ quoted: o.quoted, mentions: o.mentions, botPn }),
        },
      };
    } else if (o.media) {
      const media = typeof o.media === "string" ? { type: o.media } : o.media;
      message = {
        [`${media.type}Message`]: {
          mimetype: media.mimetype || (media.type === "image" ? "image/jpeg" : media.type === "video" ? "video/mp4" : "application/octet-stream"),
          fileLength: media.fileLength || 1024,
          ...(body ? { caption: body } : {}),
          contextInfo: contextOf({ quoted: o.quoted, mentions: o.mentions, botPn }),
        },
      };
    } else {
      const ctx = contextOf({ quoted: o.quoted, mentions: o.mentions, botPn });
      message = ctx
        ? { extendedTextMessage: { text: body, contextInfo: ctx } }
        : { conversation: body };
    }
  }

  return { key, message, pushName: o.pushName || "Tester", messageTimestamp: Math.floor(Date.now() / 1000) };
}

/**
 * Build a raw message and wrap it in the real `Message` class.
 * Accepts every `rawMessage` option, plus:
 *   `client` / `sock` (reuse one), `socket` (options for a new fakeSocket),
 *   `admin` (true/false: make the author a group admin in the fake socket; groups only).
 * `message.client.getSocket()` is the fake socket; `message.data` is the raw message.
 */
function makeMessage(o = {}) {
  const { Message } = rootRequire("lib/classes/Message");
  const sock = o.sock || o.client?.getSocket?.() || fakeSocket(o.socket);
  const client = o.client || fakeClient(sock);
  const raw = rawMessage(o);
  const message = new Message(client, raw);
  if (o.admin !== undefined && message.isGroup && typeof sock.setAdmin === "function") {
    sock.setAdmin(o.from || IDS.OWNER_PN, !!o.admin);
  }
  return message;
}

// ---------------------------------------------------------------------------
// Sent-message helpers
// ---------------------------------------------------------------------------

/** Main texts of what the bot sent (text or caption), reactions/deletes excluded. */
function sentTexts(sock, { jid, kinds } = {}) {
  return sock
    .replies((s) => (!jid || s.jid === jid) && (!kinds || kinds.includes(s.kind)))
    .map((s) => s.text);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `fn` until it returns a truthy value.
 * @returns the truthy value, or `null` on timeout
 */
async function waitFor(fn, { timeout = 5000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(interval);
  }
}

/**
 * Wait until the socket has sent `count` messages matching `filter` (reactions excluded by default).
 * Rejects with a description of what WAS sent when the timeout expires.
 * @returns {Promise<object[]>} the matching sends
 */
async function waitForSends(sock, { count = 1, timeout = 5000, filter } = {}) {
  const match = (s) => s.kind !== "react" && s.kind !== "delete" && (!filter || filter(s));
  const ok = await waitFor(() => sock.sent.filter(match).length >= count, { timeout });
  const matching = sock.sent.filter(match);
  if (!ok) {
    throw new Error(
      `expected ${count} sendMessage within ${timeout} ms, got ${matching.length}; sent so far: ${JSON.stringify(
        sock.sent.map((s) => ({ jid: s.jid, kind: s.kind, text: String(s.text).slice(0, 80) })),
      )}`,
    );
  }
  return matching;
}

// ---------------------------------------------------------------------------
// Network / process stubs
// ---------------------------------------------------------------------------

function refusedError(target = "127.0.0.1:443") {
  const error = new Error(`connect ECONNREFUSED ${target}`);
  error.code = "ECONNREFUSED";
  error.errno = -111;
  error.syscall = "connect";
  return error;
}

function enoentError(command) {
  const error = new Error(`spawn ${command} ENOENT`);
  error.code = "ENOENT";
  error.errno = -2;
  error.syscall = `spawn ${command}`;
  error.path = command;
  return error;
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/i;

function hostOfHttpArgs(args) {
  const [first, second] = args;
  try {
    if (typeof first === "string") return new URL(first).hostname;
    if (first instanceof URL) return first.hostname;
    if (first && typeof first === "object") return first.hostname || first.host || "";
    if (second && typeof second === "object") return second.hostname || second.host || "";
  } catch (_) {
    /* fall through */
  }
  return "";
}

function hostOfFetchInput(input) {
  try {
    if (typeof input === "string") return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    if (input && typeof input.url === "string") return new URL(input.url).hostname;
  } catch (_) {
    /* fall through */
  }
  return "";
}

class DeadRequest extends Writable {
  constructor(target) {
    // autoDestroy off: end() would otherwise destroy the stream before the error is emitted
    super({ autoDestroy: false, emitClose: false, write: (chunk, enc, cb) => cb() });
    setImmediate(() => {
      // an 'error' event nobody listens to would crash the process
      if (this.listenerCount("error") > 0) this.emit("error", refusedError(target));
    });
  }
  setTimeout() {
    return this;
  }
  setHeader() {}
  getHeader() {}
  removeHeader() {}
  flushHeaders() {}
  setNoDelay() {}
  setSocketKeepAlive() {}
  abort() {
    this.destroy();
  }
}

function fakeChild(error) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write: (c, e, cb) => cb() });
  child.pid = undefined;
  child.kill = () => true;
  child.unref = () => {};
  child.ref = () => {};
  setImmediate(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit("error", error);
    child.emit("close", -2, null);
  });
  return child;
}

let activeNetStub = null;

/**
 * Make every outside access fail fast, like a machine without network, ffmpeg or yt-dlp:
 *   - axios (default adapter) rejects with an AxiosError ECONNREFUSED;
 *   - http(s).request/get and any non-local net.Socket connection (got, undici, tls...) are refused with
 *     ECONNREFUSED (localhost stays reachable);
 *   - global.fetch rejects with "fetch failed" (cause ECONNREFUSED; localhost stays reachable);
 *   - child_process.{spawn,execFile,exec,fork,*Sync} fail with ENOENT, except commands matching
 *     `opts.allowExec` (a RegExp tested against the command/file name).
 *
 * Call it BEFORE the plugins are loaded: some modules capture `execFile`/`spawn`/axios instances
 * when they are required. Idempotent. Restore with `restore()` (returned) or `restoreNetwork()`.
 *
 * @returns {{ calls: Array<{kind:string, target:string}>, restore: Function }}
 *   `calls` lists every blocked attempt (kinds: axios, http, socket, fetch, exec).
 */
function stubNetwork(opts = {}) {
  if (activeNetStub) return activeNetStub;

  const calls = [];
  const saved = {};

  // axios
  // resolved like a plugin does (package "exports"), not by directory: that would load another copy
  const axios = require(require.resolve("axios", { paths: [ROOT] }));
  saved.axiosAdapter = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    const target = `${config.baseURL || ""}${config.url || ""}`;
    calls.push({ kind: "axios", target });
    const error = refusedError();
    throw new axios.AxiosError(error.message, "ECONNREFUSED", config, null, undefined);
  };

  // http / https
  const http = require("http");
  const https = require("https");
  saved.http = { request: http.request, get: http.get };
  saved.https = { request: https.request, get: https.get };
  const wrapHttp = (mod, name, original) => {
    mod[name] = function stubbedHttp(...args) {
      const host = hostOfHttpArgs(args);
      if (LOCAL_HOST.test(host)) return original.apply(this, args);
      calls.push({ kind: "http", target: host });
      return new DeadRequest(`${host}:443`);
    };
  };
  for (const name of ["request", "get"]) {
    wrapHttp(http, name, saved.http[name]);
    wrapHttp(https, name, saved.https[name]);
  }

  // raw sockets (got, undici, http2, tls...): every non-local connection is refused
  const netModule = require("net");
  saved.socketConnect = netModule.Socket.prototype.connect;
  netModule.Socket.prototype.connect = function stubbedConnect(...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    let host = "";
    let local = false;
    if (first && typeof first === "object") {
      host = first.host || first.hostname || "localhost";
      local = !!first.path || first.port === undefined; // unix socket / handle
      if (first.port === undefined && !first.path) local = false;
    } else if (typeof first === "string" && !/^\d+$/.test(first)) {
      host = "";
      local = true; // a unix socket path
    } else {
      host = typeof args[1] === "string" ? args[1] : "localhost";
    }
    if (local || LOCAL_HOST.test(host)) return saved.socketConnect.apply(this, args);
    calls.push({ kind: "socket", target: host });
    setImmediate(() => {
      if (this.listenerCount("error") > 0) this.destroy(refusedError(host));
      else this.destroy();
    });
    return this;
  };

  // fetch
  saved.fetch = global.fetch;
  global.fetch = async function stubbedFetch(input, init) {
    const host = hostOfFetchInput(input);
    if (LOCAL_HOST.test(host) && typeof saved.fetch === "function") return saved.fetch(input, init);
    calls.push({ kind: "fetch", target: host || String(input) });
    const error = new TypeError("fetch failed");
    error.cause = refusedError();
    throw error;
  };

  // child_process
  const cp = require("child_process");
  const allow = opts.allowExec instanceof RegExp ? opts.allowExec : null;
  saved.cp = {};
  const names = ["spawn", "execFile", "exec", "fork", "spawnSync", "execFileSync", "execSync"];
  for (const name of names) {
    saved.cp[name] = cp[name];
    cp[name] = function stubbedChildProcess(command, ...rest) {
      const file = typeof command === "string" ? command.split(/\s+/)[0] : String(command);
      if (allow && allow.test(path.basename(file))) return saved.cp[name].call(this, command, ...rest);
      calls.push({ kind: "exec", target: `${name} ${file}` });
      const error = enoentError(file);
      if (name.endsWith("Sync")) throw error;
      if (name === "fork") throw error;
      if (name === "exec" || name === "execFile") {
        const callback = rest.find((arg) => typeof arg === "function");
        if (callback) {
          const child = fakeChild(error);
          child.removeAllListeners("error"); // the callback reports it, like the real execFile
          child.on("error", () => {});
          setImmediate(() => callback(error, "", ""));
          return child;
        }
      }
      const child = fakeChild(error);
      child.on("error", () => {}); // never an unhandled 'error' event
      return child;
    };
  }

  const restore = () => {
    if (activeNetStub?.restore !== restore) return;
    axios.defaults.adapter = saved.axiosAdapter;
    netModule.Socket.prototype.connect = saved.socketConnect;
    Object.assign(http, saved.http);
    Object.assign(https, saved.https);
    global.fetch = saved.fetch;
    Object.assign(cp, saved.cp);
    activeNetStub = null;
  };
  activeNetStub = { calls, restore };
  return activeNetStub;
}

/**
 * Fail with a readable list: `assertNone(problems, "header")`. Nothing when `problems` is empty.
 * (assert.deepEqual(problems, []) prints a noisy diff; this prints one line per problem.)
 */
function assertNone(problems, header = "") {
  if (!problems || problems.length === 0) return;
  const lines = problems.slice(0, 80).map((p) => `  - ${p}`);
  if (problems.length > 80) lines.push(`  ... and ${problems.length - 80} more`);
  require("node:assert/strict").fail(`${header ? `${header}\n` : ""}${problems.length} problem(s):\n${lines.join("\n")}`);
}

/** Undo `stubNetwork()` (no-op when it is not active). */
function restoreNetwork() {
  if (activeNetStub) activeNetStub.restore();
}

/**
 * Replace process.exit with a recorder (some commands restart the bot).
 * @returns {{ calls: Array<{code, stack}>, restore: Function }} `stack` = the caller (which plugin exited)
 */
function stubProcessExit() {
  const original = process.exit;
  const calls = [];
  process.exit = (code) => {
    calls.push({ code, stack: new Error().stack.split("\n").slice(2, 5).map((l) => l.trim()).join(" | ") });
  };
  return {
    calls,
    restore() {
      process.exit = original;
    },
  };
}

/**
 * Remember the content of files a command may rewrite (e.g. data/status_save.json) and put it back.
 * @param {string[]} files absolute paths or paths relative to the repository root
 * @returns {Function} restore
 */
function snapshotFiles(files) {
  const fs = require("fs");
  const snapshots = files.map((file) => {
    const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
    return { abs, content: fs.existsSync(abs) ? fs.readFileSync(abs) : null };
  });
  return () => {
    for (const { abs, content } of snapshots) {
      try {
        if (content === null) fs.rmSync(abs, { force: true });
        else if (!fs.existsSync(abs) || !fs.readFileSync(abs).equals(content)) fs.writeFileSync(abs, content);
      } catch (_) {
        /* best effort */
      }
    }
  };
}

module.exports = {
  ROOT,
  IDS,
  setupEnv,
  syncDb,
  clearAllTables,
  loadAllPlugins,
  pendingI18nKeys,
  applyPendingI18n,
  setup,
  fakeSocket,
  fakeClient,
  rawMessage,
  makeMessage,
  kindOf,
  textOf,
  stringsOf,
  sentTexts,
  sleep,
  waitFor,
  waitForSends,
  assertNone,
  stubNetwork,
  restoreNetwork,
  stubProcessExit,
  snapshotFiles,
};

// Hash router: the server needs no history fallback (`/admin/#/groups`). Views are loaded lazily with
// `import("./views/<area>.mjs")`; the loaders are written out one by one (no computed import path) so
// that a static check can verify every view file exists.
//
// `AREAS` is the single list of the panel's areas, used by Nav and by the router. Each view file exports a
// matching `meta = { area, titleKey, icon }` (checked by test/admin-frontend.test.js).

import { confirmLeave } from "./ui.mjs";

export const AREAS = [
  { area: "dashboard", titleKey: "dashboard.title", icon: "dashboard" },
  { area: "settings", titleKey: "settings.title", icon: "settings" },
  { area: "commands", titleKey: "commands.title", icon: "commands" },
  { area: "groups", titleKey: "groups.title", icon: "groups" },
  { area: "pairing", titleKey: "pairing.title", icon: "pairing" },
  { area: "data", titleKey: "data.title", icon: "data" },
  { area: "broadcasts", titleKey: "broadcasts.title", icon: "broadcasts" },
  { area: "backup", titleKey: "backup.title", icon: "backup" },
  { area: "maintenance", titleKey: "maintenance.title", icon: "maintenance" },
  { area: "texts", titleKey: "texts.title", icon: "texts" },
  { area: "alerts", titleKey: "alerts.title", icon: "alerts" },
  { area: "logs", titleKey: "logs.title", icon: "logs" },
  { area: "stats", titleKey: "stats.title", icon: "stats" },
  { area: "audit", titleKey: "audit.title", icon: "audit" },
];

/** Lazy loaders, one literal `import()` per view. */
export const VIEW_LOADERS = {
  dashboard: () => import("./views/dashboard.mjs"),
  settings: () => import("./views/settings.mjs"),
  commands: () => import("./views/commands.mjs"),
  groups: () => import("./views/groups.mjs"),
  pairing: () => import("./views/pairing.mjs"),
  data: () => import("./views/data.mjs"),
  broadcasts: () => import("./views/broadcasts.mjs"),
  backup: () => import("./views/backup.mjs"),
  maintenance: () => import("./views/maintenance.mjs"),
  texts: () => import("./views/texts.mjs"),
  alerts: () => import("./views/alerts.mjs"),
  logs: () => import("./views/logs.mjs"),
  stats: () => import("./views/stats.mjs"),
  audit: () => import("./views/audit.mjs"),
  // not part of the navigation list
  login: () => import("./views/login.mjs"),
  setup: () => import("./views/setup.mjs"),
  account: () => import("./views/account.mjs"),
};

export const DEFAULT_ROUTE = "dashboard";
const AREA_NAMES = new Set(AREAS.map((a) => a.area));

/**
 * `#/settings/PREFIX?tab=a` -> `{ name: "settings", rest: ["PREFIX"], query: { tab: "a" }, path: "/settings/PREFIX" }`.
 * Names: an area, `login`, `account`, `setup`, `setup_invalid` (`#/setup/invalid`), or `not_found`.
 */
export function parseHash(hash) {
  let text = String(hash || "").replace(/^#/, "");
  if (!text.startsWith("/")) text = `/${text}`;
  const [pathPart, queryPart = ""] = text.split("?");
  const segments = pathPart.split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const query = Object.fromEntries(new URLSearchParams(queryPart));
  const [head = DEFAULT_ROUTE, ...rest] = segments;
  let name = head;
  if (head === "setup" && rest[0] === "invalid") name = "setup_invalid";
  else if (!AREA_NAMES.has(head) && !["login", "account", "setup"].includes(head)) name = "not_found";
  return { name, rest: name === "setup_invalid" ? [] : rest, query, path: pathPart || "/" };
}

/** `buildHash("settings", ["PREFIX"], { tab: "x" })` -> `#/settings/PREFIX?tab=x`. */
export function buildHash(name, rest = [], query = {}) {
  const base = ["", name, ...rest].map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join("/");
  const search = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  const text = search.toString();
  return `#${base}${text ? `?${text}` : ""}`;
}

/** Which screen the app shows for a session and a route (pure, unit-tested). */
export function resolveScreen(session, route) {
  if (!session || !session.loaded) return "loading";
  if (session.loadError) return "error";
  if (session.authenticated) return "app";
  if (route.name === "setup_invalid") return "setup_invalid";
  if (session.setup) return route.name === "login" ? "login" : "setup";
  if (!session.accountExists) return "no_account";
  return "login";
}

/** The view component for a route name (loads the module on first use). */
export async function loadView(name) {
  const loader = VIEW_LOADERS[name];
  if (!loader) return null;
  const mod = await loader();
  return mod.default;
}

const listeners = new Set();
let current = parseHash("");
let started = null;

export function currentRoute() {
  return current;
}

export function onRoute(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Go to `#/<name>/...` (a view calls `navigate("settings", ["PREFIX"])`). */
export function navigate(name, rest = [], query = {}, win = globalThis) {
  if (win && win.location) win.location.hash = buildHash(name, rest, query);
}

/**
 * Start listening to `hashchange`. Leaving a page with unsaved input asks first; refusing restores
 * the previous hash. Idempotent; returns the stop function.
 */
export function startRouter(win = globalThis) {
  if (started) return started;
  let previousHash = win.location.hash;
  let restoring = false;
  const apply = () => {
    current = parseHash(win.location.hash);
    for (const fn of [...listeners]) fn(current);
  };
  const onChange = async () => {
    if (restoring) {
      restoring = false;
      return;
    }
    const nextHash = win.location.hash;
    if (nextHash === previousHash) return;
    if (!(await confirmLeave())) {
      restoring = true;
      win.location.hash = previousHash;
      return;
    }
    previousHash = nextHash;
    apply();
  };
  win.addEventListener("hashchange", onChange);
  apply();
  started = () => {
    win.removeEventListener("hashchange", onChange);
    started = null;
  };
  return started;
}

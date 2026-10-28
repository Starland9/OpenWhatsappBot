"use strict";

/**
 * Environment detection (contracts/runtime.md section 11): where the process runs, who restarts
 * it, and which address the admin panel should bind to.
 *
 * Pure: it reads only `fs` and `process.env`, and both are injectable (`{ fs, env }` on every
 * function) so a test needs neither a container nor a real environment. Defaults are resolved at
 * call time, never at require time. No timer, no cache: the answers cannot go stale.
 *
 * Restarting and the bot state live in lib/core/botRuntime.js, not here.
 */

const nodeFs = require("fs");

const MIN_PORT = 1;
const MAX_PORT = 65535;
const DEFAULT_PORT = 3000;
const CGROUP_RE = /docker|kubepods|containerd/i;

/** A non-empty environment value, trimmed; "" when unset or blank */
function value(env, name) {
  const raw = env[name];
  return raw === undefined || raw === null ? "" : String(raw).trim();
}

/** `{ fs, env }` with the defaults filled in at call time */
function context(options) {
  const opts = options || {};
  return { fs: opts.fs || nodeFs, env: opts.env || process.env };
}

/**
 * Running inside a container: `/.dockerenv`, a docker/kubepods/containerd entry in
 * `/proc/1/cgroup`, or the `container` variable that podman and systemd-nspawn set.
 * @param {{ fs?: object, env?: object }} [options]
 * @returns {boolean}
 */
function isContainer(options) {
  const { fs, env } = context(options);
  if (value(env, "container")) return true;
  try {
    if (fs.existsSync("/.dockerenv")) return true;
  } catch (error) {
    // unreadable root: fall through to the cgroup test
  }
  try {
    return CGROUP_RE.test(String(fs.readFileSync("/proc/1/cgroup", "utf8")));
  } catch (error) {
    return false; // no /proc (macOS, Windows) or not readable
  }
}

/**
 * A hosting panel allocated the port: `PORT` is set.
 * @param {{ env?: object }} [options]
 * @returns {boolean}
 */
function hasHostPort(options) {
  return value(context(options).env, "PORT") !== "";
}

/**
 * A Pterodactyl-style game/bot host: `P_SERVER_UUID` or `SERVER_MEMORY` is set.
 * @param {{ env?: object }} [options]
 * @returns {boolean}
 */
function isPanelHost(options) {
  const { env } = context(options);
  return value(env, "P_SERVER_UUID") !== "" || value(env, "SERVER_MEMORY") !== "";
}

/**
 * Who restarts the process when it exits, first match wins:
 * SUPERVISED=true|false (explicit) -> PM2 (`pm_id`) -> panel host -> container -> systemd
 * (`INVOCATION_ID`) -> none. A container and a systemd unit are not counted as supervised: it
 * depends on their restart policy, so only SUPERVISED=true (the first rule) says so.
 * @param {{ fs?: object, env?: object }} [options]
 * @returns {{ kind: "env"|"pm2"|"panel-host"|"container"|"systemd"|"none", supervised: boolean }}
 */
function detectSupervisor(options) {
  const { fs, env } = context(options);

  const explicit = value(env, "SUPERVISED").toLowerCase();
  if (explicit === "true") return { kind: "env", supervised: true };
  if (explicit === "false") return { kind: "env", supervised: false };

  if (value(env, "pm_id") !== "") return { kind: "pm2", supervised: true };
  if (isPanelHost({ env })) return { kind: "panel-host", supervised: true };
  if (isContainer({ fs, env })) return { kind: "container", supervised: false };
  if (value(env, "INVOCATION_ID") !== "") return { kind: "systemd", supervised: false };
  return { kind: "none", supervised: false };
}

/** First of the candidates that parses as a usable TCP port (a bad value falls through, like config.js) */
function pickPort(env) {
  for (const name of ["PANEL_PORT", "PORT"]) {
    const raw = value(env, name);
    const port = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
    if (port >= MIN_PORT && port <= MAX_PORT) return { port, portSource: name };
  }
  return { port: DEFAULT_PORT, portSource: "default" };
}

/**
 * Address and port of the admin panel (research U1).
 *
 * Host: `PANEL_HOST` (or `HOST`) always wins (`hostSource: "explicit"`); otherwise `0.0.0.0` in a
 * container (`auto-container`) or when the host allocated a `PORT` (`auto-panel-host`), else
 * `127.0.0.1` (`auto-local`). Port: `PANEL_PORT || PORT || 3000`. There is no automatic drift to
 * another port: a busy port disables the panel with a message naming the settings.
 *
 * @param {{ env?: object, fs?: object }} [options]
 * @returns {{ host: string, port: number, hostSource: string, portSource: string }}
 */
function resolveBind(options) {
  const { fs, env } = context(options);

  const explicit = value(env, "PANEL_HOST") || value(env, "HOST");
  let host;
  let hostSource;
  if (explicit) {
    host = explicit;
    hostSource = "explicit";
  } else if (isContainer({ fs, env })) {
    host = "0.0.0.0";
    hostSource = "auto-container";
  } else if (hasHostPort({ env })) {
    host = "0.0.0.0";
    hostSource = "auto-panel-host";
  } else {
    host = "127.0.0.1";
    hostSource = "auto-local";
  }

  const { port, portSource } = pickPort(env);
  return { host, port, hostSource, portSource };
}

module.exports = {
  isContainer,
  hasHostPort,
  isPanelHost,
  detectSupervisor,
  resolveBind,
};

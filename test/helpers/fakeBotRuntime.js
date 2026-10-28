"use strict";
/**
 * A stand-in for the BotRuntime of lib/core/botRuntime.js (contracts/runtime.md section 6) for the dashboard tests:
 * `getStatus()` returns a mutable status object, `set(patch)` changes it and emits the `state` event the real
 * runtime emits on every client change, `restartBot()` walks the statuses of a real restart.
 *
 *   const rt = createFakeRuntime({ status: "open" });
 *   rt.set({ status: "qr", qrVersion: 2 });         emits "state" with the new status
 *   rt.restarts                                     the options of every restartBot() call
 *   rt.restartImpl = async (rt, options) => ({ ok: false, code: "timeout", status: "disconnected" });
 *   const hold = rt.holdRestart(); ... hold.release();     a restart that stays running until released
 *
 * It also carries sentinel values (`qr`, `pairingCode`) a leaky implementation could copy into the state
 * payload: the tests look for them.
 */

const { EventEmitter } = require("events");

const QR_SENTINEL = "2@QRSENTINEL0123456789abcdefghijklmnopqrstuvwxyz";
const CODE_SENTINEL = "ZXCV-BNMA";

function createFakeRuntime(patch = {}) {
  const events = new EventEmitter();
  const runtime = {
    dbReady: true,
    events,
    state: { lastActivity: "2026-01-01T11:59:30.000Z", status: "running" },
    restarts: [],
    restartImpl: null,
    status: {
      status: "open",
      since: Date.UTC(2026, 0, 1, 11, 0, 0),
      generation: 1,
      registered: true,
      me: { number: "237600000001", name: "Bot" },
      qrVersion: 0,
      hasQr: false,
      pairing: null,
      lastClose: null,
      reconnectAttempt: 0,
      restarting: false,
      pendingRestart: [],
      codeChanged: false,
      uptimeMs: 3725000,
      version: "9.9.9-test",
      messagesProcessed: 42,
      memory: { rss: 1 },
      // never part of a payload: a leak would show them
      qr: QR_SENTINEL,
      pairingCode: CODE_SENTINEL,
      ...patch,
    },
    getStatus() {
      return { ...runtime.status };
    },
    /** Change the status and emit `state` like the real runtime. */
    set(change) {
      Object.assign(runtime.status, change);
      events.emit("state", { ...runtime.status });
    },
    async restartBot(options) {
      runtime.restarts.push(options);
      if (runtime.restartImpl) return runtime.restartImpl(runtime, options);
      runtime.set({ restarting: true });
      runtime.set({ status: "stopped" });
      runtime.set({ status: "connecting" });
      runtime.set({ status: "open", restarting: false });
      return { ok: true, status: "running" };
    },
    /** The next restart stays running until `release()`; resolves `{ ok: true }` then. */
    holdRestart() {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      runtime.restartImpl = async (rt) => {
        rt.set({ restarting: true });
        await gate;
        rt.set({ restarting: false });
        return { ok: true, status: "running" };
      };
      return { release: () => release() };
    },
  };
  return runtime;
}

module.exports = { createFakeRuntime, QR_SENTINEL, CODE_SENTINEL };

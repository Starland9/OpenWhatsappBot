"use strict";
/**
 * A fake Baileys for lib/baileys/client.js (contracts/runtime.md section 16, `fakeBaileys.js`). The approach of
 * test/panel.test.js, which stays unedited: `require("baileys")` is intercepted while a test runs, every
 * makeWASocket() call returns a new fakes.fakeSocket() whose end()/logout() behave like Baileys (they emit
 * connection.update "close"), and `delay()` (the reconnect wait) is recorded and can be gated.
 *
 *   const env = loadClientWithFakeBaileys({ registered: false });
 *   const client = new env.WhatsAppClient("main", { sessionsRoot });   // sessionsRoot: a temporary directory
 *   await client.initialize();
 *   env.open(env.sockets.at(-1));                       // connection.update { connection: "open" }
 *   env.closeWith(sock, 515);                            // close with a Boom carrying that status code
 *   env.restore();                                       // always, in t.after()
 *
 * Fake sockets also offer `requestPairingCode(phone)` (returns `env.pairing.code`, or throws `env.pairing.error`),
 * `waitForSocketOpen()` (awaits `env.pairing.waitForOpen` when set) and `authState.creds` (the object of the
 * auth state handed to makeWASocket, `registered` from `options.registered`). `env.flags.failCreate = n` makes the
 * next n makeWASocket() calls throw.
 */

const Module = require("module");
const { Boom } = require("@hapi/boom");
const fakes = require("./fakes");

/**
 * @param {object} [options]
 * @param {boolean} [options.registered=false]  creds.registered of every auth state
 * @param {string} [options.pairingCode="ABCD1234"]
 * @param {(dir: string, entry: object) => Promise<void>|void} [options.onSave] runs inside saveCreds()
 */
function loadClientWithFakeBaileys(options = {}) {
  const sockets = [];
  const delays = [];
  const gate = { promise: null };
  const authStates = []; // { dir, state, saves }
  const pairing = { code: options.pairingCode || "ABCD1234", error: null, waitForOpen: null };
  const flags = { registered: options.registered === true, failCreate: 0 };

  const makeSocket = (sockOpts) => {
    const sock = fakes.fakeSocket();
    const state = sockOpts && sockOpts.auth;
    if (state) sock.authState = state;
    sock.end = async (error) => {
      sock.calls.push({ method: "end", args: [error] });
      sock.ev.emit("connection.update", { connection: "close", lastDisconnect: { error, date: new Date() } });
    };
    sock.logout = async () => {
      sock.calls.push({ method: "logout", args: [] });
      if (sock.logoutError) throw sock.logoutError;
      sock.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: undefined } });
    };
    sock.waitForSocketOpen = async () => {
      sock.calls.push({ method: "waitForSocketOpen", args: [] });
      if (pairing.waitForOpen) await pairing.waitForOpen;
    };
    sock.requestPairingCode = async (phone) => {
      sock.calls.push({ method: "requestPairingCode", args: [phone] });
      if (pairing.error) throw pairing.error;
      return pairing.code;
    };
    sockets.push(sock);
    return sock;
  };

  const fakeBaileys = {
    makeWASocket: (sockOpts) => {
      if (flags.failCreate > 0) {
        flags.failCreate -= 1;
        throw new Error("socket creation failed");
      }
      return makeSocket(sockOpts);
    },
    useMultiFileAuthState: async (dir) => {
      const state = { creds: { registered: flags.registered }, keys: {} };
      const entry = { dir, state, saves: 0 };
      authStates.push(entry);
      return {
        state,
        saveCreds: async () => {
          entry.saves += 1;
          if (options.onSave) await options.onSave(dir, entry);
        },
      };
    },
    DisconnectReason: { loggedOut: 401, restartRequired: 515 },
    delay: async (ms) => {
      delays.push(ms);
      if (gate.promise) await gate.promise;
    },
  };

  // client.js requires "baileys" inside initialize(): keep the fake in place until restore()
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    return request === "baileys" ? fakeBaileys : realLoad.call(this, request, ...rest);
  };
  const { WhatsAppClient, ClientError } = require("../../lib/baileys/client");

  return {
    WhatsAppClient,
    ClientError,
    sockets,
    delays,
    gate,
    authStates,
    pairing,
    flags,
    /** the last socket created */
    last: () => sockets.at(-1),
    /** connection.update { connection: "open" } */
    open(sock = sockets.at(-1)) {
      sock.ev.emit("connection.update", { connection: "open" });
    },
    /** connection.update { qr } */
    qr(sock = sockets.at(-1), qr = "fake-qr-payload") {
      sock.ev.emit("connection.update", { qr });
    },
    /** connection.update close carrying a Boom with that status code (undefined = no error) */
    closeWith(sock = sockets.at(-1), statusCode) {
      const error = statusCode === undefined ? new Error("network down") : new Boom("closed", { statusCode });
      sock.ev.emit("connection.update", { connection: "close", lastDisconnect: { error, date: new Date() } });
    },
    restore() {
      Module._load = realLoad;
    },
  };
}

module.exports = { loadClientWithFakeBaileys };

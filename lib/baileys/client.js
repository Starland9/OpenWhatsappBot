// We load Baileys dynamically inside initialize() to support ESM (v7+) and
// preserve CommonJS compatibility for older versions.
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");
const { getLang } = require("../utils/language");
const { createLogger } = require("../utils/logger");
const qrcode = require("qrcode-terminal");
// Group metadata cache of lib/classes/Message.js (required lazily: Message.js loads Baileys)
const invalidateGroupMetadata = (jid) =>
  require("../classes/Message").invalidateGroupMetadata(jid);
// Settings read when the socket is created (effect "restart"): required lazily, like Message.js
const getConfig = () => require("../../config");
// Will be populated at runtime when Baileys is loaded dynamically
let DisconnectReason;
// Used until Baileys is loaded, and for a Baileys build that lacks the name
const DEFAULT_REASONS = { loggedOut: 401, restartRequired: 515 };

const logger = createLogger("client");

const RECONNECT_BASE_MS = 3000; // first reconnection delay, doubled at each failed attempt
const RECONNECT_MAX_MS = 60 * 1000;
const PAIRING_WINDOW_MS = 3 * 60 * 1000; // validity of a pairing code
const PAIRING_COOLDOWN_MS = 30 * 1000; // one code request per 30 s
const QR_SECRET_TTL_MS = 5 * 60 * 1000; // how long a QR string stays registered with the log redactor
const LOGOUT_TIMEOUT_MS = 5 * 1000; // resetSession(): best-effort logout of a socket that may be dead
const SESSION_ID_RE = /^[\w-]+$/;

/**
 * Typed error of the lifecycle methods (contracts/runtime.md section 6). `code` is a stable snake_case
 * string: invalid_phone, not_connecting, already_registered, rate_limited (`params.retryAfterMs`),
 * pairing_failed, invalid_session_path.
 */
class ClientError extends Error {
  constructor(code, params) {
    super(code);
    this.name = "ClientError";
    this.code = code;
    if (params) this.params = params;
  }
}

/** HTTP-like status code of a Baileys disconnect error (a Boom, or anything shaped like one) */
function statusCodeOf(error) {
  if (!error) return undefined;
  if (error instanceof Boom) return error.output.statusCode;
  return error.output?.statusCode ?? error.statusCode ?? error.data?.statusCode;
}

/** Digits of the phone number behind `sock.user` (never a LID), or "" */
function numberOf(user) {
  for (const candidate of [user?.phoneNumber, user?.id]) {
    const [local, domain] = String(candidate || "").split("@");
    if (domain && domain !== "s.whatsapp.net") continue;
    const digits = local.split(":")[0].replace(/\D/g, "");
    if (digits) return digits;
  }
  return "";
}

/** Resolve after `ms`, or after `ms` of a promise that never settles: the caller never hangs on a dead socket */
function settleWithin(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const defaultDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * WhatsApp Client with auto-reconnection.
 *
 * Lifecycle (contracts/runtime.md section 6): `getState()` reports one of idle | connecting | qr | open |
 * reconnecting | stopped | logged_out. A generation counter, incremented by initialize(), stop(), logout() and
 * resetSession(), lets the listeners of an old socket recognise themselves and return: a late event can
 * never flip `isReady` of the socket that replaced it.
 *
 * Events: ready, close(error), messages, messages.update, groups.update, group-participants.update, and
 * `qr(qrString, version)` / `state(copy)`. A listener of `qr` must never log its payload (it links the
 * account to whoever scans it).
 */
class WhatsAppClient extends EventEmitter {
  /**
   * @param {string} [sessionId="main"]
   * @param {{ sessionsRoot?: string }} [options] sessionsRoot: tests only (default `<repo>/sessions`)
   */
  constructor(sessionId = "main", options = {}) {
    super();
    this.sessionId = String(sessionId);
    this.sessionsRoot = path.resolve(options.sessionsRoot || path.join(__dirname, "../../sessions"));
    this.sessionPath = path.join(this.sessionsRoot, this.sessionId);
    this.sock = null;
    this.store = null;
    this.isReady = false;
    // Set by stop()/logout(): the connection was closed on purpose, never reconnect
    this.stopped = false;
    // Track reacted status messages to prevent duplicate reactions
    this.reactedStatuses = new Set();

    // Status machine
    this.status = "idle";
    this.statusSince = Date.now();
    this.generation = 0;
    this.closingGeneration = null; // generation closed on purpose by stop()/logout()/resetSession()
    this.closingMode = null; // "stopped" | "logged_out" | "reset"
    this.registered = false;
    this.me = null;
    this.qrVersion = 0;
    this.qrIssuedAt = null;
    this._qr = null;
    this.pairing = null; // { requestedAt, expiresAt }
    this.lastClose = null; // { at, code, loggedOut }
    this.reconnectAttempt = 0;

    this._authState = null;
    this._sockClosed = false; // the socket in this.sock already reported its close
    this._initPromise = null;
    this._initGeneration = null;
    this._restartPromise = null;
    this._resetPromise = null;
    this._credWrites = new Set(); // in-flight saveCreds() writes, awaited by resetSession()
    this._pairingTimer = null;
    this._lastPairingRequest = 0;
    this._delay = null; // Baileys' delay() once loaded
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  _isRegistered() {
    return !!(this.registered || this._authState?.creds?.registered);
  }

  /**
   * Copy of the lifecycle state. The QR string itself is not part of it (see getPairingArtifacts()).
   */
  getState() {
    return {
      status: this.status,
      since: this.statusSince,
      generation: this.generation,
      registered: this._isRegistered(),
      me: this.me ? { ...this.me } : null,
      qrVersion: this.qrVersion,
      hasQr: !!this._qr,
      qrIssuedAt: this._qr ? this.qrIssuedAt : null,
      pairing: this.pairing ? { ...this.pairing } : null,
      lastClose: this.lastClose ? { ...this.lastClose } : null,
      reconnectAttempt: this.reconnectAttempt,
    };
  }

  /**
   * The current QR string and its version, for authenticated admin routes only.
   * @returns {{ qr: string|null, qrVersion: number }}
   */
  getPairingArtifacts() {
    return { qr: this._qr, qrVersion: this.qrVersion };
  }

  _emitState() {
    try {
      this.emit("state", this.getState());
    } catch (error) {
      logger.error({ name: error?.name }, "A state listener failed");
    }
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.statusSince = Date.now();
    this._emitState();
  }

  // ---------------------------------------------------------------------------
  // initialize()
  // ---------------------------------------------------------------------------

  /**
   * Initialize the WhatsApp connection. Single-flight: concurrent calls share the pending promise.
   * @returns {Promise<object|null>} the socket, or null when stop() came first
   */
  initialize() {
    if (this._initPromise && this._initGeneration === this.generation) return this._initPromise;
    const gen = ++this.generation;
    this._initGeneration = gen;
    this.stopped = false;
    this.closingGeneration = null;
    this._qr = null;

    // A socket that is still around (initialize() without stop()) is closed quietly: its events are stale now
    const previous = this.sock;
    this.sock = null;
    this.isReady = false;
    if (previous && !this._sockClosed) {
      try {
        Promise.resolve(previous.end?.(undefined)).catch(() => {});
      } catch (error) {
        // already closed
      }
    }
    this._setStatus("connecting");

    const promise = this._connect(gen).finally(() => {
      if (this._initPromise === promise) this._initPromise = null;
    });
    this._initPromise = promise;
    return promise;
  }

  async _connect(gen) {
    try {
      // Dynamic-load Baileys to support ESM v7 and fallback to CJS
      let baileysModule;
      try {
        // Prefer require for CommonJS projects
        baileysModule = require("baileys");
      } catch (err) {
        // Fallback to dynamic import for ESM builds
        const mod = await import("baileys");
        baileysModule = mod.default ? mod.default : mod;
      }

      const tryGet = (name) =>
        baileysModule[name] ??
        (baileysModule.default && baileysModule.default[name]);

      const makeWASocket =
        tryGet("makeWASocket") || baileysModule.default || baileysModule;
      const useMultiFileAuthState =
        tryGet("useMultiFileAuthState") || tryGet("useSingleFileAuthState");
      DisconnectReason =
        tryGet("DisconnectReason") || tryGet("DisconnectReason");
      const fetchLatestBaileysVersion = tryGet("fetchLatestBaileysVersion");
      const makeInMemoryStore = tryGet("makeInMemoryStore");
      const delayFn =
        tryGet("delay") || defaultDelay;
      this._delay = delayFn;

      // Setup auth state (normalize result)
      let state = undefined;
      let saveCreds = async () => {};
      if (useMultiFileAuthState) {
        try {
          const auth = await useMultiFileAuthState(this.sessionPath);
          state = auth.state ?? auth;
          saveCreds = auth.saveCreds ?? auth.saveCreds ?? saveCreds;
        } catch (err) {
          console.warn("useMultiFileAuthState failed:", err);
        }
      } else {
        console.warn(
          "Baileys auth hook not found; continuing without normalized auth hook",
        );
      }
      if (gen === this.generation) {
        this._authState = state || null;
        // the account stays registered across restart() and reconnects whatever the state of this load says
        this.registered = this.registered || !!state?.creds?.registered;
      }

      // Get latest Baileys version when available
      let version = undefined;
      if (fetchLatestBaileysVersion) {
        try {
          const v = await fetchLatestBaileysVersion();
          version = v?.version;
        } catch (e) {
          // ignore
        }
      }

      // Create in-memory store for chats/contacts if available
      const store = makeInMemoryStore
        ? makeInMemoryStore({ logger: pino({ level: "silent" }) })
        : { bind() {} };

      // Compose socket options (ALWAYS_ONLINE and BAILEYS_LOG_LVL are read here: effect "restart")
      const config = getConfig();
      const sockOpts = {
        logger: pino({ level: config.BAILEYS_LOG_LVL || "silent" }),
        browser: ["Open Whatsapp Bot", "Chrome", "5.0.0"],
        markOnlineOnConnect: config.ALWAYS_ONLINE === true,
        getMessage: async (key) => {
          if (store && typeof store.loadMessage === "function") {
            try {
              const msg = await store.loadMessage(key.remoteJid, key.id);
              return msg?.message || undefined;
            } catch (err) {
              return undefined;
            }
          }
          return undefined;
        },
      };

      if (version) sockOpts.version = version;
      if (state) sockOpts.auth = state;

      // Create socket connection
      const sock = await (typeof makeWASocket === "function"
        ? makeWASocket(sockOpts)
        : makeWASocket.default(sockOpts));

      // stop()/logout()/resetSession()/initialize() came while the socket was being created: close it right away
      if (gen !== this.generation) {
        await sock.end?.(undefined);
        return null;
      }
      this.sock = sock;
      this.store = store;
      this._sockClosed = false;

      // Bind store to socket
      store?.bind?.(sock.ev);

      const isCurrent = () => gen === this.generation;

      // Handle connection updates
      sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update || {};
        if (!isCurrent()) {
          // The close caused by stop()/logout()/resetSession() of this very socket is reported, never acted upon;
          // anything else from a socket that was replaced is dropped
          if (connection === "close" && gen === this.closingGeneration) {
            this._onIntentionalClose(gen, lastDisconnect?.error);
          }
          return;
        }

        if (qr) this._onQr(qr);

        if (connection === "close") {
          this._onClose(gen, lastDisconnect?.error);
        } else if (connection === "open") {
          this._onOpen(sock, version);
        }
      });

      // Save credentials on update. The writes are tracked so resetSession() can wait for them; an update of a
      // socket that was replaced is dropped (after a reset it would put the wiped files back), except the final
      // one of a socket stopped on purpose.
      sock.ev.on("creds.update", (update) => {
        const allowed =
          isCurrent() || (gen === this.closingGeneration && this.closingMode === "stopped");
        if (!allowed) return;
        const write = Promise.resolve()
          .then(() => saveCreds(update))
          .catch((error) => logger.error({ name: error?.name, code: error?.code }, "Saving the credentials failed"))
          .finally(() => this._credWrites.delete(write));
        this._credWrites.add(write);
      });

      // Handle messages (consolidated to avoid duplicate listeners)
      sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (!isCurrent()) return;
        // Emit for main message handler: live messages only. History and
        // "append" batches would re-run old commands after a reconnect.
        if (type === "notify") this.emit("messages", messages, type);

        // Handle status updates inline (auto view/react)
        const config = require("../../config");

        for (const msg of messages) {
          // Check if it's a status update
          if (msg.key.remoteJid === "status@broadcast") {
            try {
              // If socket isn't ready (connection closed / connecting), skip handling
              if (!this.isReady || !isCurrent()) {
                console.log("Socket not ready — skipping status handling");
                continue;
              }

              // Auto view status (if enabled)
              if (config.AUTO_STATUS_VIEW) {
                await sock.readMessages([msg.key]);
                console.log("✅ Auto-viewed status");
              }

              // Auto react to status (if enabled and not already reacted)
              if (config.AUTO_STATUS_REACT) {
                // Validate STATUS_EMOJIS configuration
                if (
                  !config.STATUS_EMOJIS ||
                  typeof config.STATUS_EMOJIS !== "string"
                ) {
                  console.error("❌ STATUS_EMOJIS not configured properly");
                  continue;
                }

                // Create unique ID for this status message
                // Use JSON to avoid ID collisions from underscores in participant/jid
                const statusId = JSON.stringify({
                  participant: msg.key.participant || msg.key.remoteJid,
                  id: msg.key.id,
                });

                // Check if we've already reacted to this status
                if (!this.reactedStatuses.has(statusId)) {
                  // Get emoji list and validate
                  const emojis = config.STATUS_EMOJIS.split(",")
                    .map((e) => e.trim())
                    .filter((e) => e.length > 0);

                  if (emojis.length === 0) {
                    console.error("❌ No valid emojis in STATUS_EMOJIS");
                    continue;
                  }

                  // Pick random emoji
                  const randomEmoji =
                    emojis[Math.floor(Math.random() * emojis.length)];

                  // React to status
                  await sock.sendMessage(msg.key.remoteJid, {
                    react: { text: randomEmoji, key: msg.key },
                  });

                  // Mark as reacted
                  this.reactedStatuses.add(statusId);

                  console.log(`✅ Auto-reacted to status with ${randomEmoji}`);

                  // Clean up old entries (keep only last 1000 to prevent memory leaks)
                  if (this.reactedStatuses.size > 1000) {
                    // Convert to array to ensure FIFO behavior
                    const statusArray = Array.from(this.reactedStatuses);
                    // Keep the most recent 800 entries (remove oldest 200+)
                    this.reactedStatuses = new Set(statusArray.slice(-800));
                  }
                }
              }
            } catch (error) {
              console.error("Error handling status:", error);
            }
          }
        }
      });

      // Handle group updates
      sock.ev.on("groups.update", (updates) => {
        if (!isCurrent()) return;
        for (const update of updates || []) {
          if (update?.id) invalidateGroupMetadata(update.id);
        }
        this.emit("groups.update", updates);
      });

      // Handle participant updates
      sock.ev.on("group-participants.update", (update) => {
        if (!isCurrent()) return;
        if (update?.id) invalidateGroupMetadata(update.id);
        this.emit("group-participants.update", update);
      });

      // Handle message updates (for anti-delete)
      sock.ev.on("messages.update", (updates) => {
        if (!isCurrent()) return;
        this.emit("messages.update", updates);
      });

      return sock;
    } catch (error) {
      console.error("Failed to initialize WhatsApp client:", error);
      // Nothing is connecting any more (unless a newer generation took over)
      if (gen === this.generation && this.status === "connecting") this._setStatus("idle");
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // connection.update handlers
  // ---------------------------------------------------------------------------

  _onQr(qr) {
    // A QR after the connection opened is a stray event
    if (this.isReady) return;
    this.qrVersion += 1;
    this.qrIssuedAt = Date.now();
    this._qr = qr;
    // The QR string links the account to whoever scans it: keep it out of every log line for 5 minutes
    try {
      require("../admin/logs/redactor").registerEphemeral(`qr:${this.qrVersion}`, qr, QR_SECRET_TTL_MS);
    } catch (error) {
      // redaction is a safety net, never a reason to lose the QR
    }

    // Display QR manually in terminal (v7 removed automatic terminal QR)
    try {
      qrcode.generate(qr, { small: true });
      console.log("📱 QR Code generated, scan to connect");
    } catch (e) {
      console.log("QR available (could not render in terminal)");
    }

    if (this.status === "connecting") {
      this.status = "qr";
      this.statusSince = Date.now();
    }
    try {
      this.emit("qr", qr, this.qrVersion);
    } catch (error) {
      logger.error({ name: error?.name }, "A qr listener failed");
    }
    this._emitState();
  }

  _onOpen(sock, version) {
    this.isReady = true;
    this.registered = true;
    this.reconnectAttempt = 0;
    this._qr = null;
    this.pairing = null;
    this._clearPairingTimer();
    this.me = sock.user ? { number: numberOf(sock.user), name: String(sock.user.name || "") } : null;
    this._setStatus("open");
    this._emitState(); // `me` and the cleared QR changed even when the status did not
    console.log(
      getLang(
        "extra.connected",
        "main",
        Array.isArray(version) ? version.join(".") : "-",
      ),
    );
    this.emit("ready");
  }

  _onClose(gen, error) {
    const reasons = { ...DEFAULT_REASONS, ...(DisconnectReason || {}) };
    const code = statusCodeOf(error);
    const loggedOut = code !== undefined && code === reasons.loggedOut;
    const restartRequired = code !== undefined && code === reasons.restartRequired;

    this.isReady = false;
    this._sockClosed = true;
    this._qr = null;
    this.lastClose = { at: Date.now(), code: code ?? null, loggedOut };
    this.emit("close", error);
    console.log(getLang("extra.instance_close", "main"));

    if (this.stopped) {
      // Intentional stop()/logout(): no reconnection
      console.log("Client stopped, not reconnecting");
      this._setStatus("stopped");
      return;
    }

    // A pairing code was requested but the account never got linked: the half-written credentials would poison
    // the next attempt (the code sets creds.me before WhatsApp accepts it). 515 is the normal restart after a
    // successful pairing, not an abandoned attempt.
    if (this.pairing && !this._isRegistered() && !restartRequired) {
      logger.warn({ code: code ?? null }, "Pairing abandoned: resetting the session");
      this._resetQuietly();
      return;
    }

    if (restartRequired) {
      // WhatsApp asks for a new socket right after pairing: reconnect at once (SC-006)
      this._setStatus("connecting");
      const attempt = this.initialize();
      const started = this._initGeneration;
      attempt.catch(() => {
        if (started === this.generation && !this.stopped) this._reconnectLoop(started).catch(() => {});
      });
      return;
    }

    if (loggedOut) {
      this._setStatus("logged_out");
      console.log("Logged out, please scan QR again");
      return;
    }

    this._reconnectLoop(gen).catch((err) =>
      logger.error({ name: err?.name, code: err?.code }, "Reconnection loop failed"),
    );
  }

  /** The close event of a socket that stop()/logout()/resetSession() ended on purpose */
  _onIntentionalClose(gen, error) {
    this.closingGeneration = null;
    // Something newer is running by now: its state is not ours to touch
    if (this.generation !== gen + 1) return;
    this.isReady = false;
    this.emit("close", error);
    console.log(getLang("extra.instance_close", "main"));
    console.log("Client stopped, not reconnecting");
  }

  /**
   * Reconnect after an ordinary close: wait 3 s x 2^n (capped at 60 s, reset on `open`), then initialize();
   * a failing initialize() is retried the same way instead of becoming an unhandled rejection.
   */
  async _reconnectLoop(fromGen) {
    let current = fromGen;
    for (;;) {
      const delayMs = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
      this.reconnectAttempt += 1;
      this._setStatus("reconnecting");
      console.log(getLang("extra.reconnect", "main", Math.round(delayMs / 1000)));
      await (this._delay || defaultDelay)(delayMs);
      // stop(), logout(), resetSession() or another initialize() may have come during the delay
      if (current !== this.generation || this.stopped) return;

      const attempt = this.initialize();
      const started = this._initGeneration;
      try {
        await attempt;
        return;
      } catch (error) {
        if (started !== this.generation || this.stopped) return;
        current = started;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Methods
  // ---------------------------------------------------------------------------

  /**
   * Get the socket instance
   */
  getSocket() {
    return this.sock;
  }

  /**
   * Check if client is ready
   */
  ready() {
    return this.isReady;
  }

  /**
   * Stop the client: close the connection but keep the linked device, so the next start
   * reuses sessions/ without a new QR scan. No reconnection happens afterwards.
   */
  async stop() {
    this.stopped = true;
    this.isReady = false;
    const sock = this.sock;
    this.sock = null;
    // Clear reacted statuses to prevent memory leaks
    this.reactedStatuses.clear();
    this._clearPairingTimer();
    this.pairing = null;
    this._qr = null;
    // The close caused by sock.end() below is processed in "stopped" mode; every other late event is dropped
    this.closingGeneration = this.generation;
    this.closingMode = "stopped";
    this.generation += 1;
    this._setStatus("stopped");
    if (sock) await sock.end(undefined);
  }

  /**
   * Log out: unlink this device from WhatsApp (the next start needs a new QR scan).
   * Never called on shutdown, only for an explicit "unlink" action.
   */
  async logout() {
    this.stopped = true;
    this.isReady = false;
    const sock = this.sock;
    this.sock = null;
    this.reactedStatuses.clear();
    this._clearPairingTimer();
    this.pairing = null;
    this._qr = null;
    this.registered = false;
    this.closingGeneration = this.generation;
    this.closingMode = "logged_out";
    this.generation += 1;
    this._setStatus("logged_out");
    if (sock) await sock.logout();
  }

  /**
   * Close and open the connection again with the same credentials (single-flight): no QR, no new pairing.
   * @returns {Promise<object|null>}
   */
  restart() {
    if (this._restartPromise) return this._restartPromise;
    const promise = (async () => {
      await this.stop();
      return this.initialize();
    })().finally(() => {
      if (this._restartPromise === promise) this._restartPromise = null;
    });
    this._restartPromise = promise;
    return promise;
  }

  // ---------------------------------------------------------------------------
  // Pairing by phone number
  // ---------------------------------------------------------------------------

  /**
   * Ask WhatsApp for an 8-character pairing code for `phone` (digits after stripping spaces and "+").
   * Valid for about 3 minutes; only the last two digits of the number are ever logged.
   * @param {string} phone
   * @returns {Promise<{ code: string, expiresAt: number }>} code formatted XXXX-XXXX, expiresAt in ms
   * @throws {ClientError} invalid_phone | already_registered | not_connecting | rate_limited | pairing_failed
   */
  async requestPairingCode(phone) {
    const digits = String(phone ?? "").replace(/[\s+]/g, "");
    if (!/^\d{8,15}$/.test(digits)) throw new ClientError("invalid_phone");
    if (this._isRegistered()) throw new ClientError("already_registered");

    const sock = this.sock;
    if (!sock || (this.status !== "connecting" && this.status !== "qr")) {
      throw new ClientError("not_connecting");
    }

    const now = Date.now();
    const wait = this._lastPairingRequest + PAIRING_COOLDOWN_MS - now;
    if (this._lastPairingRequest && wait > 0) throw new ClientError("rate_limited", { retryAfterMs: wait });
    this._lastPairingRequest = now;

    const gen = this.generation;
    let raw;
    try {
      if (typeof sock.waitForSocketOpen === "function") await sock.waitForSocketOpen();
      if (gen !== this.generation) throw new ClientError("not_connecting");
      raw = await sock.requestPairingCode(digits);
    } catch (error) {
      if (error instanceof ClientError) throw error;
      logger.warn({ last2: digits.slice(-2), code: error?.code }, "Pairing code request failed");
      throw new ClientError("pairing_failed");
    }

    const compact = String(raw || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (compact.length !== 8) throw new ClientError("pairing_failed");
    const code = `${compact.slice(0, 4)}-${compact.slice(4)}`;

    const requestedAt = Date.now();
    const expiresAt = requestedAt + PAIRING_WINDOW_MS;
    this.pairing = { requestedAt, expiresAt };
    this._armPairingTimer(this.pairing);
    try {
      const redactor = require("../admin/logs/redactor");
      redactor.registerEphemeral("pairing-code", code, PAIRING_WINDOW_MS);
      redactor.registerEphemeral("pairing-code-plain", compact, PAIRING_WINDOW_MS);
    } catch (error) {
      // redaction is a safety net
    }
    logger.info({ last2: digits.slice(-2) }, "Pairing code issued");
    this._emitState();
    return { code, expiresAt };
  }

  _clearPairingTimer() {
    if (this._pairingTimer) clearTimeout(this._pairingTimer);
    this._pairingTimer = null;
  }

  /** The 3-minute window: a pairing that neither opened nor registered by then is wiped */
  _armPairingTimer(pairing) {
    this._clearPairingTimer();
    const timer = setTimeout(() => {
      this._pairingTimer = null;
      // The same attempt is still pending (a 515 restart in between keeps it: the new socket may still open)
      if (this.pairing !== pairing) return;
      if (this.isReady || this._isRegistered()) return;
      logger.warn("Pairing window ended without a connection: resetting the session");
      this._resetQuietly();
    }, PAIRING_WINDOW_MS);
    if (typeof timer.unref === "function") timer.unref();
    this._pairingTimer = timer;
  }

  _resetQuietly() {
    this.resetSession().catch((error) =>
      logger.error({ name: error?.name, code: error?.code }, "Session reset failed"),
    );
  }

  // ---------------------------------------------------------------------------
  // resetSession()
  // ---------------------------------------------------------------------------

  /**
   * Refuse anything but a real directory `<sessions root>/<id>` (no symlink, no `..`, an id of word
   * characters). Resolves to false when the directory does not exist (nothing to wipe).
   */
  async _checkSessionDir() {
    if (!SESSION_ID_RE.test(this.sessionId)) throw new ClientError("invalid_session_path");
    const expected = path.join(this.sessionsRoot, this.sessionId);
    if (path.resolve(this.sessionPath) !== expected) throw new ClientError("invalid_session_path");
    let stat;
    try {
      stat = await fs.promises.lstat(expected);
    } catch (error) {
      if (error && error.code === "ENOENT") return false;
      throw new ClientError("invalid_session_path");
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ClientError("invalid_session_path");
    return true;
  }

  /**
   * Forget the linked account: best-effort logout, then empty `sessions/<id>` (its CONTENTS only: `sessions/`
   * is a volume mount in Docker), then initialize() again so a fresh QR appears. Single-flight.
   * @returns {Promise<{ removed: number }>}
   * @throws {ClientError} invalid_session_path, before anything is changed
   */
  resetSession() {
    if (this._resetPromise) return this._resetPromise;
    const promise = this._resetSession().finally(() => {
      if (this._resetPromise === promise) this._resetPromise = null;
    });
    this._resetPromise = promise;
    return promise;
  }

  async _resetSession() {
    const exists = await this._checkSessionDir();

    this.stopped = true; // nothing reconnects while the folder is being emptied
    this.isReady = false;
    const sock = this.sock;
    this.sock = null;
    this.reactedStatuses.clear();
    this._clearPairingTimer();
    this.pairing = null;
    this._qr = null;
    this.registered = false;
    this.me = null;
    this._authState = null;
    this.closingGeneration = this.generation;
    this.closingMode = "reset";
    this.generation += 1;
    this._setStatus("logged_out");

    if (sock) {
      // sock.logout() throws when the socket is down: fall back to closing it
      try {
        await settleWithin(sock.logout(), LOGOUT_TIMEOUT_MS);
      } catch (error) {
        try {
          await settleWithin(Promise.resolve(sock.end?.(undefined)), LOGOUT_TIMEOUT_MS);
        } catch (endError) {
          // already closed
        }
      }
    }

    // A credentials write still in flight would put a file back
    await Promise.allSettled([...this._credWrites]);

    let removed = 0;
    if (exists) {
      const names = await fs.promises.readdir(this.sessionPath);
      for (const name of names) {
        await fs.promises.rm(path.join(this.sessionPath, name), { recursive: true, force: true });
        removed += 1;
      }
    }
    logger.info({ removed }, "Session reset: credentials removed");

    await this.initialize();
    return { removed };
  }
}

module.exports = { WhatsAppClient, ClientError, DisconnectReason };

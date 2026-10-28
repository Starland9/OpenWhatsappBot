/**
 * Shared message pipeline (contracts/pipeline.md), used by index.js and panel.js.
 */
const config = require("../../config");
const { Message, invalidateGroupMetadata } = require("../classes/Message");
const registry = require("../plugins/registry");
const settingsCache = require("../utils/settingsCache");
const buttonRegistry = require("../utils/buttonRegistry");
const database = require("../database");
const autoResponderHandler = require("../utils/autoResponderHandler");
const viewOnceHandler = require("../utils/viewOnceHandler");
const antiDeleteHandler = require("../utils/antiDeleteHandler");
const statusSaver = require("../utils/statusSaver");
const maintenanceMode = require("../utils/maintenanceMode");
const stats = require("../utils/stats");

const logger = require("../utils/logger").createLogger("pipeline");

const BANNED_CHATS_KEY = "banned_chats";
const STICKER_CMDS_KEY = "sticker_cmds";
const CACHE_TTL_MS = 5 * 60 * 1000;

const attachedClients = new WeakSet();

/**
 * Set of disabled chat JIDs (BannedChat), cached.
 * @returns {Promise<Set<string>>}
 */
async function getBannedChats() {
  const set = await settingsCache.getOrLoad(
    BANNED_CHATS_KEY,
    async () => {
      const { BannedChat } = database;
      if (!BannedChat) return new Set();
      const rows = await BannedChat.findAll({ attributes: ["jid"], raw: true });
      return new Set(rows.map((row) => row.jid));
    },
    CACHE_TTL_MS,
  );
  return set instanceof Set ? set : new Set();
}

/**
 * Map of sticker hash (hex) -> command (StickerCommand), cached.
 * @returns {Promise<Map<string, string>>}
 */
async function getStickerCommands() {
  const map = await settingsCache.getOrLoad(
    STICKER_CMDS_KEY,
    async () => {
      const { StickerCommand } = database;
      if (!StickerCommand) return new Map();
      const rows = await StickerCommand.findAll({
        attributes: ["stickerHash", "command"],
        raw: true,
      });
      return new Map(rows.map((row) => [row.stickerHash, row.command]));
    },
    CACHE_TTL_MS,
  );
  return map instanceof Map ? map : new Map();
}

function stickerHashOf(message) {
  const sticker = message.content?.stickerMessage;
  const sha = sticker?.fileSha256;
  if (!sha || (typeof sha !== "string" && !sha.length)) return null;
  return typeof sha === "string"
    ? Buffer.from(sha, "base64").toString("hex")
    : Buffer.from(sha).toString("hex");
}

/**
 * `unban` (or one of its aliases) sent by an owner gets through a disabled chat.
 */
function isOwnerUnban(message) {
  if (!message.isCommand || !message.isSudo()) return false;
  const parsed = registry.parseCommand(message.body);
  if (!parsed) return false;
  if (parsed.cmdText === "unban") return true;
  const entry = registry.getCommandByPattern(parsed.cmdText);
  return !!entry && entry.aliases.includes("unban");
}

/**
 * Run the hooks named `name` in load order, each isolated.
 * @returns {Promise<boolean>} true when a hook returned a truthy value (and `stopOnTrue`);
 *   truthy rather than `=== true` because legacy handlers `return await message.reply(...)`
 */
async function runHooks(name, args, { stopOnTrue = false } = {}) {
  for (const { plugin, fn, file } of registry.getHooks(name)) {
    try {
      const result = await fn.apply(plugin, args);
      if (stopOnTrue && result) return true;
    } catch (error) {
      logger.error({ err: error }, `${name} hook failed in ${file || "plugin"}`);
    }
  }
  return false;
}

async function handleMessage(msg, client) {
  if (!msg || !msg.key) return;

  // A restore is in progress: new messages are dropped (the ones already started finish first)
  if (maintenanceMode.isActive()) return;

  // 1. Status broadcasts: status saver only
  if (msg.key.remoteJid === "status@broadcast") {
    try {
      await statusSaver.handleStatus(msg, client);
    } catch (error) {
      logger.error({ err: error }, "Status save error");
    }
    return;
  }

  // 2. Wrap and cache for anti-delete (non-blocking)
  const message = new Message(client, msg);
  message.isCommand = message.body.startsWith(config.PREFIX);
  setImmediate(() => {
    try {
      antiDeleteHandler.cacheMessage(message);
    } catch (error) {
      logger.debug(`Anti-delete cache error: ${error?.message}`);
    }
  });

  // 3. Disabled-chat gate (BannedChat); `unban` from an owner gets through
  const banned = await getBannedChats();
  if (banned.has(message.jid) && !isOwnerUnban(message)) return;

  // Usage statistics: counted once the chat is known to be processed, the bot's own messages excluded
  if (!message.fromMe) {
    stats.count("messages");
    if (message.isGroup) stats.count("group_msgs", message.jid);
  }

  // 4. View-once handling (never stops processing); after the gate so a disabled
  //    chat is fully ignored
  try {
    await viewOnceHandler.handleMessage(message);
  } catch (error) {
    logger.error({ err: error }, "View-once handler error");
  }

  // 5. Button / list / native-flow replies, and replies quoting a message.
  //    A prefixed command quoting a message is not a game answer: it skips this step.
  if (message.quoted || message.isInteractiveReply) {
    const digits = (message.body || "").trim();
    if (message.quoted?.id && /^\d{1,3}$/.test(digits)) {
      const id = buttonRegistry.resolve(message.quoted.id, digits);
      if (id) {
        message.body = id;
        message.isButtonReply = true;
        message.isInteractiveReply = true;
        message.isCommand = false;
      }
    }

    if (
      (message.body || "").trim() &&
      (message.isInteractiveReply || !message.isCommand)
    ) {
      const handled = await runHooks("handleButtonReply", [message], {
        stopOnTrue: true,
      });
      if (handled) return;
    }
  }

  // 6. onMessage hooks (tracking, AFK, filters...)
  if (await runHooks("onMessage", [message], { stopOnTrue: true })) return;

  // 7. Sticker bound to a command (StickerCommand)
  if (message.type === "stickerMessage") {
    try {
      const hash = stickerHashOf(message);
      const command = hash ? (await getStickerCommands()).get(hash) : null;
      if (command) {
        logger.debug(`Executing sticker command: ${command}`);
        message.body = config.PREFIX + command;
        message.isCommand = true;
        await registry.executeCommand(message);
        return;
      }
    } catch (error) {
      logger.error({ err: error }, "Sticker command error");
    }
  }

  // 8. Auto-responder for plain messages: not awaited (it waits seconds on purpose)
  if (!message.isCommand && !message.fromMe && !message.isInteractiveReply) {
    autoResponderHandler.handleMessage(message).catch((error) => {
      logger.error({ err: error }, "Auto responder error");
    });
    return;
  }

  // 9. Commands
  await registry.executeCommand(message);
}

/**
 * Process a single raw Baileys message. Never throws.
 * @param {object} msg - raw WAMessage
 * @param {object} client - WhatsAppClient (or a fake with getSocket())
 * @param {{ onError?: Function }} [options]
 */
async function processMessage(msg, client, options = {}) {
  const done = maintenanceMode.begin();
  try {
    await handleMessage(msg, client);
  } catch (error) {
    logger.error({ err: error }, "Error processing message");
    if (typeof options.onError === "function") {
      try {
        options.onError(error, msg);
      } catch (_) {
        // ignore
      }
    }
  } finally {
    done();
  }
}

/**
 * Subscribe the pipeline to every client event.
 * Call it once per client, before or after `client.initialize()`.
 * @param {EventEmitter} client
 * @param {{ onMessageProcessed?: (msg) => void, onError?: (err, msg) => void }} [options]
 *   panel.js uses these to update its counters.
 */
function attachHandlers(client, options = {}) {
  if (attachedClients.has(client)) return client;
  attachedClients.add(client);

  client.on("messages", async (messages, type) => {
    // History / append batches would re-run old commands after a reconnect
    if (type !== undefined && type !== "notify") return;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const limit = Math.max(1, Number(config.MESSAGE_CONCURRENCY_LIMIT) || 5);
    for (let i = 0; i < messages.length; i += limit) {
      const batch = messages.slice(i, i + limit);
      await Promise.allSettled(
        batch.map(async (msg) => {
          await processMessage(msg, client, options);
          if (typeof options.onMessageProcessed === "function") {
            try {
              options.onMessageProcessed(msg);
            } catch (_) {
              // ignore
            }
          }
        }),
      );
    }
  });

  client.on("messages.update", async (updates) => {
    for (const update of updates || []) {
      try {
        await antiDeleteHandler.handleMessageDelete(update, client);
      } catch (error) {
        logger.error({ err: error }, "Anti-delete handler error");
      }
    }
  });

  client.on("group-participants.update", async (update) => {
    if (update?.id) invalidateGroupMetadata(update.id);
    await runHooks("onGroupParticipants", [update, client]);
  });

  client.on("ready", async () => {
    logger.info("✅ Bot is ready and listening for messages");
    await runHooks("onReady", [client]);
  });

  return client;
}

module.exports = {
  attachHandlers,
  processMessage,
  getBannedChats,
  getStickerCommands,
  BANNED_CHATS_KEY,
  STICKER_CMDS_KEY,
};

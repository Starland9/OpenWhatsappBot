const {
  getContentType,
  downloadMediaMessage,
  jidNormalizedUser,
  extractMessageContent,
} = require("@whiskeysockets/baileys");
const config = require("../../config");

/**
 * Message abstraction class
 */
class Message {
  constructor(client, data) {
    this.client = client;
    this.data = data;
    this.key = data.key;
    this.jid = data.key.remoteJid;
    this.fromMe = data.key.fromMe;
    this.id = data.key.id;
    this.sender = jidNormalizedUser(data.key.participant || data.key.remoteJid);
    this.isGroup = this.jid.endsWith("@g.us");

    // Extract message content
    const content = extractMessageContent(data.message);
    this.type = getContentType(content);
    const msg = content[this.type];

    // Extract text
    this.body =
      msg?.text ||
      msg?.caption ||
      msg?.conversation ||
      msg?.selectedButtonId ||
      msg?.singleSelectReply?.selectedRowId ||
      (typeof msg === "string" ? msg : "") ||
      "";

    // Check if quoted/replied message
    this.quoted = msg?.contextInfo?.quotedMessage
      ? {
          message: msg.contextInfo.quotedMessage,
          sender: msg.contextInfo.participant,
          id: msg.contextInfo.stanzaId,
        }
      : null;

    // Media detection
    this.hasMedia = [
      "imageMessage",
      "videoMessage",
      "audioMessage",
      "stickerMessage",
      "documentMessage",
    ].includes(this.type);

    // Mentions
    this.mentions = msg?.contextInfo?.mentionedJid || [];
  }

  /**
   * Reply to the message
   */
  async reply(text, options = {}) {
    return await this.client
      .getSocket()
      .sendMessage(this.jid, { text, ...options }, { quoted: this.data });
  }

  /**
   * Send an image
   */
  async sendImage(buffer, caption = "", options = {}) {
    return await this.client
      .getSocket()
      .sendMessage(this.jid, { image: buffer, caption, ...options });
  }

  /**
   * Send a video
   */
  async sendVideo(buffer, caption = "", options = {}) {
    return await this.client
      .getSocket()
      .sendMessage(this.jid, { video: buffer, caption, ...options });
  }

  /**
   * Send a sticker
   */
  async sendSticker(buffer, options = {}) {
    return await this.client
      .getSocket()
      .sendMessage(this.jid, { sticker: buffer, ...options });
  }

  /**
   * Send an audio
   */
  async sendAudio(buffer, options = {}) {
    return await this.client.getSocket().sendMessage(this.jid, {
      audio: buffer,
      mimetype: "audio/mp4",
      ...options,
    });
  }

  /**
   * React to the message
   */
  async react(emoji) {
    if (!config.ENABLE_MESSAGE_REACTIONS) return null;
    return await this.client
      .getSocket()
      .sendMessage(this.jid, { react: { text: emoji, key: this.key } });
  }

  /**
   * Delete the message
   */
  async delete() {
    return await this.client
      .getSocket()
      .sendMessage(this.jid, { delete: this.key });
  }

  /**
   * Download media from the message
   */
  async downloadMedia() {
    if (!this.hasMedia) return null;

    try {
      const buffer = await downloadMediaMessage(
        this.data,
        "buffer",
        {},
        {
          logger: { info() {}, error() {}, warn() {} },
          reuploadRequest: this.client.getSocket().updateMediaMessage,
        }
      );
      return buffer;
    } catch (error) {
      console.error("Failed to download media:", error);
      return null;
    }
  }

  /**
   * Check if sender is sudo/admin
   */
  isSudo() {
    const sudoList = config.SUDO.split(",").map((s) => s.trim());
    const senderNumber = this.sender.split("@")[0];
    return sudoList.includes(senderNumber);
  }

  /**
   * Get group metadata
   */
  async getGroupMetadata() {
    if (!this.isGroup) return null;

    try {
      const metadata = await this.client.getSocket().groupMetadata(this.jid);
      return metadata;
    } catch (error) {
      console.error("Failed to get group metadata:", error);
      return null;
    }
  }

  /**
   * Check if bot is admin in group
   */
  async isBotAdmin() {
    if (!this.isGroup) return false;

    const metadata = await this.getGroupMetadata();
    if (!metadata) return false;

    const botJid = jidNormalizedUser(this.client.getSocket().user.id);
    const botParticipant = metadata.participants.find((p) => p.id === botJid);

    return botParticipant?.admin !== undefined;
  }

  /**
   * Check if sender is group admin
   */
  async isSenderAdmin() {
    if (!this.isGroup) return false;

    const metadata = await this.getGroupMetadata();
    if (!metadata) return false;

    const senderParticipant = metadata.participants.find(
      (p) => p.id === this.sender
    );
    return senderParticipant?.admin !== undefined;
  }

  /**
   * Kick a participant from group
   */
  async kick(participants) {
    if (!this.isGroup) return null;

    const jids = Array.isArray(participants) ? participants : [participants];
    return await this.client
      .getSocket()
      .groupParticipantsUpdate(this.jid, jids, "remove");
  }

  /**
   * Add participants to group
   */
  async add(participants) {
    if (!this.isGroup) return null;

    const jids = Array.isArray(participants) ? participants : [participants];
    return await this.client
      .getSocket()
      .groupParticipantsUpdate(this.jid, jids, "add");
  }

  /**
   * Promote participant to admin
   */
  async promote(participants) {
    if (!this.isGroup) return null;

    const jids = Array.isArray(participants) ? participants : [participants];
    return await this.client
      .getSocket()
      .groupParticipantsUpdate(this.jid, jids, "promote");
  }

  /**
   * Demote admin to participant
   */
  async demote(participants) {
    if (!this.isGroup) return null;

    const jids = Array.isArray(participants) ? participants : [participants];
    return await this.client
      .getSocket()
      .groupParticipantsUpdate(this.jid, jids, "demote");
  }
}

module.exports = { Message };

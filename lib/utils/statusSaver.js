const path = require("path");
const fs = require("fs").promises;
const { downloadMedia } = require("../baileys/mediaAdapter");
const statusListStore = require("./statusListStore");
const config = require("../../config");

function getSenderFromKey(msg) {
  // For status broadcasts, sender is usually in key.participant
  return msg?.key?.participant || msg?.key?.from || "";
}

function extFromMime(mime) {
  if (!mime) return "bin";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("ogg") || mime.includes("opus")) return "ogg";
  if (mime.includes("mp3")) return "mp3";
  return mime.split("/").pop() || "bin";
}

async function handleStatus(msg, client) {
  try {
    const cfg = await statusListStore.get();
    const enabled = cfg.enabled || config.AUTO_STATUS_SAVE;
    if (!enabled) return false;

    const senderJid = msg?.key?.participant || msg?.key?.from || "";
    if (!senderJid) return false;
    const senderNumber = senderJid.split("@")[0];

    const watchList = cfg.list.concat(
      (config.STATUS_SAVE_LIST || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );

    if (
      watchList.length > 0 &&
      !watchList.includes(senderNumber) &&
      !watchList.includes(senderJid)
    ) {
      // Not in watch list
      return false;
    }

    // Try to download media
    const buffer = await downloadMedia(client.getSocket(), msg);
    if (!buffer) return false;

    // Determine mime/type from message
    const content = msg.message || msg;
    const mediaKey = Object.keys(content).find((k) => k.endsWith("Message"));
    const mime = mediaKey
      ? content[mediaKey]?.mimetype || content[mediaKey]?.mediaType || null
      : null;
    const ext = extFromMime(mime);

    const folder =
      config.STATUS_SAVE_FOLDER || path.join(process.cwd(), "media", "status");
    const outFolder = path.resolve(folder);
    await fs.mkdir(outFolder, { recursive: true });

    const filename = `${senderNumber || senderJid}_${Date.now()}.${ext}`;
    const outPath = path.join(outFolder, filename);
    await fs.writeFile(outPath, buffer);

    // Log result
    console.log(`Saved status from ${senderNumber} → ${outPath}`);
    // Forward saved media to first SUDO (owner) if configured
    try {
      const sudoList = (config.SUDO || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const owner = sudoList[0];
      if (owner) {
        const ownerJid = owner.includes("@")
          ? owner
          : `${owner}@s.whatsapp.net`;
        const sock = client.getSocket();

        let payload;
        if (mediaKey && mediaKey.includes("image")) {
          payload = {
            image: buffer,
            caption: `Status de ${senderNumber || senderJid}`,
          };
        } else if (mediaKey && mediaKey.includes("video")) {
          payload = {
            video: buffer,
            caption: `Status de ${senderNumber || senderJid}`,
          };
        } else if (mediaKey && mediaKey.includes("audio")) {
          payload = { audio: buffer, mimetype: mime || undefined };
        } else if (mediaKey && mediaKey.includes("sticker")) {
          payload = { sticker: buffer };
        } else {
          payload = {
            document: buffer,
            fileName: filename,
            mimetype: mime || "application/octet-stream",
          };
        }

        try {
          await sock.sendMessage(ownerJid, payload);
          console.log(`Forwarded saved status to ${ownerJid}`);
        } catch (err) {
          console.error("Failed to forward status to owner:", err);
        }
      }
    } catch (err) {
      console.error("Error forwarding status to SUDO:", err);
    }

    return true;
  } catch (err) {
    console.error("statusSaver.handleStatus error:", err);
    return false;
  }
}

module.exports = { handleStatus };

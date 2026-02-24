const { downloadMedia } = require("../baileys/mediaAdapter");
const FileType = require("file-type");
const statusListStore = require("./statusListStore");
const config = require("../../config");

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

    // Determine content and ensure it's a media message we can download
    const content = msg.message || msg;
    const possibleMediaKeys = [
      "imageMessage",
      "videoMessage",
      "audioMessage",
      "stickerMessage",
      "documentMessage",
    ];
    const mediaKey = possibleMediaKeys.find((k) => Boolean(content[k]));
    if (!mediaKey) {
      // Not a downloadable media status (could be protocolMessage, text, etc.)
      return false;
    }

    // Try to download media
    const buffer = await downloadMedia(client.getSocket(), msg);
    if (!buffer) return false;
    let mime = mediaKey
      ? content[mediaKey]?.mimetype || content[mediaKey]?.mediaType || null
      : null;

    // Try to detect from buffer using file-type for more reliable results
    try {
      const ft = await FileType.fromBuffer(buffer);
      if (ft && ft.mime) {
        mime = ft.mime;
      }
    } catch (e) {
      // ignore detection errors
    }

    const ext = await (async () => {
      if (mime) return extFromMime(mime);
      const ft = await FileType.fromBuffer(buffer).catch(() => null);
      return ft?.ext || "bin";
    })();

    const filename = `${senderNumber || senderJid}_${Date.now()}.${ext}`;

    // Do not store on disk: directly forward buffer to owner if configured
    console.log(`Received status from ${senderNumber}; forwarding to owner`);
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
        // Choose payload based on detected mime or mediaKey
        if (
          (mediaKey && mediaKey.includes("image")) ||
          (mime && mime.startsWith("image/"))
        ) {
          payload = {
            image: buffer,
            caption: `Status de ${senderNumber || senderJid}`,
          };
        } else if (
          (mediaKey && mediaKey.includes("video")) ||
          (mime && mime.startsWith("video/"))
        ) {
          payload = {
            video: buffer,
            caption: `Status de ${senderNumber || senderJid}`,
            mimetype: mime || undefined,
          };
        } else if (
          (mediaKey && mediaKey.includes("audio")) ||
          (mime && mime.startsWith("audio/"))
        ) {
          payload = { audio: buffer, mimetype: mime || undefined };
        } else if (
          (mediaKey && mediaKey.includes("sticker")) ||
          (mime && mime === "image/webp")
        ) {
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
          console.log(`Forwarded status from ${senderNumber} to ${ownerJid}`);
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

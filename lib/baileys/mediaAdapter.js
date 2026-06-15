const { default: defaultExport } = {};
// Lightweight media adapter to abstract Baileys download/reupload API differences
const streamToBuffer = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

async function loadBaileys() {
  try {
    return require("baileys");
  } catch (e) {
    // ESM fallback
    const mod = await import("baileys");
    return mod.default ? mod.default : mod;
  }
}

async function downloadMedia(sock, messageLike, format = "buffer") {
  try {
    const baileys = await loadBaileys();

    // If baileys exposes downloadMediaMessage (v6 style), use it
    if (baileys.downloadMediaMessage) {
      return await baileys.downloadMediaMessage(
        messageLike,
        format,
        {},
        {
          logger: { info() {}, error() {}, warn() {} },
          reuploadRequest:
            (sock &&
              (sock.updateMediaMessage ||
                sock.reuploadMedia ||
                sock.reuploadMediaMessage)) ||
            undefined,
        },
      );
    }

    // Fallback: use downloadContentFromMessage (v7+)
    if (baileys.downloadContentFromMessage) {
      // Determine the media type key (imageMessage, videoMessage, etc.)
      const msg = messageLike.message || messageLike;
      const mediaKey = Object.keys(msg).find((k) => k.endsWith("Message"));
      const type = (mediaKey || "imageMessage").replace("Message", "");

      const stream = await baileys.downloadContentFromMessage(msg, type);
      const buffer = await streamToBuffer(stream);
      return buffer;
    }

    // If no helper available, try to read messageLike as Buffer if already present
    if (Buffer.isBuffer(messageLike)) return messageLike;

    return null;
  } catch (err) {
    console.error("mediaAdapter.downloadMedia error:", err);
    return null;
  }
}

function getReuploadMethod(sock) {
  if (!sock) return null;
  return (
    sock.updateMediaMessage ||
    sock.reuploadMedia ||
    sock.reuploadMediaMessage ||
    null
  );
}

module.exports = { downloadMedia, getReuploadMethod };

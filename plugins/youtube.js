const { getLang } = require("../lib/utils/language");
const play = require("play-dl");
const fs = require("fs").promises;
const path = require("path");

module.exports = {
  command: {
    pattern: "ytdl|ytv|yta|yts",
    desc: getLang("plugins.video.desc"),
    type: "download",
  },

  async execute(message, query) {
    try {
      const command = message.body
        .split(" ")[0]
        .replace(require("../config").PREFIX, "")
        .trim()
        .toLowerCase();

      if (command === "yts") {
        if (!query) {
          return await message.reply(
            "❌ Utilisation: .yts <terme>\n\nExemple: .yts despacito"
          );
        }

        try {
          await message.react("🔍");
          const results = await play.search(query, {
            limit: 5,
            source: { youtube: "video" },
          });

          if (!results || results.length === 0) {
            await message.react("❌");
            return await message.reply("❌ Aucun résultat trouvé");
          }

          let response = "🔍 *Résultats YouTube*\n\n";
          results.forEach((video, index) => {
            const duration = formatDuration(video.durationInSec);
            response += `${index + 1}. *${video.title}*\n`;
            response += `   👤 ${video.channel?.name || "Inconnu"}\n`;
            response += `   ⏱️ ${duration}\n`;
            response += `   🔗 ${video.url}\n\n`;
          });

          response += "_Pour télécharger: .ytdl <url>_";
          await message.react("✅");
          return await message.reply(response);
        } catch (error) {
          await message.react("❌");
          console.error("YouTube search error:", error);
          return await message.reply(`❌ Erreur: ${error.message}`);
        }
      }

      if (!query) {
        return await message.reply(
          "❌ Fournissez une URL YouTube\n\nExemple: .ytdl https://youtube.com/watch?v=..."
        );
      }

      try {
        await message.react("⏳");
        const isAudio = command === "yta";

        const validateResult = play.yt_validate(query);
        if (!validateResult || validateResult === "false") {
          await message.react("❌");
          return await message.reply("❌ URL YouTube invalide");
        }

        const info = await play.video_info(query);
        const video = info.video_details;
        const title = video.title;
        const duration = video.durationInSec;
        const author = video.channel?.name || "Inconnu";

        const maxDuration = isAudio ? 3600 : 900;
        if (duration > maxDuration) {
          await message.react("❌");
          return await message.reply(
            `❌ Vidéo trop longue: ${formatDuration(
              duration
            )} (Max: ${formatDuration(maxDuration)})`
          );
        }

        await message.reply(
          `📥 *Téléchargement...*\n\n*Titre:* ${title}\n*Auteur:* ${author}\n*Durée:* ${formatDuration(
            duration
          )}\n*Type:* ${isAudio ? "Audio 🎵" : "Vidéo 🎬"}`
        );

        const tempDir = path.join(__dirname, "..", "media", "temp");
        await fs.mkdir(tempDir, { recursive: true });
        const fileName = `${Date.now()}_${sanitizeFilename(title)}`;
        const filePath = path.join(tempDir, fileName);

        if (isAudio) {
          const stream = await play.stream(query, { quality: 2 });
          const audioPath = `${filePath}.mp3`;
          const writeStream = require("fs").createWriteStream(audioPath);
          stream.stream.pipe(writeStream);

          await new Promise((resolve, reject) => {
            writeStream.on("finish", resolve);
            writeStream.on("error", reject);
          });

          const buffer = await fs.readFile(audioPath);
          await message.sendAudio(buffer, {
            mimetype: "audio/mp4",
            fileName: `${sanitizeFilename(title)}.mp3`,
          });
          await fs.unlink(audioPath).catch(() => {});
        } else {
          const stream = await play.stream(query, { quality: 1 });
          const videoPath = `${filePath}.mp4`;
          const writeStream = require("fs").createWriteStream(videoPath);
          stream.stream.pipe(writeStream);

          await new Promise((resolve, reject) => {
            writeStream.on("finish", resolve);
            writeStream.on("error", reject);
          });

          const stats = await fs.stat(videoPath);
          const sizeMB = stats.size / 1024 / 1024;

          if (sizeMB > 100) {
            await fs.unlink(videoPath).catch(() => {});
            await message.react("❌");
            return await message.reply(
              `❌ Fichier trop volumineux: ${sizeMB.toFixed(2)}MB (Max: 100MB)`
            );
          }

          const buffer = await fs.readFile(videoPath);
          await message.sendVideo(buffer, title, {
            mimetype: "video/mp4",
            fileName: `${sanitizeFilename(title)}.mp4`,
          });
          await fs.unlink(videoPath).catch(() => {});
        }

        await message.react("✅");
      } catch (error) {
        await message.react("❌");
        console.error("YouTube download error:", error);
        await message.reply(`❌ Erreur: ${error.message}`);
      }
    } catch (error) {
      console.error("YouTube plugin critical error:", error);
      try {
        await message.react("❌");
        await message.reply(
          "❌ Une erreur critique est survenue. Veuillez réessayer."
        );
      } catch (e) {
        console.error("Failed to send error message:", e);
      }
    }
  },
};

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

function sanitizeFilename(filename) {
  return filename.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 50);
}

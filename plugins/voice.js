const { getLang } = require("../lib/utils/language");
const fs = require("fs").promises;
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");
const config = require("../config");

const execAsync = promisify(exec);

/**
 * Voice Processing Plugin - Speech-to-text and text-to-speech
 * Uses OpenAI Whisper for transcription and Google TTS for synthesis
 */
module.exports = {
  command: {
    pattern: "transcribe|speak",
    desc: getLang("plugins.voice.desc"),
    type: "media",
  },

  async execute(message, query) {
    const command = message.body
      .split(" ")[0]
      .replace(config.PREFIX, "")
      .toLowerCase();

    try {
      if (command === "transcribe") {
        await handleTranscription(message);
      } else if (command === "speak") {
        await handleTextToSpeech(message, query);
      }
    } catch (error) {
      await message.react("❌");
      console.error("Voice processing error:", error);
      await message.reply(
        `❌ ${getLang("plugins.voice.error")}: ${error.message}`
      );
    }
  },
};

async function handleTranscription(message) {
  // Check for audio message
  let audioBuffer;

  if (message.quoted && message.quoted.message?.audioMessage) {
    audioBuffer = await message.client
      .getSocket()
      .downloadMediaMessage(message.quoted);
  } else if (message.hasMedia && message.type === "audioMessage") {
    audioBuffer = await message.downloadMedia();
  } else {
    return await message.reply(getLang("plugins.voice.reply_audio"));
  }

  if (!audioBuffer) {
    return await message.reply(
      `❌ ${getLang("plugins.voice.download_failed")}`
    );
  }

  await message.react("⏳");

  const OPENAI_API_KEY = config.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  if (!OPENAI_API_KEY) {
    return await message.reply(`❌ ${getLang("plugins.voice.no_api_key")}`);
  }

  const tempAudio = path.join("/tmp", `audio_${Date.now()}.ogg`);
  const tempMp3 = path.join("/tmp", `audio_${Date.now()}.mp3`);

  try {
    await fs.writeFile(tempAudio, audioBuffer);

    // Convert to MP3 for OpenAI Whisper
    await execAsync(
      `ffmpeg -i ${tempAudio} -ar 16000 -ac 1 -c:a libmp3lame ${tempMp3}`
    );

    const OpenAI = require("openai");
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    const audioFile = await fs.readFile(tempMp3);
    const transcription = await openai.audio.transcriptions.create({
      file: new File([audioFile], "audio.mp3"),
      model: "whisper-1",
    });

    await message.react("✅");
    await message.reply(
      `🎤 *${getLang("plugins.voice.transcription")}*\n\n${transcription.text}`
    );
  } finally {
    await fs.unlink(tempAudio).catch(() => {});
    await fs.unlink(tempMp3).catch(() => {});
  }
}

async function handleTextToSpeech(message, text) {
  if (!text) {
    // Check if replying to a message
    if (message.quoted && message.quoted.message) {
      const quotedMsg = message.quoted.message;
      const quotedType = Object.keys(quotedMsg)[0];
      const quotedContent = quotedMsg[quotedType];
      text =
        quotedContent.text ||
        quotedContent.caption ||
        quotedContent.conversation ||
        "";
    }
  }

  if (!text) {
    return await message.reply(getLang("plugins.voice.tts_usage"));
  }

  // Limit text length
  if (text.length > 500) {
    return await message.reply(getLang("plugins.voice.text_too_long"));
  }

  await message.react("⏳");

  try {
    const googleTTS = require("google-tts-api");

    // Get TTS URL
    const url = googleTTS.getAudioUrl(text, {
      lang: config.LANG || "en",
      slow: false,
      host: "https://translate.google.com",
    });

    // Download audio
    const axios = require("axios");
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 30000,
    });
    const audioBuffer = Buffer.from(response.data);

    await message.react("✅");
    await message.sendVoice(audioBuffer);
  } catch (error) {
    console.error("TTS error:", error);
    await message.react("❌");
    await message.reply(
      `❌ ${getLang("plugins.voice.tts_error")}: ${error.message}`
    );
  }
}

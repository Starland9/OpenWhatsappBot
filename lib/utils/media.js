const sharp = require("sharp");
const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs").promises;
const path = require("path");
const FileType = require("file-type");

const execAsync = promisify(exec);

/**
 * Media processing utilities for multimodal support
 */

/**
 * Convert image to different format
 */
async function convertImage(buffer, targetFormat = "png") {
  try {
    const validFormats = ["png", "jpg", "jpeg", "webp", "gif"];
    if (!validFormats.includes(targetFormat.toLowerCase())) {
      throw new Error(`Unsupported format: ${targetFormat}`);
    }

    return await sharp(buffer)
      .toFormat(targetFormat)
      .toBuffer();
  } catch (error) {
    throw new Error(`Image conversion failed: ${error.message}`);
  }
}

/**
 * Resize image while maintaining aspect ratio
 */
async function resizeImage(buffer, width, height = null) {
  try {
    const options = {
      fit: "inside",
      withoutEnlargement: true,
    };

    if (height) {
      return await sharp(buffer).resize(width, height, options).toBuffer();
    }

    return await sharp(buffer).resize(width, null, options).toBuffer();
  } catch (error) {
    throw new Error(`Image resize failed: ${error.message}`);
  }
}

/**
 * Get image metadata
 */
async function getImageMetadata(buffer) {
  try {
    const metadata = await sharp(buffer).metadata();
    return {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      size: buffer.length,
      hasAlpha: metadata.hasAlpha,
    };
  } catch (error) {
    throw new Error(`Failed to get image metadata: ${error.message}`);
  }
}

/**
 * Convert video to audio (extract audio)
 */
async function videoToAudio(inputBuffer, outputFormat = "mp3") {
  const tempInput = path.join("/tmp", `video_${Date.now()}.mp4`);
  const tempOutput = path.join("/tmp", `audio_${Date.now()}.${outputFormat}`);

  try {
    await fs.writeFile(tempInput, inputBuffer);

    await execAsync(
      `ffmpeg -i ${tempInput} -vn -acodec libmp3lame -q:a 2 ${tempOutput}`
    );

    const audioBuffer = await fs.readFile(tempOutput);
    return audioBuffer;
  } finally {
    await fs.unlink(tempInput).catch(() => {});
    await fs.unlink(tempOutput).catch(() => {});
  }
}

/**
 * Convert audio format
 */
async function convertAudio(inputBuffer, outputFormat = "mp3") {
  const tempInput = path.join("/tmp", `audio_in_${Date.now()}.tmp`);
  const tempOutput = path.join("/tmp", `audio_out_${Date.now()}.${outputFormat}`);

  try {
    await fs.writeFile(tempInput, inputBuffer);

    await execAsync(
      `ffmpeg -i ${tempInput} -acodec libmp3lame -q:a 2 ${tempOutput}`
    );

    const audioBuffer = await fs.readFile(tempOutput);
    return audioBuffer;
  } finally {
    await fs.unlink(tempInput).catch(() => {});
    await fs.unlink(tempOutput).catch(() => {});
  }
}

/**
 * Get media file type from buffer
 */
async function getFileType(buffer) {
  try {
    const type = await FileType.fromBuffer(buffer);
    return type;
  } catch (error) {
    return null;
  }
}

/**
 * Compress image for WhatsApp
 */
async function compressImage(buffer, quality = 80) {
  try {
    return await sharp(buffer)
      .jpeg({ quality, progressive: true })
      .toBuffer();
  } catch (error) {
    throw new Error(`Image compression failed: ${error.message}`);
  }
}

/**
 * Create thumbnail from image
 */
async function createThumbnail(buffer, size = 200) {
  try {
    return await sharp(buffer)
      .resize(size, size, {
        fit: "cover",
        position: "center",
      })
      .toBuffer();
  } catch (error) {
    throw new Error(`Thumbnail creation failed: ${error.message}`);
  }
}

/**
 * Get video duration in seconds
 */
async function getVideoDuration(inputBuffer) {
  const tempInput = path.join("/tmp", `vid_${Date.now()}.mp4`);

  try {
    await fs.writeFile(tempInput, inputBuffer);

    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${tempInput}`
    );

    return parseFloat(stdout.trim());
  } finally {
    await fs.unlink(tempInput).catch(() => {});
  }
}

/**
 * Trim video
 */
async function trimVideo(inputBuffer, startTime, duration) {
  const tempInput = path.join("/tmp", `vid_in_${Date.now()}.mp4`);
  const tempOutput = path.join("/tmp", `vid_out_${Date.now()}.mp4`);

  try {
    await fs.writeFile(tempInput, inputBuffer);

    await execAsync(
      `ffmpeg -i ${tempInput} -ss ${startTime} -t ${duration} -c copy ${tempOutput}`
    );

    const outputBuffer = await fs.readFile(tempOutput);
    return outputBuffer;
  } finally {
    await fs.unlink(tempInput).catch(() => {});
    await fs.unlink(tempOutput).catch(() => {});
  }
}

module.exports = {
  convertImage,
  resizeImage,
  getImageMetadata,
  videoToAudio,
  convertAudio,
  getFileType,
  compressImage,
  createThumbnail,
  getVideoDuration,
  trimVideo,
};

const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs").promises;
const os = require("os");
const path = require("path");
const { runFfmpeg } = require("./ffmpeg");

const execFileAsync = promisify(execFile);

// sharp is a native module: load it on first use so that withTempDir()
// can be required (e.g. by the downloader) without loading it
let sharpModule = null;
function sharp(...args) {
  if (!sharpModule) sharpModule = require("sharp");
  return sharpModule(...args);
}

/**
 * Media processing utilities for multimodal support
 */

/**
 * Run fn(dir) with a fresh temporary directory, always removed afterwards
 * (even when fn throws).
 * @param {(dir: string) => Promise<T>|T} fn
 * @returns {Promise<T>} the result of fn
 */
async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Run ffprobe without a shell (ffmpeg goes through lib/utils/ffmpeg.js).
 * The error keeps only a short reason: no command line.
 */
async function runFfprobe(args, timeout = 30000) {
  try {
    return await execFileAsync("ffprobe", args, { timeout, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    if (error.code === "ENOENT") {
      const err = new Error("ffprobe is not installed");
      err.code = "ENOENT";
      throw err;
    }
    if (error.killed) {
      const err = new Error(`ffprobe timed out after ${timeout}ms`);
      err.code = "ETIMEDOUT";
      throw err;
    }
    const reason = String(error.stderr || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    throw new Error(`ffprobe failed${reason ? `: ${reason}` : ""}`);
  }
}

/** Output extensions end up in a file name: keep them to a plain token */
function safeExtension(format, fallback) {
  const ext = String(format || "").toLowerCase();
  return /^[a-z0-9]{2,5}$/.test(ext) ? ext : fallback;
}

/**
 * Convert image to different format
 */
async function convertImage(buffer, targetFormat = "png") {
  try {
    const format = String(targetFormat).toLowerCase();
    const validFormats = ["png", "jpg", "jpeg", "webp", "gif"];
    if (!validFormats.includes(format)) {
      throw new Error(`Unsupported format: ${targetFormat}`);
    }

    let image = sharp(buffer);
    // JPEG has no alpha channel: transparent pixels would turn black
    if (format === "jpg" || format === "jpeg") {
      image = image.flatten({ background: "#ffffff" });
    }

    return await image.toFormat(format).toBuffer();
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
  const ext = safeExtension(outputFormat, "mp3");

  return withTempDir(async (dir) => {
    const input = path.join(dir, "input.mp4");
    const output = path.join(dir, `output.${ext}`);

    await fs.writeFile(input, inputBuffer);
    await runFfmpeg([
      "-i", input,
      "-vn",
      "-acodec", "libmp3lame",
      "-q:a", "2",
      output,
    ]);

    return fs.readFile(output);
  });
}

/**
 * Convert audio format
 */
async function convertAudio(inputBuffer, outputFormat = "mp3") {
  const ext = safeExtension(outputFormat, "mp3");

  return withTempDir(async (dir) => {
    const input = path.join(dir, "input.tmp");
    const output = path.join(dir, `output.${ext}`);

    await fs.writeFile(input, inputBuffer);
    await runFfmpeg([
      "-i", input,
      "-acodec", "libmp3lame",
      "-q:a", "2",
      output,
    ]);

    return fs.readFile(output);
  });
}

/**
 * Get media file type from buffer
 * (file-type 22 is ESM-only: it is loaded with a dynamic import)
 */
async function getFileType(buffer) {
  try {
    const { fileTypeFromBuffer } = await import("file-type");
    const type = await fileTypeFromBuffer(buffer);
    return type || null;
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
      .flatten({ background: "#ffffff" })
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
  return withTempDir(async (dir) => {
    const input = path.join(dir, "input.mp4");
    await fs.writeFile(input, inputBuffer);

    const { stdout } = await runFfprobe([
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      input,
    ]);

    return parseFloat(stdout.trim());
  });
}

/**
 * Trim video
 */
async function trimVideo(inputBuffer, startTime, duration) {
  return withTempDir(async (dir) => {
    const input = path.join(dir, "input.mp4");
    const output = path.join(dir, "output.mp4");

    await fs.writeFile(input, inputBuffer);
    await runFfmpeg([
      "-i", input,
      "-ss", String(startTime),
      "-t", String(duration),
      "-c", "copy",
      output,
    ]);

    return fs.readFile(output);
  });
}

module.exports = {
  withTempDir,
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

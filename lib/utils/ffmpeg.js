const { spawn } = require("child_process");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");

/**
 * FFmpeg helpers
 * Thin wrapper around the system `ffmpeg` binary (no shell, no fluent-ffmpeg).
 */

// Only the tail of stderr is kept: it holds the actual error, and a runaway
// process must not fill the memory
const STDERR_LIMIT = 16 * 1024;

/**
 * Run ffmpeg with the given arguments.
 * `-y -nostdin -loglevel error` are always prepended, so no banner is printed.
 * @param {string[]} args - ffmpeg arguments (e.g. ["-i", "in.mp3", "out.ogg"])
 * @param {Object} [options]
 * @param {number} [options.timeout=120000] - kill ffmpeg after this many ms
 * @param {Buffer} [options.input] - piped to stdin (use "pipe:0" as input)
 * @returns {Promise<{stdout: Buffer}>} stdout (use "pipe:1" as output)
 * @throws {Error} short message ("ffmpeg failed (code 1)"); the trimmed
 *   stderr is in `err.stderr`, `err.code` is "ENOENT" when ffmpeg is missing
 *   and "ETIMEDOUT" on timeout
 */
function runFfmpeg(args, { timeout = 120000, input } = {}) {
  return new Promise((resolve, reject) => {
    const hasInput = Buffer.isBuffer(input);
    let child;
    try {
      child = spawn(
        "ffmpeg",
        ["-y", "-nostdin", "-loglevel", "error", ...args],
        {
          shell: false,
          stdio: [hasInput ? "pipe" : "ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      return reject(error);
    }

    const stdout = [];
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };

    const fail = (message, extra) => {
      const error = new Error(message);
      error.stderr = stderr.toString("utf8").trim();
      Object.assign(error, extra);
      finish(error);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > STDERR_LIMIT) {
        stderr = stderr.subarray(stderr.length - STDERR_LIMIT);
      }
    });

    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        fail("ffmpeg not found", { code: "ENOENT" });
      } else {
        fail(`ffmpeg failed to start (${error.code || "error"})`, {
          code: error.code,
        });
      }
    });

    child.on("close", (code, signal) => {
      if (timedOut) {
        return fail(`ffmpeg timed out after ${timeout}ms`, {
          code: "ETIMEDOUT",
        });
      }
      if (code === 0) return finish(null, { stdout: Buffer.concat(stdout) });
      fail(`ffmpeg failed (${signal ? `signal ${signal}` : `code ${code}`})`, {
        exitCode: code,
        signal,
      });
    });

    if (hasInput) {
      // ffmpeg may exit before reading all the input (bad file): EPIPE is
      // then reported through the exit code, not here
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

const OPUS_VOICE_ARGS = [
  "-vn",
  "-c:a",
  "libopus",
  "-b:a",
  "24k",
  "-ar",
  "48000",
  "-ac",
  "1",
  "-f",
  "ogg",
];

/**
 * Convert any audio buffer to an ogg/opus voice note (mono, 48 kHz, 24 kbps).
 * @param {Buffer} buffer - audio (or video) in any format ffmpeg can read
 * @param {Object} [options]
 * @param {number} [options.timeout] - kill ffmpeg after this many ms
 * @returns {Promise<Buffer>} ogg/opus audio
 */
async function toOpusVoice(buffer, { timeout } = {}) {
  const options = timeout ? { timeout } : {};
  try {
    const { stdout } = await runFfmpeg(
      ["-i", "pipe:0", ...OPUS_VOICE_ARGS, "pipe:1"],
      { ...options, input: buffer },
    );
    return stdout;
  } catch (error) {
    // Some containers (mp4/m4a with the index at the end) cannot be read from
    // a pipe: retry from a temp file. Missing binary and timeouts are final.
    if (error.code === "ENOENT" || error.code === "ETIMEDOUT") throw error;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-"));
    try {
      const inputFile = path.join(tempDir, "input");
      await fs.writeFile(inputFile, buffer);
      const { stdout } = await runFfmpeg(
        ["-i", inputFile, ...OPUS_VOICE_ARGS, "pipe:1"],
        options,
      );
      return stdout;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = { runFfmpeg, toOpusVoice };

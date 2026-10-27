const { execFile } = require("child_process");
const fs = require("fs").promises;
const path = require("path");
const pino = require("pino");
const config = require("../../config");
const { withTempDir } = require("./media");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

/**
 * Downloader: thin wrapper around the yt-dlp binary (YouTube, Instagram, TikTok, ...).
 *
 * The binary is started with execFile (no shell). Errors carry a `code`:
 *   YTDLP_MISSING      binary not installed / not executable (classifyError: service_unavailable)
 *   MEDIA_TOO_LARGE    file over the size cap (classifyError: media_too_large)
 *   ETIMEDOUT          took longer than the timeout (classifyError: service_unavailable)
 *   YTDLP_BLOCKED      bot check, HTTP 429/403, network failure, extractor broken: run `yt-dlp -U`
 *                      (classifyError: service_unavailable)
 *   YTDLP_UNSUPPORTED  URL not supported / no media in the page
 *   YTDLP_UNAVAILABLE  private, removed, geo-blocked or live content
 *   INVALID_URL        not an http(s) URL
 *   YTDLP_FAILED       any other failure (err.stderr has the full output)
 *
 * URL host allow-lists and SSRF checks are the caller's job.
 */

const VIDEO_FORMAT = "best[height<=720][ext=mp4]/best[ext=mp4]/best";
const AUDIO_FORMAT = "bestaudio[ext=m4a]/bestaudio/best";
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 60000;
const INFO_TIMEOUT_MS = 60000;
const NOT_AVAILABLE_RETRY_MS = 30000;

const MIME_BY_EXT = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  aac: "audio/aac",
  wav: "audio/wav",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

function binary() {
  return config.YTDLP_PATH || "yt-dlp";
}

function defaultTimeout() {
  return config.DOWNLOAD_TIMEOUT || 180000;
}

function defaultMaxBytes() {
  return (config.MAX_UPLOAD || 230) * 1024 * 1024;
}

function makeError(message, code, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

/**
 * Turn a yt-dlp stderr into a short message and an error code.
 */
function parseFailure(stderr) {
  const lines = String(stderr || "")
    .replace(ANSI_RE, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const errorLine = [...lines].reverse().find((l) => /^ERROR:/i.test(l)) || lines[lines.length - 1] || "";
  const reason = errorLine.replace(/^ERROR:\s*/i, "").slice(0, 200) || "unknown error";
  const all = lines.join("\n");

  let code = "YTDLP_FAILED";
  if (/larger than max-filesize/i.test(all)) code = "MEDIA_TOO_LARGE";
  else if (/unsupported url|no video could be found/i.test(all)) {
    code = "YTDLP_UNSUPPORTED";
  } else if (
    /private video|video unavailable|this video is (?:not available|unavailable|private)|http error (?:404|410)|has been removed|age[- ]restricted|not available in your country|geo.?restrict|live event|is_live|does not pass filter|members-only|login required|only available for registered|requested content is not available/i.test(
      all
    )
  ) {
    code = "YTDLP_UNAVAILABLE";
  } else if (
    /http error (?:429|403|5\d\d)|too many requests|sign in to confirm|not a bot|no video formats found|requested format is not available|unable to extract|please report this issue|unable to download (?:webpage|video data|json)|name or service not known|temporary failure in name resolution|connection (?:refused|reset|timed out)|network is unreachable|ssl|certificate|timed out/i.test(
      all
    )
  ) {
    code = "YTDLP_BLOCKED";
  }
  return { reason, code };
}

/**
 * Run yt-dlp. Never rejects with the command line in the message.
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function runYtDlp(args, { timeoutMs = defaultTimeout() } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    execFile(
      binary(),
      args,
      {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { ...process.env, NO_COLOR: "1", PYTHONIOENCODING: "utf-8" },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout: String(stdout), stderr: String(stderr) });

        if (error.code === "ENOENT" || error.code === "EACCES") {
          return reject(makeError("yt-dlp is not installed or not executable", "YTDLP_MISSING"));
        }
        if (error.killed && Date.now() - started >= timeoutMs - 1000) {
          return reject(makeError(`yt-dlp timed out after ${timeoutMs}ms`, "ETIMEDOUT"));
        }
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          return reject(makeError("yt-dlp produced too much output", "YTDLP_FAILED"));
        }
        const { reason, code } = parseFailure(stderr || error.message);
        reject(makeError(reason, code, { stderr: String(stderr || "") }));
      }
    );
  });
}

/** Accept only http(s) URLs; also keeps a URL from being read as an option */
function assertHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url).trim());
  } catch (e) {
    throw makeError("Invalid URL", "INVALID_URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw makeError("Invalid URL", "INVALID_URL");
  }
  return parsed.href;
}

let availability = null; // { ok: boolean, version: string|null, at: number }
let availabilityCheck = null;

/**
 * Is the yt-dlp binary usable? The result is cached: a positive one for the whole
 * process, a negative one for 30 s (so an install while running is picked up).
 * @returns {Promise<boolean>}
 */
async function isAvailable() {
  if (availability && (availability.ok || Date.now() - availability.at < NOT_AVAILABLE_RETRY_MS)) {
    return availability.ok;
  }
  if (!availabilityCheck) {
    availabilityCheck = runYtDlp(["--version"], { timeoutMs: 15000 })
      .then(({ stdout }) => {
        availability = { ok: true, version: stdout.trim() || null, at: Date.now() };
      })
      .catch((err) => {
        logger.warn({ code: err.code, message: err.message }, "yt-dlp is not available");
        availability = { ok: false, version: null, at: Date.now() };
      })
      .finally(() => {
        availabilityCheck = null;
      });
  }
  await availabilityCheck;
  return availability.ok;
}

/**
 * yt-dlp version, or null when it is not available (call isAvailable() first).
 * @returns {string|null}
 */
function getVersion() {
  return availability && availability.ok ? availability.version : null;
}

/** Forget the cached availability (tests, after `yt-dlp -U`) */
function resetCache() {
  availability = null;
}

function safeFileName(title, id, ext) {
  const base =
    String(title || id || "download")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80)
      .trim() || "download";
  return `${base}.${ext}`;
}

/**
 * Download a video (or audio, or image post) with yt-dlp into memory.
 * @param {string} url - http(s) URL
 * @param {Object} [opts]
 * @param {boolean} [opts.audio=false] - Extract the audio track as m4a
 * @param {number} [opts.maxBytes] - Size cap in bytes (default: config.MAX_UPLOAD MB)
 * @param {number} [opts.timeoutMs] - Default: config.DOWNLOAD_TIMEOUT (180 s)
 * @returns {Promise<{ buffer: Buffer, mimetype: string, fileName: string, title: string }>}
 */
async function download(url, { audio = false, maxBytes, timeoutMs } = {}) {
  const href = assertHttpUrl(url);
  const limit = maxBytes || defaultMaxBytes();
  const limitMb = Math.max(1, Math.floor(limit / 1024 / 1024));

  // Each download may use up to MAX_UPLOAD MB of disk and then of memory: cap the
  // number running at once so a burst of requests can't exhaust the host
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    throw makeError("too many downloads in progress", "YTDLP_BUSY");
  }
  activeDownloads += 1;
  try {
    return await downloadInTempDir(href, { audio, limit, limitMb, timeoutMs });
  } finally {
    activeDownloads -= 1;
  }
}

const MAX_CONCURRENT_DOWNLOADS = 2;
let activeDownloads = 0;

async function downloadInTempDir(href, { audio, limit, limitMb, timeoutMs }) {
  return withTempDir(async (dir) => {
    const args = [
      "--no-playlist",
      // --no-playlist only applies to a link that is both a video and a playlist: a pure
      // playlist / channel / profile link would download every entry. One item at most.
      "--playlist-items", "1",
      "--no-progress",
      "--no-warnings",
      "--socket-timeout", "20",
      "--match-filter", "!is_live",
      "--max-filesize", `${limitMb}M`,
      "-o", path.join(dir, "%(id)s.%(ext)s"),
      "--print", "after_move:%(.{filepath,title,id,ext})j",
      // --print implies --quiet, which hides the "larger than max-filesize" reason
      "--no-quiet",
    ];
    if (audio) args.push("-f", AUDIO_FORMAT, "-x", "--audio-format", "m4a");
    else args.push("-f", VIDEO_FORMAT);
    args.push("--", href);

    const { stdout, stderr } = await runYtDlp(args, { timeoutMs: timeoutMs || defaultTimeout() });

    // The JSON line printed after the move tells us the file and the title
    let printed = null;
    for (const line of stdout.split("\n").reverse()) {
      const text = line.trim();
      if (!text.startsWith("{")) continue;
      try {
        printed = JSON.parse(text);
        break;
      } catch (e) {
        // keep looking
      }
    }

    let filePath = printed && printed.filepath ? String(printed.filepath) : null;
    // Never trust a path outside the temp dir
    if (filePath && path.dirname(path.resolve(filePath)) !== path.resolve(dir)) filePath = null;
    if (!filePath) {
      const files = (await fs.readdir(dir)).filter((f) => !/\.(part|ytdl|temp)$/i.test(f));
      if (files.length) filePath = path.join(dir, files[0]);
    }

    if (!filePath) {
      const { code, reason } = parseFailure(stderr + "\n" + stdout);
      if (code === "MEDIA_TOO_LARGE") throw makeError(`Media exceeds the ${limitMb} MB limit`, "MEDIA_TOO_LARGE");
      if (code === "YTDLP_FAILED") throw makeError("yt-dlp produced no file", "YTDLP_UNSUPPORTED", { stderr });
      throw makeError(reason, code, { stderr });
    }

    const stat = await fs.stat(filePath);
    if (stat.size > limit) {
      throw makeError(`Media exceeds the ${limitMb} MB limit`, "MEDIA_TOO_LARGE");
    }

    const ext = path.extname(filePath).slice(1).toLowerCase() || "bin";
    const buffer = await fs.readFile(filePath);
    const title = (printed && printed.title ? String(printed.title) : "").trim();
    const id = printed && printed.id ? String(printed.id) : path.basename(filePath, path.extname(filePath));

    return {
      buffer,
      mimetype: MIME_BY_EXT[ext] || "application/octet-stream",
      fileName: safeFileName(title, id, ext),
      title: title || id,
    };
  });
}

/**
 * Search YouTube.
 * @param {string} query
 * @param {number} [n=5] - Number of results (1 to 10)
 * @returns {Promise<Array<{ id: string, title: string, url: string, duration: number|null, channel: string|null }>>}
 */
async function search(query, n = 5) {
  const text = String(query || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!text) return [];
  const count = Math.min(10, Math.max(1, parseInt(n, 10) || 5));

  const { stdout } = await runYtDlp(
    [
      "--dump-json",
      "--flat-playlist",
      "--skip-download",
      "--no-warnings",
      "--socket-timeout", "20",
      "--",
      `ytsearch${count}:${text}`,
    ],
    { timeoutMs: Math.min(defaultTimeout(), SEARCH_TIMEOUT_MS) }
  );

  const results = [];
  for (const line of stdout.split("\n")) {
    const row = line.trim();
    if (!row.startsWith("{")) continue;
    let entry;
    try {
      entry = JSON.parse(row);
    } catch (e) {
      continue;
    }
    if (!entry.id) continue;
    results.push({
      id: String(entry.id),
      title: String(entry.title || entry.id),
      url: entry.webpage_url || entry.url || `https://www.youtube.com/watch?v=${entry.id}`,
      duration: typeof entry.duration === "number" ? entry.duration : null,
      channel: entry.channel || entry.uploader || null,
    });
  }
  return results.slice(0, count);
}

/**
 * Metadata only, to reject a too long or too big video before downloading it.
 * @param {string} url - http(s) URL
 * @param {Object} [opts]
 * @param {boolean} [opts.audio=false] - Estimate the size of the audio format
 * @returns {Promise<{ title: string, duration: number|null, filesizeApprox: number|null, id: string|null, isLive: boolean }>}
 */
async function getInfo(url, { audio = false } = {}) {
  const href = assertHttpUrl(url);
  const { stdout } = await runYtDlp(
    [
      "--dump-single-json",
      "--skip-download",
      "--no-playlist",
      "--no-warnings",
      "--socket-timeout", "20",
      "-f", audio ? AUDIO_FORMAT : VIDEO_FORMAT,
      "--",
      href,
    ],
    { timeoutMs: Math.min(defaultTimeout(), INFO_TIMEOUT_MS) }
  );

  let info;
  try {
    info = JSON.parse(stdout);
  } catch (e) {
    throw makeError("yt-dlp returned unreadable metadata", "YTDLP_FAILED");
  }

  return {
    title: String(info.title || info.id || ""),
    duration: typeof info.duration === "number" ? info.duration : null,
    filesizeApprox: info.filesize_approx || info.filesize || null,
    id: info.id ? String(info.id) : null,
    isLive: !!info.is_live,
  };
}

module.exports = {
  isAvailable,
  getVersion,
  resetCache,
  download,
  search,
  getInfo,
};

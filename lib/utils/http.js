const axios = require("axios");
const config = require("../../config");

/**
 * HTTP helpers shared by the plugins.
 *
 * - fetchJson / fetchBuffer: axios with a TOTAL timeout (AbortSignal.timeout) and a size cap
 * - classifyError: maps any failure (axios, fetch, OpenAI, @google/genai, yt-dlp wrapper)
 *   to a kind the plugins turn into a localized reply (see replyKeyFor)
 * - safeLog: log-safe view of an error (axios errors carry API keys in `config`)
 */

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_JSON_MAX_BYTES = 10 * 1024 * 1024;

/** Default size cap for downloads, in bytes (config.MAX_UPLOAD is in MB) */
function defaultMaxBytes() {
  return (config.MAX_UPLOAD || 230) * 1024 * 1024;
}

/**
 * Remove everything that may hold secrets from an error (request config with
 * headers/params, the raw request, ...). The status, code and response body stay.
 * @param {Error} err
 * @returns {Error} the same error
 */
function scrubError(err) {
  if (!err || typeof err !== "object") return err;
  try {
    if ("config" in err) err.config = undefined;
    if ("request" in err) err.request = undefined;
    if (err.response && typeof err.response === "object") {
      err.response.config = undefined;
      err.response.request = undefined;
    }
  } catch (e) {
    // frozen error object: nothing more we can do
  }
  return err;
}

function tooLargeError(maxBytes) {
  const limit = maxBytes >= 1024 * 1024 ? `${Math.round(maxBytes / 1024 / 1024)} MB` : `${Math.round(maxBytes / 1024)} KB`;
  const err = new Error(`Media exceeds the ${limit} limit`);
  err.code = "MEDIA_TOO_LARGE";
  return err;
}

const SIZE_MESSAGE_RE = /maxContentLength|maxBodyLength|content[- ]length (?:size )?(?:of .* )?exceed/i;

function isSizeLimitError(err) {
  return (
    !!err &&
    (err.code === "MEDIA_TOO_LARGE" ||
      (typeof err.message === "string" && SIZE_MESSAGE_RE.test(err.message)))
  );
}

/**
 * Run an axios request with a total timeout, scrubbing the error on failure.
 */
async function request(config_, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await axios.request({ ...config_, timeout: timeoutMs, signal });
  } catch (err) {
    if (signal.aborted && axios.isCancel(err)) {
      // the total timeout fired while the socket was still active
      err.code = "ETIMEDOUT";
      err.message = `Request timed out after ${timeoutMs}ms`;
    }
    throw scrubError(err);
  }
}

/**
 * GET (or other method) a JSON endpoint.
 * @param {string} url
 * @param {Object} [opts]
 * @param {Object} [opts.params] - Query string parameters
 * @param {Object} [opts.headers]
 * @param {number} [opts.timeoutMs=30000] - Total timeout
 * @param {string} [opts.method="GET"]
 * @param {*} [opts.data] - Request body
 * @param {number} [opts.maxBytes=10485760] - Response size cap
 * @returns {Promise<any>} parsed JSON
 */
async function fetchJson(
  url,
  { params, headers, timeoutMs = DEFAULT_TIMEOUT_MS, method = "GET", data, maxBytes = DEFAULT_JSON_MAX_BYTES } = {}
) {
  let res;
  try {
    res = await request(
      {
        url,
        method,
        params,
        headers,
        data,
        responseType: "json",
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
      },
      timeoutMs
    );
  } catch (err) {
    if (isSizeLimitError(err)) err.code = "MEDIA_TOO_LARGE";
    throw err;
  }

  const body = res.data;
  // A 200 with an HTML page (captive portal, error page) is not a usable answer
  if (typeof body === "string" && /^\s*</.test(body)) {
    const err = new Error("Unexpected non-JSON response");
    err.code = "ERR_BAD_RESPONSE_FORMAT";
    err.status = res.status;
    throw err;
  }
  return body;
}

/**
 * Download a binary resource into memory.
 * @param {string} url
 * @param {Object} [opts]
 * @param {number} [opts.maxBytes] - Size cap in bytes (default: config.MAX_UPLOAD MB)
 * @param {number} [opts.timeoutMs=30000] - Total timeout (not an idle timeout)
 * @param {Object} [opts.headers]
 * @returns {Promise<{ buffer: Buffer, contentType: string|null }>}
 * @throws {Error} with code "MEDIA_TOO_LARGE" when over the cap
 */
async function fetchBuffer(
  url,
  { maxBytes = defaultMaxBytes(), timeoutMs = DEFAULT_TIMEOUT_MS, headers } = {}
) {
  let res;
  try {
    res = await request(
      {
        url,
        method: "GET",
        headers,
        responseType: "arraybuffer",
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
      },
      timeoutMs
    );
  } catch (err) {
    if (isSizeLimitError(err)) {
      const tooLarge = tooLargeError(maxBytes);
      tooLarge.cause = err;
      throw tooLarge;
    }
    throw err;
  }

  const buffer = Buffer.from(res.data);
  if (buffer.length > maxBytes) throw tooLargeError(maxBytes);
  return { buffer, contentType: res.headers?.["content-type"] || null };
}

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ERR_CANCELED",
  "ERR_BAD_RESPONSE_FORMAT",
  "YTDLP_MISSING",
  "YTDLP_BLOCKED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const TLS_CODE_RE = /CERT|SELF_SIGNED|VERIFY_LEAF|^ERR_TLS_|^ERR_SSL_|^EPROTO$/i;
const NETWORK_NAMES = new Set([
  "AbortError",
  "TimeoutError",
  "APIConnectionError",
  "APIConnectionTimeoutError",
  "CanceledError",
]);
const AUTH_MESSAGE_RE = /api key (?:not valid|is invalid|expired)|invalid api key|incorrect api key|invalid x-api-key|permission denied|unauthori[sz]ed/i;

/**
 * Collect the error codes, names and statuses from an error and its causes.
 */
function inspect(err) {
  const info = { status: null, codes: [], names: [] };
  const seen = new Set();
  const visit = (e, depth) => {
    if (!e || typeof e !== "object" || seen.has(e) || depth > 3) return;
    seen.add(e);
    if (typeof e.code === "string") info.codes.push(e.code);
    if (typeof e.name === "string") info.names.push(e.name);
    if (info.status === null) {
      const s = e.response?.status ?? e.status ?? e.statusCode;
      if (Number.isInteger(s)) info.status = s;
    }
    visit(e.cause, depth + 1);
    if (Array.isArray(e.errors)) e.errors.slice(0, 2).forEach((x) => visit(x, depth + 1));
  };
  visit(err, 0);
  return info;
}

/**
 * Classify a failure so the plugin can pick the right reply.
 *
 * @param {Error} err
 * @param {Object} [opts]
 * @param {boolean} [opts.hasKey] - Whether an API key is configured for the service.
 *   Pass `false` for key-based services: a 401/403 then means "not configured".
 *   Omitted or true: a 401/403 means the service refuses us ("service_unavailable").
 * @param {boolean} [opts.userUrl=false] - The URL came from the user: a 404/410
 *   is then a plain "error" (bad link) instead of a dead service.
 * @returns {"not_configured"|"rate_limited"|"service_unavailable"|"media_too_large"|"error"}
 */
function classifyError(err, { hasKey, userUrl = false } = {}) {
  if (!err) return "error";

  if (isSizeLimitError(err)) return "media_too_large";

  const { status, codes, names } = inspect(err);
  const message = typeof err.message === "string" ? err.message : "";

  if (status === 413) return "media_too_large";
  if (status === 429) return "rate_limited";

  // OpenAI / Gemini report quota exhaustion in a code or status string
  if (
    codes.includes("insufficient_quota") ||
    codes.includes("rate_limit_exceeded") ||
    /RESOURCE_EXHAUSTED/.test(message)
  ) {
    return "rate_limited";
  }

  if (status === 401 || status === 403 || (status === 400 && AUTH_MESSAGE_RE.test(message))) {
    return hasKey === false ? "not_configured" : "service_unavailable";
  }

  // A 2xx/3xx status next to an error means a bad body, not an HTTP failure: use the code
  if (status !== null && status >= 400) {
    if (status === 404 || status === 410) return userUrl ? "error" : "service_unavailable";
    if (status === 408 || status >= 500) return "service_unavailable";
    return "error";
  }

  if (codes.some((c) => NETWORK_CODES.has(c) || TLS_CODE_RE.test(c))) return "service_unavailable";
  if (names.some((n) => NETWORK_NAMES.has(n))) return "service_unavailable";
  // Node's fetch wraps network failures in a bare "fetch failed" TypeError
  if (/^fetch failed$/i.test(message) || /socket hang up|timed? ?out/i.test(message)) {
    return "service_unavailable";
  }

  return "error";
}

/**
 * Reject if `promise` (or the promise returned by a function) takes longer than `ms`.
 * The underlying work is not cancelled: pass an AbortSignal to it when it supports one.
 * @param {Promise<T>|(() => Promise<T>)} promise
 * @param {number} ms
 * @param {string} [label="operation"]
 * @returns {Promise<T>}
 * @throws {Error} with code "ETIMEDOUT"
 */
function withTimeout(promise, ms, label = "operation") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.code = "ETIMEDOUT";
      reject(err);
    }, ms);
  });
  const work = typeof promise === "function" ? Promise.resolve().then(promise) : Promise.resolve(promise);
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Strip anything that looks like a credential from a log line */
function redact(text) {
  return String(text)
    .replace(/((?:api[_-]?key|key|token|secret|password|authorization|client_secret)=)[^&\s"']+/gi, "$1***")
    .replace(/Bearer\s+[\w.\-~+/]+=*/gi, "Bearer ***")
    .replace(/\bsk-[\w\-*]{6,}/g, "sk-***")
    .replace(/\bAIza[\w\-]{20,}/g, "AIza***");
}

/**
 * Log-safe view of an error: never the axios config (it contains API keys).
 * @param {Error} err
 * @returns {{ message: string, status: number|undefined, code: string|undefined }}
 */
function safeLog(err) {
  if (!err || typeof err !== "object") return { message: redact(err), status: undefined, code: undefined };
  const status = err.response?.status ?? err.status ?? err.statusCode;
  const message = redact(typeof err.message === "string" ? err.message : String(err))
    .replace(/\s+/g, " ")
    .slice(0, 300);
  return {
    message,
    status: Number.isInteger(status) ? status : undefined,
    code: typeof err.code === "string" ? err.code : undefined,
  };
}

const REPLY_KEYS = {
  not_configured: "common.not_configured",
  rate_limited: "common.rate_limited",
  service_unavailable: "common.service_unavailable",
  media_too_large: "common.media_too_large",
  error: "common.error",
};

/**
 * Lang key for a classifyError() result.
 * @param {string} kind
 * @returns {string} e.g. "common.service_unavailable"
 */
function replyKeyFor(kind) {
  return REPLY_KEYS[kind] || REPLY_KEYS.error;
}

/**
 * Shortcut: lang key for an error (classifyError + replyKeyFor).
 * @param {Error} err
 * @param {Object} [opts] - Same options as classifyError
 * @returns {string}
 */
function replyKeyForError(err, opts) {
  return replyKeyFor(classifyError(err, opts));
}

module.exports = {
  fetchJson,
  fetchBuffer,
  classifyError,
  withTimeout,
  safeLog,
  replyKeyFor,
  replyKeyForError,
  scrubError,
};

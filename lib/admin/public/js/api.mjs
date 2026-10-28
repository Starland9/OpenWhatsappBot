// HTTP client of the panel (contracts/admin-http-api.md sections 1.6, 1.7, 1.9).
//
//  - the CSRF token lives in a closure variable (never in storage): it comes from AUTH-1, login, setup
//    and password-change answers (any JSON answer carrying a string `csrf` updates it);
//  - JSON in and out; every unsafe request carries `Content-Type: application/json`, even without a body
//    (an empty body is sent as `{}`);
//  - errors are parsed from the envelope `{ error: { code, fields, params, requestId } }` into ApiError,
//    never into prose (the SPA translates codes with i18n.mjs);
//  - 401 `session_expired` / `unauthenticated` are emitted as events so the app can warn about unsaved
//    input before redirecting to login.
//
// No DOM access at import time (node:test loads this file); fetch and XMLHttpRequest are injectable.

const SAFE_METHODS = new Set(["GET", "HEAD"]);

export class ApiError extends Error {
  constructor({ status = 0, code = "internal_error", fields = null, params = null, requestId = null, retryAfterMs = null } = {}) {
    super(code); // a code, never prose
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields && typeof fields === "object" ? fields : {};
    this.params = params && typeof params === "object" ? params : {};
    this.requestId = requestId;
    this.retryAfterMs = typeof retryAfterMs === "number" ? retryAfterMs : typeof this.params.retryAfterMs === "number" ? this.params.retryAfterMs : null;
  }
}

/** `?a=1&b=x` from an object; null, undefined and empty strings are skipped, arrays repeat the key. */
export function buildQuery(params) {
  if (!params || typeof params !== "object") return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) for (const item of value) search.append(key, String(item));
    else search.append(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

function headerOf(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

/** Turn a finished HTTP answer into its JSON body, or throw the matching ApiError. */
function interpret(status, text, getHeader) {
  let data;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  } else {
    data = null;
  }
  if (status >= 200 && status < 300) {
    if (data === undefined) throw new ApiError({ status, code: "invalid_response" });
    return data;
  }
  const envelope = data && typeof data === "object" ? data.error : null;
  if (envelope && typeof envelope.code === "string") {
    const retryHeader = Number(getHeader("Retry-After"));
    throw new ApiError({
      status,
      code: envelope.code,
      fields: envelope.fields,
      params: envelope.params,
      requestId: envelope.requestId || getHeader("X-Request-Id") || null,
      retryAfterMs: Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader * 1000 : null,
    });
  }
  throw new ApiError({ status, code: "invalid_response", requestId: getHeader("X-Request-Id") || null });
}

function filenameFrom(disposition, fallback) {
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition || "");
  const raw = match ? match[1] : fallback;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // keep the raw value
  }
  const clean = String(decoded || "download").split(/[\\/]/).pop().replace(/[\u0000-\u001f"<>:*?|]/g, "_");
  return clean || "download";
}

function saveBlobInBrowser(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/**
 * Build an API client. The default instance below is what the app uses; tests build their own with
 * `createApi({ fetch, XMLHttpRequest, saveBlob })`.
 */
export function createApi(options = {}) {
  let csrf = null;
  const handlers = new Map();

  const emit = (event, payload) => {
    for (const fn of [...(handlers.get(event) || [])]) {
      try {
        fn(payload);
      } catch {
        // a listener must never break a request
      }
    }
  };

  function on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(fn);
    return () => handlers.get(event).delete(fn);
  }

  function fail(err) {
    if (err.status === 401) {
      if (err.code === "session_expired") {
        csrf = null;
        emit("session_expired", err);
      } else if (err.code === "unauthenticated") {
        csrf = null;
        emit("unauthenticated", err);
      }
    }
    throw err;
  }

  function remember(data) {
    if (data && typeof data === "object" && typeof data.csrf === "string") csrf = data.csrf;
    return data;
  }

  const doFetch = (url, init) => (options.fetch || globalThis.fetch)(url, init);

  function buildRequest(method, path, body) {
    const verb = String(method || "GET").toUpperCase();
    const headers = { Accept: "application/json" };
    const init = { method: verb, headers, credentials: "same-origin", cache: "no-store" };
    let url = path;
    if (SAFE_METHODS.has(verb)) {
      // a plain object on a GET is its query string: api("GET", "/admin/api/logs", { since: 12 })
      const query = body && typeof body === "object" ? buildQuery(body) : "";
      if (query) url += (path.includes("?") ? "&" : "?") + query.slice(1);
    } else {
      headers["Content-Type"] = "application/json";
      if (csrf) headers["X-CSRF-Token"] = csrf;
      init.body = JSON.stringify(body === undefined || body === null ? {} : body);
    }
    return { url, init };
  }

  /** `api("POST", "/admin/api/restart", { confirm: true })`: resolves with the parsed JSON body. */
  async function api(method, path, body) {
    const { url, init } = buildRequest(method, path, body);
    let res;
    try {
      res = await doFetch(url, init);
    } catch {
      throw new ApiError({ status: 0, code: "network_error" });
    }
    let text = "";
    try {
      text = await res.text();
    } catch {
      throw new ApiError({ status: res.status, code: "network_error" });
    }
    try {
      return remember(interpret(res.status, text, (name) => headerOf(res.headers, name)));
    } catch (err) {
      return fail(err);
    }
  }

  /**
   * UP-1: `PUT /admin/api/uploads` with the raw file (XMLHttpRequest for progress).
   * `onProgress({ loaded, total, ratio })`; `{ signal }` aborts. Resolves with the 201 body.
   */
  function upload(file, purpose, name, onProgress, { signal } = {}) {
    return new Promise((resolve, reject) => {
      const XHR = options.XMLHttpRequest || globalThis.XMLHttpRequest;
      if (!XHR) {
        reject(new ApiError({ status: 0, code: "network_error" }));
        return;
      }
      const xhr = new XHR();
      const label = name || (file && file.name) || "";
      xhr.open("PUT", `/admin/api/uploads${buildQuery({ purpose, name: label })}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      if (csrf) xhr.setRequestHeader("X-CSRF-Token", csrf);
      xhr.responseType = "text";
      if (xhr.upload && typeof onProgress === "function") {
        xhr.upload.onprogress = (event) => {
          if (!event.lengthComputable) return;
          onProgress({ loaded: event.loaded, total: event.total, ratio: event.total ? event.loaded / event.total : 0 });
        };
      }
      xhr.onload = () => {
        try {
          resolve(remember(interpret(xhr.status, xhr.responseText || "", (n) => (xhr.getResponseHeader ? xhr.getResponseHeader(n) : null))));
        } catch (err) {
          try {
            fail(err);
          } catch (final) {
            reject(final);
          }
        }
      };
      xhr.onerror = () => reject(new ApiError({ status: 0, code: "network_error" }));
      xhr.ontimeout = () => reject(new ApiError({ status: 0, code: "network_error" }));
      xhr.onabort = () => reject(new ApiError({ status: 0, code: "aborted" }));
      if (signal) {
        if (signal.aborted) {
          reject(new ApiError({ status: 0, code: "aborted" }));
          return;
        }
        signal.addEventListener("abort", () => xhr.abort(), { once: true });
      }
      xhr.send(file);
    });
  }

  /**
   * Save an answer as a file (BAK-1 export, BAK-5 stored backup). The file name comes from
   * Content-Disposition, else `fallbackName`. A non-2xx answer is parsed as an ApiError.
   */
  async function download(method, path, body, fallbackName = "download") {
    const { url, init } = buildRequest(method, path, body);
    init.headers.Accept = "*/*";
    let res;
    try {
      res = await doFetch(url, init);
    } catch {
      throw new ApiError({ status: 0, code: "network_error" });
    }
    if (!res.ok) {
      let text = "";
      try {
        text = await res.text();
      } catch {
        // fall through with an empty body
      }
      try {
        interpret(res.status, text, (name) => headerOf(res.headers, name));
      } catch (err) {
        return fail(err);
      }
      return fail(new ApiError({ status: res.status, code: "invalid_response" }));
    }
    let blob;
    try {
      blob = await res.blob();
    } catch {
      throw new ApiError({ status: res.status, code: "network_error" });
    }
    const filename = filenameFrom(headerOf(res.headers, "Content-Disposition"), fallbackName);
    (options.saveBlob || saveBlobInBrowser)(blob, filename);
    return { filename, size: blob.size };
  }

  return {
    api,
    upload,
    download,
    on,
    setCsrf(token) {
      csrf = typeof token === "string" && token ? token : null;
    },
    getCsrf: () => csrf,
  };
}

const client = createApi();

export const api = client.api;
export const upload = client.upload;
export const download = client.download;
export const on = client.on;
export const setCsrf = client.setCsrf;
export const getCsrf = client.getCsrf;

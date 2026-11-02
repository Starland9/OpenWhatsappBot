"use strict";
/**
 * Render-loop guard for the view tests (contracts/panel-ui.md section 9). The 2026-10-30 incident: a fakeDom test
 * with a runaway render loop grew without bound and killed the machine and the editor. A loop has to stop at its
 * source, so this helper puts three caps under every view test:
 *
 *   const guard = createViewGuard({ preact, maxRequests = 150, maxPerRoute = 40, maxRenders = 600 });
 *   globalThis.fetch = guard.fetch({ "GET /admin/api/api": (body, search) => answer(200, {...}) });
 *   ...mount, click, dom.settle(6)...
 *   guard.assertClean();            throws, naming the cause and the counts, when a cap was hit
 *   guard.restore();                gives preact.options.debounceRendering back
 *
 *   guard.fetch(routes)   routes: { "METHOD /path": (body, search) => answer }; the returned function is what to assign
 *                         to globalThis.fetch. It throws on a request nobody scripted. Past maxRequests (all routes)
 *                         or maxPerRoute (one route) it records `tripped` and returns a promise that never resolves,
 *                         which halts an effect that re-fetches in a loop at its source.
 *   guard.requests        [{ key, search, body }], at most maxRequests entries
 *   guard.count(key)      requests recorded for "METHOD /path"
 *   guard.renders()       re-render batches counted
 *   guard.tripped()       null, "requests", "perRoute" or "renders" (the first cap that was hit)
 *   guard.assertClean()   throws when tripped
 *   guard.restore()       puts preact.options.debounceRendering back (idempotent)
 *
 * The render counter wraps `preact.options.debounceRendering` (a public Preact option): Preact calls it once per
 * scheduled re-render batch, so a loop of setState costs one count per turn. Past maxRenders the wrapper stops
 * scheduling (the queued batch is dropped), which freezes the render loop for good. Unmount the root BEFORE
 * restoring the option: a component that is no longer mounted is skipped when Preact flushes its old queue.
 *
 * `answer(status, body, headers)` builds the Response-like object the panel's api.mjs reads.
 */

/** A Response-like answer: `{ ok, status, headers: { get }, text(), blob() }` with a JSON body. */
function answer(status, body, headers = {}) {
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    text: async () => text,
    blob: async () => ({ size: text.length, text }),
  };
}

function createViewGuard({ preact, maxRequests = 150, maxPerRoute = 40, maxRenders = 600 } = {}) {
  if (!preact || !preact.options) throw new Error("createViewGuard: the Preact module is required");
  const requests = [];
  const counts = new Map();
  let total = 0;
  let renderBatches = 0;
  let cause = null;
  let restored = false;

  const trip = (name) => {
    if (cause === null) cause = name;
  };

  const original = preact.options.debounceRendering;
  const defer = (callback) => Promise.resolve().then(callback);
  preact.options.debounceRendering = (callback) => {
    if (cause === "renders") return; // frozen: the queued batch is dropped and never rescheduled
    renderBatches += 1;
    if (renderBatches > maxRenders) {
      trip("renders");
      return;
    }
    (original || defer)(callback);
  };

  const never = () => new Promise(() => {});

  const guard = {
    requests,
    fetch(routes = {}) {
      return async (url, init = {}) => {
        const method = String((init && init.method) || "GET").toUpperCase();
        const [path, search = ""] = String(url).split("?");
        const key = `${method} ${path}`;
        let body;
        if (init && init.body) {
          try {
            body = JSON.parse(init.body);
          } catch {
            body = init.body;
          }
        }
        total += 1;
        const per = (counts.get(key) || 0) + 1;
        counts.set(key, per);
        if (requests.length < maxRequests) requests.push({ key, search, body });
        if (total > maxRequests) {
          trip("requests");
          return never();
        }
        if (per > maxPerRoute) {
          trip("perRoute");
          return never();
        }
        if (!Object.hasOwn(routes, key)) throw new Error(`unexpected request ${key}`);
        return routes[key](body, search);
      };
    },
    count: (key) => counts.get(key) || 0,
    renders: () => renderBatches,
    tripped: () => cause,
    assertClean() {
      if (cause === null) return;
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      throw new Error(
        `view guard tripped on "${cause}": ${total} request(s) (cap ${maxRequests}), ${renderBatches} render batch(es) (cap ${maxRenders}), busiest route ${top ? `${top[0]} x${top[1]}` : "none"} (cap ${maxPerRoute})`,
      );
    },
    restore() {
      if (restored) return;
      restored = true;
      preact.options.debounceRendering = original;
    },
  };
  return guard;
}

module.exports = { createViewGuard, answer };

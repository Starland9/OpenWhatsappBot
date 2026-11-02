"use strict";

/**
 * Router of the public messaging API (feature 004, contracts/runtime.md section 15.5). A separate router, not a
 * generalisation of lib/admin/http/router.js (that one is welded to sessions, `/admin` and CSRF and its table is
 * pinned): two routers and two tables make FR-004 structural.
 *
 *   createApiRouter({ endpoints })
 *     .match(method, pathname)   -> { endpoint, params } | { allow: string[] } | null
 *     .table()                   -> [{ id, method, path }]
 *
 * Paths are literal segments and `:param` segments; no regular expression path. Every `:param` has its own pattern
 * (`endpoint.params[name]`) and the match is exact on the raw pathname (never decoded): a trailing slash, a doubled
 * slash, a different case or a parameter that does not match its pattern is no match. `{ allow }` is returned when
 * the path exists for other verbs only (the pipeline answers 405 + Allow after authentication). Two endpoints whose
 * paths could match the same URL with the same verb are refused at build (checked by shape: at each position
 * the segments are equal literals or at least one is a parameter), so a request never depends on load order.
 */

class ApiRouterError extends Error {
  constructor(endpoint, reason) {
    super(`API router: ${endpoint}: ${reason}`);
    this.name = "ApiRouterError";
    this.endpoint = endpoint;
    this.reason = reason;
  }
}

function compileRoute(endpoint) {
  const segments = String(endpoint.path)
    .split("/")
    .slice(1)
    .map((raw) => {
      if (raw.startsWith(":")) {
        const name = raw.slice(1);
        const pattern = endpoint.params && endpoint.params[name];
        if (!(pattern instanceof RegExp)) throw new ApiRouterError(endpoint.id, `parameter :${name} has no pattern`);
        return { param: name, pattern };
      }
      if (raw === "" || raw.includes(":")) throw new ApiRouterError(endpoint.id, `malformed path segment`);
      return { literal: raw };
    });
  return { endpoint, method: endpoint.method, segments };
}

/** Could both routes match one URL? (same verb, same length, each position equal literals or a parameter involved) */
function overlaps(a, b) {
  if (a.method !== b.method || a.segments.length !== b.segments.length) return false;
  return a.segments.every((segment, i) => {
    const other = b.segments[i];
    if (segment.param || other.param) return true;
    return segment.literal === other.literal;
  });
}

function createApiRouter({ endpoints = [] } = {}) {
  const routes = endpoints.map(compileRoute);
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      if (overlaps(routes[i], routes[j])) {
        throw new ApiRouterError(routes[j].endpoint.id, `path is ambiguous with ${routes[i].endpoint.id}`);
      }
    }
  }

  function matchPath(route, parts) {
    if (route.segments.length !== parts.length) return null;
    const params = {};
    for (let i = 0; i < parts.length; i++) {
      const segment = route.segments[i];
      if (segment.literal !== undefined) {
        if (segment.literal !== parts[i]) return null;
      } else {
        if (!segment.pattern.test(parts[i])) return null;
        params[segment.param] = parts[i];
      }
    }
    return params;
  }

  return {
    match(method, pathname) {
      const text = String(pathname || "");
      if (!text.startsWith("/")) return null;
      const parts = text.split("/").slice(1);
      const allow = [];
      for (const route of routes) {
        const params = matchPath(route, parts);
        if (!params) continue;
        if (route.method === method) return { endpoint: route.endpoint, params };
        if (!allow.includes(route.method)) allow.push(route.method);
      }
      return allow.length ? { allow: allow.sort() } : null;
    },

    table: () => routes.map(({ endpoint }) => ({ id: endpoint.id, method: endpoint.method, path: endpoint.path })),
  };
}

module.exports = { createApiRouter, ApiRouterError };

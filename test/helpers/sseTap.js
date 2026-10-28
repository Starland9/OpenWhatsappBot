"use strict";
/**
 * Streaming reader of the admin event stream for the tests of the dashboard and the logs (W-DASH).
 *
 *   const stream = await openEventStream({ port: t.port, client, target: "/admin/api/events?logs=1" });
 *   stream.events("state")            parsed frames { event, id, data, payload } of that event
 *   stream.frames()                   every complete frame (comments included)
 *   await stream.waitFor((s) => s.events("state").length >= 2)
 *   stream.text                       everything received so far (raw)
 *   stream.close()
 *
 * `client` is a cookie-jar client of test/helpers/adminClient.js: its cookies are sent as they are. The stream
 * is a plain `http.request`, so no header is added that a browser would not send (EventSource sends Cookie
 * and, on its own reconnects, Last-Event-ID: pass it in `headers`).
 */

const http = require("http");
const assert = require("node:assert/strict");
const fakes = require("./fakes");

/** The complete frames of an SSE text: { event, data, id, retry, comment, payload }. */
function parseFrames(text) {
  const complete = text.slice(0, text.lastIndexOf("\n\n") + 2);
  return complete
    .split("\n\n")
    .filter((block) => block.length)
    .map((block) => {
      const out = {};
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) {
          out.comment = line.slice(1);
          continue;
        }
        const at = line.indexOf(":");
        out[line.slice(0, at)] = line.slice(at + 1).trimStart();
      }
      if (out.data !== undefined) out.payload = JSON.parse(out.data);
      return out;
    });
}

const cookieHeader = (client) =>
  Object.entries(client ? client.cookies() : {})
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");

/** Open an event stream; resolves once the response head is there. */
function openEventStream({ port, client, target = "/admin/api/events", headers = {} }) {
  return new Promise((resolve, reject) => {
    const merged = { ...headers };
    const cookie = cookieHeader(client);
    if (cookie && merged.Cookie === undefined) merged.Cookie = cookie;
    const req = http.request({ host: "127.0.0.1", port, path: target, headers: merged, agent: false }, (res) => {
      res.setEncoding("utf8");
      const stream = {
        status: res.statusCode,
        headers: res.headers,
        text: "",
        ended: false,
        frames: () => parseFrames(stream.text),
        events: (name) => parseFrames(stream.text).filter((frame) => frame.event === name),
        close: () => req.destroy(),
        async waitFor(predicate, timeout = 3000) {
          const ok = await fakes.waitFor(() => predicate(stream), { timeout });
          if (!ok) assert.fail(`timeout; received so far: ${JSON.stringify(stream.text.slice(-500))}`);
        },
      };
      res.on("data", (chunk) => {
        stream.text += chunk;
      });
      for (const name of ["end", "close", "error"]) {
        res.on(name, () => {
          stream.ended = true;
        });
      }
      resolve(stream);
    });
    req.on("error", reject);
    req.end();
  });
}

module.exports = { openEventStream, parseFrames };

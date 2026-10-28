"use strict";
/**
 * T041: lib/utils/runtime.js (environment detection and bind resolution), with a fake `fs` and a
 * plain object as the environment: nothing here depends on the machine running the test.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const runtime = require("../lib/utils/runtime");

/** Fake fs: `files` maps an absolute path to its content; a path in `dirs` only exists */
function fakeFs({ files = {}, exists = [] } = {}) {
  const reads = [];
  return {
    reads,
    existsSync: (p) => exists.includes(p) || p in files,
    readFileSync: (p) => {
      reads.push(p);
      if (p in files) return files[p];
      const error = new Error(`ENOENT: ${p}`);
      error.code = "ENOENT";
      throw error;
    },
  };
}

const bare = fakeFs();
const docker = fakeFs({ exists: ["/.dockerenv"] });
const cgroup = (text) => fakeFs({ files: { "/proc/1/cgroup": text } });

// ---------------------------------------------------------------------------
// isContainer
// ---------------------------------------------------------------------------

test("isContainer: false on a bare host", () => {
  assert.equal(runtime.isContainer({ fs: bare, env: {} }), false);
});

test("isContainer: /.dockerenv", () => {
  assert.equal(runtime.isContainer({ fs: docker, env: {} }), true);
});

test("isContainer: /proc/1/cgroup naming docker, kubepods or containerd", () => {
  for (const line of [
    "12:cpu:/docker/3f2a9c",
    "0::/kubepods/besteffort/pod1234/abcd",
    "1:name=systemd:/system.slice/containerd.service",
    "0::/kubepods.slice/kubepods-burstable.slice",
  ]) {
    assert.equal(runtime.isContainer({ fs: cgroup(line), env: {} }), true, line);
  }
});

test("isContainer: an ordinary cgroup is not a container", () => {
  assert.equal(runtime.isContainer({ fs: cgroup("0::/user.slice/user-1000.slice/session-2.scope\n"), env: {} }), false);
  assert.equal(runtime.isContainer({ fs: cgroup("0::/\n"), env: {} }), false);
  assert.equal(runtime.isContainer({ fs: cgroup(""), env: {} }), false);
});

test("isContainer: the `container` variable (podman, systemd-nspawn)", () => {
  assert.equal(runtime.isContainer({ fs: bare, env: { container: "podman" } }), true);
  assert.equal(runtime.isContainer({ fs: bare, env: { container: "" } }), false);
});

test("isContainer: an fs that throws (no /proc, not readable) means false", () => {
  const broken = {
    existsSync() {
      throw new Error("EACCES");
    },
    readFileSync() {
      throw new Error("EACCES");
    },
  };
  assert.equal(runtime.isContainer({ fs: broken, env: {} }), false);
});

test("isContainer: the env check needs no file access", () => {
  const spy = fakeFs();
  assert.equal(runtime.isContainer({ fs: spy, env: { container: "docker" } }), true);
  assert.deepEqual(spy.reads, []);
});

// ---------------------------------------------------------------------------
// hasHostPort / isPanelHost
// ---------------------------------------------------------------------------

test("hasHostPort: PORT set", () => {
  assert.equal(runtime.hasHostPort({ env: { PORT: "8080" } }), true);
  assert.equal(runtime.hasHostPort({ env: { PORT: "" } }), false);
  assert.equal(runtime.hasHostPort({ env: {} }), false);
  assert.equal(runtime.hasHostPort({ env: { PANEL_PORT: "8080" } }), false);
});

test("isPanelHost: P_SERVER_UUID or SERVER_MEMORY", () => {
  assert.equal(runtime.isPanelHost({ env: { P_SERVER_UUID: "abc" } }), true);
  assert.equal(runtime.isPanelHost({ env: { SERVER_MEMORY: "512" } }), true);
  assert.equal(runtime.isPanelHost({ env: { SERVER_MEMORY: "" } }), false);
  assert.equal(runtime.isPanelHost({ env: { PORT: "8080" } }), false);
  assert.equal(runtime.isPanelHost({ env: {} }), false);
});

// ---------------------------------------------------------------------------
// detectSupervisor
// ---------------------------------------------------------------------------

test("detectSupervisor: nothing detected", () => {
  assert.deepEqual(runtime.detectSupervisor({ fs: bare, env: {} }), { kind: "none", supervised: false });
});

test("detectSupervisor: SUPERVISED=true|false is explicit and wins over everything", () => {
  const busy = { pm_id: "0", P_SERVER_UUID: "x", INVOCATION_ID: "y" };
  assert.deepEqual(runtime.detectSupervisor({ fs: docker, env: { ...busy, SUPERVISED: "true" } }), { kind: "env", supervised: true });
  assert.deepEqual(runtime.detectSupervisor({ fs: docker, env: { ...busy, SUPERVISED: "false" } }), { kind: "env", supervised: false });
  assert.deepEqual(runtime.detectSupervisor({ fs: bare, env: { SUPERVISED: " TRUE " } }), { kind: "env", supervised: true });
});

test("detectSupervisor: SUPERVISED=auto or junk falls through to the detection", () => {
  assert.deepEqual(runtime.detectSupervisor({ fs: bare, env: { SUPERVISED: "auto" } }), { kind: "none", supervised: false });
  assert.deepEqual(runtime.detectSupervisor({ fs: bare, env: { SUPERVISED: "yes", pm_id: "1" } }), { kind: "pm2", supervised: true });
  assert.deepEqual(runtime.detectSupervisor({ fs: bare, env: { SUPERVISED: "" } }), { kind: "none", supervised: false });
});

test("detectSupervisor: PM2 (pm_id defined, even 0) is supervised", () => {
  assert.deepEqual(runtime.detectSupervisor({ fs: bare, env: { pm_id: "0" } }), { kind: "pm2", supervised: true });
  assert.deepEqual(runtime.detectSupervisor({ fs: docker, env: { pm_id: "3", P_SERVER_UUID: "x" } }), { kind: "pm2", supervised: true });
});

test("detectSupervisor: a panel host is assumed supervised", () => {
  assert.deepEqual(runtime.detectSupervisor({ fs: bare, env: { P_SERVER_UUID: "x" } }), { kind: "panel-host", supervised: true });
  assert.deepEqual(runtime.detectSupervisor({ fs: docker, env: { SERVER_MEMORY: "512" } }), { kind: "panel-host", supervised: true });
});

test("detectSupervisor: a container is not supervised (depends on its restart policy)", () => {
  assert.deepEqual(runtime.detectSupervisor({ fs: docker, env: {} }), { kind: "container", supervised: false });
  assert.deepEqual(runtime.detectSupervisor({ fs: docker, env: { INVOCATION_ID: "z" } }), { kind: "container", supervised: false });
});

test("detectSupervisor: systemd (INVOCATION_ID) is not supervised unless SUPERVISED=true", () => {
  assert.deepEqual(runtime.detectSupervisor({ fs: bare, env: { INVOCATION_ID: "z" } }), { kind: "systemd", supervised: false });
  assert.deepEqual(runtime.detectSupervisor({ fs: bare, env: { INVOCATION_ID: "z", SUPERVISED: "true" } }), { kind: "env", supervised: true });
});

test("detectSupervisor: a bare PORT is not a supervisor", () => {
  assert.deepEqual(runtime.detectSupervisor({ fs: bare, env: { PORT: "8080" } }), { kind: "none", supervised: false });
});

// ---------------------------------------------------------------------------
// resolveBind (U1)
// ---------------------------------------------------------------------------

test("resolveBind: local run binds to loopback on 3000", () => {
  assert.deepEqual(runtime.resolveBind({ fs: bare, env: {} }), {
    host: "127.0.0.1",
    port: 3000,
    hostSource: "auto-local",
    portSource: "default",
  });
});

test("resolveBind: a container binds to all interfaces", () => {
  assert.deepEqual(runtime.resolveBind({ fs: docker, env: {} }), {
    host: "0.0.0.0",
    port: 3000,
    hostSource: "auto-container",
    portSource: "default",
  });
  assert.equal(runtime.resolveBind({ fs: cgroup("0::/docker/abc"), env: {} }).hostSource, "auto-container");
  assert.equal(runtime.resolveBind({ fs: bare, env: { container: "podman" } }).hostSource, "auto-container");
});

test("resolveBind: a host-allocated PORT binds to all interfaces and is the port", () => {
  assert.deepEqual(runtime.resolveBind({ fs: bare, env: { PORT: "8123" } }), {
    host: "0.0.0.0",
    port: 8123,
    hostSource: "auto-panel-host",
    portSource: "PORT",
  });
});

test("resolveBind: a container with PORT reports the container as the reason", () => {
  const bind = runtime.resolveBind({ fs: docker, env: { PORT: "9000" } });
  assert.equal(bind.host, "0.0.0.0");
  assert.equal(bind.hostSource, "auto-container");
  assert.equal(bind.port, 9000);
});

test("resolveBind: PANEL_HOST always wins, in a container and with PORT too", () => {
  assert.deepEqual(runtime.resolveBind({ fs: docker, env: { PANEL_HOST: "127.0.0.1", PORT: "8123" } }), {
    host: "127.0.0.1",
    port: 8123,
    hostSource: "explicit",
    portSource: "PORT",
  });
  assert.deepEqual(runtime.resolveBind({ fs: bare, env: { PANEL_HOST: "192.168.1.5" } }), {
    host: "192.168.1.5",
    port: 3000,
    hostSource: "explicit",
    portSource: "default",
  });
});

test("resolveBind: HOST is the second spelling, PANEL_HOST beats it", () => {
  assert.equal(runtime.resolveBind({ fs: bare, env: { HOST: "10.0.0.2" } }).host, "10.0.0.2");
  assert.equal(runtime.resolveBind({ fs: bare, env: { HOST: "10.0.0.2" } }).hostSource, "explicit");
  assert.equal(runtime.resolveBind({ fs: bare, env: { HOST: "10.0.0.2", PANEL_HOST: "::1" } }).host, "::1");
  assert.equal(runtime.resolveBind({ fs: docker, env: { PANEL_HOST: "   ", HOST: "" } }).hostSource, "auto-container", "blank is unset");
});

test("resolveBind: port is PANEL_PORT || PORT || 3000, with no drift", () => {
  assert.equal(runtime.resolveBind({ fs: bare, env: { PANEL_PORT: "4000", PORT: "5000" } }).port, 4000);
  assert.equal(runtime.resolveBind({ fs: bare, env: { PANEL_PORT: "4000", PORT: "5000" } }).portSource, "PANEL_PORT");
  assert.equal(runtime.resolveBind({ fs: bare, env: { PORT: "5000" } }).port, 5000);
  assert.equal(runtime.resolveBind({ fs: bare, env: {} }).port, 3000);
});

test("resolveBind: an unusable PANEL_PORT falls through like config.js does", () => {
  for (const bad of ["abc", "0", "-1", "70000", "80.5", "", "12abc"]) {
    const bind = runtime.resolveBind({ fs: bare, env: { PANEL_PORT: bad, PORT: "5000" } });
    assert.equal(bind.port, 5000, bad);
    assert.equal(bind.portSource, "PORT", bad);
  }
  const none = runtime.resolveBind({ fs: bare, env: { PANEL_PORT: "abc", PORT: "xyz" } });
  assert.equal(none.port, 3000);
  assert.equal(none.portSource, "default");
  assert.equal(runtime.resolveBind({ fs: bare, env: { PANEL_PORT: "65535" } }).port, 65535);
  assert.equal(runtime.resolveBind({ fs: bare, env: { PANEL_PORT: "1" } }).port, 1);
});

test("resolveBind reads the injected env only, and process.env by default", () => {
  const saved = { PANEL_HOST: process.env.PANEL_HOST, HOST: process.env.HOST };
  process.env.PANEL_HOST = "203.0.113.9";
  delete process.env.HOST;
  try {
    assert.equal(runtime.resolveBind({ fs: bare, env: {} }).host, "127.0.0.1", "the injected env is used alone");
    assert.equal(runtime.resolveBind({ fs: bare }).host, "203.0.113.9", "default env is process.env, read at call time");
    assert.equal(runtime.resolveBind().hostSource, "explicit");
  } finally {
    for (const [name, original] of Object.entries(saved)) {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  }
});

test("requiring runtime.js has no side effect", () => {
  assert.deepEqual(Object.keys(runtime).sort(), [
    "detectSupervisor",
    "hasHostPort",
    "isContainer",
    "isPanelHost",
    "resolveBind",
  ]);
});

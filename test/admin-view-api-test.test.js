"use strict";
/**
 * The Test tab and the Documentation tab of the API area (feature 004, contracts/panel-ui.md 7.10 and 7.11, tasks T106 and
 * T136). The Test tab renders the REAL descriptors of the format registry with the generic renderer and sends the body
 * `buildRequest` gives; media goes through a fake XMLHttpRequest. Render guards of viewGuard.js, one fixed number of turns.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { boot, realFormats, makeCatalog, makeState, makeKey, ok, fail } = require("./helpers/apiViewKit");
const { importPublic } = require("./helpers/fakeDom");

let kit;
let dom;
let i18n;
let ui;
let testTab;
let docsTab;
let formLogic;
const T = (key, params) => i18n.t(key, params);
const FORMATS = realFormats();
const UPLOAD_ID = "a".repeat(32);

before(async () => {
  kit = await boot();
  ({ dom, i18n, ui } = kit);
  testTab = await importPublic("js/views/api-test.mjs");
  docsTab = await importPublic("js/views/api-docs.mjs");
  formLogic = await importPublic("js/views/api-form-logic.mjs");
});
beforeEach(() => {
  ui.toastStore.set({ items: [] });
  FakeXHR.reset();
});
after(() => {
  dom.restore();
  i18n.__resetForTests();
  delete globalThis.fetch;
  delete globalThis.XMLHttpRequest;
  delete globalThis.location;
});

/** A minimal XMLHttpRequest for UP-1: records the request, can hold the answer, then resolves with the 201 body. */
class FakeXHR {
  static reset() {
    FakeXHR.instances = [];
    FakeXHR.hold = false;
    FakeXHR.refuse = null;
  }
  constructor() {
    this.upload = {};
    this.headers = {};
    FakeXHR.instances.push(this);
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name, value) {
    this.headers[name] = value;
  }
  getResponseHeader() {
    return null;
  }
  send(body) {
    this.body = body;
    this.finish = () => {
      this.status = FakeXHR.refuse ? 422 : 201;
      this.responseText = JSON.stringify(FakeXHR.refuse || { uploadId: UPLOAD_ID, purpose: "api", kind: "image", mime: "image/png", size: body.size, name: body.name, expiresAt: "2099-01-01T00:00:00.000Z" });
      this.onload();
    };
    if (!FakeXHR.hold) setTimeout(this.finish, 0);
  }
  abort() {}
}
FakeXHR.reset();

const file = (name = "photo.png", size = 1234) => ({ name, size });
const stateOf = (over = {}) => makeState({ stepUp: { confirmedUntil: null, windowMs: 300000 }, ...over });
const group = { jid: "120363025246125486@g.us", name: "Training", kind: "group" };
const chatsRoute = () => (body, query) => {
  const kind = new URLSearchParams(query).get("kind");
  const items = kind === "group" ? [group] : [];
  return ok({ items, page: 1, pageSize: 50, total: items.length });
};
const accepted = (over = {}) => ({ message: { id: 31, source: "panel", key: null, to: "237690000001@s.whatsapp.net", toName: null, kind: "private", format: "text", size: null, status: "queued", failureCode: null, acceptedAt: "2026-11-02T09:00:00.000Z", ...over } });

/** Mount the Test tab directly (no ApiView): a format preselected through the route query. */
function mountTest({ format, state = stateOf(), catalog = makeCatalog(), routes = {}, deps } = {}) {
  const query = format ? { tab: "test", format } : { tab: "test" };
  return kit.mount(kit.html`<${testTab.TestTab} catalog=${catalog} state=${state} route=${{ name: "api", rest: [], query }} deps=${deps} />`, {
    "GET /admin/api/chats": chatsRoute(),
    ...routes,
  });
}

const inputNamed = (t, name) => dom.byAttr(t.root, "name", name)[0];
async function type(el, value) {
  dom.type(el, String(value));
  await dom.settle(2);
}
const addButton = (t, path) => dom.find(t.root, (el) => el.localName === "button" && el.getAttribute("data-add") === path)[0];
const removeButton = (t, path) => dom.find(t.root, (el) => el.localName === "button" && el.getAttribute("data-remove") === path)[0];
const submit = (t) => dom.click(t.find.button(T("api.test_submit")));

/** Fill the form of a descriptor from a flat body through the controls only, like a person would. */
async function fill(t, descriptor, body) {
  async function fillField(field, parts, value) {
    const name = `api-${parts.join("-")}`;
    if (value === undefined) return;
    if (field.type === "recipient") {
      if (String(value).endsWith("@g.us")) {
        dom.check(dom.find(t.root, (el) => el.localName === "input" && el.getAttribute("type") === "radio" && el.getAttribute("name") === "api-test-to-kind")[1], true);
        await t.settle(4);
        dom.check(dom.find(t.root, (el) => el.localName === "input" && (el.getAttribute("aria-label") || "") === T("api.groups_pick", { group: "Training" }))[0], true);
        await t.settle(3);
      } else {
        await type(inputNamed(t, "api-test-to-number"), value);
      }
      return;
    }
    if (field.type === "boolean") {
      dom.check(inputNamed(t, name), Boolean(value));
      await dom.settle(2);
      return;
    }
    if (field.type === "select") {
      dom.choose(dom.byAttr(t.root, "name", name, "select")[0], String(value));
      await dom.settle(2);
      return;
    }
    if (field.type === "list") {
      const rows = Array.isArray(value) ? value : [];
      const have = () => dom.find(t.root, (el) => el.getAttribute("data-remove") !== null && el.getAttribute("data-remove").startsWith(`${parts.join(".")}.`) && el.getAttribute("data-remove").split(".").length === parts.length + 1).length;
      while (have() < rows.length) {
        dom.click(addButton(t, parts.join(".")));
        await dom.settle(2);
      }
      for (let index = 0; index < rows.length; index += 1) {
        if (field.items && field.items.fields) for (const child of field.items.fields) await fillField(child, [...parts, String(index), child.name], rows[index][child.name]);
        else await fillField(field.item || { type: "text" }, [...parts, String(index)], rows[index]);
      }
      return;
    }
    await type(inputNamed(t, name), value);
  }
  for (const field of descriptor.fields) await fillField(field, [field.name], body[field.name]);
}

// ===========================================================================
// The Test tab: the 13 real descriptors
// ===========================================================================

describe("TestTab: the descriptors of the registry", () => {
  for (const descriptor of FORMATS) {
    test(`${descriptor.name}: every field is rendered and the exact body of buildRequest is sent`, async () => {
      globalThis.XMLHttpRequest = FakeXHR;
      const t = mountTest({ format: descriptor.name, routes: { "POST /admin/api/api/test": () => ok(accepted({ format: descriptor.name }), 202) } });
      try {
        await t.settle(5);
        for (const key of formLogic.panelKeysOfDescriptor(descriptor).slice(0, 6)) assert.ok(i18n.hasKey(key), `${key} exists`);
        assert.ok(t.find.has(T(descriptor.descKey)));
        for (const field of descriptor.fields) assert.ok(t.find.has(T(field.labelKey)), `label of ${field.name}`);
        const example = formLogic.exampleBody(descriptor);
        await fill(t, descriptor, example);
        let uploadId;
        if (descriptor.media) {
          const input = dom.byAttr(t.root, "type", "file", "input")[0];
          assert.equal(input.getAttribute("accept"), descriptor.media.accept.join(","));
          input.files = [file()];
          dom.fire(input, "change");
          await t.settle(6);
          uploadId = UPLOAD_ID;
        }
        submit(t);
        await t.settle(6);
        const sent = t.guard.requests.find((r) => r.key === "POST /admin/api/api/test");
        assert.ok(sent, "the test message was sent");
        assert.deepEqual(sent.body, formLogic.buildRequest(descriptor, formLogic.valuesFromBody(descriptor, example), { uploadId }));
        assert.equal(sent.body.format, descriptor.name);
        assert.ok(t.find.has(T("api.test_queued", { id: 31 })), "the result card shows the accepted message");
      } finally {
        t.done();
      }
    });
  }

  test("an empty form shows the courtesy errors and sends nothing", async () => {
    const t = mountTest({ format: "buttons", routes: { "POST /admin/api/api/test": () => ok(accepted(), 202) } });
    try {
      await t.settle(5);
      submit(t);
      await t.settle(3);
      assert.equal(t.guard.count("POST /admin/api/api/test"), 0);
      assert.ok(dom.find(t.root, (el) => el.getAttribute("role") === "alert" && dom.text(el) === T("fields.required")).length >= 3, "to, text and the button fields");
    } finally {
      t.done();
    }
  });
});

describe("RepeatedItems", () => {
  test("Add and Remove stop at max and min; the row keys are stable, so a removal keeps the other rows' inputs", async () => {
    const t = mountTest({ format: "buttons" });
    try {
      await t.settle(5);
      assert.equal(removeButton(t, "buttons.0").prop("disabled"), true, "min 1: the only row cannot go");
      for (let i = 0; i < 2; i += 1) {
        dom.click(addButton(t, "buttons"));
        await t.settle(2);
      }
      assert.equal(addButton(t, "buttons").prop("disabled"), true, "max 3");
      for (const [index, id] of ["a", "b", "c"].entries()) await type(inputNamed(t, `api-buttons-${index}-id`), id);
      const third = inputNamed(t, "api-buttons-2-id");
      dom.click(removeButton(t, "buttons.1"));
      await t.settle(3);
      assert.equal(addButton(t, "buttons").prop("disabled"), false);
      assert.equal(inputNamed(t, "api-buttons-0-id").value, "a");
      assert.equal(inputNamed(t, "api-buttons-1-id").value, "c");
      assert.equal(inputNamed(t, "api-buttons-1-id"), third, "the input of the third row survived the removal (stable row key)");
      assert.ok(t.find.has(T("api.form_list_row", { label: T("api.format.buttons.field.buttons.label"), n: 2 })));
    } finally {
      t.done();
    }
  });
});

describe("MediaField", () => {
  const image = () => mountTest({ format: "image", routes: { "POST /admin/api/api/test": () => ok(accepted({ format: "image" }), 202) } });
  const pick = async (t, name = "photo.png", size = 1234) => {
    const input = dom.byAttr(t.root, "type", "file", "input")[0];
    input.files = [file(name, size)];
    dom.fire(input, "change");
    await t.settle(6);
  };

  test("a file is uploaded with purpose=api, the progress shows, the size is pre-checked, the type is left to the server", async () => {
    globalThis.XMLHttpRequest = FakeXHR;
    FakeXHR.hold = true;
    const t = image();
    try {
      await t.settle(5);
      await type(inputNamed(t, "api-test-to-number"), "237690000001");
      const input = dom.byAttr(t.root, "type", "file", "input")[0];
      input.files = [file("big.png", 99999999)];
      dom.fire(input, "change");
      await t.settle(3);
      assert.ok(t.find.has(T("api.media_too_large", { max: i18n.formatBytes(16777216) })));
      assert.equal(FakeXHR.instances.length, 0, "an oversized file is never uploaded");
      input.files = [file("photo.png", 1234)];
      dom.fire(input, "change");
      await t.settle(3);
      const xhr = FakeXHR.instances[0];
      assert.equal(xhr.method, "PUT");
      assert.ok(xhr.url.startsWith("/admin/api/uploads?") && xhr.url.includes("purpose=api") && xhr.url.includes("name=photo.png"), xhr.url);
      xhr.upload.onprogress({ lengthComputable: true, loaded: 30, total: 100 });
      await t.settle(3);
      const bar = dom.find(t.root, (el) => el.localName === "progress")[0];
      assert.equal(Number(bar.getAttribute("value") ?? bar.value), 0.3);
      assert.equal(t.find.button(T("api.test_submit")).prop("disabled"), true, "no send while the file is on its way");
      xhr.finish();
      await t.settle(4);
      assert.ok(t.find.has("photo.png") && t.find.has(T("api.media_remove")));
      assert.equal(dom.find(t.root, (el) => el.localName === "progress").length, 0);
    } finally {
      t.done();
    }
  });

  test("the upload is kept after a refusal, cleared after the 202 (consumed, no DELETE), and the next send needs a new file", async () => {
    globalThis.XMLHttpRequest = FakeXHR;
    let answers = [fail(409, "chat_disabled"), ok(accepted({ format: "image" }), 202)];
    const t = mountTest({ format: "image", routes: { "POST /admin/api/api/test": () => answers.shift(), [`DELETE /admin/api/uploads/${UPLOAD_ID}`]: () => ok({}) } });
    try {
      await t.settle(5);
      await type(inputNamed(t, "api-test-to-number"), "237690000001");
      await pick(t);
      submit(t);
      await t.settle(5);
      assert.ok(t.find.has("photo.png"), "kept after the refusal");
      assert.ok(ui.toastStore.get().items.some((item) => item.kind === "error"), "the refusal is toasted");
      submit(t);
      await t.settle(5);
      assert.equal(t.guard.requests.filter((r) => r.key === "POST /admin/api/api/test").length, 2);
      assert.ok(t.find.has(T("api.media_none")), "cleared after the acceptance");
      assert.equal(t.guard.count(`DELETE /admin/api/uploads/${UPLOAD_ID}`), 0, "a consumed upload is not deleted");
      submit(t);
      await t.settle(3);
      assert.equal(t.guard.requests.filter((r) => r.key === "POST /admin/api/api/test").length, 2, "a file is required again");
    } finally {
      t.done();
    }
  });

  test("Remove, a format change and the unmount each delete the upload (best effort)", async () => {
    globalThis.XMLHttpRequest = FakeXHR;
    const routes = { [`DELETE /admin/api/uploads/${UPLOAD_ID}`]: () => fail(404, "not_found") };
    const removed = image();
    removed.guard.requests.length = 0;
    try {
      await removed.settle(5);
      await pick(removed);
      globalThis.fetch = removed.guard.fetch({ ...routes });
      dom.click(removed.find.button(T("api.media_remove")));
      await removed.settle(4);
      assert.equal(removed.guard.count(`DELETE /admin/api/uploads/${UPLOAD_ID}`), 1);
      assert.ok(removed.find.has(T("api.media_none")), "a failed delete changes nothing for the owner");
    } finally {
      removed.done();
    }
    const changed = mountTest({ format: "image", routes });
    try {
      await changed.settle(5);
      await pick(changed);
      dom.choose(dom.byAttr(changed.root, "name", "api-test-format", "select")[0], "text");
      await changed.settle(4);
      assert.equal(changed.guard.count(`DELETE /admin/api/uploads/${UPLOAD_ID}`), 1);
      assert.ok(changed.find.has(T("api.format.text.field.text.label")));
    } finally {
      changed.done();
    }
    const left = mountTest({ format: "image", routes });
    await left.settle(5);
    await pick(left);
    const guard = left.guard;
    left.done();
    assert.equal(guard.count(`DELETE /admin/api/uploads/${UPLOAD_ID}`), 1, "leaving the tab deletes it");
  });

  test("the URL source sends media: { url } and no upload id", async () => {
    const t = image();
    try {
      await t.settle(5);
      await type(inputNamed(t, "api-test-to-number"), "237690000001");
      dom.check(dom.byAttr(t.root, "name", "api-media-source", "input")[1], true);
      await t.settle(3);
      await type(inputNamed(t, "api-media-url"), "https://files.example.org/receipt.png");
      submit(t);
      await t.settle(5);
      const body = t.guard.requests.find((r) => r.key === "POST /admin/api/api/test").body;
      assert.deepEqual(body, { format: "image", to: "237690000001", media: { url: "https://files.example.org/receipt.png" } });
    } finally {
      t.done();
    }
  });
});

describe("TestTab: server answers", () => {
  test("fields land under their dotted paths; unknown paths are listed under the summary", async () => {
    const t = mountTest({
      format: "buttons",
      routes: {
        "POST /admin/api/api/test": () => fail(422, "validation_failed", { fields: { "buttons.1.id": { code: "duplicate" }, "buttons.0.label": { code: "too_long", params: { max: 20 } }, "$unknown": { code: "unknown_field" }, "zzz.path": { code: "invalid_type" } } }),
      },
    });
    try {
      await t.settle(5);
      await fill(t, FORMATS.find((f) => f.name === "buttons"), formLogic.exampleBody(FORMATS.find((f) => f.name === "buttons")));
      submit(t);
      await t.settle(5);
      const rowOf = (n) => dom.find(t.root, (el) => el.localName === "fieldset" && dom.text(el).includes(T("api.form_list_row", { label: T("api.format.buttons.field.buttons.label"), n })))[0];
      assert.ok(dom.text(rowOf(2)).includes(T("fields.duplicate")), "buttons.1.id under row 2");
      assert.ok(dom.text(rowOf(1)).includes(T("fields.too_long", { max: 20 })), "buttons.0.label under row 1");
      const summary = dom.find(t.root, (el) => el.getAttribute("role") === "alert" && dom.text(el).includes(T("api.test_other_errors")))[0];
      assert.ok(summary && dom.text(summary).includes("$unknown") && dom.text(summary).includes("zzz.path"));
      assert.deepEqual(ui.toastStore.get().items.filter((item) => item.kind === "error"), [], "a validation failure is not toasted");
    } finally {
      t.done();
    }
  });

  test("api_disabled, chat_disabled and queue_full are toasted with their own text", async () => {
    for (const [status, code, params] of [[409, "api_disabled", { reason: "switch_off" }], [409, "chat_disabled", {}], [503, "queue_full", { scope: "global", retryAfterMs: 30000 }]]) {
      ui.toastStore.set({ items: [] });
      const t = mountTest({ format: "text", routes: { "POST /admin/api/api/test": () => fail(status, code, { params }) } });
      try {
        await t.settle(5);
        await type(inputNamed(t, "api-test-to-number"), "237690000001");
        await type(inputNamed(t, "api-text"), "hello");
        submit(t);
        await t.settle(4);
        const expected = i18n.tError(new kit.apiModule.ApiError({ status, code, params }));
        assert.ok(ui.toastStore.get().items.some((item) => item.kind === "error" && item.message === expected), `${code}: ${expected}`);
      } finally {
        t.done();
      }
    }
  });

  test("the result card follows the message: Refresh polls now, the link opens the detail, the id can be copied", async () => {
    let status = "queued";
    const t = mountTest({
      format: "text",
      routes: {
        "POST /admin/api/api/test": () => ok(accepted(), 202),
        "GET /admin/api/api/messages/31": () => ok({ message: { ...accepted({ status }).message, steps: [{ status: "queued", at: "2026-11-02T09:00:00.000Z" }, { status: "sent", at: "2026-11-02T09:00:04.000Z" }], interactive: false, responses: null, publicId: "msg_x", waId: null, expiresAt: "2026-11-02T09:10:00.000Z" } }),
      },
    });
    try {
      await t.settle(5);
      await type(inputNamed(t, "api-test-to-number"), "237690000001");
      await type(inputNamed(t, "api-text"), "hello");
      submit(t);
      await t.settle(5);
      assert.ok(t.find.has(T("api.test_result_title")) && t.find.has(T("api.msg_status.queued")) && t.find.has(T("api.watch_live")));
      assert.ok(dom.find(t.root, (el) => el.localName === "a" && el.getAttribute("href") === "#/api/history/31").length === 1);
      assert.equal(t.guard.count("GET /admin/api/api/messages/31"), 0, "the first poll waits");
      status = "sent";
      dom.click(dom.byText(t.root, T("api.watch_refresh"), "button")[0]);
      await t.settle(5);
      assert.equal(t.guard.count("GET /admin/api/api/messages/31"), 1);
      assert.ok(t.find.has(T("api.msg_status.sent")));
    } finally {
      t.done();
    }
  });

  test("the API off disables the send with its notice; a bot offline only warns; a registry failure leaves nothing to render", async () => {
    const off = mountTest({ state: stateOf({ enabled: false }) });
    try {
      await off.settle(5);
      assert.ok(off.find.has(T("api.test_disabled")));
      assert.equal(off.find.button(T("api.test_submit")).prop("disabled"), true);
    } finally {
      off.done();
    }
    const offline = mountTest({ state: stateOf({ botReady: false }) });
    try {
      await offline.settle(5);
      assert.ok(offline.find.has(T("api.test_bot_offline", { minutes: 10 })));
      assert.equal(offline.find.button(T("api.test_submit")).prop("disabled"), false);
    } finally {
      offline.done();
    }
    const broken = mountTest({ state: stateOf({ failure: { code: "registry_failed", endpoint: "messages.create" } }), catalog: makeCatalog({ formats: [], rights: [], endpoints: [] }) });
    try {
      await broken.settle(5);
      assert.ok(broken.find.has(T("api.state_registry_failed", { endpoint: "messages.create" })));
    } finally {
      broken.done();
    }
  });

  test("the curl preview uses $OWB_KEY and @./file, never a key; the URL source uses the placeholder", async () => {
    globalThis.XMLHttpRequest = FakeXHR;
    const t = mountTest({ format: "image" });
    try {
      await t.settle(5);
      await type(inputNamed(t, "api-test-to-number"), "237690000001");
      const preview = () => dom.text(dom.find(t.root, (el) => el.localName === "pre")[0]);
      assert.ok(preview().includes('curl -X POST "https://bot.example.org/api/v1/messages"') && preview().includes("Authorization: Bearer $OWB_KEY"), preview());
      assert.ok(preview().includes("file=@./file"));
      const input = dom.byAttr(t.root, "type", "file", "input")[0];
      input.files = [file("receipt.png")];
      dom.fire(input, "change");
      await t.settle(6);
      assert.ok(preview().includes("file=@./receipt.png"));
      assert.ok(!/owbk_/.test(preview()));
      dom.check(dom.byAttr(t.root, "name", "api-media-source", "input")[1], true);
      await t.settle(3);
      assert.ok(preview().includes("<url of the file>") && !preview().includes("-F"));
    } finally {
      t.done();
    }
  });
});

// ===========================================================================
// The Documentation tab
// ===========================================================================

describe("DocsTab", () => {
  const mountDocs = ({ state = makeState(), catalog = makeCatalog(), deps } = {}) =>
    kit.mount(kit.html`<${docsTab.DocsTab} catalog=${catalog} state=${state} route=${{ name: "api", rest: [], query: { tab: "docs" } }} deps=${deps} />`, {});

  test("quick start: four steps, the base address of the state, a text example", async () => {
    const t = mountDocs({ state: makeState({ baseUrl: "https://panel.example.net/api/v1" }) });
    try {
      await t.settle(4);
      for (const key of ["api.docs_quick_title", "api.docs_step_enable", "api.docs_step_create", "api.docs_step_copy", "api.docs_step_send", "api.docs_auth_text", "api.docs_idempotency_text", "api.docs_limits_text", "api.docs_errors_text", "api.docs_status_text", "api.docs_replies_text"]) assert.ok(t.find.has(T(key)), key);
      assert.ok(t.find.has("https://panel.example.net/api/v1"));
      const first = dom.text(dom.find(t.root, (el) => el.localName === "pre")[0]);
      assert.ok(first.includes('curl -X POST "https://panel.example.net/api/v1/messages"') && first.includes('"format":"text"'), first);
      assert.ok(!t.find.has(T("api.docs_http_warning")));
    } finally {
      t.done();
    }
    globalThis.location = { protocol: "http:", hostname: "bot.example.org", hash: "" };
    const insecure = mountDocs();
    try {
      await insecure.settle(4);
      assert.ok(insecure.find.has(T("api.docs_http_warning")));
    } finally {
      insecure.done();
      delete globalThis.location;
    }
  });

  test("the endpoints table shows the English summary as is and collapses the thirteen send rights", async () => {
    const t = mountDocs();
    try {
      await t.settle(4);
      const create = dom.text(dom.find(t.root, (el) => el.localName === "tr" && dom.text(el).includes("Send a message."))[0]);
      assert.ok(create.includes(T("api.docs_rights_send")) && !create.includes("messages.send.text"));
      assert.ok(create.includes("POST") && create.includes("/api/v1/messages"));
      const read = dom.text(dom.find(t.root, (el) => el.localName === "tr" && dom.text(el).includes("Read a message."))[0]);
      assert.ok(read.includes("messages.read"));
      assert.ok(t.find.has(T("api.docs_english_note")));
    } finally {
      t.done();
    }
  });

  test("one example per format: JSON without media, multipart with it, a second URL block where media.url is allowed, a Try it link", async () => {
    const t = mountDocs();
    try {
      await t.settle(4);
      const blocks = dom.find(t.root, (el) => el.localName === "pre").map((el) => dom.text(el));
      const mediaFormats = FORMATS.filter((f) => f.media);
      const urlBlocks = mediaFormats.filter((f) => f.media.sources.includes("url"));
      assert.equal(blocks.length, 1 + FORMATS.length + urlBlocks.length, "quick start + one per format + a URL block per media format");
      assert.equal(blocks.filter((text) => text.includes("-F '")).length, mediaFormats.length);
      assert.ok(blocks.filter((text) => text.includes("<url of the file>")).length === urlBlocks.length);
      assert.equal(blocks.filter((text) => text.includes('-H "Content-Type: application/json"')).length, 1 + (FORMATS.length - mediaFormats.length) + urlBlocks.length);
      const links = dom.find(t.root, (el) => el.localName === "a" && (el.getAttribute("href") || "").startsWith("#/api?tab=test&format=")).map((el) => el.getAttribute("href"));
      assert.deepEqual(links, FORMATS.map((f) => `#/api?tab=test&format=${f.name}`));
      assert.ok(t.find.has(T("api.docs_file_note")) && t.find.has(T("api.docs_url_note")));
    } finally {
      t.done();
    }
  });

  test("Copy writes the block; without a clipboard the text is selected with the guarded Selection API and the hint shows", async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const t = mountDocs();
    try {
      await t.settle(4);
      let copied = null;
      Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async (text) => { copied = text; } } }, configurable: true, writable: true });
      dom.click(dom.byText(t.root, T("api.docs_copy_block"), "button")[0]);
      await t.settle(3);
      assert.ok(copied && copied.includes("curl -X POST"));
      assert.ok(t.find.has(T("api.docs_copied")));
      // no clipboard: the Selection API when it exists, nothing breaks when it does not
      Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });
      dom.click(dom.byText(t.root, T("api.docs_copy_block"), "button")[1]);
      await t.settle(3);
      assert.ok(t.find.has(T("api.copy_manual")), "guarded: no Selection API in this DOM, still no error");
      const ranges = [];
      globalThis.getSelection = () => ({ removeAllRanges() {}, addRange: (range) => ranges.push(range) });
      document.createRange = () => ({ selectNodeContents(node) { this.node = node; } });
      dom.click(dom.byText(t.root, T("api.docs_copy_block"), "button")[2]);
      await t.settle(3);
      assert.equal(ranges.length, 1);
      assert.equal(ranges[0].node.localName, "pre");
    } finally {
      t.done();
      delete globalThis.getSelection;
      delete document.createRange;
      if (saved) Object.defineProperty(globalThis, "navigator", saved);
      else delete globalThis.navigator;
    }
  });

  test("the download calls API-13 with the fallback file name; the server's Content-Disposition name is the client's job", async () => {
    const calls = [];
    const t = mountDocs({ deps: { download: async (...args) => { calls.push(args); return { filename: "openwhatsappbot-api-v1.openapi.json", size: 10 }; } } });
    try {
      await t.settle(4);
      dom.click(t.find.button(T("api.docs_download")));
      await t.settle(3);
      assert.deepEqual(calls, [["GET", "/admin/api/api/openapi", undefined, "openwhatsappbot-api-v1.openapi.json"]]);
    } finally {
      t.done();
    }
  });

  test("a 14th format appears in the Docs, the key rights and the Test form with no edit of the SPA (SC-009)", async () => {
    const demo = {
      name: "sparkle", right: "messages.send.sparkle", interactive: false, order: 140, labelKey: "api.format.sparkle.label", descKey: "api.format.sparkle.desc", media: null,
      example: { format: "sparkle", to: "237690000001", glitter: "high" },
      fields: [
        { name: "to", type: "recipient", required: true, labelKey: "api.format.common.field.to.label", hintKey: "api.format.common.field.to.hint" },
        { name: "glitter", type: "select", required: true, labelKey: "api.format.sparkle.field.glitter.label", options: [{ value: "low", labelKey: "api.format.sparkle.field.glitter.option.low" }, { value: "high", labelKey: "api.format.sparkle.field.glitter.option.high" }] },
      ],
    };
    const catalog = makeCatalog({ formats: [...FORMATS, demo] });
    const docs = mountDocs({ catalog });
    try {
      await docs.settle(4);
      assert.ok(dom.find(docs.root, (el) => el.localName === "pre" && dom.text(el).includes('"format":"sparkle"')).length === 1);
      assert.ok(dom.find(docs.root, (el) => el.localName === "a" && el.getAttribute("href") === "#/api?tab=test&format=sparkle").length === 1);
    } finally {
      docs.done();
    }
    const test = mountTest({ format: "sparkle", catalog, routes: { "POST /admin/api/api/test": () => ok(accepted({ format: "sparkle" }), 202) } });
    try {
      await test.settle(5);
      assert.ok(dom.byAttr(test.root, "name", "api-glitter", "select").length === 1, "the generic renderer made the select");
      await type(inputNamed(test, "api-test-to-number"), "237690000001");
      submit(test);
      await test.settle(5);
      assert.deepEqual(test.guard.requests.find((r) => r.key === "POST /admin/api/api/test").body, { format: "sparkle", to: "237690000001", glitter: "low" });
    } finally {
      test.done();
    }
    const view = await importPublic("js/views/api.mjs");
    const editor = kit.mount(kit.html`<${view.default} route=${{ name: "api", rest: ["keys", "new"], query: {} }} />`, {
      "GET /admin/api/api": () => ok(makeState()),
      "GET /admin/api/api/catalog": () => ok(catalog),
      "GET /admin/api/api/keys": () => ok({ items: [makeKey(1)] }),
      "GET /admin/api/chats": chatsRoute(),
    });
    try {
      await editor.settle(6);
      assert.ok(dom.byAttr(editor.root, "name", "messages.send.sparkle", "input").length === 1, "the new right is a checkbox, unticked");
    } finally {
      editor.done();
    }
  });
});

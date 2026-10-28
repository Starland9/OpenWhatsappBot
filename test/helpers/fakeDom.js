"use strict";
/**
 * A very small DOM for rendering the panel's Preact views under node:test (no browser, no jsdom): just enough of
 * Node / Element / Text for Preact's diff, plus the queries and the user gestures a view test needs.
 *
 *   const dom = await createDom();                 installs globalThis.document, makes the effects flush quickly
 *   const root = dom.mount(vnode);                 renders into a fresh container, returns it
 *   await dom.settle();                            lets state updates and effects (and pending promises) run
 *   dom.text(root)                                 the visible text of a subtree
 *   dom.find(root, (el) => ...) / dom.byText(root, "Save", "button") / dom.byAttr(root, "name", "PREFIX")
 *   dom.click(el) / dom.type(el, "text") / dom.check(el, true) / dom.choose(select, "value")
 *   dom.unmount(root) / dom.restore()
 *
 * Only what the views use is implemented; an unsupported call throws rather than pretending.
 */

const path = require("path");
const { pathToFileURL } = require("url");

const PUBLIC = path.resolve(__dirname, "..", "..", "lib", "admin", "public");
const importPublic = (relative) => import(pathToFileURL(path.join(PUBLIC, relative)).href);

class FakeNode {
  constructor() {
    this.childNodes = [];
    this.parentNode = null;
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  appendChild(child) {
    return this.insertBefore(child, null);
  }
  insertBefore(child, before) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    this.childNodes.splice(index === -1 ? this.childNodes.length : index, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index === -1) throw new Error("removeChild: not a child");
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
}

class FakeText extends FakeNode {
  constructor(data) {
    super();
    this.nodeType = 3;
    this.data = String(data);
  }
}

class FakeElement extends FakeNode {
  constructor(name, namespaceURI) {
    super();
    this.nodeType = 1;
    this.localName = name;
    this.nodeName = name.toUpperCase();
    this.namespaceURI = namespaceURI;
    this.attrs = new Map();
    this.listeners = new Map();
    this.style = {};
    // properties Preact assigns directly (everything else goes through setAttribute)
    if (["input", "textarea", "select", "option"].includes(name)) {
      this.value = "";
      this.checked = false;
      this.selected = false;
      this.disabled = false;
    } else if (name === "button") {
      this.disabled = false;
    }
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  removeAttribute(name) {
    this.attrs.delete(name);
  }
  get attributes() {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }
  // Preact registers "onClick" as "Click" when the element has no `onclick` property and later looks the handler up by
  // `event.type`: names are matched case-insensitively here, and the event carries the spelling it was registered with
  addEventListener(type, fn) {
    const name = String(type).toLowerCase();
    if (!this.listeners.has(name)) this.listeners.set(name, new Map());
    this.listeners.get(name).set(fn, String(type));
  }
  removeEventListener(type, fn) {
    const name = String(type).toLowerCase();
    if (this.listeners.has(name)) this.listeners.get(name).delete(fn);
  }
  /** The attribute, or the property Preact assigned (value, checked, disabled...) */
  prop(name) {
    return name in this && name !== "attrs" ? this[name] : this.getAttribute(name);
  }
}

function walk(node, visit) {
  if (visit(node) === false) return;
  for (const child of node.childNodes) walk(child, visit);
}

async function createDom() {
  const previous = { document: globalThis.document };
  const document = {
    createElementNS: (ns, name) => new FakeElement(name, ns),
    createElement: (name) => new FakeElement(name, "http://www.w3.org/1999/xhtml"),
    createTextNode: (text) => new FakeText(text),
    documentElement: new FakeElement("html", "http://www.w3.org/1999/xhtml"),
  };
  globalThis.document = document;

  const preact = await importPublic("vendor/preact.mjs");
  // effects run on the next tick instead of after a 100 ms animation-frame timeout
  const frame = preact.options.requestAnimationFrame;
  preact.options.requestAnimationFrame = (callback) => setTimeout(callback, 0);

  const roots = [];

  const dom = {
    document,
    preact,
    mount(vnode) {
      const root = new FakeElement("div", "http://www.w3.org/1999/xhtml");
      roots.push(root);
      preact.render(vnode, root);
      return root;
    },
    unmount(root) {
      preact.render(null, root);
    },
    /** Let renders, effects and resolved promises run (a few turns of the event loop) */
    async settle(turns = 6) {
      for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    },
    text(node) {
      let out = "";
      walk(node, (n) => {
        if (n.nodeType === 3) out += `${n.data} `;
      });
      return out.replace(/\s+/g, " ").trim();
    },
    find(root, predicate) {
      const found = [];
      walk(root, (n) => {
        if (n.nodeType === 1 && predicate(n)) found.push(n);
      });
      return found;
    },
    /** Elements named `tag` (any when omitted) whose text contains `text` and that hold no deeper match */
    byText(root, text, tag) {
      return dom
        .find(root, (el) => (!tag || el.localName === tag) && dom.text(el).includes(text))
        .filter((el) => !el.childNodes.some((child) => child.nodeType === 1 && (!tag || child.localName === tag) && dom.text(child).includes(text)));
    },
    byAttr(root, name, value, tag) {
      return dom.find(root, (el) => (!tag || el.localName === tag) && el.prop(name) === value);
    },
    fire(el, type, extra = {}) {
      const registered = [...(el.listeners.get(String(type).toLowerCase()) || [])];
      let event = null;
      for (const [fn, spelling] of registered) {
        event = { type: spelling, target: el, currentTarget: el, preventDefault() {}, stopPropagation() {}, ...extra };
        fn.call(el, event);
      }
      return event;
    },
    click(el) {
      if (!el) throw new Error("click: no element");
      if (el.prop("disabled") === true) throw new Error("click: the element is disabled");
      return dom.fire(el, "click");
    },
    type(el, value) {
      el.value = value;
      return dom.fire(el, "input");
    },
    check(el, checked) {
      el.checked = checked;
      return dom.fire(el, "change");
    },
    choose(select, value) {
      select.value = value;
      return dom.fire(select, "change");
    },
    restore() {
      for (const root of roots.splice(0)) {
        try {
          preact.render(null, root);
        } catch {
          // already gone
        }
      }
      preact.options.requestAnimationFrame = frame;
      globalThis.document = previous.document;
      if (previous.document === undefined) delete globalThis.document;
    },
  };
  return dom;
}

module.exports = { createDom, importPublic, FakeElement, FakeText };

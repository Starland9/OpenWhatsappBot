import { html, useRef } from "./html.mjs";

/**
 * Accessible tab strip. `tabs = [{ id, label, badge? }]`, `active` is an id, `onChange(id)`.
 * Pair it with <TabPanel> (renders its children only while active).
 */
export function Tabs({ tabs, active, onChange, label, idPrefix = "tab" }) {
  const list = useRef(null);
  const move = (index) => {
    const next = (index + tabs.length) % tabs.length;
    onChange(tabs[next].id);
    const buttons = list.current && list.current.querySelectorAll('[role="tab"]');
    if (buttons && buttons[next]) buttons[next].focus();
  };
  const onKeyDown = (event, index) => {
    if (event.key === "ArrowRight") move(index + 1);
    else if (event.key === "ArrowLeft") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(tabs.length - 1);
    else return;
    event.preventDefault();
  };
  return html`<div class="tabs" role="tablist" aria-label=${label} ref=${list}>
    ${tabs.map(
      (tab, index) => html`<button
        key=${tab.id}
        type="button"
        role="tab"
        class="tab"
        id=${`${idPrefix}-${tab.id}`}
        aria-selected=${tab.id === active ? "true" : "false"}
        aria-controls=${`${idPrefix}-panel-${tab.id}`}
        tabindex=${tab.id === active ? 0 : -1}
        onClick=${() => onChange(tab.id)}
        onKeyDown=${(event) => onKeyDown(event, index)}
      >${tab.label}${tab.badge !== undefined && tab.badge !== null ? html`<span class="badge">${tab.badge}</span>` : null}</button>`,
    )}
  </div>`;
}

export function TabPanel({ id, active, idPrefix = "tab", children }) {
  if (id !== active) return null;
  return html`<div role="tabpanel" id=${`${idPrefix}-panel-${id}`} aria-labelledby=${`${idPrefix}-${id}`}>${children}</div>`;
}

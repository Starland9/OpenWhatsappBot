import { html } from "./html.mjs";
import { Icon } from "./icon.mjs";

/** Nothing to show yet: an icon, a title, a sentence and an optional action (children). */
export function EmptyState({ icon = "info", title, message, children }) {
  return html`<div class="empty">
    <${Icon} name=${icon} className="icon-lg" />
    ${title ? html`<h2>${title}</h2>` : null}
    ${message ? html`<p>${message}</p>` : null}
    ${children}
  </div>`;
}

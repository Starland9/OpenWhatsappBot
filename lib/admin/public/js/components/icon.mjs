import { html } from "./html.mjs";

/** An icon from the sprite /admin/icons.svg (`name` is the symbol id without the `i-` prefix). */
export function Icon({ name, className = "" }) {
  return html`<svg class=${`icon ${className}`.trim()} aria-hidden="true" focusable="false"><use href=${`/admin/icons.svg#i-${name}`}></use></svg>`;
}

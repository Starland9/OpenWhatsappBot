import { html } from "./html.mjs";
import { t } from "../i18n.mjs";

/** Loading indicator. `inline` renders just the wheel (inside a button, for instance). */
export function Spinner({ label, inline = false }) {
  if (inline) return html`<span class="spinner" role="status" aria-label=${label ?? t("common.loading")}></span>`;
  return html`<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span><span>${label ?? t("common.loading")}</span></div>`;
}

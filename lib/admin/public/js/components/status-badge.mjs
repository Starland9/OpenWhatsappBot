import { html } from "./html.mjs";
import { t } from "../i18n.mjs";
import { statusTone } from "../ui.mjs";

/**
 * A pill with a coloured dot. `status` is a client status (`open`, `qr`, ... translated as `status.<id>`);
 * for any other use pass `tone` (`ok`, `warn`, `danger`, `info`, `neutral`) and `label`.
 */
export function StatusBadge({ status, tone, label }) {
  const resolved = tone || statusTone(status);
  const text = label ?? (status ? t(`status.${status}`) : "");
  return html`<span class=${`badge badge-${resolved}`}><span class="dot" aria-hidden="true"></span>${text}</span>`;
}

import { html } from "../components/html.mjs";
import { t } from "../i18n.mjs";

export const meta = { area: "pairing", titleKey: "pairing.title", icon: "pairing" };

// Placeholder shown until the area's own agent replaces this file (keep `meta` and the default export).
export default function PairingView() {
  return html`<section class="view">
    <div class="view-header"><h1>${t("pairing.title")}</h1></div>
    <p class="muted">${t("common.placeholder")}</p>
  </section>`;
}

import { html } from "../components/html.mjs";
import { t } from "../i18n.mjs";

export const meta = { area: "audit", titleKey: "audit.title", icon: "audit" };

// Placeholder shown until the area's own agent replaces this file (keep `meta` and the default export).
export default function AuditView() {
  return html`<section class="view">
    <div class="view-header"><h1>${t("audit.title")}</h1></div>
    <p class="muted">${t("common.placeholder")}</p>
  </section>`;
}

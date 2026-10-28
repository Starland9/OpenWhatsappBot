import { html } from "../components/html.mjs";
import { t } from "../i18n.mjs";

export const meta = { area: "maintenance", titleKey: "maintenance.title", icon: "maintenance" };

// Placeholder shown until the area's own agent replaces this file (keep `meta` and the default export).
export default function MaintenanceView() {
  return html`<section class="view">
    <div class="view-header"><h1>${t("maintenance.title")}</h1></div>
    <p class="muted">${t("common.placeholder")}</p>
  </section>`;
}

import { html } from "../components/html.mjs";
import { t } from "../i18n.mjs";

export const meta = { area: "backup", titleKey: "backup.title", icon: "backup" };

// Placeholder shown until the area's own agent replaces this file (keep `meta` and the default export).
export default function BackupView() {
  return html`<section class="view">
    <div class="view-header"><h1>${t("backup.title")}</h1></div>
    <p class="muted">${t("common.placeholder")}</p>
  </section>`;
}

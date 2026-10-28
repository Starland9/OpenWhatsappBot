import { html, useState, useLanguage, Icon } from "../components/index.mjs";
import { t } from "../i18n.mjs";
import { ExportCard } from "./backup-export.mjs";
import { RestoreCard } from "./backup-restore.mjs";
import { StoredCard } from "./backup-stored.mjs";

export const meta = { area: "backup", titleKey: "backup.title", icon: "backup" };

/**
 * US10 (FR-051 to FR-053): export everything to one passphrase-encrypted file, restore a file (checked first,
 * confirmed second, never half applied), and get at the safety copies the bot makes before each restore.
 */
export default function BackupView() {
  useLanguage();
  // bumped when a restore finishes: the list of safety copies reloads
  const [restored, setRestored] = useState(0);

  return html`<section class="view stack">
    <div class="view-header"><h1>${t("backup.title")}</h1></div>
    <p class="muted">${t("backup.intro")}</p>
    <div class="banner banner-info" role="note">
      <${Icon} name="info" />
      <div class="banner-body">
        <strong>${t("backup.contents_title")}</strong>
        <div>${t("backup.contents_included")}</div>
        <div>${t("backup.contents_excluded")}</div>
      </div>
    </div>
    <${ExportCard} />
    <${RestoreCard} onRestored=${() => setRestored((n) => n + 1)} />
    <${StoredCard} refreshKey=${restored} />
  </section>`;
}

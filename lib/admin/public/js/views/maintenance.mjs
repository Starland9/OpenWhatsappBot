import { html } from "../components/index.mjs";
import { t } from "../i18n.mjs";
import { UpdateCard } from "./maintenance-update.mjs";
import { YtdlpCard } from "./maintenance-ytdlp.mjs";
import { StorageCard } from "./maintenance-storage.mjs";

export const meta = { area: "maintenance", titleKey: "maintenance.title", icon: "maintenance" };

/** US11: update the bot, update the download tools, see and empty what the bot stores. */
export default function MaintenanceView() {
  return html`<section class="view">
    <div class="view-header"><h1>${t("maintenance.title")}</h1></div>
    <div class="stack">
      <${UpdateCard} />
      <${YtdlpCard} />
      <${StorageCard} />
    </div>
  </section>`;
}

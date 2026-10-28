import { html, useLanguage, Tabs } from "../components/index.mjs";
import { t } from "../i18n.mjs";
import { navigate } from "../router.mjs";
import { DataTab } from "./data-tab.mjs";
import { EconomyTab } from "./data-economy.mjs";
import { DEFAULT_KIND, KINDS, tabKey, tabOf } from "./data-logic.mjs";

export const meta = { area: "data", titleKey: "data.title", icon: "data" };

/**
 * US8: what the bot's commands keep, seen and cleaned from the panel. `#/data?tab=<kind>` picks the tab (reminders,
 * economy, keywords, sticker-commands, afk, tasks, ideas, quotes). The files next to this one hold the parts
 * (data-tab.mjs, data-economy.mjs, data-columns.mjs) and the pure logic (data-logic.mjs).
 */
export default function DataView({ route }) {
  useLanguage();
  const active = tabOf(route && route.query ? route.query.tab : undefined);
  const tabs = KINDS.map((id) => ({ id, label: t(tabKey(id)) }));
  return html`<section class="view stack">
    <div class="view-header"><h1>${t("data.title")}</h1></div>
    <p class="muted">${t("data.page_intro")}</p>
    <${Tabs} tabs=${tabs} active=${active} label=${t("data.title")} idPrefix="data-tab" onChange=${(id) => navigate("data", [], id === DEFAULT_KIND ? {} : { tab: id })} />
    <div role="tabpanel" id=${`data-tab-panel-${active}`} aria-labelledby=${`data-tab-${active}`}>
      ${active === "economy" ? html`<${EconomyTab} key="economy" />` : html`<${DataTab} key=${active} kind=${active} />`}
    </div>
  </section>`;
}

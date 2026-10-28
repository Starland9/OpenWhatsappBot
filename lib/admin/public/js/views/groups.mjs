import { html, useLanguage } from "../components/index.mjs";
import { GroupsList } from "./groups-list.mjs";
import { GroupPage } from "./groups-page.mjs";

export const meta = { area: "groups", titleKey: "groups.title", icon: "groups" };

/**
 * US6: `#/groups` lists the groups (and the chats where the bot is disabled), `#/groups/<jid>` is one group's
 * page, `?tab=` picks a tab. The files next to this one hold the parts (groups-*.mjs) and the pure logic
 * (groups-logic.mjs).
 */
export default function GroupsView({ route }) {
  useLanguage();
  const jid = route && route.rest ? route.rest[0] : undefined;
  const tab = route && route.query ? route.query.tab : undefined;
  return jid ? html`<${GroupPage} key=${jid} jid=${jid} tab=${tab} />` : html`<${GroupsList} tab=${tab} />`;
}

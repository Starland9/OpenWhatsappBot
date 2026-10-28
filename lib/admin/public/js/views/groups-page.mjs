// One group's page (GRP-3 and the writes behind it): header and warnings, then the tabs.
import { html, useState, useEffect, useAsync, useAction, EmptyState, Field, Icon, Spinner, StatusBadge, TabPanel, Tabs } from "../components/index.mjs";
import { t, tError, formatDateTime, formatNumber } from "../i18n.mjs";
import { api } from "../api.mjs";
import { confirm, toastSuccess } from "../ui.mjs";
import { buildHash, navigate } from "../router.mjs";
import { MessagesTab } from "./groups-templates.mjs";
import { FiltersTab } from "./groups-filters.mjs";
import { MembersTab } from "./groups-members.mjs";
import { CommandsTab } from "./groups-commands.mjs";
import { TABS, guardBody, hasWarning, shortJid, tabOf, warningKey } from "./groups-logic.mjs";

const groupPath = (jid) => `/admin/api/groups/${encodeURIComponent(jid)}`;

/** Anti-link, anti-bot and mute (GRD-1, GRD-2). */
function ProtectionTab({ group, reload }) {
  const [busy, run] = useAction();
  const base = groupPath(group.jid);

  const setGuard = (key, value) =>
    run(async () => {
      await api("PUT", `${base}/guard`, guardBody(key, value));
      await reload();
      toastSuccess(t("common.saved"));
    });

  const setMute = (muted) =>
    run(async () => {
      if (muted) {
        const ok = await confirm({ title: t("groups.mute_confirm_title"), message: t("groups.mute_confirm_message"), confirmLabel: t("groups.mute_confirm") });
        if (!ok) return;
      }
      await api("PUT", `${base}/mute`, { muted });
      await reload();
      toastSuccess(t(muted ? "groups.mute_done" : "groups.unmute_done"));
    });

  return html`<section class="card stack">
    <h2 class="card-title">${t("groups.protection_title")}</h2>
    <p class="muted">${t("groups.protection_intro")}</p>
    <${Field} type="bool" name="antilink" label=${t("groups.antilink_label")} hint=${t("groups.antilink_hint")} value=${group.antilink} disabled=${busy} onChange=${(value) => setGuard("antilink", value)} />
    <${Field} type="bool" name="antibot" label=${t("groups.antibot_label")} hint=${t("groups.antibot_hint")} value=${group.antibot} disabled=${busy || group.former} onChange=${(value) => setGuard("antibot", value)} />
    <${Field} type="bool" name="mute" label=${t("groups.mute_label")} hint=${t("groups.mute_hint")} value=${group.mute} disabled=${busy || group.former} onChange=${setMute} />
    <p class="muted">${t("groups.exempt_hint")}</p>
  </section>`;
}

/** Disable the bot here (GRP-4 `disabled`), and delete a former group's settings (GRP-6). */
function AdvancedTab({ group, onGroup, reload }) {
  const [busy, run] = useAction();
  const base = groupPath(group.jid);

  const setDisabled = (disabled) =>
    run(async () => {
      if (disabled) {
        const ok = await confirm({ title: t("groups.disable_confirm_title"), message: t("groups.disable_confirm_message"), confirmLabel: t("groups.disable_confirm") });
        if (!ok) return;
      }
      onGroup(await api("PATCH", base, { disabled }));
      toastSuccess(t(disabled ? "groups.disable_done" : "groups.enable_done"));
    });

  const deleteSettings = () =>
    run(async () => {
      const ok = await confirm({
        title: t("groups.delete_confirm_title", { name: group.name || shortJid(group.jid) }),
        message: t("groups.delete_confirm_message"),
        confirmLabel: t("groups.delete_confirm"),
      });
      if (!ok) return;
      const answer = await api("DELETE", `${base}?confirm=true`);
      toastSuccess(t("groups.delete_done", answer.deleted));
      navigate("groups");
    });

  return html`<div class="stack">
    <section class="card stack">
      <h2 class="card-title">${t("groups.disable_title")}</h2>
      <p class="muted">${t("groups.disable_hint")}</p>
      <${Field} type="bool" name="disabled" label=${t("groups.disable_label")} value=${group.disabled} disabled=${busy} onChange=${setDisabled} />
    </section>
    ${group.former
      ? html`<section class="card stack">
          <h2 class="card-title">${t("groups.delete_title")}</h2>
          <p class="muted">${t("groups.delete_hint")}</p>
          <div><button type="button" class="btn btn-danger" disabled=${busy} onClick=${deleteSettings}><${Icon} name="trash" />${t("groups.delete_button")}</button></div>
        </section>`
      : null}
  </div>`;
}

function Header({ group }) {
  const admin = group.former ? null : group.botIsAdmin;
  return html`<div class="stack-sm">
    <div class="view-header">
      <div class="stack-sm">
        <h1>${group.name || t("groups.unnamed")}</h1>
        <span class="muted mono">${shortJid(group.jid)}</span>
      </div>
      <a class="btn" href=${buildHash("groups")}><${Icon} name="chevron-left" />${t("groups.back")}</a>
    </div>
    <div class="row-wrap">
      ${group.former ? html`<${StatusBadge} tone="neutral" label=${t("groups.badge_former")} />` : null}
      ${admin === true ? html`<${StatusBadge} tone="ok" label=${t("groups.badge_bot_admin")} />` : null}
      ${admin === false ? html`<${StatusBadge} tone="warn" label=${t("groups.badge_bot_not_admin")} />` : null}
      ${admin === null && !group.former ? html`<${StatusBadge} tone="neutral" label=${t("groups.badge_admin_unknown")} />` : null}
      ${group.disabled ? html`<${StatusBadge} tone="danger" label=${t("groups.badge_disabled")} />` : null}
      ${group.members !== null ? html`<span class="muted">${t("groups.members_count", { count: group.members, formatted: formatNumber(group.members) })}</span>` : null}
      ${group.former && group.leftAt ? html`<span class="muted">${t("groups.left_at", { when: formatDateTime(group.leftAt) })}</span>` : null}
    </div>
  </div>`;
}

/** `#/groups/<jid>?tab=...` */
export function GroupPage({ jid, tab }) {
  const { data, error, reload } = useAsync(() => api("GET", groupPath(jid)), [jid]);
  const [local, setLocal] = useState(null);
  useEffect(() => setLocal(null), [data]);
  const group = local || data;

  if (!group) {
    if (error) {
      return html`<section class="view stack">
        <${EmptyState} icon="error" title=${error.code === "not_found" ? t("groups.not_found") : t("common.view_error")} message=${error.code === "not_found" ? t("groups.not_found_hint") : tError(error)}>
          <a class="btn" href=${buildHash("groups")}>${t("groups.back")}</a>
        <//>
      </section>`;
    }
    return html`<${Spinner} />`;
  }

  const active = tabOf(tab, TABS);
  const counts = group.counts || { filters: 0, roles: 0, warnings: 0 };
  const tabs = TABS.map((id) => ({
    id,
    label: t(`groups.tab_${id}`),
    badge: id === "filters" ? counts.filters : id === "members" ? counts.roles + counts.warnings : id === "commands" ? group.disabledCommands.length : undefined,
  }));
  const common = { group, onGroup: setLocal, reload };

  return html`<section class="view stack">
    <${Header} group=${group} />
    ${hasWarning(group, "bot_not_admin")
      ? html`<div class="banner banner-warn" role="status"><${Icon} name="warning" /><div class="banner-body">${t(warningKey("bot_not_admin"))}</div></div>`
      : null}
    <${Tabs} tabs=${tabs} active=${active} label=${t("groups.title")} idPrefix="group-tab" onChange=${(id) => navigate("groups", [jid], id === TABS[0] ? {} : { tab: id })} />
    <${TabPanel} id="messages" active=${active} idPrefix="group-tab"><${MessagesTab} ...${common} /><//>
    <${TabPanel} id="protection" active=${active} idPrefix="group-tab"><${ProtectionTab} ...${common} /><//>
    <${TabPanel} id="filters" active=${active} idPrefix="group-tab"><${FiltersTab} ...${common} /><//>
    <${TabPanel} id="members" active=${active} idPrefix="group-tab"><${MembersTab} ...${common} /><//>
    <${TabPanel} id="commands" active=${active} idPrefix="group-tab"><${CommandsTab} ...${common} /><//>
    <${TabPanel} id="advanced" active=${active} idPrefix="group-tab"><${AdvancedTab} ...${common} /><//>
  </section>`;
}

import {
  html,
  useState,
  useMemo,
  useAsync,
  useAction,
  useLanguage,
  DataTable,
  EmptyState,
  Icon,
  Spinner,
  StatusBadge,
} from "../components/index.mjs";
import { t, tError } from "../i18n.mjs";
import { api } from "../api.mjs";
import { confirm, toast, toastSuccess } from "../ui.mjs";
import { ScopeEditor } from "./commands-editor.mjs";
import { OrphanRows } from "./commands-orphans.mjs";
import {
  filterCommands,
  accessLevels,
  stateOf,
  summarize,
  toggleBody,
  lockoutWarning,
  warningKeys,
  GLOBAL_SCOPE,
} from "./commands-logic.mjs";

export const meta = { area: "commands", titleKey: "commands.title", icon: "commands" };

const statePath = (name) => `/admin/api/commands/${encodeURIComponent(name)}/state`;

function StateBadge({ command }) {
  const { state, groups } = stateOf(command);
  if (state === "global") return html`<${StatusBadge} tone="danger" label=${t("commands.state_global")} />`;
  if (state === "groups") return html`<${StatusBadge} tone="warn" label=${t("commands.state_groups", { count: groups })} />`;
  return html`<${StatusBadge} tone="ok" label=${t("commands.state_enabled")} />`;
}

function AccessBadges({ command }) {
  const levels = accessLevels(command);
  if (levels.length === 0) return html`<span class="muted">${t("commands.access_everyone")}</span>`;
  return html`<span class="row-wrap">${levels.map((level) => html`<span key=${level} class="badge" title=${t(`commands.access_${level}_hint`)}>${t(`commands.access_${level}`)}</span>`)}</span>`;
}

/** CMD-1 / CMD-2: the command table, the global switch, the per-group scope editor and the orphan rows. */
export default function CommandsView() {
  useLanguage();
  const { data, error, loading, reload } = useAsync(() => api("GET", "/admin/api/commands"), []);
  const [busy, run] = useAction();
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [selected, setSelected] = useState(null);
  // answers of CMD-2 not yet reflected by a reload: command name -> { disabledGlobal, disabledGroups }
  const [patches, setPatches] = useState({});

  const commands = useMemo(
    () => ((data && data.commands) || []).map((command) => (patches[command.name] ? { ...command, ...patches[command.name] } : command)),
    [data, patches],
  );
  const visible = useMemo(() => filterCommands(commands, { query, type }), [commands, query, type]);
  const totals = useMemo(() => summarize(commands), [commands]);
  const editing = selected ? commands.find((command) => command.name === selected) : null;

  /** Send a CMD-2 body, keep the answer, show the lockout warnings the server returned */
  const apply = (command, change) =>
    run(async () => {
      const body = toggleBody(change);
      if (!body) return null;
      const warning = lockoutWarning(command, change);
      if (warning) {
        const ok = await confirm({
          title: t("commands.lockout_title", { name: command.name }),
          message: t(warning),
          confirmLabel: t("commands.lockout_confirm"),
        });
        if (!ok) return null;
      }
      const answer = await api("PATCH", statePath(command.name), body);
      setPatches((current) => ({ ...current, [command.name]: { disabledGlobal: answer.disabledGlobal, disabledGroups: answer.disabledGroups } }));
      toastSuccess(t("commands.saved", { name: command.name }));
      for (const key of warningKeys(answer.warnings)) toast(t(key), { kind: "info", ttl: 12000 });
      return answer;
    });

  const toggleGlobal = (command) => apply(command, command.disabledGlobal ? { enable: [GLOBAL_SCOPE] } : { disable: [GLOBAL_SCOPE] });

  const removeOrphan = (command, scope) =>
    run(async () => {
      await api("PATCH", statePath(command), toggleBody({ enable: [scope] }));
      toastSuccess(t("commands.orphan_removed", { command }));
      setPatches({});
      await reload();
    });

  const columns = [
    {
      key: "name",
      label: t("commands.col_command"),
      render: (command) => html`<div class="stack-sm">
        <span class="mono"><strong>${command.name}</strong></span>
        ${command.aliases.length > 1 ? html`<span class="muted mono">${command.aliases.slice(1).join(", ")}</span>` : null}
      </div>`,
    },
    { key: "type", label: t("commands.col_category"), render: (command) => html`<span class="nowrap">${command.type}</span>` },
    { key: "desc", label: t("commands.col_description"), render: (command) => command.desc },
    { key: "access", label: t("commands.col_access"), render: (command) => html`<${AccessBadges} command=${command} />` },
    { key: "state", label: t("commands.col_state"), render: (command) => html`<${StateBadge} command=${command} />` },
    {
      key: "actions",
      label: t("commands.col_actions"),
      render: (command) => html`<div class="cell-actions">
        <label class="switch">
          <input type="checkbox" role="switch" checked=${!command.disabledGlobal} disabled=${busy} aria-label=${t("commands.switch_label", { name: command.name })} onChange=${() => toggleGlobal(command)} />
          <span>${command.disabledGlobal ? t("commands.switch_off") : t("commands.switch_on")}</span>
        </label>
        <button type="button" class="btn btn-sm" aria-pressed=${selected === command.name} onClick=${() => setSelected(selected === command.name ? null : command.name)}>${t("commands.scopes_button")}</button>
      </div>`,
    },
  ];

  if (loading && !data) return html`<section class="view"><div class="view-header"><h1>${t("commands.title")}</h1></div><${Spinner} /></section>`;
  if (error && !data) {
    return html`<section class="view">
      <div class="view-header"><h1>${t("commands.title")}</h1></div>
      <${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(error)}>
        <button type="button" class="btn" onClick=${reload}><${Icon} name="refresh" />${t("common.retry")}</button>
      <//>
    </section>`;
  }

  const types = (data && data.types) || [];
  return html`<section class="view stack">
    <div class="view-header">
      <h1>${t("commands.title")}</h1>
      <button type="button" class="btn btn-sm" disabled=${loading} onClick=${() => {
        setPatches({});
        reload();
      }}><${Icon} name="refresh" />${t("common.refresh")}</button>
    </div>
    <p class="muted">${t("commands.intro")}</p>

    <div class="row-wrap">
      <div class="grow">
        <input class="input" type="search" value=${query} placeholder=${t("commands.search_placeholder")} aria-label=${t("commands.search_label")} autocomplete="off" onInput=${(event) => setQuery(event.currentTarget.value)} />
      </div>
      <select class="select" value=${type} aria-label=${t("commands.category_label")} onChange=${(event) => setType(event.currentTarget.value)}>
        <option value="" selected=${type === ""}>${t("commands.category_all")}</option>
        ${types.map((name) => html`<option key=${name} value=${name} selected=${type === name}>${name}</option>`)}
      </select>
    </div>
    <p class="muted" aria-live="polite">${t("commands.summary", { shown: visible.length, total: totals.total, off: totals.offGlobal + totals.offGroups })}</p>

    ${editing
      ? html`<${ScopeEditor}
          key=${`${editing.name}:${editing.disabledGlobal}:${editing.disabledGroups.join(",")}`}
          command=${editing}
          busy=${busy}
          onSave=${(change) => apply(editing, change)}
          onClose=${() => setSelected(null)}
        />`
      : null}

    <${DataTable}
      columns=${columns}
      rows=${visible}
      rowKey="name"
      caption=${t("commands.title")}
      empty=${html`<${EmptyState} icon="info" title=${t("commands.no_match")} message=${t("commands.no_match_hint")} />`}
    />

    <${OrphanRows} orphans=${(data && data.orphans) || []} busy=${busy} onRemove=${removeOrphan} />
  </section>`;
}

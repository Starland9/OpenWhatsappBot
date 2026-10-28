import {
  html,
  useState,
  useMemo,
  useEffect,
  useAsync,
  useAction,
  useLanguage,
  DataTable,
  EmptyState,
  Icon,
  Spinner,
  StatusBadge,
} from "../components/index.mjs";
import { t, tError, formatDateTime } from "../i18n.mjs";
import { api } from "../api.mjs";
import { buildHash } from "../router.mjs";
import { toastSuccess } from "../ui.mjs";
import { buildRows, toggleBody, patchFromAnswer, summarize, noRecipient, typeKeys, statusKey, statusTone } from "./alerts-logic.mjs";

export const meta = { area: "alerts", titleKey: "alerts.title", icon: "alerts" };

const REFRESH_MS = 30 * 1000;

/** ALR-1 for the page, SET-1 for the versions that SET-2 needs to switch a type */
const load = async () => {
  const [alerts, settings] = await Promise.all([api("GET", "/admin/api/alerts"), api("GET", "/admin/api/settings")]);
  return { alerts, settings: settings.settings };
};

const when = (value) => (value ? formatDateTime(value) : t("alerts.never"));

/** ALR-1: the six alert types with their toggle (SET-2 on the ALERT_* keys), the last sends and the recent alerts. */
export default function AlertsView() {
  useLanguage();
  const { data, error, loading, reload } = useAsync(load, []);
  const [busy, run] = useAction();
  // toggles answered by SET-2 and not yet reflected by a reload: type -> { enabled, version }
  const [patches, setPatches] = useState({});

  // a fresh answer replaces the toggles answered so far
  const refresh = () =>
    reload().then((fresh) => {
      if (fresh) setPatches({});
    });

  // the pending counts and the recent list move on their own: look again every 30 s
  useEffect(() => {
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const rows = useMemo(() => buildRows(data && data.alerts, data && data.settings, patches), [data, patches]);
  const totals = useMemo(() => summarize(rows), [rows]);

  const toggle = (row) =>
    run(async () => {
      const enabled = !row.enabled;
      const body = toggleBody(row, enabled);
      if (!body) return null;
      let answer;
      try {
        answer = await api("PATCH", "/admin/api/settings", body);
      } catch (err) {
        if (err && err.code === "conflict") refresh(); // someone changed it meanwhile: show the current state
        throw err;
      }
      const patch = patchFromAnswer(answer, row.settingKey);
      setPatches((current) => ({ ...current, [row.type]: patch || { enabled, version: row.version + 1 } }));
      const name = t(typeKeys(row.type).title);
      toastSuccess(enabled ? t("alerts.saved_on", { name }) : t("alerts.saved_off", { name }));
      return answer;
    });

  const columns = [
    {
      key: "type",
      label: t("alerts.col_alert"),
      render: (row) => html`<div class="stack-sm">
        <strong>${t(typeKeys(row.type).title)}</strong>
        <span class="muted">${t(typeKeys(row.type).desc)}</span>
      </div>`,
    },
    {
      key: "enabled",
      label: t("alerts.col_enabled"),
      render: (row) => html`<label class="switch" title=${row.version === null ? t("alerts.toggle_unavailable") : undefined}>
        <input
          type="checkbox"
          role="switch"
          checked=${row.enabled}
          disabled=${busy || row.version === null}
          aria-label=${t("alerts.switch_label", { name: t(typeKeys(row.type).title) })}
          onChange=${() => toggle(row)}
        />
        <span>${row.enabled ? t("alerts.switch_on") : t("alerts.switch_off")}</span>
      </label>`,
    },
    { key: "lastSentAt", label: t("alerts.col_last_sent"), render: (row) => html`<span class="nowrap">${when(row.lastSentAt)}</span>` },
    {
      key: "pending",
      label: t("alerts.col_pending"),
      align: "right",
      render: (row) => (row.pending > 0 ? html`<${StatusBadge} tone="warn" label=${String(row.pending)} />` : html`<span class="muted">0</span>`),
    },
  ];

  const recentColumns = [
    { key: "type", label: t("alerts.col_type"), render: (row) => (typeKeys(row.type) ? t(typeKeys(row.type).title) : row.type) },
    {
      key: "status",
      label: t("alerts.col_status"),
      render: (row) => (statusKey(row.status) ? html`<${StatusBadge} tone=${statusTone(row.status)} label=${t(statusKey(row.status))} />` : row.status),
    },
    { key: "createdAt", label: t("alerts.col_created"), render: (row) => html`<span class="nowrap">${when(row.createdAt)}</span>` },
    { key: "sentAt", label: t("alerts.col_sent"), render: (row) => html`<span class="nowrap">${row.sentAt ? formatDateTime(row.sentAt) : "-"}</span>` },
  ];

  if (loading && !data) return html`<section class="view"><div class="view-header"><h1>${t("alerts.title")}</h1></div><${Spinner} /></section>`;
  if (error && !data) {
    return html`<section class="view">
      <div class="view-header"><h1>${t("alerts.title")}</h1></div>
      <${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(error)}>
        <button type="button" class="btn" onClick=${reload}><${Icon} name="refresh" />${t("common.retry")}</button>
      <//>
    </section>`;
  }

  const alerts = data && data.alerts;
  const recent = (alerts && alerts.recent) || [];
  return html`<section class="view stack">
    <div class="view-header">
      <h1>${t("alerts.title")}</h1>
      <button type="button" class="btn btn-sm" disabled=${loading} onClick=${refresh}><${Icon} name="refresh" />${t("common.refresh")}</button>
    </div>
    <p class="muted">${t("alerts.intro")}</p>

    ${noRecipient(alerts)
      ? html`<div class="banner banner-warn" role="alert">
          <${Icon} name="warning" />
          <div class="banner-body">
            ${t("alerts.no_recipient")}
            <a class="banner-link" href=${buildHash("settings")}>${t("alerts.no_recipient_action")}</a>
          </div>
        </div>`
      : null}

    <section class="card" aria-labelledby="alerts-types">
      <h2 class="card-title" id="alerts-types">${t("alerts.types_title")}</h2>
      <p class="muted" aria-live="polite">${t("alerts.summary", totals)}</p>
      <${DataTable} columns=${columns} rows=${rows} rowKey="type" caption=${t("alerts.types_title")} />
      <p class="muted">${t("alerts.limits_note")}</p>
      <p class="muted">${t("alerts.pending_note")}</p>
    </section>

    <section class="card" aria-labelledby="alerts-recent">
      <h2 class="card-title" id="alerts-recent">${t("alerts.recent_title")}</h2>
      <${DataTable}
        columns=${recentColumns}
        rows=${recent}
        rowKey="id"
        caption=${t("alerts.recent_title")}
        empty=${html`<${EmptyState} icon="info" title=${t("alerts.recent_empty")} message=${t("alerts.recent_empty_hint")} />`}
      />
    </section>
  </section>`;
}

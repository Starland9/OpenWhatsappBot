import { html, useState, useEffect, useMemo, useAsync, useAction, useLive, useUnsavedGuard, Tabs, TabPanel, Spinner, EmptyState, Icon } from "../components/index.mjs";
import { t } from "../i18n.mjs";
import { api } from "../api.mjs";
import { confirm, toast, toastSuccess, toastError } from "../ui.mjs";
import {
  MAX_CHANGES,
  INACTIVE_THEME,
  groupSettings,
  initialForm,
  setValue,
  setSecret,
  resetKeys,
  rebaseForm,
  pairKeys,
  diffChanges,
  buildPayload,
  singleChange,
  changeCounts,
  emptiesOwners,
  validateForm,
  fieldErrorsFromError,
  isOwnersConfirmation,
  themeOf,
  mergeSettings,
} from "./settings-logic.mjs";
import { SettingRow } from "./settings-row.mjs";

export const meta = { area: "settings", titleKey: "settings.title", icon: "settings" };

function Banner({ tone = "warn", icon = "warning", children }) {
  return html`<div class=${`banner banner-${tone}`} role="status"><${Icon} name=${icon} /><div class="banner-body">${children}</div></div>`;
}

/** SET-1 loaded: every setting in its tab, one batch to save (SET-2), the actions of a single setting. */
function SettingsForm({ data, reloadAll, focusKey }) {
  const [settings, setSettings] = useState(data.settings);
  const [info, setInfo] = useState({ restartPending: data.restartPending, secretStore: data.secretStore, ownersConfigured: data.ownersConfigured });
  const [form, setForm] = useState(() => initialForm(data.settings));
  const [errors, setErrors] = useState({});
  const [active, setActive] = useState(() => themeOf(data.settings, focusKey) || "general");
  const [tests, setTests] = useState({});
  const [testing, setTesting] = useState({});
  const [busy, run] = useAction();

  // a fresh list from the server (after a restart): start again from it
  useEffect(() => {
    setSettings(data.settings);
    setInfo({ restartPending: data.restartPending, secretStore: data.secretStore, ownersConfigured: data.ownersConfigured });
    setForm(initialForm(data.settings));
    setErrors({});
  }, [data]);

  const groups = useMemo(() => groupSettings(settings), [settings]);
  const counts = useMemo(() => changeCounts(settings, form), [settings, form]);
  const pending = useMemo(() => diffChanges(settings, form).length, [settings, form]);
  useUnsavedGuard("settings", pending > 0);

  const tabs = groups.filter((g) => !g.folded).map((g) => ({ id: g.theme, label: t(`settings.theme.${g.theme}`), badge: counts[g.theme] || undefined }));
  const shown = tabs.some((tab) => tab.id === active) ? active : tabs.length ? tabs[0].id : "";
  const inactive = groups.find((g) => g.folded);

  const onValue = (key, value) => {
    setForm((f) => setValue(f, key, value));
    setErrors((e) => (e[key] ? Object.fromEntries(Object.entries(e).filter(([name]) => name !== key)) : e));
  };
  const onSecret = (key, patch) => {
    setForm((f) => setSecret(f, key, patch));
    setErrors((e) => (e[key] ? Object.fromEntries(Object.entries(e).filter(([name]) => name !== key)) : e));
  };

  const apply = (answer) => {
    const updated = answer.settings || [];
    setSettings((list) => mergeSettings(list, updated));
    setForm((f) => resetKeys(f, updated, updated.map((s) => s.key)));
    setInfo((i) => ({ ...i, restartPending: answer.restartPending || [] }));
  };

  const jumpToFirstError = (fields, list = settings) => {
    const first = Object.keys(fields).find((key) => themeOf(list, key));
    const theme = first ? themeOf(list, first) : null;
    if (theme && theme !== INACTIVE_THEME) setActive(theme);
  };

  /** PATCH; resolves true when saved. A rejected batch writes nothing: the errors are shown on the fields. */
  const post = async (payload) => {
    try {
      const answer = await api("PATCH", "/admin/api/settings", payload);
      apply(answer);
      setErrors({});
      toastSuccess(t("settings.saved"));
      return true;
    } catch (err) {
      if (isOwnersConfirmation(err)) {
        const ok = await askOwners();
        return ok ? post({ ...payload, confirm: ["owners_empty"] }) : false;
      }
      if (err.code === "validation_failed" || err.code === "conflict") {
        const fields = fieldErrorsFromError(err);
        setErrors(fields);
        jumpToFirstError(fields);
      }
      toastError(err);
      return false;
    }
  };
  const send = (payload) => run(() => post(payload), { silent: true });

  const askOwners = () => confirm({ title: t("settings.owners_empty_title"), message: t("settings.owners_empty_message"), confirmLabel: t("settings.owners_empty_confirm") });

  const save = async () => {
    const problems = validateForm(settings, form);
    if (Object.keys(problems).length) {
      setErrors(problems);
      jumpToFirstError(problems);
      toast(t("settings.fix_errors"), { kind: "error" });
      return;
    }
    const confirmed = emptiesOwners(settings, form) ? ["owners_empty"] : [];
    if (confirmed.length && !(await askOwners())) return;
    const payload = buildPayload(settings, form, { confirm: confirmed });
    if (!payload) return;
    if (payload.changes.length > MAX_CHANGES) {
      toast(t("settings.too_many_changes", { max: MAX_CHANGES }), { kind: "error" });
      return;
    }
    await send(payload);
  };

  const discard = () => {
    setForm(initialForm(settings));
    setErrors({});
  };

  const onAction = async (setting, op) => {
    const label = t(`settings.${setting.key}.label`);
    const ok = await confirm({
      title: t(op === "default" ? "settings.reset_default" : "settings.revert_file"),
      message: t(op === "default" ? "settings.confirm_default" : "settings.confirm_revert", { label }),
      confirmLabel: t(op === "default" ? "settings.reset_default" : "settings.revert_file"),
      danger: false,
    });
    if (ok) await send(singleChange(setting, op));
  };

  /** A conflict: take the server's list (fresh versions), keep what was typed elsewhere, drop the stale draft */
  const onReload = (key) =>
    run(async () => {
      const fresh = await api("GET", "/admin/api/settings");
      const keys = pairKeys(key);
      setForm((f) => resetKeys(rebaseForm(f, settings, fresh.settings), fresh.settings, keys));
      setSettings(fresh.settings);
      setInfo({ restartPending: fresh.restartPending, secretStore: fresh.secretStore, ownersConfigured: fresh.ownersConfigured });
      setErrors((e) => Object.fromEntries(Object.entries(e).filter(([name]) => !keys.includes(name))));
    });

  const onTest = async (setting) => {
    const service = setting.testService;
    setTesting((s) => ({ ...s, [service]: true }));
    try {
      const answer = await api("POST", `/admin/api/settings/keys/${encodeURIComponent(service)}/test`, {});
      setTests((s) => ({ ...s, [service]: answer }));
    } catch (error) {
      setTests((s) => ({ ...s, [service]: { error } }));
    } finally {
      setTesting((s) => ({ ...s, [service]: false }));
    }
  };

  const restartNow = async () => {
    const ok = await confirm({ title: t("settings.restart_title"), message: t("settings.restart_message"), confirmLabel: t("settings.restart_button"), danger: false });
    if (!ok) return;
    await run(async () => {
      await api("POST", "/admin/api/restart", { confirm: true });
      toast(t("settings.restart_started"), { kind: "info" });
    });
  };

  // the restart ends with a job event: the list is read again (pendingRestart cleared, new baseline)
  useLive("job", (job) => {
    if (job && job.type === "restart" && job.status === "done") reloadAll();
  });

  const row = (setting) => {
    const service = setting.testService;
    return html`<${SettingRow}
      key=${setting.key}
      setting=${setting}
      settings=${settings}
      form=${form}
      error=${errors[setting.key]}
      busy=${busy}
      test=${service ? tests[service] : undefined}
      testing=${service ? Boolean(testing[service]) : false}
      onValue=${onValue}
      onSecret=${onSecret}
      onAction=${onAction}
      onTest=${onTest}
      onReload=${onReload}
    />`;
  };

  const saveBar = pending
    ? html`<div class="actions">
        <button type="button" class="btn btn-primary" disabled=${busy} onClick=${save}>${busy ? html`<${Spinner} inline />` : null}${t("settings.save", { count: pending })}</button>
        <button type="button" class="btn" disabled=${busy} onClick=${discard}>${t("settings.discard")}</button>
      </div>`
    : null;

  return html`<section class="view stack">
    <div class="view-header">
      <h1>${t("settings.title")}</h1>
      ${saveBar}
    </div>
    <div class="banners">
      ${info.restartPending.length
        ? html`<${Banner}>${t("settings.restart_banner", { keys: info.restartPending.join(", ") })} <button type="button" class="btn btn-sm" disabled=${busy} onClick=${restartNow}>${t("settings.restart_button")}</button><//>`
        : null}
      ${info.secretStore === "key_missing" ? html`<${Banner} tone="error" icon="error">${t("settings.secret_key_lost")}<//>` : null}
      ${info.ownersConfigured ? null : html`<${Banner}>${t("settings.no_owner")}<//>`}
    </div>
    <p class="muted">${t("settings.intro")}</p>
    <${Tabs} tabs=${tabs} active=${shown} onChange=${setActive} label=${t("settings.title")} idPrefix="settings-tab" />
    ${groups
      .filter((g) => !g.folded)
      .map(
        (group) => html`<${TabPanel} key=${group.theme} id=${group.theme} active=${shown} idPrefix="settings-tab">
          <div class="stack">
            ${group.theme === "boot" ? html`<p class="muted">${t("settings.boot_note")}</p>` : null}
            ${group.items.map(row)}
            ${group.theme === "boot" ? null : saveBar}
          </div>
        <//>`,
      )}
    ${inactive
      ? html`<details class="card">
          <summary class="field-label">${t("settings.theme.inactive")} (${inactive.items.length})</summary>
          <p class="muted">${t("settings.inactive_note")}</p>
          <div class="stack">${inactive.items.map(row)}</div>
        </details>`
      : null}
  </section>`;
}

/** SET-1 / SET-2 / SET-3 (admin-http-api.md 2.5): every setting by theme, one batch to save, key tests. */
export default function SettingsView({ route }) {
  const { data, loading, reload } = useAsync(() => api("GET", "/admin/api/settings"), []);
  if (!data) {
    if (loading) return html`<section class="view"><${Spinner} /></section>`;
    return html`<section class="view">
      <${EmptyState} icon="error" title=${t("common.view_error")} message=${t("common.view_error_hint")}>
        <button type="button" class="btn" onClick=${reload}>${t("common.retry")}</button>
      <//>
    </section>`;
  }
  return html`<${SettingsForm} data=${data} reloadAll=${reload} focusKey=${route && route.rest ? route.rest[0] : undefined} />`;
}

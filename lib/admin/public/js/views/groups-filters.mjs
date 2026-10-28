// The automatic-reply filters of one group (GRP-7..GRP-10): list, add, edit in place, delete.
import { html, useState, useAsync, useAction, DataTable, EmptyState, Field, Icon, useUnsavedGuard } from "../components/index.mjs";
import { t, tError } from "../i18n.mjs";
import { api } from "../api.mjs";
import { confirm, toastSuccess, toastError } from "../ui.mjs";
import { excerpt, filterBody, validateFilter } from "./groups-logic.mjs";

const EMPTY = { pattern: "", response: "" };

export function FiltersTab({ group, reload: reloadGroup }) {
  const base = `/admin/api/groups/${encodeURIComponent(group.jid)}/filters`;
  const { data, error, loading, reload } = useAsync(() => api("GET", base), [group.jid]);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, run] = useAction();

  const filters = data ? data.filters : [];
  const limits = (data && data.limits) || group.limits;
  const check = validateFilter(form, filters, { editingId: editing, limits });
  const dirty = Boolean(form.pattern || form.response);
  useUnsavedGuard(`groups-${group.jid}-filters`, dirty);

  const change = (name) => (value) => {
    setForm((f) => ({ ...f, [name]: value }));
    setErrors((e) => ({ ...e, [name]: undefined }));
  };
  const clear = () => {
    setForm(EMPTY);
    setEditing(null);
    setErrors({});
  };

  const submit = (event) => {
    event.preventDefault();
    if (!check.ok) {
      setErrors(check.fields);
      return undefined;
    }
    return run(
      async () => {
        try {
          if (editing === null) await api("POST", base, filterBody(form));
          else await api("PUT", `${base}/${editing}`, filterBody(form));
          clear();
          toastSuccess(t("common.saved"));
          await Promise.all([reload(), reloadGroup()]);
        } catch (err) {
          if (err.code === "validation_failed" && err.fields) setErrors(err.fields);
          else if (err.code === "duplicate") setErrors({ pattern: { code: "duplicate" } });
          else toastError(err);
        }
      },
      { silent: true },
    );
  };

  const remove = (filter) =>
    run(async () => {
      const ok = await confirm({
        title: t("groups.filter_delete_title"),
        message: t("groups.filter_delete_message", { pattern: filter.pattern }),
        confirmLabel: t("common.delete"),
      });
      if (!ok) return;
      await api("DELETE", `${base}/${filter.id}`);
      if (editing === filter.id) clear();
      toastSuccess(t("groups.filter_deleted"));
      await Promise.all([reload(), reloadGroup()]);
    });

  const columns = [
    { key: "pattern", label: t("groups.filter_pattern"), render: (row) => html`<span class="mono">${row.pattern}</span>` },
    { key: "response", label: t("groups.filter_response"), render: (row) => excerpt(row.response) },
    {
      key: "actions",
      label: t("groups.col_actions"),
      render: (row) => html`<span class="cell-actions">
        <button type="button" class="icon-btn" disabled=${busy} aria-label=${t("groups.filter_edit_label", { pattern: row.pattern })} onClick=${() => { setEditing(row.id); setForm({ pattern: row.pattern, response: row.response }); setErrors({}); }}><${Icon} name="edit" /></button>
        <button type="button" class="icon-btn" disabled=${busy} aria-label=${t("groups.filter_delete_label", { pattern: row.pattern })} onClick=${() => remove(row)}><${Icon} name="trash" /></button>
      </span>`,
    },
  ];

  return html`<div class="stack">
    <section class="card stack">
      <h2 class="card-title">${editing === null ? t("groups.filter_add_title") : t("groups.filter_edit_title")}</h2>
      <p class="muted">${t("groups.filters_intro")}</p>
      <form class="form" onSubmit=${submit} noValidate>
        <${Field} name="pattern" label=${t("groups.filter_pattern")} value=${form.pattern} error=${errors.pattern} hint=${t("groups.filter_pattern_hint", { max: limits.patternMax })} disabled=${busy} onChange=${change("pattern")} required />
        <${Field} type="textarea" name="response" label=${t("groups.filter_response")} value=${form.response} error=${errors.response} hint=${t("groups.filter_response_hint", { max: limits.responseMax })} rows=${3} disabled=${busy} onChange=${change("response")} required />
        ${check.limit ? html`<p class="field-error" role="alert">${t("errors.limit_reached")}</p>` : null}
        <div class="actions">
          <button type="submit" class="btn btn-primary" disabled=${busy || check.limit}>${editing === null ? t("common.add") : t("common.save")}</button>
          ${editing !== null || dirty ? html`<button type="button" class="btn" disabled=${busy} onClick=${clear}>${t("common.cancel")}</button>` : null}
        </div>
      </form>
    </section>
    <section class="card stack">
      <h2 class="card-title">${t("groups.filters_title", { count: filters.length, max: limits.filtersMax })}</h2>
      ${error && !data
        ? html`<${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(error)}><button type="button" class="btn" onClick=${reload}>${t("common.retry")}</button><//>`
        : html`<${DataTable}
            columns=${columns}
            rows=${filters}
            rowKey="id"
            loading=${loading}
            caption=${t("groups.filters_title", { count: filters.length, max: limits.filtersMax })}
            empty=${html`<${EmptyState} icon="info" title=${t("groups.filters_empty")} message=${t("groups.filters_empty_hint")} />`}
          />`}
    </section>
  </div>`;
}

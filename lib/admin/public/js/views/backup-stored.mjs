import { html, useAsync, useAction, useLanguage, useEffect, DataTable, EmptyState, Icon } from "../components/index.mjs";
import { t, tError, formatBytes, formatDateTime } from "../i18n.mjs";
import { api, download } from "../api.mjs";
import { toastSuccess } from "../ui.mjs";
import { storedRows } from "./backup-logic.mjs";

const load = () => api("GET", "/admin/api/backup/stored");

/** BAK-4 and BAK-5: the backups the bot made before each restore, so a bad restore can be undone without a shell. */
export function StoredCard({ refreshKey = 0 }) {
  useLanguage();
  const { data, error, loading, reload } = useAsync(load, []);
  const [busy, run] = useAction();

  // a restore just finished: a new pre-restore file exists
  useEffect(() => {
    if (refreshKey) reload();
  }, [refreshKey]);

  const rows = storedRows(data && data.items);

  const fetchOne = (row) =>
    run(async () => {
      const saved = await download("GET", row.path, undefined, row.name);
      toastSuccess(t("backup.stored_downloaded", { name: saved.filename }));
      return saved;
    });

  const columns = [
    { key: "name", label: t("backup.stored_col_name"), render: (row) => html`<span class="mono">${row.name}</span>` },
    { key: "createdAt", label: t("backup.stored_col_date"), render: (row) => html`<span class="nowrap">${row.createdAt ? formatDateTime(row.createdAt) : "-"}</span>` },
    { key: "size", label: t("backup.stored_col_size"), align: "right", render: (row) => formatBytes(row.size) },
    {
      key: "actions",
      label: "",
      render: (row) => html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => fetchOne(row)}>
        <${Icon} name="backup" />${t("backup.stored_download")}
      </button>`,
    },
  ];

  return html`<section class="card" aria-labelledby="backup-stored-title">
    <div class="view-header">
      <h2 class="card-title" id="backup-stored-title">${t("backup.stored_title")}</h2>
      <button type="button" class="btn btn-sm" disabled=${loading} onClick=${reload}><${Icon} name="refresh" />${t("common.refresh")}</button>
    </div>
    <p class="muted">${t("backup.stored_intro")}</p>
    ${error && !data
      ? html`<p class="field-error" role="alert">${tError(error)}</p>`
      : html`<${DataTable}
          columns=${columns}
          rows=${rows}
          rowKey="name"
          loading=${loading}
          caption=${t("backup.stored_title")}
          empty=${html`<${EmptyState} icon="info" title=${t("backup.stored_empty")} />`}
        />`}
  </section>`;
}

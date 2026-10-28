// The storage table (MNT-6, MNT-7, FR-056, US11 scenario 4): the bytes of each real category, the part of the
// broadcast media that a purge keeps, the free disk, and a purge behind a confirmation that says what is kept. The
// database shows its size only: it has no purge button.

import { html, useState, useAsync, useAction, DataTable, Spinner, EmptyState, Icon } from "../components/index.mjs";
import { t, tError, formatBytes, formatNumber, formatDateTime } from "../i18n.mjs";
import { api } from "../api.mjs";
import { confirm, toastSuccess } from "../ui.mjs";
import { buildStorageRows, buildDisk, totalBytes, describeSize, purgeState, purgeConfirmation, purgeResultMessage } from "./maintenance-logic.mjs";

const bytesText = (bytes, truncated) => {
  const size = describeSize(bytes, { truncated, format: formatBytes });
  if (!size.known) return t("maintenance.size_unknown");
  return size.atLeast ? t("maintenance.size_at_least", { size: size.text }) : size.text;
};

/** Confirmation parameters with the sizes already formatted for the sentence */
function confirmationText(row) {
  const asked = purgeConfirmation(row);
  return t(asked.messageKey, {
    size: row.bytes === null ? t("maintenance.size_unknown") : formatBytes(asked.params.size),
    items: formatNumber(asked.params.items),
    kept: formatNumber(asked.params.kept),
    keptBytes: formatBytes(asked.params.keptBytes),
  });
}

export function StorageCard() {
  const { data, error, loading, reload } = useAsync(() => api("GET", "/admin/api/maintenance/storage"), []);
  const [busy, run] = useAction();
  const [purging, setPurging] = useState(null);
  const [fresh, setFresh] = useState(null); // an answer to "refresh" replaces the loaded one
  const shown = fresh || data;
  const rows = buildStorageRows(shown);
  const disk = buildDisk(shown && shown.disk);

  const refresh = async () => {
    const answer = await run(() => api("GET", "/admin/api/maintenance/storage", { refresh: 1 }));
    if (answer) setFresh(answer);
  };

  const purge = async (row) => {
    const ok = await confirm({
      title: t("maintenance.purge_title", { name: t(row.labelKey) }),
      message: confirmationText(row),
      confirmLabel: t("maintenance.purge"),
    });
    if (!ok) return;
    setPurging(row.id);
    const result = await run(() => api("POST", `/admin/api/maintenance/storage/${encodeURIComponent(row.id)}/purge`, { confirm: true }));
    setPurging(null);
    if (!result) return;
    const message = purgeResultMessage(row.id, result);
    toastSuccess(t(message.key, { size: formatBytes(message.params.size), removed: formatNumber(message.params.removed), kept: formatNumber(message.params.kept) }));
    setFresh(null);
    await reload();
  };

  const columns = [
    {
      key: "label",
      label: t("maintenance.col_category"),
      render: (row) => html`<div>
        <strong>${t(row.labelKey)}</strong>
        ${row.noteKey ? html`<div class="muted">${t(row.noteKey)}</div>` : null}
      </div>`,
    },
    {
      key: "bytes",
      label: t("maintenance.col_size"),
      align: "right",
      render: (row) => html`<div>
        <span class="nowrap">${bytesText(row.bytes, row.truncated)}</span>
        ${
          row.id === "broadcast_media" && row.protectedBytes !== null
            ? html`<div class="muted nowrap">${t("maintenance.protected_part", { size: formatBytes(row.protectedBytes), count: formatNumber(row.protectedItems || 0) })}</div>`
            : null
        }
      </div>`,
    },
    {
      key: "items",
      label: t("maintenance.col_items"),
      align: "right",
      render: (row) => (row.items === null ? "" : t(row.unitKey, { count: row.items, n: formatNumber(row.items) })),
    },
    {
      key: "actions",
      label: t("maintenance.col_actions"),
      render: (row) => {
        const state = purgeState(row, purging);
        if (!state.show) return html`<span class="muted">${t("maintenance.size_only")}</span>`;
        return html`<button type="button" class="btn btn-sm btn-danger" disabled=${busy || state.disabled} onClick=${() => purge(row)}><${Icon} name="trash" />${t("maintenance.purge")}</button>`;
      },
    },
  ];

  return html`<section class="card" aria-labelledby="maintenance-storage-title">
    <h2 class="card-title" id="maintenance-storage-title">${t("maintenance.storage_title")}</h2>
    ${
      !shown
        ? loading
          ? html`<${Spinner} />`
          : html`<${EmptyState} icon="error" title=${error ? tError(error) : t("common.view_error")}>
              <button type="button" class="btn" onClick=${reload}>${t("common.retry")}</button>
            <//>`
        : html`<div class="stack-sm">
            <${DataTable} columns=${columns} rows=${rows} rowKey="id" caption=${t("maintenance.storage_title")} />
            <dl class="kv">
              <dt>${t("maintenance.total_used")}</dt><dd>${formatBytes(totalBytes(rows))}</dd>
              <dt>${t("maintenance.disk_free")}</dt><dd>${disk.freeBytes === null ? t("common.unknown") : t("maintenance.disk_of", { free: formatBytes(disk.freeBytes), total: formatBytes(disk.totalBytes || 0) })}</dd>
              ${rows.length ? html`<dt>${t("maintenance.measured_at")}</dt><dd>${shown.categories[0] && shown.categories[0].measuredAt ? formatDateTime(shown.categories[0].measuredAt, { dateStyle: "short", timeStyle: "medium" }) : ""}</dd>` : null}
            </dl>
            <div class="actions">
              <button type="button" class="btn btn-sm" disabled=${busy} onClick=${refresh}><${Icon} name="refresh" />${t("common.refresh")}</button>
            </div>
          </div>`
    }
  </section>`;
}

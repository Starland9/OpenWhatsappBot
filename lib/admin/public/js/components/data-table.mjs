import { html } from "./html.mjs";
import { t } from "../i18n.mjs";
import { Icon } from "./icon.mjs";
import { Spinner } from "./spinner.mjs";
import { EmptyState } from "./empty-state.mjs";

/** "Page 2 of 5" with previous / next. `page` is 1-based; nothing is shown when everything fits one page. */
export function Pagination({ page, pageSize, total, onPage, disabled = false }) {
  const pages = Math.max(1, Math.ceil((total || 0) / (pageSize || 1)));
  if (pages <= 1) return null;
  return html`<nav class="pagination" aria-label=${t("common.pagination")}>
    <span class="muted">${t("common.page_of", { page, pages, total })}</span>
    <div class="actions">
      <button type="button" class="btn btn-sm" disabled=${disabled || page <= 1} onClick=${() => onPage(page - 1)}><${Icon} name="chevron-left" />${t("common.previous")}</button>
      <button type="button" class="btn btn-sm" disabled=${disabled || page >= pages} onClick=${() => onPage(page + 1)}>${t("common.next")}<${Icon} name="chevron-right" /></button>
    </div>
  </nav>`;
}

function ariaSort(sort, column) {
  if (!column.sortable || !sort || sort.key !== column.key) return undefined;
  return sort.dir === "desc" ? "descending" : "ascending";
}

/**
 * Responsive table (a list of labelled cards under 600 px).
 *   columns: [{ key, label, render?(row, index), sortable?, align?: "right" }]
 *   rows, rowKey (property name or function), loading, empty (a node), caption (screen readers),
 *   sort { key, dir } + onSort(key), pagination { page, pageSize, total, onPage }.
 * Cell values are rendered as text; `render` may return nodes (never markup strings).
 */
export function DataTable({ columns, rows, rowKey = "id", loading = false, empty, caption, sort, onSort, pagination }) {
  const list = rows || [];
  if (loading && !list.length) return html`<${Spinner} />`;
  if (!list.length) return empty ?? html`<${EmptyState} icon="info" title=${t("common.empty")} />`;
  const keyOf = typeof rowKey === "function" ? rowKey : (row, index) => (row && row[rowKey] !== undefined ? row[rowKey] : index);
  return html`<div>
    <div class="table-wrap">
      <table class="table table-cards">
        ${caption ? html`<caption class="sr-only">${caption}</caption>` : null}
        <thead><tr>${columns.map(
          (column) => html`<th scope="col" class=${column.align === "right" ? "num" : undefined} aria-sort=${ariaSort(sort, column)}>${
            column.sortable && onSort
              ? html`<button type="button" class="th-btn" onClick=${() => onSort(column.key)}>${column.label}</button>`
              : column.label
          }</th>`,
        )}</tr></thead>
        <tbody>${list.map(
          (row, index) => html`<tr key=${keyOf(row, index)}>${columns.map(
            (column) => html`<td class=${column.align === "right" ? "num" : undefined} data-label=${column.label ?? ""}>${column.render ? column.render(row, index) : row[column.key]}</td>`,
          )}</tr>`,
        )}</tbody>
      </table>
    </div>
    ${pagination ? html`<${Pagination} ...${pagination} />` : null}
  </div>`;
}

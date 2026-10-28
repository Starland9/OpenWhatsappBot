// One tab of the data view for every kind but the economy: search and filters, the table, pagination and the row
// action (cancel a reminder, clear an AFK status, delete the rest), each one behind a confirmation (FR-039, FR-042,
// FR-044). The list is DATA-1, the action DATA-2.
import { html, useState, useEffect, useAsync, useAction, Field, DataTable, EmptyState } from "../components/index.mjs";
import { t, tError } from "../i18n.mjs";
import { api } from "../api.mjs";
import { confirm, toastSuccess, toastError } from "../ui.mjs";
import { columnsFor } from "./data-columns.mjs";
import {
  PAGE_SIZE,
  SEARCH_MAX,
  actionOf,
  appliesTo,
  emptyFilters,
  filterErrors,
  pageAfterRemoval,
  removalId,
  removalPath,
  tabQuery,
} from "./data-logic.mjs";

const STATUS_OPTIONS = ["pending", "all"];

/** The filters of a tab: only the ones that apply to its data */
function Filters({ kind, typed, onChange, errors }) {
  // functional updates: two edits before a re-render both survive
  const set = (name) => (value) => onChange((current) => ({ ...current, [name]: value }));
  return html`<form class="card form" role="search" onSubmit=${(event) => event.preventDefault()}>
    <div class="grid">
      ${appliesTo(kind, "q")
        ? html`<${Field} label=${t("data.search_label")} name="q" type="text" value=${typed.q} onChange=${set("q")} placeholder=${t(`data.search_placeholder.${kind}`)} maxLength=${SEARCH_MAX} />`
        : null}
      ${appliesTo(kind, "chat")
        ? html`<${Field} label=${t("data.chat_label")} name="chat" type="text" value=${typed.chat} onChange=${set("chat")} error=${errors.chat} hint=${t("data.chat_hint")} placeholder="120363000000000000@g.us" />`
        : null}
      ${appliesTo(kind, "status")
        ? html`<${Field} label=${t("data.status_label")} name="status" type="enum" value=${typed.status} onChange=${set("status")} options=${STATUS_OPTIONS.map((value) => ({ value, label: t(`data.status_filter_${value}`) }))} />`
        : null}
    </div>
  </form>`;
}

/** The text asked before the row action */
function confirmation(kind) {
  const action = actionOf(kind);
  return {
    title: t(`data.confirm_${action}_title`),
    message: t(`data.confirm_${action}_message.${kind}`),
    confirmLabel: t(`data.action_${action}`),
    danger: true,
  };
}

export function DataTab({ kind }) {
  const [typed, setTyped] = useState(emptyFilters());
  const [filters, setFilters] = useState(emptyFilters());
  const [page, setPage] = useState(1);
  const [busy, run] = useAction();

  // typing applies after a short pause and goes back to the first page
  useEffect(() => {
    const handle = setTimeout(() => {
      setFilters(typed);
      setPage(1);
    }, 300);
    return () => clearTimeout(handle);
  }, [typed]);

  const errors = filterErrors(kind, typed);
  const query = tabQuery(kind, filters, page, PAGE_SIZE);
  const blocked = Object.keys(filterErrors(kind, filters)).length > 0;
  const { data, error, loading, reload } = useAsync(
    () => (blocked ? Promise.resolve({ items: [], page: 1, pageSize: PAGE_SIZE, total: 0 }) : api("GET", `/admin/api/data/${kind}`, query)),
    [kind, JSON.stringify(query), blocked],
  );

  const act = async (row) => {
    const ok = await confirm(confirmation(kind));
    if (!ok) return;
    await run(
      async () => {
        let removed = false;
        try {
          const answer = await api("DELETE", removalPath(kind, removalId(kind, row)));
          removed = true;
          toastSuccess(t(answer && answer.cancelled ? "data.done_cancelled" : "data.done_deleted"));
        } catch (err) {
          // a reminder that was sent or cancelled meanwhile, a row already gone: say so, then show the list as it is
          toastError(err);
        }
        const next = removed ? pageAfterRemoval(page, data ? data.items.length : 1) : page;
        if (next !== page) setPage(next);
        else await reload();
      },
      { silent: true },
    );
  };

  const columns = columnsFor(kind, { busy, onAct: act });
  const filtered = Boolean(filters.q || filters.chat || (appliesTo(kind, "status") && filters.status === "all"));

  let body;
  if (error && !data) {
    body = html`<${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(error)}>
      <button type="button" class="btn" onClick=${reload}>${t("common.retry")}</button>
    <//>`;
  } else {
    body = html`<${DataTable}
      columns=${columns}
      rows=${data ? data.items : []}
      rowKey=${(row) => (kind === "afk" ? row.jid : row.id)}
      loading=${loading}
      caption=${t(`data.tab.${kind}`)}
      empty=${html`<${EmptyState} icon="data" title=${filtered ? t("data.no_match") : t(`data.empty.${kind}`)} message=${filtered ? t("data.no_match_hint") : t(`data.empty_hint.${kind}`)} />`}
      pagination=${data ? { page: data.page, pageSize: data.pageSize, total: data.total, onPage: setPage, disabled: loading } : undefined}
    />`;
  }

  return html`<div class="stack">
    <p class="muted">${t(`data.intro.${kind}`)}</p>
    <${Filters} kind=${kind} typed=${typed} onChange=${setTyped} errors=${errors} />
    ${body}
  </div>`;
}

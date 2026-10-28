// Destination picker of the broadcast form. Fed by CHAT-1 (`GET /admin/api/chats?selectable=1`) and nothing else:
// there is no field to type a number, the search box only filters the list of known chats (FR-046). The selection
// is held by the form (an array of destinations, at most 200).
import { html, useState, useEffect, useAsync, DataTable, EmptyState, Icon, Spinner, fieldErrorText } from "../components/index.mjs";
import { t, tError } from "../i18n.mjs";
import { api } from "../api.mjs";
import { MAX_TARGETS, pickerQuery, isSelected, toggleDestination, addDestinations, removeDestination } from "./broadcasts-logic.mjs";

const PAGE_SIZE = 50;

/** The chosen destinations, each with a remove button and the "may already have received it" flag */
function Selection({ selection, onChange, disabled }) {
  if (!selection.length) return html`<p class="muted">${t("broadcasts.selection_empty")}</p>`;
  return html`<ul class="row-wrap" aria-label=${t("broadcasts.selection_label")}>
    ${selection.map(
      (item) => html`<li key=${item.jid} class="chip" title=${item.jid}>
        <span class="chip-text">${item.name || t(`broadcasts.kind_chat_${item.kind}`)}</span>
        ${item.mayHaveBeenDelivered ? html`<span class="badge badge-warn" title=${t("broadcasts.unsure_hint")}>${t("broadcasts.unsure_flag")}</span>` : null}
        <button type="button" class="icon-btn" disabled=${disabled} aria-label=${t("broadcasts.remove_destination", { name: item.name || item.jid })} onClick=${() => onChange(removeDestination(selection, item.jid))}><${Icon} name="close" /></button>
      </li>`,
    )}
  </ul>`;
}

/**
 *   selection: [{ jid, name, kind, mayHaveBeenDelivered? }]    onChange(nextSelection)
 *   error: the `targets` field error ({ code, params } or text)
 */
export function DestinationPicker({ selection, onChange, error, disabled = false }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState("");
  const query = pickerQuery({ q, kind, page, pageSize: PAGE_SIZE });
  const { data, error: loadError, loading, reload } = useAsync(() => api("GET", "/admin/api/chats", query), [q, kind, page]);

  useEffect(() => setPage(1), [q, kind]);

  const items = (data && data.items) || [];
  const full = selection.length >= MAX_TARGETS;

  const toggle = (item) => {
    const result = toggleDestination(selection, item);
    setNotice(result.full ? t("broadcasts.selection_full", { max: MAX_TARGETS }) : "");
    onChange(result.selection);
  };

  const addPage = () => {
    const result = addDestinations(selection, items);
    setNotice(result.truncated ? t("broadcasts.selection_full", { max: MAX_TARGETS }) : "");
    onChange(result.selection);
  };

  const columns = [
    {
      key: "pick",
      label: t("broadcasts.col_pick"),
      render: (item) => html`<label class="choice"><input type="checkbox" checked=${isSelected(selection, item)} disabled=${disabled || (full && !isSelected(selection, item))} aria-label=${t("broadcasts.pick_destination", { name: item.name || item.jid })} onChange=${() => toggle(item)} /></label>`,
    },
    { key: "name", label: t("broadcasts.col_name"), render: (item) => html`<span>${item.name || html`<span class="muted">${t("broadcasts.no_name")}</span>`}</span>` },
    { key: "kind", label: t("broadcasts.col_kind"), render: (item) => t(`broadcasts.kind_chat_${item.kind}`) },
  ];

  return html`<div class="stack-sm">
    <p class="muted">${t("broadcasts.picker_hint")}</p>
    <div class="row-wrap">
      <div class="grow">
        <input class="input" type="search" value=${q} placeholder=${t("broadcasts.picker_search")} aria-label=${t("broadcasts.picker_search_label")} autocomplete="off" disabled=${disabled} onInput=${(event) => setQ(event.currentTarget.value)} />
      </div>
      <select class="select" value=${kind} aria-label=${t("broadcasts.picker_kind_label")} disabled=${disabled} onChange=${(event) => setKind(event.currentTarget.value)}>
        <option value="" selected=${kind === ""}>${t("broadcasts.picker_kind_all")}</option>
        <option value="private" selected=${kind === "private"}>${t("broadcasts.kind_chat_private")}</option>
        <option value="group" selected=${kind === "group"}>${t("broadcasts.kind_chat_group")}</option>
      </select>
      <button type="button" class="btn btn-sm" disabled=${disabled || !items.length || full} onClick=${addPage}>${t("broadcasts.picker_add_page")}</button>
      <button type="button" class="btn btn-sm" disabled=${disabled || !selection.length} onClick=${() => {
        setNotice("");
        onChange([]);
      }}>${t("broadcasts.picker_clear")}</button>
    </div>

    ${loading && !data ? html`<${Spinner} />` : null}
    ${loadError && !data
      ? html`<${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(loadError)}>
          <button type="button" class="btn" onClick=${reload}><${Icon} name="refresh" />${t("common.retry")}</button>
        <//>`
      : html`<${DataTable}
          columns=${columns}
          rows=${items}
          rowKey="jid"
          caption=${t("broadcasts.picker_caption")}
          empty=${html`<${EmptyState} icon="info" title=${t("broadcasts.picker_empty")} message=${t("broadcasts.picker_empty_hint")} />`}
          pagination=${data ? { page: data.page, pageSize: data.pageSize, total: data.total, onPage: setPage } : null}
        />`}

    <p class="field-hint" aria-live="polite">${t("broadcasts.selection_count", { count: selection.length, max: MAX_TARGETS })} ${notice}</p>
    <${Selection} selection=${selection} onChange=${onChange} disabled=${disabled} />
    ${error ? html`<div class="field-error" role="alert">${fieldErrorText(error)}</div>` : null}
  </div>`;
}

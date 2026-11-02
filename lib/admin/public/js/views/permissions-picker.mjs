// Picker of the rule editor for the "everywhere" scope (contracts/panel-ui.md section 6): the private chats the bot
// already knows (CHAT-1, `kind=private`, never `selectable`) and a number typed with its country code. It never lists
// group members and never reads the bot's connection, so it works with the bot offline. It holds no draft: the editor
// does (`onToggle` for a box, `onAdd` for a typed number; both answer `{ error }`).
import { html, useState, useAsync, useId, DataTable, EmptyState, Field, Icon, Spinner } from "../components/index.mjs";
import { t, tError } from "../i18n.mjs";
import { api } from "../api.mjs";
import { SEARCH_MAX, shortJid } from "./groups-logic.mjs";
import { chatQuery, parseNumber, personKey } from "./permissions-logic.mjs";

const PAGE_SIZE = 50;

/** The known private chats: a search box, a table with a box per chat, the number always shown beside the name */
function KnownContacts({ selected, max, disabled, onToggle }) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const searchId = `permissions-picker-search-${useId()}`;
  const query = chatQuery({ q, page, pageSize: PAGE_SIZE });
  const { data, error, loading, reload } = useAsync(() => api("GET", "/admin/api/chats", query), [q, page]);

  const picked = new Set((selected || []).map((person) => personKey(person.jid)));
  const full = (selected || []).length >= max;
  const items = (data && data.items) || [];

  const columns = [
    {
      key: "pick",
      label: t("permissions.col_pick"),
      render: (chat) => {
        const checked = picked.has(personKey(chat.jid));
        return html`<label class="choice"><input type="checkbox" checked=${checked} disabled=${disabled || (full && !checked)} aria-label=${t("permissions.pick_person", { person: shortJid(chat.jid) })} onChange=${() => onToggle({ jid: chat.jid, name: chat.name || null })} /></label>`;
      },
    },
    { key: "name", label: t("permissions.col_name"), render: (chat) => (chat.name ? html`<span>${chat.name}</span>` : html`<span class="muted">-</span>`) },
    { key: "number", label: t("permissions.col_number"), render: (chat) => html`<span class="mono">${shortJid(chat.jid)}</span>` },
  ];

  return html`<div class="stack-sm">
    <p class="muted">${t("permissions.picker_hint")}</p>
    <div class="field">
      <label class="field-label" for=${searchId}>${t("permissions.picker_search")}</label>
      <input id=${searchId} class="input" type="search" inputmode="search" maxlength=${SEARCH_MAX} value=${q} placeholder=${t("permissions.picker_search")} autocomplete="off" onInput=${(event) => {
        setQ(event.currentTarget.value);
        setPage(1);
      }} />
    </div>
    ${loading && !data ? html`<${Spinner} />` : null}
    ${error && !data
      ? html`<${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(error)}>
          <button type="button" class="btn" onClick=${reload}><${Icon} name="refresh" />${t("common.retry")}</button>
        <//>`
      : html`<${DataTable}
          columns=${columns}
          rows=${items}
          rowKey="jid"
          caption=${t("permissions.picker_title")}
          empty=${html`<${EmptyState} icon="info" title=${t("permissions.picker_empty")} />`}
          pagination=${data ? { page: data.page, pageSize: data.pageSize, total: data.total, onPage: setPage } : null}
        />`}
  </div>`;
}

/** The typed-number form: parseNumber first, nothing is added on an error, the field shows why */
function TypedNumber({ disabled, onAdd }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState(null);

  const submit = (event) => {
    event.preventDefault();
    const parsed = parseNumber(input);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const result = onAdd({ jid: parsed.jid, name: null });
    if (result && result.error) {
      setError(result.error);
      return;
    }
    setInput("");
    setError(null);
  };

  return html`<form class="row-wrap" onSubmit=${submit} noValidate>
    <div class="grow">
      <${Field}
        name="permissions-number"
        label=${t("permissions.number_label")}
        hint=${t("permissions.number_hint")}
        value=${input}
        onChange=${(value) => {
          setInput(value);
          setError(null);
        }}
        error=${error}
        inputMode="tel"
        maxLength=${32}
        disabled=${disabled}
      />
    </div>
    <div><button type="submit" class="btn" disabled=${disabled || !input.trim()}><${Icon} name="plus" />${t("permissions.number_add")}</button></div>
  </form>`;
}

/** PersonPicker({ selected, max, disabled, onToggle, onAdd }) */
export function PersonPicker({ selected, max, disabled = false, onToggle, onAdd }) {
  return html`<div class="stack-sm">
    <${KnownContacts} selected=${selected} max=${max} disabled=${disabled} onToggle=${onToggle} />
    <${TypedNumber} disabled=${disabled} onAdd=${onAdd} />
  </div>`;
}

// The recipient policy of a key (feature 004, contracts/panel-ui.md 7.5.2): three radios, the chips of the chosen
// recipients, the 003 PersonPicker (numbers, unchanged) and the group picker (CHAT-1 `kind=group`). The "anyone" radio
// asks first and reflects the click through a local `pendingMode` (a controlled Preact radio keeps the clicked box
// otherwise). No draft here: the editor holds it.
import { html, useState, useAsync, DataTable, EmptyState, Icon, Spinner } from "../components/index.mjs";
import { t, tError } from "../i18n.mjs";
import { api } from "../api.mjs";
import { PersonPicker } from "./permissions-picker.mjs";
import { personKey } from "./permissions-logic.mjs";
import { SEARCH_MAX, shortJid } from "./groups-logic.mjs";
import { POLICY_MODES, addRecipient, groupLabel, recipientChatQuery, recipientKind, removeRecipient, toggleRecipient } from "./api-logic.mjs";
import { errorText } from "./api-ips.mjs";

/** `GroupPicker({ selected, max, disabled, single, onToggle })`: the groups the bot knows, a box (or radio) per group. */
export function GroupPicker({ selected, max, disabled = false, single = false, onToggle }) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useAsync(() => api("GET", "/admin/api/chats", recipientChatQuery({ kind: "group", q, page })), [q, page]);
  const picked = new Set((selected || []).map((entry) => personKey(entry.jid)));
  const full = !single && (selected || []).length >= max;
  const columns = [
    {
      key: "pick",
      label: t("api.groups_col_pick"),
      render: (chat) => {
        const label = groupLabel(chat);
        const checked = picked.has(personKey(chat.jid));
        return html`<label class="choice"><input type=${single ? "radio" : "checkbox"} name="api-group-pick" checked=${checked} disabled=${disabled || (full && !checked)} aria-label=${t("api.groups_pick", { group: label.name || label.id })} onChange=${() => onToggle({ jid: chat.jid, name: chat.name || null })} /></label>`;
      },
    },
    { key: "name", label: t("api.groups_col_name"), render: (chat) => (chat.name ? html`<span>${chat.name}</span>` : html`<span class="muted">-</span>`) },
    { key: "id", label: t("api.groups_col_id"), render: (chat) => html`<span class="mono">${shortJid(chat.jid)}</span>` },
  ];
  return html`<div class="stack-sm">
    <div class="field">
      <label class="field-label" for="api-group-search">${t("api.groups_search")}</label>
      <input id="api-group-search" class="input" type="search" maxlength=${SEARCH_MAX} value=${q} autocomplete="off" onInput=${(event) => {
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
          rows=${(data && data.items) || []}
          rowKey="jid"
          caption=${t("api.recipients_groups")}
          empty=${html`<${EmptyState} icon="info" title=${t("api.groups_empty")} />`}
          pagination=${data ? { page: data.page, pageSize: data.pageSize, total: data.total, onPage: setPage } : null}
        />`}
  </div>`;
}

function Chip({ person, disabled, onRemove }) {
  const group = recipientKind(person.jid) === "group";
  const label = group ? groupLabel(person) : null;
  const text = group ? `${label.name || ""} ${label.id}`.trim() : shortJid(person.jid);
  return html`<li class="chip">
    <span class="chip-text">
      ${group ? html`<span class="badge">${t("api.kind_group")}</span> ${label.name ? html`<span>${label.name}</span> ` : null}<span class="mono">${label.id}</span>` : html`<span class="mono">${shortJid(person.jid)}</span>${person.name ? html` <span class="muted">${person.name}</span>` : null}`}
    </span>
    ${disabled ? null : html`<button type="button" class="icon-btn" aria-label=${t("api.recipients_remove", { recipient: text })} onClick=${onRemove}><${Icon} name="close" /></button>`}
  </li>`;
}

/** `RecipientsEditor({ mode, recipients, max, disabled, errors, onMode, onChange, askAnyone })` */
export function RecipientsEditor({ mode, recipients, max, disabled = false, errors = {}, onMode, onChange, askAnyone }) {
  const [pendingMode, setPendingMode] = useState(null);
  const [pickError, setPickError] = useState(null);
  const shown = pendingMode || mode;
  const listMode = mode === "list" && !disabled;
  const people = recipients || [];

  const choose = async (value) => {
    if (disabled || value === shown) return;
    if (value === "anyone" && mode !== "anyone") {
      setPendingMode("anyone");
      const ok = await askAnyone();
      setPendingMode(null);
      if (ok) onMode("anyone");
      return;
    }
    onMode(value);
  };

  const apply = (result) => {
    setPickError(result.error || null);
    if (!result.error) onChange(result.draft.recipients);
    return result;
  };
  const toggle = (entry) => apply(toggleRecipient({ recipients: people }, entry, { max }));
  // a typed number reports its own refusal inside the picker (it reads `result.error`): nothing to show twice
  const add = (entry) => {
    const result = addRecipient({ recipients: people }, entry, { max });
    if (!result.error) {
      setPickError(null);
      onChange(result.draft.recipients);
    }
    return result;
  };
  const remove = (jid) => {
    setPickError(null);
    onChange(removeRecipient({ recipients: people }, jid).recipients);
  };

  const hints = { list: ["api.policy_list", "api.policy_list_hint"], known: ["api.policy_known", "api.policy_known_hint"], anyone: ["api.policy_anyone", "api.policy_anyone_hint"] };
  const problem = errors.recipients ? errorText(errors.recipients) : pickError ? errorText(pickError.code ? { code: pickError.code, params: pickError.params } : pickError) : "";

  return html`<div class="stack">
    <fieldset class="choice-group">
      <legend>${t("api.policy_label")}</legend>
      ${POLICY_MODES.map(
        (value) => html`<label class="choice" key=${value}>
          <input type="radio" name="api-policy" value=${value} checked=${shown === value} disabled=${disabled} onChange=${() => choose(value)} />
          <span>${t(hints[value][0])} <span class="muted">${t(hints[value][1])}</span></span>
        </label>`,
      )}
    </fieldset>
    ${shown === "anyone" ? html`<div class="banner banner-warn" role="status"><div class="banner-body">${t("api.anyone_banner")}</div></div>` : null}
    <div class="stack-sm">
      ${people.length === 0 ? html`<p class="muted">${t("api.recipients_empty")}</p>` : html`<ul class="row-wrap">${people.map((person) => html`<${Chip} key=${personKey(person.jid)} person=${person} disabled=${!listMode} onRemove=${() => remove(person.jid)} />`)}</ul>`}
      <p class="muted">${t("api.recipients_max", { max })}</p>
    </div>
    <div class="stack-sm">
      <h3 class="field-label">${t("api.recipients_numbers")}</h3>
      <${PersonPicker} selected=${people} max=${max} disabled=${!listMode} onToggle=${toggle} onAdd=${add} />
    </div>
    <div class="stack-sm">
      <h3 class="field-label">${t("api.recipients_groups")}</h3>
      <${GroupPicker} selected=${people} max=${max} disabled=${!listMode} onToggle=${toggle} />
    </div>
    ${problem ? html`<div class="field-error" role="alert">${problem}</div>` : null}
  </div>`;
}


// The economy tab (DATA-1 for `economy`, DATA-3, FR-043): the balances of one group, and the adjustment form, "add" (the
// amount may be negative) or "set" (a target balance), with a mandatory reason that goes to the history. A debit that
// would take a balance below zero is flagged here when the list shows the balance, and refused by the server
// otherwise (422 negative_balance, nothing written); the balance shown after an adjustment is the one the server read back.
import { html, useState, useEffect, useAsync, useAction, useUnsavedGuard, Field, DataTable, EmptyState, Icon } from "../components/index.mjs";
import { t, tError, formatDateTime, formatNumber } from "../i18n.mjs";
import { api } from "../api.mjs";
import { toastSuccess, toastError } from "../ui.mjs";
import { Jid } from "./data-columns.mjs";
import {
  MODES,
  PAGE_SIZE,
  REASON_MAX,
  SEARCH_MAX,
  adjustmentErrors,
  adjustmentPayload,
  applyAdjustment,
  emptyAdjustment,
  filterErrors,
  formatDelta,
  knownBalance,
  projectedBalance,
  shortJid,
  tabQuery,
  validateAdjustment,
  canLoad,
} from "./data-logic.mjs";

/** The groups the bot knows (CHAT-1), for the picker; a left group stays listed, its balances are still data */
function useGroups() {
  const { data } = useAsync(() => api("GET", "/admin/api/chats", { kind: "group", pageSize: 200 }), []);
  return data ? data.items : [];
}

function GroupPicker({ groups, selected, typed, onSelect, onType, error }) {
  const options = [{ value: "", label: t("data.economy_pick_group") }].concat(
    groups.map((group) => ({ value: group.jid, label: `${group.name || t("data.unnamed_group")} (${shortJid(group.jid)})` })),
  );
  return html`<div class="grid">
    <${Field} label=${t("data.economy_group")} name="economy-group" type="enum" value=${selected} onChange=${onSelect} options=${options} />
    <${Field} label=${t("data.economy_group_typed")} name="economy-group-typed" type="text" value=${typed} onChange=${onType} error=${error} hint=${t("data.economy_group_hint")} placeholder="120363000000000000@g.us" />
  </div>`;
}

function AdjustForm({ form, onChange, balance, errors, busy, onSubmit, onClear }) {
  // functional updates: two edits before a re-render both survive
  const set = (name) => (value) => onChange((current) => ({ ...current, [name]: value }));
  const projected = projectedBalance(form.mode, form.amount, balance);
  return html`<form class="card form" onSubmit=${(event) => {
    event.preventDefault();
    onSubmit();
  }}>
    <h2 class="card-title">${t("data.economy_adjust_title")}</h2>
    <p class="muted">${t("data.economy_adjust_intro")}</p>
    <div class="grid">
      <${Field} label=${t("data.economy_member")} name="userJid" type="text" value=${form.userJid} onChange=${set("userJid")} error=${errors.userJid} hint=${t("data.economy_member_hint")} placeholder="237690000001" required />
      <${Field}
        label=${t("data.economy_mode")}
        name="mode"
        type="enum"
        value=${form.mode}
        onChange=${set("mode")}
        error=${errors.mode}
        options=${MODES.map((value) => ({ value, label: t(`data.economy_mode_${value}`) }))}
        hint=${t(`data.economy_mode_hint_${form.mode}`)}
      />
      <${Field} label=${t("data.economy_amount")} name="amount" type="int" value=${form.amount} onChange=${set("amount")} error=${errors.amount} min=${form.mode === "set" ? 0 : undefined} required />
    </div>
    <${Field}
      label=${t("data.economy_reason")}
      name="reason"
      type="textarea"
      rows=${2}
      value=${form.reason}
      onChange=${set("reason")}
      error=${errors.reason}
      maxLength=${REASON_MAX}
      hint=${t("data.economy_reason_hint", { max: REASON_MAX })}
      required
    />
    ${balance !== null && projected !== null && !errors.amount
      ? html`<p class="muted" role="status">${t("data.economy_preview", { from: formatNumber(balance), to: formatNumber(projected) })}</p>`
      : null}
    <div class="row-wrap">
      <button type="submit" class="btn btn-primary" disabled=${busy}><${Icon} name="check" />${t("data.economy_submit")}</button>
      <button type="button" class="btn" disabled=${busy} onClick=${onClear}>${t("data.economy_clear")}</button>
    </div>
  </form>`;
}

export function EconomyTab() {
  const groups = useGroups();
  const [selected, setSelected] = useState("");
  const [typedGroup, setTypedGroup] = useState("");
  const [typedQ, setTypedQ] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [form, setForm] = useState(emptyAdjustment());
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState(null);
  const [busy, run] = useAction();

  // the group typed by hand wins over the picker
  const groupJid = typedGroup.trim() || selected;
  const groupError = filterErrors("economy", { groupJid: typedGroup }).groupJid;
  const ready = canLoad("economy", { groupJid });

  useEffect(() => {
    const handle = setTimeout(() => {
      setQ(typedQ);
      setPage(1);
    }, 300);
    return () => clearTimeout(handle);
  }, [typedQ]);
  useEffect(() => {
    setPage(1);
  }, [groupJid]);

  const query = tabQuery("economy", { groupJid, q }, page, PAGE_SIZE);
  const { data, error, loading, reload } = useAsync(
    () => (ready ? api("GET", "/admin/api/data/economy", query) : Promise.resolve(null)),
    [JSON.stringify(query), ready],
  );
  const items = ready && data ? data.items : [];

  const draft = { ...form, groupJid };
  const balance = knownBalance(items, groupJid, form.userJid);
  const local = validateAdjustment(draft, balance);
  const dirty = Boolean(form.userJid || form.reason || (form.amount !== null && form.amount !== undefined));
  useUnsavedGuard("data-economy", dirty);
  // before a first submit only the negative-result warning shows; after it every problem does
  const errors = serverErrors || (submitted ? local : local.amount && local.amount.code === "negative_balance" ? { amount: local.amount } : {});

  const change = (next) => {
    setForm(next);
    setServerErrors(null);
  };
  const clear = () => {
    setForm(emptyAdjustment());
    setSubmitted(false);
    setServerErrors(null);
  };

  const submit = () => {
    setSubmitted(true);
    if (Object.keys(local).length) return undefined;
    return run(
      async () => {
        try {
          const answer = await api("POST", "/admin/api/data/economy/adjust", adjustmentPayload(draft));
          toastSuccess(t("data.economy_done", { balance: formatNumber(answer.balance), delta: formatDelta(answer.delta) }));
          setForm((current) => ({ ...current, amount: null, reason: "" }));
          setSubmitted(false);
          setServerErrors(null);
          await reload();
        } catch (err) {
          const fields = adjustmentErrors(err);
          if (fields) setServerErrors(fields);
          if (!fields || err.code === "negative_balance") toastError(err);
          if (fields && err.code === "negative_balance") await reload();
        }
      },
      { silent: true },
    );
  };

  const columns = [
    { key: "userJid", label: t("data.col_member"), render: (row) => html`<${Jid} jid=${row.userJid} />` },
    { key: "balance", label: t("data.col_balance"), align: "right", render: (row) => formatNumber(row.balance) },
    { key: "streak", label: t("data.col_streak"), align: "right", render: (row) => formatNumber(row.streak) },
    { key: "lastDailyAt", label: t("data.col_last_daily"), render: (row) => (row.lastDailyAt ? formatDateTime(row.lastDailyAt) : html`<span class="muted">${t("common.none")}</span>`) },
    {
      key: "actions",
      label: t("data.col_actions"),
      render: (row) =>
        html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => change((current) => ({ ...current, userJid: row.userJid, amount: null, reason: "" }))}>
          <${Icon} name="edit" />${t("data.economy_adjust")}
        </button>`,
    },
  ];

  let table;
  if (!ready) {
    table = html`<${EmptyState} icon="data" title=${t("data.economy_no_group")} message=${t("data.economy_no_group_hint")} />`;
  } else if (error && !data) {
    table = html`<${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(error)}>
      <button type="button" class="btn" onClick=${reload}>${t("common.retry")}</button>
    <//>`;
  } else {
    table = html`<${DataTable}
      columns=${columns}
      rows=${items}
      rowKey=${(row) => `${row.groupJid}:${row.userJid}`}
      loading=${loading}
      caption=${t("data.tab.economy")}
      empty=${html`<${EmptyState} icon="data" title=${q ? t("data.no_match") : t("data.empty.economy")} message=${q ? t("data.no_match_hint") : t("data.empty_hint.economy")} />`}
      pagination=${data ? { page: data.page, pageSize: data.pageSize, total: data.total, onPage: setPage, disabled: loading } : undefined}
    />`;
  }

  return html`<div class="stack">
    <p class="muted">${t("data.intro.economy")}</p>
    <div class="card form">
      <${GroupPicker} groups=${groups} selected=${selected} typed=${typedGroup} onSelect=${setSelected} onType=${setTypedGroup} error=${groupError} />
      ${ready
        ? html`<${Field} label=${t("data.search_label")} name="economy-q" type="text" value=${typedQ} onChange=${setTypedQ} placeholder=${t("data.search_placeholder.economy")} maxLength=${SEARCH_MAX} />`
        : null}
    </div>
    ${table}
    ${ready ? html`<${AdjustForm} form=${form} onChange=${change} balance=${balance} errors=${errors} busy=${busy} onSubmit=${submit} onClear=${clear} />` : null}
  </div>`;
}

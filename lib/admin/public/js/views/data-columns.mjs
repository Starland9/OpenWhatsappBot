// The columns of each tab of the data view (DATA-1 item shapes of contracts/admin-http-api.md 2.10) and the one
// button a row offers (cancel a reminder, clear an AFK status, delete the rest). Text cells are rendered as text.
import { html, Icon, StatusBadge } from "../components/index.mjs";
import { t, formatDateTime, formatNumber } from "../i18n.mjs";
import { actionOf, canAct, excerpt, shortJid, TEXT_EXCERPT } from "./data-logic.mjs";

const REMINDER_TONES = { pending: "info", sent: "ok", cancelled: "neutral", missed: "warn", failed: "danger" };

const Jid = ({ jid }) => (jid ? html`<span class="mono" title=${jid}>${shortJid(jid)}</span>` : html`<span class="muted">${t("common.none")}</span>`);

/** A long text cut to a line; the whole text stays in the tooltip */
const Excerpt = ({ value }) => html`<span title=${String(value ?? "")}>${excerpt(value, TEXT_EXCERPT)}</span>`;

const yesNo = (value) => (value ? t("common.yes") : t("common.no"));

/** The chat of a row: its name when the bot knows it, always its identifier */
function Chat({ jid, name }) {
  if (!jid) return html`<span class="muted">${t("common.none")}</span>`;
  return html`<div class="stack-sm">${name ? html`<span>${name}</span>` : null}<${Jid} jid=${jid} /></div>`;
}

/** The action button of a row (null when the row offers none) */
function RowAction({ kind, row, busy, onAct }) {
  if (!canAct(kind, row)) return null;
  const action = actionOf(kind);
  return html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => onAct(row)}>
    <${Icon} name=${action === "delete" ? "trash" : "close"} />${t(`data.action_${action}`)}
  </button>`;
}

/**
 * The columns of a tab. `ctx = { busy, onAct }`: `onAct(row)` asks for the confirmation and sends the request.
 * The economy tab has its own table (data-economy.mjs).
 */
export function columnsFor(kind, ctx) {
  const action = { key: "actions", label: t("data.col_actions"), render: (row) => html`<${RowAction} kind=${kind} row=${row} busy=${ctx.busy} onAct=${ctx.onAct} />` };
  switch (kind) {
    case "reminders":
      return [
        { key: "text", label: t("data.col_reminder"), render: (row) => html`<${Excerpt} value=${row.textPreview} />` },
        { key: "chat", label: t("data.col_chat"), render: (row) => html`<${Chat} jid=${row.chatJid} name=${row.chatName} />` },
        { key: "creator", label: t("data.col_author"), render: (row) => html`<${Jid} jid=${row.creatorJid} />` },
        { key: "dueAt", label: t("data.col_due"), render: (row) => formatDateTime(row.dueAt) },
        {
          key: "status",
          label: t("data.col_status"),
          render: (row) => html`<${StatusBadge} tone=${REMINDER_TONES[row.status] || "neutral"} label=${t(`data.status_${row.status}`)} />`,
        },
        action,
      ];
    case "keywords":
      return [
        { key: "keyword", label: t("data.col_keyword"), render: (row) => html`<strong>${row.keyword}</strong>` },
        { key: "userJid", label: t("data.col_member"), render: (row) => html`<${Jid} jid=${row.userJid} />` },
        { key: "scopeJid", label: t("data.col_group"), render: (row) => html`<${Jid} jid=${row.scopeJid} />` },
        { key: "enabled", label: t("data.col_enabled"), render: (row) => yesNo(row.enabled) },
        action,
      ];
    case "sticker-commands":
      return [
        { key: "command", label: t("data.col_command"), render: (row) => html`<strong>${row.command}</strong>` },
        { key: "stickerHash", label: t("data.col_sticker"), render: (row) => html`<span class="mono" title=${row.stickerHash}>${String(row.stickerHash).slice(0, 12)}</span>` },
        { key: "createdBy", label: t("data.col_created_by"), render: (row) => html`<${Jid} jid=${row.createdBy} />` },
        action,
      ];
    case "afk":
      return [
        {
          key: "jid",
          label: t("data.col_member"),
          render: (row) => html`<div class="stack-sm">${row.name ? html`<span>${row.name}</span>` : null}<${Jid} jid=${row.jid} /></div>`,
        },
        { key: "afkReason", label: t("data.col_reason"), render: (row) => (row.afkReason ? html`<${Excerpt} value=${row.afkReason} />` : html`<span class="muted">${t("common.none")}</span>`) },
        { key: "afkTime", label: t("data.col_since"), render: (row) => formatDateTime(row.afkTime) },
        action,
      ];
    case "tasks":
      return [
        { key: "text", label: t("data.col_task"), render: (row) => html`<${Excerpt} value=${row.text} />` },
        { key: "chatJid", label: t("data.col_chat"), render: (row) => html`<${Jid} jid=${row.chatJid} />` },
        {
          key: "done",
          label: t("data.col_status"),
          render: (row) => html`<${StatusBadge} tone=${row.done ? "ok" : "info"} label=${row.done ? t("data.task_done") : t("data.task_open")} />`,
        },
        { key: "createdBy", label: t("data.col_created_by"), render: (row) => html`<${Jid} jid=${row.createdBy} />` },
        { key: "doneBy", label: t("data.col_done_by"), render: (row) => html`<${Jid} jid=${row.doneBy} />` },
        action,
      ];
    case "ideas":
      return [
        { key: "text", label: t("data.col_idea"), render: (row) => html`<${Excerpt} value=${row.text} />` },
        { key: "category", label: t("data.col_category"), render: (row) => row.category },
        { key: "groupJid", label: t("data.col_group"), render: (row) => html`<${Jid} jid=${row.groupJid} />` },
        { key: "authorJid", label: t("data.col_author"), render: (row) => html`<${Jid} jid=${row.authorJid} />` },
        { key: "voters", label: t("data.col_votes"), align: "right", render: (row) => formatNumber(row.voters) },
        action,
      ];
    case "quotes":
      return [
        { key: "text", label: t("data.col_quote"), render: (row) => html`<${Excerpt} value=${row.text} />` },
        {
          key: "authorJid",
          label: t("data.col_author"),
          render: (row) => html`<div class="stack-sm">${row.authorName ? html`<span>${row.authorName}</span>` : null}<${Jid} jid=${row.authorJid} /></div>`,
        },
        { key: "groupJid", label: t("data.col_group"), render: (row) => html`<${Jid} jid=${row.groupJid} />` },
        { key: "savedBy", label: t("data.col_saved_by"), render: (row) => html`<${Jid} jid=${row.savedBy} />` },
        action,
      ];
    default:
      return [];
  }
}

export { Jid, Excerpt };

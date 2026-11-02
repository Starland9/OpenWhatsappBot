// The message detail page and its parts (feature 004, contracts/panel-ui.md 7.8): the facts, the timeline (`MessageSteps`,
// also used by the test result card) and the replies of an interactive message (`ResponsesCard`). The status is polled
// by `useMessage`; recipients are shown in full (FR-073 masks logs only) and no message content exists to show.
import { html, EmptyState, Icon, Spinner, StatusBadge } from "../components/index.mjs";
import { t, formatBytes, formatDateTime } from "../i18n.mjs";
import { toast } from "../ui.mjs";
import { buildHash } from "../router.mjs";
import { authorLabel, choiceLabel, copyText, failureText, pollBars, recipientCell, sourceCell, statusTone, stepRows } from "./api-logic.mjs";
import { useMessage } from "./api-watch.mjs";

/** The badge of a message status. */
export function MessageStatus({ status }) {
  return html`<${StatusBadge} tone=${statusTone(status)} label=${t(`api.msg_status.${status}`)} />`;
}

/** `MessageSteps({ message })`: the lifecycle by time, one line per step. */
export function MessageSteps({ message }) {
  return html`<section class="stack-sm">
    <h3 class="card-title">${t("api.timeline_title")}</h3>
    <ol class="stack-sm">
      ${stepRows(message).map((step) => html`<li class="row-wrap" key=${`${step.status}:${step.at}`}><${MessageStatus} status=${step.status} /><span class="muted">${formatDateTime(step.at, { dateStyle: "short", timeStyle: "medium" })}</span></li>`)}
    </ol>
  </section>`;
}

function ChoiceCells({ choices, format }) {
  if (!choices || choices.length === 0) return html`<span class="muted">-</span>`;
  return choices.map((choice, index) => {
    const label = choiceLabel(choice, index, format);
    return html`<span class="row-wrap" key=${String(choice.id)}><span class="mono">${String(choice.id)}</span><span>${label.key ? t(label.key, label.params) : label.label !== String(choice.id) ? label.label : ""}</span></span>`;
  });
}

/** `ResponsesCard({ message, state })`: replies to buttons and lists, votes and totals for a poll. */
export function ResponsesCard({ message, state }) {
  const responses = message.responses;
  const items = responses && Array.isArray(responses.items) ? responses.items : [];
  const poll = message.format === "poll";
  const days = state && state.settings ? state.settings.replyWindowDays : "";
  const bars = poll && responses && responses.totals ? pollBars(responses.totals) : [];
  return html`<section class="card stack-sm">
    <h3 class="card-title">${t("api.responses_title")}</h3>
    ${poll && bars.length
      ? html`<h4 class="field-label">${t("api.responses_totals_title")}</h4>
          <ol class="bar-list">
            ${bars.map((bar, index) => {
              const label = choiceLabel({ id: bar.id, label: bar.label }, index, "poll");
              const text = label.key ? t(label.key, label.params) : label.label;
              return html`<li key=${String(bar.id)}>
                <div class="row"><span class="grow">${text}</span><strong>${bar.count}</strong></div>
                <progress max="1" value=${bar.ratio} aria-label=${text}></progress>
              </li>`;
            })}
          </ol>`
      : null}
    ${items.length === 0
      ? html`<p class="muted">${t("api.responses_empty")}</p>`
      : html`${poll ? html`<h4 class="field-label">${t("api.responses_voters_title")}</h4>` : null}
          <div class="table-wrap">
            <table class="table table-cards">
              <thead><tr><th scope="col">${t("api.responses_col_when")}</th><th scope="col">${t("api.responses_col_author")}</th><th scope="col">${t("api.responses_col_choice")}</th></tr></thead>
              <tbody>
                ${items.map(
                  (item, index) => html`<tr key=${`${item.author}:${item.at}:${index}`}>
                    <td data-label=${t("api.responses_col_when")}>${formatDateTime(item.at, { dateStyle: "short", timeStyle: "medium" })}</td>
                    <td data-label=${t("api.responses_col_author")}><span class="mono">${authorLabel(item.author)}</span></td>
                    <td data-label=${t("api.responses_col_choice")}><${ChoiceCells} choices=${item.choices} format=${message.format} />${item.via ? html` <span class="muted mono">${item.via}</span>` : null}</td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>`}
    <p class="muted">${t("api.responses_window", { days })}</p>
  </section>`;
}

/** `MessageDetail({ id, state, catalog })`, route `#/api/history/<id>`. */
export function MessageDetail({ id, state, catalog }) {
  const valid = /^[1-9]\d{0,9}$/.test(String(id));
  const { message, error, loading, polling, refresh } = useMessage({ id: valid ? String(id) : "0" });
  const back = html`<a class="btn" href=${buildHash("api", [], { tab: "history" })}><${Icon} name="chevron-left" />${t("api.back_history")}</a>`;

  if (!valid || (error && !message && (error.code === "not_found" || error.status === 404))) {
    return html`<${EmptyState} icon="info" title=${t("api.detail_not_found")}>${back}<//>`;
  }
  if (!message) {
    if (error) {
      return html`<${EmptyState} icon="error" title=${t("common.view_error")}>
        <button type="button" class="btn" onClick=${refresh}><${Icon} name="refresh" />${t("common.retry")}</button>${back}
      <//>`;
    }
    return html`<${Spinner} />`;
  }

  const source = sourceCell(message);
  const recipient = recipientCell(message);
  const failure = message.failureCode ? failureText(message.failureCode) : null;
  const format = (catalog.formats || []).find((item) => item.name === message.format);
  const copy = async () => {
    if ((await copyText(message.publicId)) === "manual") toast(t("api.copy_manual"), { kind: "info" });
  };

  return html`<div class="stack">
    <div class="view-header">
      <h1>${t("api.detail_title", { id: message.id })}</h1>
      <div class="row-wrap">
        <${MessageStatus} status=${message.status} />
        <button type="button" class="btn btn-sm" disabled=${loading} onClick=${refresh}><${Icon} name="refresh" />${t("api.watch_refresh")}</button>
        ${back}
      </div>
    </div>
    <p class="muted" role="status">${polling ? t("api.watch_live") : t("api.watch_stopped")}</p>
    <section class="card">
      <dl class="kv">
        <dt>${t("api.detail_public_id")}</dt><dd><span class="mono">${message.publicId}</span> <button type="button" class="icon-btn" aria-label=${t("api.secret_copy")} onClick=${copy}><${Icon} name="copy" /></button></dd>
        <dt>${t("api.detail_source")}</dt><dd>${source.kind === "panel" ? t("api.source_panel") : source.kind === "key" ? source.name : t("api.source_key_gone")}</dd>
        <dt>${t("api.detail_recipient")}</dt><dd><span class="mono">${recipient.number}</span>${recipient.name ? html` ${recipient.name}` : null}${recipient.group ? html` <span class="badge">${t("api.kind_group")}</span>` : null}</dd>
        <dt>${t("api.detail_format")}</dt><dd>${format ? t(format.labelKey) : message.format}</dd>
        <dt>${t("api.detail_size")}</dt><dd>${message.size === null || message.size === undefined ? "-" : formatBytes(message.size)}</dd>
        <dt>${t("api.detail_wa_id")}</dt><dd>${message.waId ? html`<span class="mono">${message.waId}</span>` : "-"}</dd>
        <dt>${t("api.detail_accepted")}</dt><dd>${formatDateTime(message.acceptedAt, { dateStyle: "short", timeStyle: "medium" })}</dd>
        <dt>${t("api.detail_expires")}</dt><dd>${formatDateTime(message.expiresAt, { dateStyle: "short", timeStyle: "medium" })}</dd>
        <dt>${t("api.detail_failure")}</dt><dd>${failure ? html`${failure.key ? t(failure.key) : null} <span class="mono">${failure.code}</span>` : "-"}</dd>
      </dl>
    </section>
    <section class="card"><${MessageSteps} message=${message} /></section>
    ${message.interactive ? html`<${ResponsesCard} message=${message} state=${state} />` : null}
  </div>`;
}

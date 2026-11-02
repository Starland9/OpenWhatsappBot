// The state card of the API area (feature 004, contracts/panel-ui.md 7.2): the on/off switch with its two confirmation
// flows, the banners that explain a degraded state, and the read-only summary of the limits in force. The limits are
// Settings entries (SET-2 is their only writer): this page shows them and links there.
import { html, useState, useAction, Icon, StatusBadge } from "../components/index.mjs";
import { t, formatDateTime } from "../i18n.mjs";
import { api } from "../api.mjs";
import { confirm, toast, toastSuccess, isInsecureRemote } from "../ui.mjs";
import { buildHash } from "../router.mjs";
import { withStepUp } from "../reauth.mjs";
import { widenings, copyText } from "./api-logic.mjs";
import { typeKeys } from "./alerts-logic.mjs";

const base = "/admin/api/api";

const ALERT_ROWS = [
  { type: "api_origin_blocked", key: "originBlocked" },
  { type: "api_key_new_ip", key: "keyNewIp" },
  { type: "api_paused", key: "paused" },
];

/** The banners of a degraded state, in the order of the contract. */
export function StateBanners({ state }) {
  const paused = state.pausedUntil && Date.parse(state.pausedUntil) > Date.now();
  const minutes = state.settings ? state.settings.expiryMin : "";
  const banner = (tone, text) => html`<div class=${`banner banner-${tone}`} role="status"><${Icon} name=${tone === "error" ? "error" : tone === "warn" ? "warning" : "info"} /><div class="banner-body">${text}</div></div>`;
  return html`<div class="stack-sm">
    ${state.failure ? banner("error", t("api.state_registry_failed", { endpoint: state.failure.endpoint || "?" })) : null}
    ${!state.enabled ? banner("info", t("api.state_disabled_banner")) : null}
    ${paused ? banner("warn", t("api.state_paused", { time: formatDateTime(state.pausedUntil) })) : null}
    ${state.enabled && !state.botReady ? banner("warn", t("api.state_bot_offline", { minutes })) : null}
    ${isInsecureRemote() ? banner("warn", t("api.state_http_warning")) : null}
  </div>`;
}

/** The limits in force (read-only) and the three alert toggles, with links to the pages that edit them. */
export function LimitsSummary({ settings }) {
  const s = settings || {};
  const keys = s.settingKeys || {};
  const alerts = s.alerts || {};
  return html`<div class="stack-sm">
    <h3 class="field-label">${t("api.settings_title")}</h3>
    <p class="muted">${t("api.settings_hint")}</p>
    <ul class="stack-sm">
      <li>${t("api.settings_spacing", { seconds: Math.round((s.minSpacingMs || 0) / 1000) })}</li>
      <li>${t("api.settings_per_minute", { count: s.perMinute })}</li>
      <li>${t("api.settings_per_day", { count: s.perDay })}</li>
      <li>${t("api.settings_pending", { count: s.maxPending })}</li>
      <li>${t("api.settings_queue_max", { count: s.queueMax })}</li>
      <li>${t("api.settings_expiry", { minutes: s.expiryMin })}</li>
      <li>${t("api.settings_retention", { days: s.retentionDays })}</li>
      <li>${t("api.settings_reply_window", { days: s.replyWindowDays })}</li>
    </ul>
    <dl class="kv">
      ${ALERT_ROWS.map(
        (row) => html`<dt key=${row.type}>${t(typeKeys(row.type).title)}</dt><dd key=${`${row.type}:v`}><${StatusBadge} tone=${alerts[row.key] ? "ok" : "neutral"} label=${alerts[row.key] ? t("api.state_on") : t("api.state_off")} /></dd>`,
      )}
    </dl>
    <div class="row-wrap">
      <a class="btn btn-sm" href=${buildHash("settings", keys.perMinute ? [keys.perMinute] : [])}>${t("api.settings_open")}</a>
      <a class="btn btn-sm" href=${buildHash("alerts")}>${t("api.settings_alerts")}</a>
    </div>
  </div>`;
}

// the question comes first, directly above the call that sends `confirm: true` (the confirmation guard looks for it)
async function askDisable(queued) {
  return confirm({
    title: t("api.disable_title"),
    message: queued ? t("api.disable_message", { count: queued }) : t("api.disable_message_none"),
    confirmLabel: t("api.disable_confirm"),
  });
}

async function disableApi(state) {
  if (!(await askDisable(state.queued))) return null;
  return api("PUT", `${base}/state`, { enabled: false, confirm: true });
}

/** `EnableCard({ state, onChanged })`: status, base address, the switch, the limits in force. */
export function EnableCard({ state, onChanged }) {
  const [busy, run] = useAction();
  const [copied, setCopied] = useState(false);

  const enable = () =>
    run(async () => {
      const ok = await confirm({ danger: false, title: t("api.enable_title"), message: t("api.enable_warning"), confirmLabel: t("api.enable_confirm") });
      if (!ok) return;
      const result = await withStepUp(() => api("PUT", `${base}/state`, { enabled: true }), {
        needed: widenings({ enabled: false }, { enabled: true }).length > 0,
        reasons: ["enable"],
      });
      if (!result.ok) return;
      toastSuccess(t("api.enable_done"));
      onChanged();
    });

  const disable = () =>
    run(async () => {
      const answer = await disableApi(state);
      if (!answer) return;
      const cancelled = typeof answer.cancelled === "number" ? answer.cancelled : 0;
      toastSuccess(t("api.disable_done", { count: cancelled, cancelled }));
      onChanged();
    });

  const copy = async () => {
    const outcome = await copyText(state.baseUrl);
    if (outcome === "copied") setCopied(true);
    else toast(t("api.copy_manual"), { kind: "info" });
  };

  return html`<section class="card stack">
    <div class="row-wrap">
      <h2 class="card-title grow">${t("api.state_title")}</h2>
      <${StatusBadge} tone=${state.enabled ? "ok" : "neutral"} label=${state.enabled ? t("api.state_on") : t("api.state_off")} />
    </div>
    ${state.changedAt ? html`<p class="muted">${t("api.state_since", { when: formatDateTime(state.changedAt) })}</p>` : null}
    ${state.queued ? html`<p class="muted">${t("api.state_queued", { count: state.queued })}</p>` : null}
    <div class="row-wrap">
      <span class="muted">${t("api.state_base_url")}</span>
      <span class="mono">${state.baseUrl}</span>
      <button type="button" class="icon-btn" aria-label=${copied ? t("api.secret_copied") : t("api.secret_copy")} onClick=${copy}><${Icon} name="copy" /></button>
    </div>
    <div>
      ${state.enabled
        ? html`<button type="button" class="btn btn-danger" disabled=${busy} onClick=${disable}>${t("api.disable_button")}</button>`
        : html`<button type="button" class="btn btn-primary" disabled=${busy || Boolean(state.failure)} onClick=${enable}>${t("api.enable_button")}</button>`}
    </div>
    <${LimitsSummary} settings=${state.settings} />
  </section>`;
}

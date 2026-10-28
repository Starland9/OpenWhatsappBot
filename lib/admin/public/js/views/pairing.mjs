import { html, useState, useEffect, useRef, useLive, useAsync, useAction, Field, Spinner, StatusBadge, EmptyState } from "../components/index.mjs";
import { t, formatDateTime } from "../i18n.mjs";
import { api } from "../api.mjs";
import { confirm, toastSuccess, toastError } from "../ui.mjs";
import {
  normalizePairing,
  panelFor,
  qrSource,
  validatePhone,
  codeFromAnswer,
  codeIsLive,
  secondsLeft,
  cooldownLeftMs,
  formatCountdown,
  toMs,
} from "./pairing-logic.mjs";

export const meta = { area: "pairing", titleKey: "pairing.title", icon: "pairing" };

// The texts of the two confirmed actions (PAIR-4): "logout" for a paired bot, "repair" after the device was unlinked.
const ACTION_TEXTS = {
  logout: {
    button: "pairing.logout",
    title: "pairing.logout_title",
    message: "pairing.logout_message",
    confirm: "pairing.logout_confirm",
    done: "pairing.logout_done",
  },
  repair: {
    button: "pairing.repair",
    title: "pairing.repair_title",
    message: "pairing.repair_message",
    confirm: "pairing.repair_confirm",
    done: "pairing.repair_done",
  },
};

/** Re-render every second while `active` (a countdown is on screen); the views read the clock themselves. */
function useTick(active) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
}

/** PAIR-2: the image is addressed by the QR version, so each renewal loads a new picture. */
function QrCard({ view }) {
  const src = qrSource(view);
  const version = view.qr ? view.qr.version : null;
  const [failed, setFailed] = useState(null); // the version whose picture could not be loaded
  const broken = src !== null && failed === version;
  return html`<section class="card">
    <h2 class="card-title">${t("pairing.qr_title")}</h2>
    <div class="stack">
      <ol class="stack-sm">
        <li>${t("pairing.qr_step1")}</li>
        <li>${t("pairing.qr_step2")}</li>
        <li>${t("pairing.qr_step3")}</li>
      </ol>
      ${src && !broken
        ? html`<img key=${version} class="qr" src=${src} alt=${t("pairing.qr_alt")} onError=${() => setFailed(version)} />`
        : html`<${Spinner} label=${broken ? t("pairing.qr_error") : t("pairing.qr_waiting")} />`}
      <p class="muted">${t("pairing.qr_renews")}</p>
    </div>
  </section>`;
}

/** PAIR-3: the number form, the code (shown once, in memory only) and its countdown. */
function CodeCard({ view, phone, setPhone, phoneError, issued, now, cooldownUntil, busy, onSubmit }) {
  const live = codeIsLive(issued, now);
  const wait = Math.ceil(cooldownLeftMs(cooldownUntil, now) / 1000);
  const pendingUntil = view.code && view.code.pending ? toMs(view.code.expiresAt) : null;
  return html`<section class="card">
    <h2 class="card-title">${t("pairing.code_title")}</h2>
    <form class="form" onSubmit=${onSubmit} noValidate>
      <${Field}
        label=${t("pairing.phone_label")}
        name="phone"
        type="text"
        inputMode="tel"
        autoComplete="tel"
        placeholder=${t("pairing.phone_placeholder")}
        hint=${t("pairing.phone_hint")}
        value=${phone}
        onChange=${setPhone}
        error=${phoneError}
        required
      />
      <div class="actions">
        <button type="submit" class="btn btn-primary" disabled=${busy || wait > 0}>${t("pairing.code_request")}</button>
        ${wait > 0 ? html`<span class="muted" role="status">${t("pairing.code_retry_in", { seconds: wait })}</span>` : null}
      </div>
    </form>
    ${live
      ? html`<div class="stack-sm" role="status">
          <h3>${t("pairing.code_result_title")}</h3>
          <p class="pairing-code mono"><strong>${issued.code}</strong></p>
          <p>${t("pairing.code_valid_for", { time: formatCountdown(secondsLeft(issued.deadline, now)) })}</p>
          <p class="muted">${t("pairing.code_instructions")}</p>
        </div>`
      : issued
        ? html`<p class="muted" role="status">${t("pairing.code_expired")}</p>`
        : pendingUntil
          ? html`<p class="muted">${t("pairing.code_pending", { time: formatDateTime(pendingUntil, { timeStyle: "short" }) })}</p>`
          : null}
  </section>`;
}

function ConnectedCard({ view, action, busy, onAction }) {
  return html`<section class="card">
    <h2 class="card-title">${t("pairing.connected_title")}</h2>
    <div class="stack">
      <dl class="kv">
        <dt>${t("pairing.connected_number")}</dt><dd class="mono">${view.number ? `+${view.number}` : t("common.unknown")}</dd>
      </dl>
      <p class="muted">${t("pairing.connected_hint")}</p>
      ${action ? html`<div><button type="button" class="btn btn-danger" disabled=${busy} onClick=${() => onAction(action)}>${t(ACTION_TEXTS[action].button)}</button></div>` : null}
    </div>
  </section>`;
}

/** Every state that is neither paired nor ready to pair: a sentence naming it, and the button that still makes sense. */
function NoticeCard({ panel, action, busy, onAction }) {
  const waiting = panel.kind === "waiting";
  return html`<section class="card">
    <div class="stack">
      ${waiting ? html`<${Spinner} label=${t(panel.statusKey)} />` : html`<p role="status">${t(panel.statusKey)}</p>`}
      ${action ? html`<div><button type="button" class=${`btn ${action === "repair" ? "btn-primary" : "btn-danger"}`} disabled=${busy} onClick=${() => onAction(action)}>${t(ACTION_TEXTS[action].button)}</button></div>` : null}
    </div>
  </section>`;
}

/** PAIR-1 to PAIR-4: pair the bot from the browser, by QR code or by phone number, or disconnect the session. */
export default function PairingView() {
  const loaded = useAsync(() => api("GET", "/admin/api/pairing"), []);
  const [view, setView] = useState(null);
  const [phone, setPhone] = useState("");
  const [phoneError, setPhoneError] = useState(null);
  const [issued, setIssued] = useState(null); // { code, deadline, cooldownUntil }: the code lives here and nowhere else
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [busy, run] = useAction();
  const seenStatus = useRef(null);

  // The first answer, then the live `pairing` events (QR renewals and status changes).
  useEffect(() => {
    if (!loaded.data) return;
    setView((previous) => normalizePairing(loaded.data, previous));
    if (loaded.data.codeCooldownMs > 0) setCooldownUntil(Date.now() + loaded.data.codeCooldownMs);
  }, [loaded.data]);
  useLive("pairing", (payload) => setView((previous) => normalizePairing(payload, previous)));

  const status = view ? view.status : null;
  const registered = view ? view.registered : false;

  // The pairing went through: forget the code, say so once.
  useEffect(() => {
    if (!status) return;
    if (status === "open") {
      setIssued(null);
      if (seenStatus.current && seenStatus.current !== "open") toastSuccess(t("pairing.connected_toast"));
    }
    seenStatus.current = status;
  }, [status, registered]);

  const now = Date.now();
  useTick(codeIsLive(issued, now) || cooldownUntil > now);

  const submit = async (event) => {
    event.preventDefault();
    const check = validatePhone(phone);
    setPhoneError(check.error);
    if (!check.ok) return;
    await run(
      async () => {
        try {
          const answer = await api("POST", "/admin/api/pairing/code", { phone: check.phone });
          const received = Date.now();
          const next = codeFromAnswer(answer, received);
          setIssued(next);
          setCooldownUntil(next.cooldownUntil);
          setPhoneError(null);
        } catch (err) {
          if (err.code === "validation_failed" && err.fields && err.fields.phone) {
            setPhoneError(err.fields.phone);
            return;
          }
          if (err.code === "rate_limited" && err.retryAfterMs) setCooldownUntil(Date.now() + err.retryAfterMs);
          if (err.code === "already_paired" || err.code === "not_connected") loaded.reload();
          toastError(err);
        }
      },
      { silent: true },
    );
  };

  const disconnect = async (action) => {
    const texts = ACTION_TEXTS[action];
    const ok = await confirm({ title: t(texts.title), message: t(texts.message), confirmLabel: t(texts.confirm) });
    if (!ok) return;
    await run(async () => {
      await api("POST", "/admin/api/pairing/logout", { confirm: true });
      setIssued(null);
      setCooldownUntil(0);
      toastSuccess(t(texts.done));
      await loaded.reload();
    });
  };

  if (!view) {
    return html`<section class="view stack">
      <div class="view-header"><h1>${t("pairing.title")}</h1></div>
      ${loaded.error
        ? html`<${EmptyState} icon="error" title=${t("common.view_error")} message=${t("common.view_error_hint")}>
            <button type="button" class="btn" onClick=${() => loaded.reload()}>${t("common.retry")}</button>
          <//>`
        : html`<${Spinner} />`}
    </section>`;
  }

  const panel = panelFor(view);
  let body;
  if (panel.kind === "connected") {
    body = html`<${ConnectedCard} view=${view} action=${panel.logoutAction} busy=${busy} onAction=${disconnect} />`;
  } else if (panel.kind === "pairing") {
    body = html`<div class="grid">
      <${QrCard} view=${view} />
      <${CodeCard} view=${view} phone=${phone} setPhone=${setPhone} phoneError=${phoneError} issued=${issued} now=${now} cooldownUntil=${cooldownUntil} busy=${busy} onSubmit=${submit} />
    </div>`;
  } else {
    body = html`<${NoticeCard} panel=${panel} action=${panel.logoutAction} busy=${busy} onAction=${disconnect} />`;
  }

  return html`<section class="view stack">
    <div class="view-header">
      <h1>${t("pairing.title")}</h1>
      <${StatusBadge} status=${view.status} />
    </div>
    ${body}
  </section>`;
}

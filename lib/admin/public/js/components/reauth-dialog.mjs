import { html, useEffect, useRef, useId, useState } from "./html.mjs";
import { Field } from "./field.mjs";
import { useStore } from "./hooks.mjs";
import { t, tError, hasKey } from "../i18n.mjs";
import { reauthStore, resolveReauth, submitPassword, classifyReauthError } from "../reauth.mjs";

const WINDOW_MINUTES = 5;

/**
 * The password modal of the step-up (contracts/panel-ui.md section 6), on the native <dialog> guarded like
 * ConfirmView. `request.reasons` are the codes of admin-api.md 1.5 (`api.reason_<code>`, a code without a text is
 * shown raw). Escape and Cancel resolve false; while the password is being checked both are ignored.
 * The password lives in the input and one useState: cleared on success, on a refusal, on cancel and on unmount.
 */
export function ReauthView({ request, onResolve }) {
  const ref = useRef(null);
  const bodyRef = useRef(null);
  const uid = useId();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState(null);
  const [banner, setBanner] = useState(null);
  const [focusTick, setFocusTick] = useState(0);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open && typeof dialog.showModal === "function") dialog.showModal();
    return () => {
      if (dialog && dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, []);

  // after a refusal the input is enabled again only once the render is done: focus it from an effect, not from the handler
  useEffect(() => {
    if (focusTick === 0) return;
    const body = bodyRef.current;
    const input = body && typeof body.querySelector === "function" ? body.querySelector("input") : null;
    if (input && typeof input.focus === "function") input.focus();
  }, [focusTick]);

  const cancel = () => {
    if (busy) return;
    setPassword("");
    onResolve(false);
  };

  const submit = async (event) => {
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    if (busy || password === "") return;
    setBusy(true);
    setBanner(null);
    setFieldError(null);
    try {
      await submitPassword(password);
      setPassword("");
      setBusy(false);
      onResolve(true);
    } catch (err) {
      setBusy(false);
      const kind = classifyReauthError(err);
      if (kind === "wrong") {
        setFieldError(err.fields.password);
        setPassword("");
        setFocusTick((n) => n + 1);
      } else {
        setBanner(tError(err));
      }
    }
  };

  const reasons = Array.isArray(request.reasons) ? request.reasons : [];
  return html`<dialog ref=${ref} class="dialog" aria-labelledby=${`${uid}-t`} aria-describedby=${`${uid}-m`} onCancel=${(event) => {
    event.preventDefault();
    cancel();
  }}>
    <div class="dialog-inner">
      <h2 class="dialog-title" id=${`${uid}-t`}>${t("reauth.title")}</h2>
      <p class="dialog-message" id=${`${uid}-m`}>${t("reauth.message", { minutes: WINDOW_MINUTES })}</p>
      ${reasons.length
        ? html`<div class="stack-sm">
            <p class="muted">${t("reauth.reasons_title")}</p>
            <ul class="stack-sm">${reasons.map((code) => html`<li key=${code}>${hasKey(`api.reason_${code}`) ? t(`api.reason_${code}`) : html`<span class="mono">${code}</span>`}</li>`)}</ul>
          </div>`
        : null}
      <form onSubmit=${submit}>
        <div class="stack-sm" ref=${bodyRef}>
          <${Field} type="password" name="reauth-password" label=${t("reauth.password_label")} value=${password} onChange=${setPassword} error=${fieldError} autoComplete="current-password" disabled=${busy} required />
          ${banner ? html`<div class="banner banner-warn" role="alert">${banner}</div>` : null}
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn" disabled=${busy} onClick=${cancel}>${t("common.cancel")}</button>
          <button type="submit" class="btn btn-primary" disabled=${busy || password === ""}>${t("reauth.confirm")}</button>
        </div>
      </form>
    </div>
  </dialog>`;
}

/** The host: mounted once by the app (T072), shows the request raised by `requestReauth()`. */
export function ReauthDialog() {
  const { request } = useStore(reauthStore);
  if (!request) return null;
  return html`<${ReauthView} key=${request.id} request=${request} onResolve=${resolveReauth} />`;
}

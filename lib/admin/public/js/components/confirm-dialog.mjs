import { html, useEffect, useRef, useId } from "./html.mjs";
import { confirmStore, resolveConfirm } from "../ui.mjs";
import { useStore } from "./hooks.mjs";

/** One modal built on the native <dialog>. Escape cancels. `request` comes from `confirm()` in ui.mjs. */
export function ConfirmView({ request, onResolve }) {
  const ref = useRef(null);
  const uid = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open && typeof dialog.showModal === "function") dialog.showModal();
    return () => {
      if (dialog && dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, []);
  const hasCancel = request.cancelLabel !== null;
  // The safe answer holds the focus: Cancel for a destructive action, the one button for a notice.
  return html`<dialog ref=${ref} class="dialog" aria-labelledby=${`${uid}-t`} aria-describedby=${`${uid}-m`} onCancel=${(event) => {
    event.preventDefault();
    onResolve(false);
  }}>
    <div class="dialog-inner">
      <h2 class="dialog-title" id=${`${uid}-t`}>${request.title}</h2>
      ${request.message ? html`<p class="dialog-message" id=${`${uid}-m`}>${request.message}</p>` : null}
      <div class="dialog-actions">
        ${hasCancel ? html`<button type="button" class="btn" autofocus=${request.danger} onClick=${() => onResolve(false)}>${request.cancelLabel}</button>` : null}
        <button type="button" class=${`btn ${request.danger ? "btn-danger" : "btn-primary"}`} autofocus=${!request.danger || !hasCancel} onClick=${() => onResolve(true)}>${request.confirmLabel}</button>
      </div>
    </div>
  </dialog>`;
}

/** The host: mounted once by the app, shows the request raised by `confirm()` (FR-039). */
export function ConfirmDialog() {
  const { request } = useStore(confirmStore);
  if (!request) return null;
  return html`<${ConfirmView} key=${request.id} request=${request} onResolve=${resolveConfirm} />`;
}

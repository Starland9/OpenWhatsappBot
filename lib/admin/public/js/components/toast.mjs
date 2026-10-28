import { html } from "./html.mjs";
import { t } from "../i18n.mjs";
import { toastStore, dismissToast } from "../ui.mjs";
import { useStore } from "./hooks.mjs";
import { Icon } from "./icon.mjs";

const ICONS = { success: "check", error: "error", info: "info" };

export function Toast({ toast, onDismiss }) {
  const kind = ICONS[toast.kind] ? toast.kind : "info";
  return html`<div class=${`toast toast-${kind}`} role=${kind === "error" ? "alert" : "status"}>
    <${Icon} name=${ICONS[kind]} />
    <div class="toast-body">${toast.message}</div>
    <button type="button" class="icon-btn" aria-label=${t("common.close")} onClick=${() => onDismiss(toast.id)}><${Icon} name="close" /></button>
  </div>`;
}

/** Renders the toasts raised with `toast()` / `toastError()` from ui.mjs. Mounted once by the app. */
export function ToastHost() {
  const { items } = useStore(toastStore);
  return html`<div class="toasts" aria-live="polite">${items.map((item) => html`<${Toast} key=${item.id} toast=${item} onDismiss=${dismissToast} />`)}</div>`;
}

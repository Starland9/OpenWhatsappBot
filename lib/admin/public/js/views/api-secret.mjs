// The secret-once dialog (feature 004, contracts/panel-ui.md 7.6): a new key's secret is shown here and nowhere else.
// It lives in ApiView's useState (set from the create or duplicate answer, null on close), never in useAsync data,
// a toast, a confirmation text, the URL or storage. Escape and the backdrop do nothing; closing without a copy asks first.
import { html, useEffect, useId, useRef, useState, Icon } from "../components/index.mjs";
import { t } from "../i18n.mjs";
import { confirm, setDirty } from "../ui.mjs";
import { copyText } from "./api-logic.mjs";

/** `SecretOnceDialog({ secret, name, last4, onClose })` */
export function SecretOnceDialog({ secret, name, last4, onClose }) {
  const ref = useRef(null);
  const areaRef = useRef(null);
  const uid = useId();
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open && typeof dialog.showModal === "function") dialog.showModal();
    return () => {
      if (dialog && dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, []);

  const selectAll = () => {
    const area = areaRef.current;
    if (area && typeof area.select === "function") area.select();
  };

  const copy = async () => {
    const outcome = await copyText(secret);
    if (outcome === "copied") {
      setCopied(true);
      setManual(false);
    } else {
      setManual(true);
      selectAll();
    }
  };

  const done = async () => {
    if (!copied) {
      const ok = await confirm({ danger: true, title: t("api.secret_close_title"), message: t("api.secret_close_message"), confirmLabel: t("api.secret_close_confirm") });
      if (!ok) return;
    }
    // explicit, before any navigation: otherwise the router's leave guard would ask
    setDirty("api-secret", false);
    onClose();
  };

  return html`<dialog ref=${ref} class="dialog" aria-labelledby=${`${uid}-t`} onCancel=${(event) => event.preventDefault()}>
    <div class="dialog-inner stack">
      <h2 class="dialog-title" id=${`${uid}-t`}>${t("api.secret_title")}</h2>
      <div class="banner banner-warn" role="status"><${Icon} name="warning" /><div class="banner-body">${t("api.secret_warning")}</div></div>
      <p class="muted">${t("api.secret_for", { name, last4 })}</p>
      <textarea ref=${areaRef} class="textarea mono" rows="3" readonly aria-label=${t("api.secret_label")} value=${secret} onFocus=${selectAll}></textarea>
      ${manual ? html`<p class="field-hint" role="status">${t("api.copy_manual")}</p>` : null}
      <div class="dialog-actions">
        <button type="button" class="btn" onClick=${copy}><${Icon} name="copy" />${copied ? t("api.secret_copied") : t("api.secret_copy")}</button>
        <button type="button" class="btn btn-primary" onClick=${done}>${t("api.secret_done")}</button>
      </div>
    </div>
  </dialog>`;
}

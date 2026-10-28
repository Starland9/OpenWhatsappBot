import { html, useState, useLanguage, Field, Icon } from "../components/index.mjs";
import { t, tError, formatBytes } from "../i18n.mjs";
import { download } from "../api.mjs";
import { confirm, toastSuccess } from "../ui.mjs";
import { checkPassphrase, exportBody, fallbackFileName, refusalFor, EXPORT_PATH, PASSPHRASE_MIN } from "./backup-logic.mjs";

/** The text of a refused request: the page's own wording when it has one, else the generic message of the code */
export function refusalText(error) {
  const refusal = refusalFor(error);
  return refusal ? t(refusal.key, refusal.params) : tError(error);
}

/** BAK-1: the passphrase (typed twice), the optional session with its takeover warning, and the download. */
export function ExportCard() {
  useLanguage();
  const [passphrase, setPassphrase] = useState("");
  const [repeat, setRepeat] = useState("");
  const [includeSession, setIncludeSession] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
  const [refusal, setRefusal] = useState(null);

  const problem = checkPassphrase(passphrase, { repeat });
  const passphraseError = touched && problem && problem.code !== "mismatch" ? problem : null;
  const repeatError = touched && !passphraseError && problem && problem.code === "mismatch" ? problem : null;
  const serverError = refusal && refusal.fields && refusal.fields.passphrase ? refusal.fields.passphrase : null;

  const submit = async (event) => {
    if (event && event.preventDefault) event.preventDefault();
    setTouched(true);
    setSaved(null);
    setRefusal(null);
    if (problem) return;

    let sessionConfirmed = false;
    if (includeSession) {
      sessionConfirmed = await confirm({
        title: t("backup.session_confirm_title"),
        message: t("backup.session_confirm_message"),
        confirmLabel: t("backup.session_confirm_ok"),
      });
      if (!sessionConfirmed) return;
    }

    setBusy(true);
    try {
      const file = await download("POST", EXPORT_PATH, exportBody({ passphrase, includeSession, sessionConfirmed }), fallbackFileName());
      setSaved(file);
      toastSuccess(t("backup.export_done", { name: file.filename, size: formatBytes(file.size) }));
      // the passphrase leaves the page as soon as the file is made
      setPassphrase("");
      setRepeat("");
      setIncludeSession(false);
      setTouched(false);
    } catch (err) {
      setRefusal(err);
    } finally {
      setBusy(false);
    }
  };

  return html`<section class="card" aria-labelledby="backup-export-title">
    <h2 class="card-title" id="backup-export-title">${t("backup.export_title")}</h2>
    <p class="muted">${t("backup.export_intro")}</p>
    <form class="form stack" onSubmit=${submit} autocomplete="off" noValidate>
      <${Field}
        label=${t("backup.passphrase_label")}
        name="passphrase"
        type="password"
        value=${passphrase}
        onChange=${setPassphrase}
        hint=${t("backup.passphrase_hint", { min: PASSPHRASE_MIN })}
        error=${passphraseError || serverError}
        autoComplete="new-password"
        disabled=${busy}
        required
      />
      <${Field}
        label=${t("backup.passphrase_repeat_label")}
        name="passphrase_repeat"
        type="password"
        value=${repeat}
        onChange=${setRepeat}
        error=${repeatError}
        autoComplete="new-password"
        disabled=${busy}
        required
      />
      <${Field}
        label=${t("backup.include_session_label")}
        name="include_session"
        type="bool"
        value=${includeSession}
        onChange=${setIncludeSession}
        hint=${t("backup.include_session_hint")}
        disabled=${busy}
      />
      ${includeSession
        ? html`<div class="banner banner-warn" role="alert">
            <${Icon} name="warning" />
            <div class="banner-body">${t("backup.session_warning")}</div>
          </div>`
        : null}
      ${refusal && !serverError
        ? html`<div class="banner banner-error" role="alert">
            <${Icon} name="error" />
            <div class="banner-body">${refusalText(refusal)}</div>
          </div>`
        : null}
      <div class="actions">
        <button type="submit" class="btn btn-primary" disabled=${busy}>
          <${Icon} name="backup" />${busy ? t("backup.exporting") : t("backup.export_button")}
        </button>
      </div>
      ${saved
        ? html`<p class="muted" role="status">${t("backup.export_done", { name: saved.filename, size: formatBytes(saved.size) })}</p>`
        : null}
    </form>
  </section>`;
}

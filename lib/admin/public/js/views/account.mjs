import { html, useState, useStore, useAction, useUnsavedGuard, Field } from "../components/index.mjs";
import { t, tError, formatDateTime } from "../i18n.mjs";
import { api } from "../api.mjs";
import { sessionStore, applyAccountPreferences, toastSuccess, toastError } from "../ui.mjs";
import { validatePasswordChange, pickFieldErrors } from "./setup-logic.mjs";
import { preferencesChange, UI_LANGS, THEME_CHOICES } from "./account-logic.mjs";

export const meta = { area: "account", titleKey: "account.title", icon: "account" };

function Preferences({ account }) {
  const [busy, run] = useAction();
  const save = (wanted) =>
    run(async () => {
      const body = preferencesChange(account, wanted);
      if (!body) return;
      const answer = await api("PATCH", "/admin/api/account/preferences", body);
      const next = { ...account, ...answer };
      await applyAccountPreferences(next);
      sessionStore.set({ account: next });
      toastSuccess(t("account.preferences_saved"));
    });
  return html`<section class="card">
    <h2 class="card-title">${t("account.preferences")}</h2>
    <div class="stack">
      <fieldset class="choice-group">
        <legend class="field-label">${t("account.language")}</legend>
        ${UI_LANGS.map(
          (lang) => html`<label class="choice"><input type="radio" name="uiLang" value=${lang} checked=${account.uiLang === lang} disabled=${busy} onChange=${() => save({ uiLang: lang })} />${t(`account.language_${lang}`)}</label>`,
        )}
        <span class="field-hint">${t("account.language_hint")}</span>
      </fieldset>
      <fieldset class="choice-group">
        <legend class="field-label">${t("account.theme")}</legend>
        ${THEME_CHOICES.map(
          (theme) => html`<label class="choice"><input type="radio" name="theme" value=${theme} checked=${account.theme === theme} disabled=${busy} onChange=${() => save({ theme })} />${t(`account.theme_${theme}`)}</label>`,
        )}
      </fieldset>
    </div>
  </section>`;
}

function PasswordForm() {
  const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [errors, setErrors] = useState({});
  const [busy, run] = useAction();
  const dirty = Boolean(form.currentPassword || form.newPassword || form.confirm);
  useUnsavedGuard("account-password", dirty);
  const set = (name) => (value) => setForm((f) => ({ ...f, [name]: value }));
  const submit = async (event) => {
    event.preventDefault();
    const check = validatePasswordChange(form);
    setErrors(check.fields);
    if (!check.ok) return;
    await run(
      async () => {
        try {
          await api("PATCH", "/admin/api/account/password", { currentPassword: form.currentPassword, newPassword: form.newPassword });
          setForm({ currentPassword: "", newPassword: "", confirm: "" });
          setErrors({});
          toastSuccess(t("account.password_changed"));
        } catch (err) {
          if (err.code === "validation_failed") setErrors(pickFieldErrors(err, ["currentPassword", "newPassword"]));
          else toastError(err);
        }
      },
      { silent: true },
    );
  };
  return html`<section class="card">
    <h2 class="card-title">${t("account.password")}</h2>
    <form class="form" onSubmit=${submit} noValidate>
      <${Field} label=${t("account.current_password")} name="currentPassword" type="password" value=${form.currentPassword} onChange=${set("currentPassword")} error=${errors.currentPassword} autoComplete="current-password" required />
      <${Field} label=${t("auth.new_password")} name="newPassword" type="password" value=${form.newPassword} onChange=${set("newPassword")} error=${errors.newPassword} hint=${t("auth.password_rule", { min: 12 })} autoComplete="new-password" required />
      <${Field} label=${t("auth.confirm_password")} name="confirm" type="password" value=${form.confirm} onChange=${set("confirm")} error=${errors.confirm} autoComplete="new-password" required />
      <p class="muted">${t("account.password_revokes")}</p>
      <div><button type="submit" class="btn btn-primary" disabled=${busy}>${t("account.password_submit")}</button></div>
    </form>
  </section>`;
}

/** AUTH-5 (password change) and AUTH-6 (interface language and theme). */
export default function AccountView() {
  const { account, session } = useStore(sessionStore);
  if (!account) return null;
  return html`<section class="view stack">
    <div class="view-header"><h1>${t("account.title")}</h1></div>
    <${Preferences} account=${account} />
    <${PasswordForm} />
    <section class="card">
      <h2 class="card-title">${t("account.session")}</h2>
      <dl class="kv">
        <dt>${t("account.last_login")}</dt><dd>${account.lastLoginAt ? formatDateTime(account.lastLoginAt) : t("common.none")}</dd>
        ${session ? html`<dt>${t("account.idle_expires")}</dt><dd>${formatDateTime(session.idleExpiresAt)}</dd><dt>${t("account.absolute_expires")}</dt><dd>${formatDateTime(session.absoluteExpiresAt)}</dd>` : null}
      </dl>
    </section>
  </section>`;
}

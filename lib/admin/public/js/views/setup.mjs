import { html, useState, useStore, useAction, AuthFrame, Field } from "../components/index.mjs";
import { t } from "../i18n.mjs";
import { api } from "../api.mjs";
import { sessionStore, applyAuthenticated, loadSession, collectBanners, toastError } from "../ui.mjs";
import { navigate } from "../router.mjs";
import { validateNewPassword, pickFieldErrors } from "./setup-logic.mjs";

export const meta = { area: "setup", titleKey: "auth.setup_title", icon: "lock" };

/** What to do when there is no usable setup link: follow the console link, or ask for a new one. */
function Invitation({ invalid, accountExists }) {
  return html`<div class="stack-sm">
    <p>${invalid ? t("auth.setup_invalid") : t("auth.no_account")}</p>
    ${invalid ? html`<p class="muted">${accountExists ? t("auth.setup_invalid_reset") : t("auth.setup_invalid_restart")}</p>` : null}
    ${accountExists ? html`<div class="actions"><a class="btn" href="#/login" onClick=${() => loadSession()}>${t("auth.back_to_login")}</a></div>` : null}
  </div>`;
}

/** First-run account creation (purpose `setup`) and password reset (purpose `reset`), AUTH-4. */
export default function SetupView({ screen }) {
  const session = useStore(sessionStore);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState({});
  const [busy, run] = useAction();
  const banners = collectBanners({ session, loc: globalThis.location });

  if (screen === "no_account" || screen === "setup_invalid" || !session.setup) {
    return html`<${AuthFrame} banners=${banners} title=${t("auth.setup_title")}><${Invitation} invalid=${screen === "setup_invalid"} accountExists=${session.accountExists} /><//>`;
  }

  const reset = session.setup.purpose === "reset";
  const submit = async (event) => {
    event.preventDefault();
    const check = validateNewPassword(password, confirm);
    setErrors(check.fields);
    if (!check.ok) return;
    await run(
      async () => {
        try {
          const answer = await api("POST", "/admin/api/setup", { password });
          await applyAuthenticated(answer);
          setPassword("");
          setConfirm("");
          navigate("dashboard");
        } catch (err) {
          if (err.code === "token_invalid") {
            await loadSession();
            navigate("setup", ["invalid"]);
          } else if (err.code === "validation_failed") setErrors(pickFieldErrors(err, ["password"]));
          else toastError(err);
        }
      },
      { silent: true },
    );
  };

  return html`<${AuthFrame} banners=${banners} title=${reset ? t("auth.reset_title") : t("auth.setup_title")}>
    <p class="muted">${reset ? t("auth.reset_intro") : t("auth.setup_intro")}</p>
    <form class="form" onSubmit=${submit} noValidate>
      <${Field} label=${t("auth.new_password")} name="password" type="password" value=${password} onChange=${setPassword} error=${errors.password} hint=${t("auth.password_rule", { min: 12 })} autoComplete="new-password" required />
      <${Field} label=${t("auth.confirm_password")} name="confirm" type="password" value=${confirm} onChange=${setConfirm} error=${errors.confirm} autoComplete="new-password" required />
      <button type="submit" class="btn btn-primary" disabled=${busy}>${reset ? t("auth.reset_submit") : t("auth.setup_submit")}</button>
    </form>
  <//>`;
}

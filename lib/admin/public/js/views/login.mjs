import { html, useState, useEffect, useStore, useAction, AuthFrame, Field } from "../components/index.mjs";
import { t, tError, formatDuration } from "../i18n.mjs";
import { api } from "../api.mjs";
import { sessionStore, applyAuthenticated, loadSession, collectBanners } from "../ui.mjs";
import { navigate } from "../router.mjs";
import { remainingMs, blockedUntilFrom } from "./login-logic.mjs";

export const meta = { area: "login", titleKey: "auth.login_title", icon: "lock" };

/** AUTH-2. After 5 failures the origin is blocked: the form is replaced by the delay, counted down here. */
export default function LoginView() {
  const session = useStore(sessionStore);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [blockedUntil, setBlockedUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [busy, run] = useAction();
  const banners = collectBanners({ session, loc: globalThis.location });
  const left = remainingMs(blockedUntil, now);

  useEffect(() => {
    if (!blockedUntil) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [blockedUntil]);

  const submit = async (event) => {
    event.preventDefault();
    if (left > 0 || !password) return;
    setError(null);
    await run(
      async () => {
        try {
          const answer = await api("POST", "/admin/api/login", { password });
          setPassword("");
          await applyAuthenticated(answer);
          navigate("dashboard");
        } catch (err) {
          setPassword("");
          if (err.code === "login_blocked") {
            setNow(Date.now());
            setBlockedUntil(blockedUntilFrom(err));
          } else if (err.code === "setup_required") await loadSession();
          else setError(err);
        }
      },
      { silent: true },
    );
  };

  return html`<${AuthFrame} banners=${banners} title=${t("auth.login_title")}>
    ${left > 0
      ? html`<div class="banner banner-error" role="alert"><div class="banner-body">${t("auth.blocked", { retryAfter: formatDuration(left) })}</div></div>`
      : null}
    <form class="form" onSubmit=${submit} noValidate>
      <${Field} label=${t("auth.password")} name="password" type="password" value=${password} onChange=${setPassword} autoComplete="current-password" disabled=${left > 0} required />
      ${error ? html`<div class="field-error" role="alert">${tError(error)}</div>` : null}
      <button type="submit" class="btn btn-primary" disabled=${busy || left > 0 || !password}>${t("auth.login_submit")}</button>
    </form>
  <//>`;
}

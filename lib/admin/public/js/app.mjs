// Bootstrap of the panel SPA: AUTH-1 -> (no account | setup | login | the app shell with the live stream).
import {
  html,
  render,
  Fragment,
  useEffect,
  useState,
  useErrorBoundary,
  useStore,
  useRoute,
  useLanguage,
  Layout,
  ToastHost,
  ConfirmDialog,
  Spinner,
  AuthFrame,
  EmptyState,
} from "./components/index.mjs";
import { t, tError } from "./i18n.mjs";
import { api, on as onApiEvent } from "./api.mjs";
import { live } from "./live.mjs";
import { AREAS, buildHash, loadView, navigate, resolveScreen, startRouter } from "./router.mjs";
import {
  sessionStore,
  botStore,
  loadSession,
  clearSession,
  initPreferences,
  collectBanners,
  installUnsavedGuard,
  confirm,
  confirmLeave,
  hasUnsaved,
  clearDirty,
  toast,
} from "./ui.mjs";

const AREA_NAMES = AREAS.map((entry) => entry.area);
const AUTH_ROUTES = ["login", "setup", "setup_invalid"];

/** Loads a view module on demand and renders it; a view that fails to load offers a retry. */
function ViewHost({ name, route, screen }) {
  const [View, setView] = useState(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setView(null);
    setFailed(false);
    loadView(name)
      .then((component) => {
        if (!cancelled) setView(() => component);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [name, attempt]);
  if (!View) {
    if (failed) {
      return html`<${EmptyState} icon="error" title=${t("common.view_error")} message=${t("common.view_error_hint")}>
        <button type="button" class="btn" onClick=${() => setAttempt((n) => n + 1)}>${t("common.retry")}</button>
      <//>`;
    }
    return html`<${Spinner} />`;
  }
  return html`<${View} route=${route} screen=${screen} />`;
}

/** A view that throws while rendering must not take the shell down. */
function Boundary({ resetKey, children }) {
  const [error, reset] = useErrorBoundary();
  useEffect(() => {
    reset();
  }, [resetKey]);
  if (error) {
    return html`<${EmptyState} icon="error" title=${t("common.view_error")} message=${t("common.view_error_hint")}>
      <button type="button" class="btn" onClick=${reset}>${t("common.retry")}</button>
    <//>`;
  }
  return children;
}

function NotFound() {
  return html`<${EmptyState} icon="info" title=${t("common.not_found")}>
    <a class="btn" href=${buildHash("dashboard")}>${t("nav.dashboard")}</a>
  <//>`;
}

async function logout() {
  if (!(await confirmLeave())) return;
  try {
    await api("POST", "/admin/api/logout", {});
  } catch {
    // the session is dropped locally either way
  }
  clearSession();
  navigate("login");
  await loadSession();
}

let ending = false;

/** The session is over (expired, revoked, or no cookie): warn if input would be lost, then show login. */
async function endSession({ notify = true } = {}) {
  if (ending) return;
  ending = true;
  try {
    if (hasUnsaved()) {
      await confirm({
        title: t("session.expired_title"),
        message: t("session.expired_unsaved"),
        confirmLabel: t("session.expired_ok"),
        cancelLabel: null,
        danger: false,
      });
    } else if (notify) {
      toast(t("session.expired_toast"), { kind: "info" });
    }
    clearDirty();
    clearSession();
    await loadSession();
  } finally {
    ending = false;
  }
}

function AppShell({ route }) {
  const { state } = useStore(botStore);
  const session = useStore(sessionStore);
  const banners = collectBanners({ state, session, loc: globalThis.location });
  const known = AREA_NAMES.includes(route.name) || route.name === "account";
  const entry = AREAS.find((a) => a.area === route.name);

  useEffect(() => {
    const label = known ? t(entry ? entry.titleKey : "account.title") : t("common.not_found");
    document.title = `${label} - ${t("app.name")}`;
  });

  return html`<${Layout} route=${route} state=${state} banners=${banners} onLogout=${logout}>
    <${Boundary} resetKey=${route.path}>
      ${known ? html`<${ViewHost} key=${route.name} name=${route.name} route=${route} />` : html`<${NotFound} />`}
    <//>
  <//>`;
}

function App() {
  useLanguage();
  const session = useStore(sessionStore);
  const route = useRoute();
  const screen = resolveScreen(session, route);

  // The live stream runs while someone is logged in; the first `state` feeds the banners and the status.
  useEffect(() => {
    if (!session.authenticated) return undefined;
    const offs = [
      live.subscribe("state", (state) => botStore.set({ state })),
      live.subscribe("connection", ({ mode }) => botStore.set({ connection: mode })),
      live.subscribe("session", () => endSession({ notify: false })),
    ];
    live.start();
    return () => {
      for (const off of offs) off();
      live.stop();
    };
  }, [session.authenticated]);

  useEffect(() => {
    if (screen === "app" && AUTH_ROUTES.includes(route.name)) navigate("dashboard");
  }, [screen, route.name]);

  useEffect(() => {
    if (screen === "login") document.title = `${t("auth.login_title")} - ${t("app.name")}`;
    else if (screen === "setup" || screen === "setup_invalid" || screen === "no_account") document.title = `${t("auth.setup_title")} - ${t("app.name")}`;
  }, [screen]);

  let body;
  if (screen === "loading") body = html`<div class="boot"><${Spinner} /></div>`;
  else if (screen === "error") {
    body = html`<${AuthFrame}>
      <p class="banner banner-error" role="alert">${tError(session.loadError)}</p>
      <button type="button" class="btn btn-primary" onClick=${() => loadSession()}>${t("common.retry")}</button>
    <//>`;
  } else if (screen === "app") body = html`<${AppShell} route=${route} />`;
  else body = html`<${ViewHost} key=${screen === "login" ? "login" : "setup"} name=${screen === "login" ? "login" : "setup"} route=${route} screen=${screen} />`;

  return html`<${Fragment}>${body}<${ToastHost} /><${ConfirmDialog} /><//>`;
}

async function main() {
  const root = document.getElementById("app");
  await initPreferences();
  installUnsavedGuard(window);
  onApiEvent("session_expired", () => endSession());
  onApiEvent("unauthenticated", () => endSession());
  startRouter(window);
  root.textContent = "";
  root.removeAttribute("aria-busy");
  render(html`<${App} />`, root);
  await loadSession();
}

if (typeof document !== "undefined") main();

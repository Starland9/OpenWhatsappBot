import { html, useState, useEffect, useRef } from "./html.mjs";
import { t, hasKey } from "../i18n.mjs";
import { Icon } from "./icon.mjs";
import { Nav } from "./nav.mjs";
import { BannerList } from "./banner-list.mjs";
import { StatusBadge } from "./status-badge.mjs";

/** "Restart: starting" for the running-job indicator of the top bar. */
function jobLabel(job) {
  const type = hasKey(`jobs.type.${job.type}`) ? t(`jobs.type.${job.type}`) : job.type;
  const phase = job.phase && hasKey(`jobs.phase.${job.phase}`) ? t(`jobs.phase.${job.phase}`) : job.phase;
  return phase ? `${type}: ${phase}` : type;
}

/**
 * The app shell: top bar (menu, name, running job, connection status), navigation drawer, banners and
 * the main column. `state` is the DASH-1 object (or null before the first one arrives).
 */
export function Layout({ route, state, banners, onLogout, children }) {
  const [open, setOpen] = useState(false);
  const main = useRef(null);
  const toggle = useRef(null);
  const path = route ? route.path : "";

  const closeNav = () => {
    setOpen(false);
    if (toggle.current) toggle.current.focus();
  };

  useEffect(() => {
    setOpen(false);
  }, [path]);

  useEffect(() => {
    if (!open) return undefined;
    const close = document.querySelector("#nav .nav-close");
    if (close) close.focus();
    const onKey = (event) => {
      if (event.key === "Escape") closeNav();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const job = state && state.job && state.job.status === "running" ? state.job : null;
  const status = state && state.bot ? state.bot.status : null;
  return html`<div class=${`shell${open ? " nav-open" : ""}`}>
    <button type="button" class="skip-link" onClick=${() => main.current && main.current.focus()}>${t("nav.skip")}</button>
    <header class="topbar">
      <button type="button" class="icon-btn nav-toggle" ref=${toggle} aria-controls="nav" aria-expanded=${open ? "true" : "false"} aria-label=${t("nav.open")} onClick=${() => setOpen(true)}><${Icon} name="menu" /></button>
      <span class="brand">${t("app.name")}</span>
      <span class="topbar-spacer"></span>
      <div class="topbar-status">
        ${job ? html`<span class="chip" role="status"><${Icon} name="job" /><span class="chip-text">${jobLabel(job)}</span></span>` : null}
        ${status ? html`<${StatusBadge} status=${status} />` : null}
      </div>
    </header>
    ${open ? html`<div class="nav-backdrop" onClick=${closeNav}></div>` : null}
    <${Nav} route=${route} onNavigate=${() => setOpen(false)} onClose=${closeNav} onLogout=${onLogout} />
    <main id="main" class="main" tabindex="-1" ref=${main}>
      <${BannerList} banners=${banners} />
      ${children}
    </main>
  </div>`;
}

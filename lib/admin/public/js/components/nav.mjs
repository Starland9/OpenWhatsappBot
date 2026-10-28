import { html } from "./html.mjs";
import { t } from "../i18n.mjs";
import { AREAS, buildHash } from "../router.mjs";
import { Icon } from "./icon.mjs";

/**
 * The drawer (a permanent sidebar from 1024 px). Lists **every** area of the panel, each labelled
 * `nav.<area>`; the current route is marked with aria-current. `onNavigate` closes the drawer on mobile.
 */
export function Nav({ route, onNavigate = () => {}, onClose = () => {}, onLogout = () => {} }) {
  const link = (name, icon, label) => html`<a class="nav-link" href=${buildHash(name)} aria-current=${route && route.name === name ? "page" : undefined} onClick=${onNavigate}><${Icon} name=${icon} /><span>${label}</span></a>`;
  return html`<nav id="nav" class="nav" aria-label=${t("nav.label")}>
    <div class="nav-head">
      <span>${t("app.name")}</span>
      <button type="button" class="icon-btn nav-close" aria-label=${t("nav.close")} onClick=${onClose}><${Icon} name="close" /></button>
    </div>
    <ul class="nav-list">${AREAS.map((entry) => html`<li key=${entry.area}>${link(entry.area, entry.icon, t(`nav.${entry.area}`))}</li>`)}</ul>
    <div class="nav-foot">
      ${link("account", "account", t("nav.account"))}
      <button type="button" class="nav-link" onClick=${onLogout}><${Icon} name="logout" /><span>${t("nav.logout")}</span></button>
    </div>
  </nav>`;
}

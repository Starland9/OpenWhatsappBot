import { html } from "./html.mjs";
import { t } from "../i18n.mjs";
import { BannerList } from "./banner-list.mjs";

/** The centred card used by the screens shown before login (setup, login, invitation). */
export function AuthFrame({ banners, title, children }) {
  return html`<div class="auth">
    ${banners && banners.length ? html`<div class="auth-banners"><${BannerList} banners=${banners} /></div>` : null}
    <main class="auth-card">
      <h1>${t("app.name")}</h1>
      ${title ? html`<h2>${title}</h2>` : null}
      ${children}
    </main>
  </div>`;
}

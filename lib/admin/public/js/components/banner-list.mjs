import { html } from "./html.mjs";
import { t, hasKey } from "../i18n.mjs";
import { buildHash } from "../router.mjs";
import { Icon } from "./icon.mjs";

/** Where a banner points the administrator (an area of the panel), when it has a natural place to fix it. */
export const BANNER_LINKS = {
  restart_needed: "dashboard",
  update_restart: "maintenance",
  secret_key_lost: "settings",
  no_owner: "settings",
  logged_out: "pairing",
  invalid_file_values: "settings",
};

const ICONS = { info: "info", warn: "warning", error: "error" };
const MAX_LISTED = 5;

/** Parameters ready for interpolation: long lists are cut, phases translated. */
export function bannerParams(banner) {
  const params = { ...(banner.params || {}) };
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value) && value.length > MAX_LISTED) {
      params[key] = `${value.slice(0, MAX_LISTED).join(", ")} (+${value.length - MAX_LISTED})`;
    }
  }
  if (typeof params.phase === "string" && hasKey(`jobs.phase.${params.phase}`)) params.phase = t(`jobs.phase.${params.phase}`);
  return params;
}

function Banner({ banner }) {
  const severity = ICONS[banner.severity] ? banner.severity : "info";
  const link = BANNER_LINKS[banner.id];
  return html`<div class=${`banner banner-${severity}`} role=${severity === "error" ? "alert" : "status"}>
    <${Icon} name=${ICONS[severity]} />
    <div class="banner-body">
      ${t(`banners.${banner.id}`, bannerParams(banner))}
      ${link ? html` <a class="banner-link" href=${buildHash(link)}>${t("common.open")}</a>` : null}
    </div>
  </div>`;
}

/** The `state.banners` list (plus the client-side ones), each rendered through `banners.<id>`. */
export function BannerList({ banners, className = "" }) {
  if (!banners || !banners.length) return null;
  return html`<div class=${`banners ${className}`.trim()}>${banners.map((banner) => html`<${Banner} key=${banner.id} banner=${banner} />`)}</div>`;
}

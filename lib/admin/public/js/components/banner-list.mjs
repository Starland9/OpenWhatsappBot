import { html, useState } from "./html.mjs";
import { t, hasKey } from "../i18n.mjs";
import { buildHash } from "../router.mjs";
import { requestRestart } from "../ui.mjs";
import { Icon } from "./icon.mjs";

/**
 * Where a banner points the administrator, when it has a natural place to fix it: `[area]` or `[area, key]`
 * (a setting key opens the settings page on that entry).
 */
export const BANNER_LINKS = {
  update_restart: ["maintenance"],
  undeclared_proxy: ["settings", "PANEL_TRUST_PROXY"],
  secret_key_lost: ["settings"],
  no_owner: ["settings", "SUDO"],
  maintenance: ["backup"],
  restore_interrupted: ["backup"],
  logged_out: ["pairing"],
  invalid_file_values: ["settings"],
};

/** Banners that list setting keys (`params.keys`): shown as "Label (KEY)" when the setting has a label. */
const SETTING_KEY_BANNERS = new Set(["restart_needed", "secret_key_lost", "invalid_file_values"]);

const ICONS = { info: "info", warn: "warning", error: "error" };
const MAX_LISTED = 5;

/** The link of a banner as a hash, or null. */
export function bannerHref(banner) {
  const link = BANNER_LINKS[banner.id];
  if (!link) return null;
  return link[1] ? buildHash(link[0], [link[1]]) : buildHash(link[0]);
}

function keyLabel(key) {
  return hasKey(`settings.${key}.label`) ? `${t(`settings.${key}.label`)} (${key})` : String(key);
}

/** Parameters ready for interpolation: setting keys named, long lists cut, phases translated, gaps filled. */
export function bannerParams(banner) {
  const params = { ...(banner.params || {}) };
  if (SETTING_KEY_BANNERS.has(banner.id) && Array.isArray(params.keys)) params.keys = params.keys.map(keyLabel);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value) && value.length > MAX_LISTED) {
      params[key] = `${value.slice(0, MAX_LISTED).join(", ")} (+${value.length - MAX_LISTED})`;
    }
  }
  if (typeof params.phase === "string" && hasKey(`jobs.phase.${params.phase}`)) params.phase = t(`jobs.phase.${params.phase}`);
  if (banner.id === "update_restart") {
    // the versions are not always known (an update applied by a script, an archive without a version)
    for (const name of ["from", "to"]) if (params[name] === null || params[name] === undefined || params[name] === "") params[name] = t("common.unknown");
  }
  return params;
}

/** The catalog key of a banner's text: `banners.<id>`, or its variant when the list the text needs is empty. */
export function bannerTextKey(banner) {
  const keys = banner.params && banner.params.keys;
  if (banner.id === "secret_key_lost" && !(Array.isArray(keys) && keys.length)) return "banners.secret_key_lost_unknown";
  return `banners.${banner.id}`;
}

/** The "Restart now" button of `restart_needed` (confirmation first, FR-039). */
function RestartAction() {
  const [busy, setBusy] = useState(false);
  const restart = async () => {
    setBusy(true);
    try {
      await requestRestart();
    } finally {
      setBusy(false);
    }
  };
  return html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${restart}><${Icon} name="refresh" />${t("banners.restart_now")}</button>`;
}

function Banner({ banner }) {
  const severity = ICONS[banner.severity] ? banner.severity : "info";
  const href = bannerHref(banner);
  return html`<div class=${`banner banner-${severity}`} role=${severity === "error" ? "alert" : "status"} data-banner=${banner.id}>
    <${Icon} name=${ICONS[severity]} />
    <div class="banner-body">
      ${t(bannerTextKey(banner), bannerParams(banner))}
      ${href ? html` <a class="banner-link" href=${href}>${t("common.open")}</a>` : null}
      ${banner.id === "restart_needed" ? html`<div class="banner-actions"><${RestartAction} /></div>` : null}
    </div>
  </div>`;
}

/** The `state.banners` list (plus the client-side ones), each rendered through `banners.<id>`. */
export function BannerList({ banners, className = "" }) {
  if (!banners || !banners.length) return null;
  return html`<div class=${`banners ${className}`.trim()}>${banners.map((banner) => html`<${Banner} key=${banner.id} banner=${banner} />`)}</div>`;
}

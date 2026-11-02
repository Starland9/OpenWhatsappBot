// The list of IP entries (feature 004, contracts/panel-ui.md 7.3 and 7.5): shared by the key editor (allowed addresses)
// and by the plain-HTTP networks card (private-only mode). One aggregated error per list, because the list control
// has a single error slot. It holds no draft: the owner of the rows does.
import { html, Field, fieldErrorText } from "../components/index.mjs";
import { t } from "../i18n.mjs";
import { isAnyIp, parseIpEntry } from "./api-logic.mjs";

/** The text of an error of api-logic: `{ key, params }` through the catalog, `{ code, params }` through `fields.<code>`, a string as is. */
export const errorText = (error) => (error && error.key ? t(error.key, error.params) : fieldErrorText(error));

/** `IpListEditor({ rows, onChange, error, privateOnly, disabled, label, hint, placeholder, emptyText })` */
export function IpListEditor({ rows, onChange, error, privateOnly = false, disabled = false, label, hint, placeholder, emptyText }) {
  const list = Array.isArray(rows) ? rows : [];
  const any = !privateOnly && list.some((row) => {
    const parsed = parseIpEntry(row);
    return parsed.ok && isAnyIp(parsed.value);
  });
  return html`<div class="stack-sm">
    ${list.length === 0 && emptyText ? html`<p class="muted">${emptyText}</p>` : null}
    <${Field} type="list" name=${privateOnly ? "api-networks" : "api-ip"} label=${label} hint=${hint} value=${list} onChange=${onChange} error=${errorText(error)} disabled=${disabled} placeholder=${placeholder} addLabel=${t("api.ip_add")} />
    ${any ? html`<div class="banner banner-warn" role="status"><div class="banner-body">${t("api.ip_any_warning")}</div></div>` : null}
  </div>`;
}

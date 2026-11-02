// The plain-HTTP networks card (feature 004, contracts/panel-ui.md 7.3, decision U1): private ranges that may call the API
// without HTTPS. API-2 is declarative, so a networks edit sends the current `enabled` and never flips the switch.
// The draft starts from `state.plainHttpFrom`; the parent keys the card by the stored list so a save remounts it.
import { html, useState, useAction, useUnsavedGuard, Icon } from "../components/index.mjs";
import { t } from "../i18n.mjs";
import { api } from "../api.mjs";
import { toastSuccess } from "../ui.mjs";
import { withStepUp } from "../reauth.mjs";
import { DEFAULT_LIMITS, ipRowsError, parseIpRows, widenings } from "./api-logic.mjs";
import { IpListEditor } from "./api-ips.mjs";

const base = "/admin/api/api";

const sameSet = (a, b) => a.length === b.length && a.every((value) => b.includes(value));

/** `NetworksCard({ state, catalog, onChanged })` */
export function NetworksCard({ state, catalog, onChanged }) {
  const stored = state.plainHttpFrom || [];
  const max = (catalog && catalog.limits && catalog.limits.plainHttpFromMax) || DEFAULT_LIMITS.plainHttpFromMax;
  const [rows, setRows] = useState(() => stored.slice());
  const [serverError, setServerError] = useState(null);
  const [busy, run] = useAction();

  const parsed = parseIpRows(rows, { max, privateOnly: true });
  const problem = ipRowsError(parsed, { max, networks: true });
  const dirty = !sameSet(parsed.values, stored) || Boolean(problem) || parsed.duplicates.length > 0;
  useUnsavedGuard("api-networks", dirty);

  const edit = (next) => {
    setServerError(null);
    setRows(next);
  };

  const save = () => {
    if (problem) return null;
    const values = parsed.values;
    return run(async () => {
      let result;
      try {
        result = await withStepUp(() => api("PUT", `${base}/state`, { enabled: state.enabled, plainHttpFrom: values }), {
          needed: widenings(state, { enabled: state.enabled, plainHttpFrom: values }).includes("plain_http"),
          reasons: ["plain_http"],
        });
      } catch (err) {
        const field = err && err.code === "validation_failed" && err.fields ? err.fields.plainHttpFrom : null;
        if (!field) throw err;
        const indices = field.params && Array.isArray(field.params.indices) ? field.params.indices : [];
        const key = field.params && field.params.reason === "not_private" ? "api.networks_not_private" : "api.networks_invalid_rows";
        setServerError({ key, params: { rows: indices.map((i) => Number(i) + 1).join(", ") } });
        return;
      }
      if (!result.ok) return;
      toastSuccess(t("api.networks_saved"));
      onChanged();
    });
  };

  return html`<section class="card stack">
    <h2 class="card-title">${t("api.networks_title")}</h2>
    <p class="muted">${t("api.networks_intro")}</p>
    <${IpListEditor}
      rows=${rows}
      privateOnly
      disabled=${busy}
      error=${serverError || problem}
      label=${t("api.networks_label")}
      hint=${t("api.networks_hint")}
      placeholder=${t("api.networks_placeholder")}
      emptyText=${t("api.networks_empty")}
      onChange=${edit}
    />
    <div><button type="button" class="btn btn-primary" disabled=${busy || !dirty} onClick=${save}><${Icon} name="check" />${t("api.networks_save")}</button></div>
  </section>`;
}


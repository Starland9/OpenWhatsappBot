// The "API" area of the panel (feature 004, contracts/panel-ui.md 7.1). `views/api.mjs` is this area's view; `js/api.mjs`
// is the HTTP client (every view imports it as `../api.mjs`).
//
// ApiView loads the state (API-1), the catalogue (API-3) and the keys (API-4) ONCE and hands them to the tabs as props;
// it owns the secret-once state (the only place a new key's secret ever lives) and dispatches the routes:
//   #/api[?tab=keys|history|usage|test|docs]   the tabbed page          #/api/keys/new, #/api/keys/<id>   the key editor
//   #/api/history/<id>                         the message detail
import { html, useEffect, useState, useAsync, useUnsavedGuard, EmptyState, Icon, Spinner, TabPanel, Tabs } from "../components/index.mjs";
import { t, tError } from "../i18n.mjs";
import { api } from "../api.mjs";
import { navigate } from "../router.mjs";
import { syncConfirmation } from "../reauth.mjs";
import { tabOf, TABS } from "./api-logic.mjs";
import { EnableCard, StateBanners } from "./api-state.mjs";
import { KeysTab } from "./api-keys.mjs";
import { KeyEditor } from "./api-key-editor.mjs";
import { SecretOnceDialog } from "./api-secret.mjs";
import { HistoryTab } from "./api-history.mjs";
import { MessageDetail } from "./api-message.mjs";
import { UsageTab } from "./api-usage.mjs";
import { TestTab } from "./api-test.mjs";
import { DocsTab } from "./api-docs.mjs";

const base = "/admin/api/api";

export const meta = { area: "api", titleKey: "api.title", icon: "api" };

export default function ApiView({ route }) {
  const stateAsync = useAsync(() => api("GET", base), []);
  const catalogAsync = useAsync(() => api("GET", `${base}/catalog`), []);
  const keysAsync = useAsync(() => api("GET", `${base}/keys`), []);
  const [secret, setSecret] = useState(null);
  useUnsavedGuard("api-secret", Boolean(secret));

  const state = stateAsync.data;
  const catalog = catalogAsync.data;
  const keys = keysAsync.data;
  const loaded = Boolean(state);
  const confirmedUntil = state && state.stepUp ? state.stepUp.confirmedUntil : null;
  // the server's view of the confirmation replaces the browser's belief at every page load
  useEffect(() => {
    if (state) syncConfirmation(state.stepUp);
  }, [loaded, confirmedUntil]);

  const reloadAll = () => {
    stateAsync.reload();
    catalogAsync.reload();
    keysAsync.reload();
  };
  const onChanged = () => {
    stateAsync.reload();
    keysAsync.reload();
  };

  if (!state || !catalog) {
    const failure = stateAsync.error || catalogAsync.error;
    if (failure && (!state || !catalog)) {
      return html`<section class="view stack">
        <div class="view-header"><h1>${t("api.title")}</h1></div>
        <${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(failure)}>
          <button type="button" class="btn" onClick=${reloadAll}><${Icon} name="refresh" />${t("common.retry")}</button>
        <//>
      </section>`;
    }
    return html`<section class="view stack"><div class="view-header"><h1>${t("api.title")}</h1></div><${Spinner} /></section>`;
  }

  const dialog = secret
    ? html`<${SecretOnceDialog}
        secret=${secret.secret}
        name=${secret.name}
        last4=${secret.last4}
        onClose=${() => {
          const after = secret.after;
          setSecret(null);
          if (typeof after === "string" && after.startsWith("editor:")) navigate("api", ["keys", after.slice("editor:".length)]);
        }}
      />`
    : null;

  const rest = (route && route.rest) || [];
  const query = (route && route.query) || {};

  if (rest[0] === "keys" && rest[1]) {
    return html`<section class="view stack">
      <${KeyEditor} id=${rest[1]} keys=${keys} keysError=${keysAsync.error} catalog=${catalog} state=${state} onChanged=${onChanged} onSecret=${setSecret} />
      ${dialog}
    </section>`;
  }
  if (rest[0] === "history" && rest[1]) {
    return html`<section class="view stack"><${MessageDetail} id=${rest[1]} state=${state} catalog=${catalog} />${dialog}</section>`;
  }

  const tab = tabOf(query.tab);
  const tabs = TABS.map((id) => ({ id, label: t(`api.tab_${id}`), badge: id === "keys" && state.counts ? state.counts.active : undefined }));
  const routeKey = JSON.stringify(query);
  const keysProps = { keys, error: keysAsync.error, reload: keysAsync.reload, state, catalog, onChanged, onSecret: setSecret };

  return html`<section class="view stack">
    <div class="view-header">
      <h1>${t("api.title")}</h1>
      <button type="button" class="btn btn-sm" onClick=${reloadAll}><${Icon} name="refresh" />${t("common.refresh")}</button>
    </div>
    <p class="muted">${t("api.intro")}</p>
    <${StateBanners} state=${state} />
    <${EnableCard} state=${state} onChanged=${onChanged} />
    <${Tabs} tabs=${tabs} active=${tab} label=${t("api.title")} idPrefix="api-tab" onChange=${(id) => navigate("api", [], id === "keys" ? {} : { tab: id })} />
    <${TabPanel} id="keys" active=${tab} idPrefix="api-tab"><${KeysTab} ...${keysProps} /><//>
    <${TabPanel} id="history" active=${tab} idPrefix="api-tab"><${HistoryTab} key=${routeKey} keys=${keys} catalog=${catalog} state=${state} route=${route} /><//>
    <${TabPanel} id="usage" active=${tab} idPrefix="api-tab"><${UsageTab} keys=${keys} state=${state} /><//>
    <${TabPanel} id="test" active=${tab} idPrefix="api-tab"><${TestTab} key=${routeKey} catalog=${catalog} state=${state} route=${route} /><//>
    <${TabPanel} id="docs" active=${tab} idPrefix="api-tab"><${DocsTab} catalog=${catalog} state=${state} route=${route} /><//>
    ${dialog}
  </section>`;
}

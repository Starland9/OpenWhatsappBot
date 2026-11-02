// The Documentation tab (feature 004, contracts/panel-ui.md 7.11): quick start, the static auth / limits / errors texts, the
// endpoints table, one example per format built from the descriptors (a new format needs no edit here) and the OpenAPI
// download. No network except the download.
import { html, useRef, useState, useAction, DataTable, EmptyState, Icon } from "../components/index.mjs";
import { t } from "../i18n.mjs";
import { download as defaultDownload } from "../api.mjs";
import { isInsecureRemote } from "../ui.mjs";
import { buildHash } from "../router.mjs";
import { apiBaseUrl, copyText, endpointUrl } from "./api-logic.mjs";
import { curlExample, orderedFormats } from "./api-form-logic.mjs";

const base = "/admin/api/api";
// the name the server sends in Content-Disposition; this one is only the fallback
const OPENAPI_FILE = "openwhatsappbot-api-v1.openapi.json";

/** Select the text of a node with the Selection API (guarded: absent in a minimal DOM). */
function selectNode(node) {
  const selection = typeof globalThis.getSelection === "function" ? globalThis.getSelection() : null;
  const doc = globalThis.document;
  if (!node || !selection || !doc || typeof doc.createRange !== "function") return;
  const range = doc.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** A `pre.code-block` with its Copy button; when the clipboard is out of reach the text is selected for a manual copy. */
function CodeBlock({ code, title }) {
  const ref = useRef(null);
  const [state, setState] = useState("idle");
  const copy = async () => {
    const outcome = await copyText(code);
    if (outcome === "copied") setState("copied");
    else {
      setState("manual");
      selectNode(ref.current);
    }
  };
  return html`<div class="stack-sm">
    ${title ? html`<p class="muted">${title}</p>` : null}
    <pre class="code-block" ref=${ref}>${code}</pre>
    <div class="row-wrap">
      <button type="button" class="btn btn-sm" onClick=${copy}><${Icon} name="copy" />${state === "copied" ? t("api.docs_copied") : t("api.docs_copy_block")}</button>
      ${state === "manual" ? html`<span class="field-hint" role="status">${t("api.copy_manual")}</span>` : null}
    </div>
  </div>`;
}

/** The thirteen `messages.send.*` rights collapse into one chip; the others stay as written. */
function RightsCell({ rights }) {
  const list = rights || [];
  const send = list.some((id) => id.startsWith("messages.send."));
  const others = list.filter((id) => !id.startsWith("messages.send."));
  if (!send && others.length === 0) return html`<span class="muted">-</span>`;
  return html`<span class="row-wrap">${send ? html`<span class="chip">${t("api.docs_rights_send")}</span>` : null}${others.map((id) => html`<span class="chip mono" key=${id}>${id}</span>`)}</span>`;
}

/** `DocsTab({ catalog, state, route, deps })` */
export function DocsTab({ catalog, state, deps = {} }) {
  const [busy, run] = useAction();
  const download = deps.download || defaultDownload;
  const formats = orderedFormats(catalog);
  const sendEndpoint = (catalog.endpoints || []).find((endpoint) => endpoint.method === "POST" && /\/messages$/.test(endpoint.path)) || { path: `${catalog.basePath || "/api/v1"}/messages` };
  const url = endpointUrl(state, sendEndpoint);
  const text = formats.find((format) => format.name === "text") || formats[0] || null;

  const columns = [
    { key: "method", label: t("api.docs_col_method"), render: (row) => html`<span class="mono">${row.method}</span>` },
    { key: "path", label: t("api.docs_col_path"), render: (row) => html`<span class="mono">${row.path}</span>` },
    { key: "rights", label: t("api.docs_col_rights"), render: (row) => html`<${RightsCell} rights=${row.rights} />` },
    { key: "summary", label: t("api.docs_col_summary"), render: (row) => row.summary },
  ];

  const fetchFile = () => run(() => download("GET", `${base}/openapi`, undefined, OPENAPI_FILE));

  return html`<div class="stack">
    <section class="card stack">
      <h2 class="card-title">${t("api.docs_quick_title")}</h2>
      <ol class="stack-sm">
        <li>${t("api.docs_step_enable")}</li>
        <li>${t("api.docs_step_create")}</li>
        <li>${t("api.docs_step_copy")}</li>
        <li>${t("api.docs_step_send")}</li>
      </ol>
      <p class="row-wrap"><span class="muted">${t("api.docs_base_url")}</span><span class="mono">${apiBaseUrl(state)}</span></p>
      ${isInsecureRemote() ? html`<div class="banner banner-warn" role="status"><${Icon} name="warning" /><div class="banner-body">${t("api.docs_http_warning")}</div></div>` : null}
      <p class="muted">${t("api.docs_plain_http")}</p>
      ${text ? html`<${CodeBlock} code=${curlExample({ url, descriptor: text })} />` : null}
    </section>
    <section class="card stack-sm">
      <h2 class="card-title">${t("api.docs_auth_title")}</h2>
      <p>${t("api.docs_auth_text")}</p>
      <p>${t("api.docs_idempotency_text")}</p>
      <p>${t("api.docs_limits_text")}</p>
      <p>${t("api.docs_errors_text")}</p>
      <p>${t("api.docs_status_text")}</p>
      <p>${t("api.docs_replies_text")}</p>
    </section>
    <section class="card stack-sm">
      <h2 class="card-title">${t("api.docs_endpoints_title")}</h2>
      <p class="muted">${t("api.docs_english_note")}</p>
      <${DataTable} columns=${columns} rows=${catalog.endpoints || []} rowKey="id" caption=${t("api.docs_endpoints_title")} empty=${html`<${EmptyState} icon="info" title=${t("api.state_registry_failed", { endpoint: "?" })} />`} />
    </section>
    <section class="card stack">
      <h2 class="card-title">${t("api.docs_formats_title")}</h2>
      ${formats.map((format) => {
        const media = format.media;
        return html`<article class="stack-sm" key=${format.name}>
          <h3 class="card-title">${t(format.labelKey)}</h3>
          <p class="muted">${t(format.descKey)}</p>
          ${media
            ? html`<${CodeBlock} code=${curlExample({ url, descriptor: format, fileName: `file.${(media.accept && media.accept[0] ? media.accept[0].split("/")[1] || "bin" : "bin").replace(/[^a-z0-9]/gi, "")}` })} title=${t("api.docs_file_note")} />
              ${media.sources.includes("url") ? html`<${CodeBlock} code=${curlExample({ url, descriptor: format, source: "url" })} title=${t("api.docs_url_note")} />` : null}`
            : html`<${CodeBlock} code=${curlExample({ url, descriptor: format })} />`}
          <div><a class="btn btn-sm" href=${buildHash("api", [], { tab: "test", format: format.name })}>${t("api.docs_format_try")}</a></div>
        </article>`;
      })}
    </section>
    <section class="card stack-sm">
      <p class="muted">${t("api.docs_download_hint")}</p>
      <div><button type="button" class="btn" disabled=${busy} onClick=${fetchFile}><${Icon} name="refresh" />${t("api.docs_download")}</button></div>
    </section>
  </div>`;
}

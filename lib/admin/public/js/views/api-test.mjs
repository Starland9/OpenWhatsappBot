// The Test tab (feature 004, contracts/panel-ui.md 7.10): send a message through the real engine, from the owner's
// session (API-11), with the form generated from the format descriptors. The same call as a key would make, as curl.
import { html, useEffect, useRef, useState, useAction, EmptyState, Field, Icon } from "../components/index.mjs";
import { t } from "../i18n.mjs";
import { api } from "../api.mjs";
import { toast } from "../ui.mjs";
import { buildHash } from "../router.mjs";
import { copyText, endpointUrl } from "./api-logic.mjs";
import { buildRequest, carryOver, clientValidate, curlExample, initialValues, orderedFormats, splitFieldErrors } from "./api-form-logic.mjs";
import { DescriptorForm, removeUpload } from "./api-form.mjs";
import { errorText } from "./api-ips.mjs";
import { MessageStatus, MessageSteps } from "./api-message.mjs";
import { useMessage } from "./api-watch.mjs";

const base = "/admin/api/api";
const NO_ERRORS = Object.freeze({ byPath: {}, other: [] });
const emptyMedia = (descriptor) => ({ source: descriptor && descriptor.media && !descriptor.media.sources.includes("file") ? "url" : "file", file: null, url: "", progress: null, sizeError: null, failed: false });

/** `ResultCard({ message, catalog, state })`: the accepted message, followed until it settles. */
export function ResultCard({ message }) {
  const live = useMessage({ id: String(message.id), initial: message });
  const current = live.message || message;
  const copy = async () => {
    if ((await copyText(String(message.id))) === "manual") toast(t("api.copy_manual"), { kind: "info" });
  };
  return html`<section class="card stack-sm">
    <div class="row-wrap">
      <h3 class="card-title grow">${t("api.test_result_title")}</h3>
      <${MessageStatus} status=${current.status} />
    </div>
    <p class="row-wrap"><span>${t("api.test_queued", { id: message.id })}</span><button type="button" class="icon-btn" aria-label=${t("api.secret_copy")} onClick=${copy}><${Icon} name="copy" /></button></p>
    <${MessageSteps} message=${current} />
    <p class="muted" role="status">${live.polling ? t("api.watch_live") : t("api.watch_stopped")}</p>
    <div class="row-wrap">
      <button type="button" class="btn btn-sm" onClick=${live.refresh}><${Icon} name="refresh" />${t("api.watch_refresh")}</button>
      <a class="btn btn-sm" href=${buildHash("api", ["history", String(message.id)])}>${t("api.test_result_open")}</a>
    </div>
  </section>`;
}

/** `TestTab({ catalog, state, route, deps })` */
export function TestTab({ catalog, state, route, deps = {} }) {
  const formats = orderedFormats(catalog);
  const asked = route && route.query ? route.query.format : "";
  const first = formats.find((format) => format.name === asked) || formats[0] || null;
  const [name, setName] = useState(first ? first.name : "");
  const descriptor = formats.find((format) => format.name === name) || null;
  const [values, setValues] = useState(() => (first ? initialValues(first) : {}));
  const [media, setMedia] = useState(() => emptyMedia(first));
  const [errors, setErrors] = useState(NO_ERRORS);
  const [result, setResult] = useState(null);
  const [busy, run] = useAction();
  const drop = deps.removeUpload || removeUpload;

  // an upload that was never consumed is deleted when the tab goes away
  const upload = useRef(null);
  upload.current = media.file;
  useEffect(() => () => {
    if (upload.current) drop(upload.current.uploadId);
  }, []);

  if (!descriptor) {
    return html`<${EmptyState} icon="info" title=${t("api.state_registry_failed", { endpoint: state.failure && state.failure.endpoint ? state.failure.endpoint : "?" })} />`;
  }

  const off = !state.enabled || Boolean(state.failure);
  const changeFormat = (next) => {
    const target = formats.find((format) => format.name === next);
    if (!target || target.name === name) return;
    if (media.file) drop(media.file.uploadId);
    setName(target.name);
    setValues(carryOver(values, target));
    setMedia(emptyMedia(target));
    setErrors(NO_ERRORS);
  };

  const mediaProblem = () => {
    if (!descriptor.media) return null;
    const viaUrl = media.source === "url";
    if (viaUrl ? media.url.trim() === "" : !media.file) return t("fields.required");
    return null;
  };
  const bodyOf = (extra) => buildRequest(descriptor, values, extra);

  const submit = () =>
    run(async () => {
      const client = clientValidate(descriptor, values);
      const problem = mediaProblem();
      if (Object.keys(client).length > 0 || problem) {
        setErrors({ byPath: { ...client, ...(problem ? { media: problem } : {}) }, other: [] });
        return;
      }
      const viaUrl = descriptor.media && media.source === "url";
      const body = bodyOf(viaUrl ? { mediaUrl: media.url.trim() } : descriptor.media ? { uploadId: media.file.uploadId } : {});
      try {
        const answer = await api("POST", `${base}/test`, body);
        setResult(answer.message);
        setErrors(NO_ERRORS);
        // consumed by the server: nothing to delete, the next message starts without a file
        setMedia(emptyMedia(descriptor));
      } catch (err) {
        if (err && err.code === "validation_failed") {
          const split = splitFieldErrors(err.fields, descriptor, values);
          setErrors({ byPath: split.byPath, other: split.other });
          // an unknown upload is gone on the server side: forget it here (any other refusal keeps the file)
          if (err.fields && err.fields.uploadId && err.fields.uploadId.code === "not_found") setMedia(emptyMedia(descriptor));
          return;
        }
        throw err;
      }
    });

  const sendEndpoint = (catalog.endpoints || []).find((endpoint) => endpoint.method === "POST" && /\/messages$/.test(endpoint.path)) || { path: `${catalog.basePath || "/api/v1"}/messages` };
  const viaFile = Boolean(descriptor.media) && media.source === "file";
  const curl = curlExample({
    url: endpointUrl(state, sendEndpoint),
    descriptor,
    body: bodyOf({}),
    fileName: viaFile ? (media.file ? media.file.name : "file") : undefined,
    source: descriptor.media && media.source === "url" ? "url" : "file",
  });
  const copyCurl = async () => {
    if ((await copyText(curl)) === "manual") toast(t("api.copy_manual"), { kind: "info" });
  };

  return html`<div class="stack">
    ${off ? html`<div class="banner banner-info" role="status"><${Icon} name="info" /><div class="banner-body">${t("api.test_disabled")}</div></div>` : null}
    ${state.enabled && !state.botReady ? html`<div class="banner banner-warn" role="status"><${Icon} name="warning" /><div class="banner-body">${t("api.test_bot_offline", { minutes: state.settings ? state.settings.expiryMin : "" })}</div></div>` : null}
    <section class="card stack">
      <${Field} type="enum" name="api-test-format" label=${t("api.test_format")} value=${name} options=${formats.map((format) => ({ value: format.name, label: t(format.labelKey) }))} onChange=${changeFormat} />
      <p class="muted">${t(descriptor.descKey)}</p>
      <${DescriptorForm}
        key=${name}
        descriptor=${descriptor}
        values=${values}
        errors=${errors.byPath}
        onChange=${(next) => {
          setErrors(NO_ERRORS);
          setValues(next);
        }}
        disabled=${busy}
        deps=${deps}
        media=${descriptor.media ? media : null}
        onMedia=${setMedia}
        mediaError=${errors.byPath.media ? errorText(errors.byPath.media) : null}
      />
      ${errors.other.length
        ? html`<div class="banner banner-error" role="alert"><div class="banner-body"><p>${t("api.test_other_errors")}</p><ul>${errors.other.map((item) => html`<li key=${item.path}><span class="mono">${item.path}</span></li>`)}</ul></div></div>`
        : null}
      <div><button type="button" class="btn btn-primary" disabled=${busy || off || media.progress !== null} onClick=${submit}>${t("api.test_submit")}</button></div>
    </section>
    ${result ? html`<${ResultCard} key=${result.id} message=${result} catalog=${catalog} state=${state} />` : null}
    <section class="card stack-sm">
      <h3 class="card-title">${t("api.test_curl_title")}</h3>
      <p class="muted">${t("api.test_curl_hint")}</p>
      <pre class="code-block">${curl}</pre>
      <div><button type="button" class="btn btn-sm" onClick=${copyCurl}><${Icon} name="copy" />${t("api.docs_copy_block")}</button></div>
    </section>
  </div>`;
}

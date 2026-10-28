import { html, useState, useEffect, useAsync, useAction, Field, Pagination, Spinner, EmptyState } from "../components/index.mjs";
import { t } from "../i18n.mjs";
import { api } from "../api.mjs";
import { confirm, toastSuccess, toastError } from "../ui.mjs";
import {
  LANGS,
  DEFAULT_PAGE_SIZE,
  expectedTokens,
  validateDraft,
  isDirty,
  initialDrafts,
  statusOf,
  isOverridden,
  isStale,
  formatTokens,
  listQuery,
  replaceItem,
  textFieldError,
} from "./texts-logic.mjs";

export const meta = { area: "texts", titleKey: "texts.title", icon: "texts" };

/** The text of one language: the original, the replacement in force, and the flags */
function LanguageText({ item, lang }) {
  const entry = item.texts[lang];
  const status = statusOf(item, lang);
  return html`<div class="stack-sm">
    <div class="row-wrap">
      <strong>${t(`texts.lang.${lang}`)}</strong>
      ${status === "edited" ? html`<span class="badge badge-ok">${t("texts.edited")}</span>` : null}
      ${status === "stale" ? html`<span class="badge badge-warn">${t("texts.original_changed")}</span>` : null}
    </div>
    ${status === "original"
      ? html`<div class="mono">${entry.original === null ? t("common.none") : entry.original}</div>`
      : html`<div class="mono">${entry.effective}</div>
          <div class="field-hint">${t("texts.original_was")}</div>
          <div class="mono muted">${entry.original === null ? t("common.none") : entry.original}</div>`}
    ${status === "stale" ? html`<div class="field-hint">${t("texts.original_changed_note")}</div>` : null}
  </div>`;
}

/** The editor of one language: a textarea, the tokens it must keep, save and revert */
function LanguageEditor({ item, lang, draft, onDraft, onSave, onRevert, busy, serverError }) {
  const tokens = expectedTokens(item, lang);
  const local = isDirty(item, lang, draft) ? validateDraft(item, lang, draft) : null;
  const error = local || serverError || null;
  const dirty = isDirty(item, lang, draft);
  return html`<div class="stack-sm">
    <${Field}
      type="textarea"
      rows=${4}
      label=${t(`texts.lang.${lang}`)}
      name=${`${item.key}-${lang}`}
      value=${draft}
      onChange=${onDraft}
      error=${error}
      hint=${tokens.length ? t("texts.expected_tokens", { tokens: formatTokens(tokens) }) : t("texts.no_tokens")}
      disabled=${busy}
    />
    <div class="row-wrap">
      <span class="muted">${t("texts.chars", { count: Array.from(draft).length })}</span>
      <button type="button" class="btn btn-sm btn-primary" disabled=${busy || !dirty || Boolean(local)} onClick=${onSave}>${t("texts.save")}</button>
      ${item.texts[lang].overridden
        ? html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${onRevert}>${t("texts.revert")}</button>`
        : null}
    </div>
  </div>`;
}

/** One key: both languages side by side, and an editor that opens in place */
function TextCard({ item, onItem }) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState(() => initialDrafts(item));
  const [errors, setErrors] = useState({});
  const [busy, run] = useAction();

  // the item was replaced by the server's answer (or by a new page): the editor starts from what is in force
  useEffect(() => {
    setDrafts(initialDrafts(item));
    setErrors({});
  }, [item]);

  const save = (lang) =>
    run(
      async () => {
        try {
          const answer = await api("PUT", `/admin/api/texts/${lang}/${encodeURIComponent(item.key)}`, { text: drafts[lang] });
          onItem(answer.item);
          setErrors((e) => ({ ...e, [lang]: null }));
          toastSuccess(t("texts.saved"));
        } catch (error) {
          const field = textFieldError(error);
          if (field) setErrors((e) => ({ ...e, [lang]: field }));
          else toastError(error);
        }
      },
      { silent: true },
    );

  const revert = async (lang) => {
    const ok = await confirm({
      title: t("texts.revert_title"),
      message: t("texts.revert_message", { language: t(`texts.lang.${lang}`) }),
      confirmLabel: t("texts.revert"),
      danger: false,
    });
    if (!ok) return;
    await run(async () => {
      const answer = await api("DELETE", `/admin/api/texts/${lang}/${encodeURIComponent(item.key)}`);
      onItem(answer.item);
      toastSuccess(t("texts.reverted"));
    });
  };

  return html`<article class="card" id=${`text-${item.key}`}>
    <div class="row-wrap">
      <span class="mono grow">${item.key}</span>
      ${item.command ? html`<span class="badge badge-info">${t("texts.command_badge", { command: item.command })}</span>` : null}
      ${isOverridden(item) ? html`<span class="badge badge-ok">${t("texts.edited")}</span>` : null}
      ${isStale(item) ? html`<span class="badge badge-warn">${t("texts.original_changed")}</span>` : null}
      <button type="button" class="btn btn-sm" aria-expanded=${open ? "true" : "false"} onClick=${() => setOpen(!open)}>${open ? t("texts.close") : t("texts.edit")}</button>
    </div>
    ${item.placeholders.length ? html`<div class="field-hint">${t("texts.expected_tokens", { tokens: formatTokens(item.placeholders) })}</div>` : null}
    <div class="grid">${LANGS.map((lang) => html`<${LanguageText} key=${lang} item=${item} lang=${lang} />`)}</div>
    ${open
      ? html`<div class="grid">${LANGS.map(
          (lang) => html`<${LanguageEditor}
            key=${lang}
            item=${item}
            lang=${lang}
            draft=${drafts[lang]}
            onDraft=${(value) => setDrafts((d) => ({ ...d, [lang]: value }))}
            onSave=${() => save(lang)}
            onRevert=${() => revert(lang)}
            busy=${busy}
            serverError=${errors[lang]}
          />`,
        )}</div>`
      : null}
  </article>`;
}

/** TXT-1 to TXT-3: search the bot's texts, compare the original with the one in force, edit it, put it back. */
export default function TextsView() {
  const [typed, setTyped] = useState({ q: "", command: "", overridden: false, changed: false });
  const [applied, setApplied] = useState(typed);
  const [page, setPage] = useState(1);
  const [items, setItems] = useState(null);

  // the search follows the typing after a short pause (one request per pause, not per key)
  useEffect(() => {
    const timer = setTimeout(() => {
      setApplied(typed);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [typed]);

  const query = listQuery(applied, page, DEFAULT_PAGE_SIZE);
  const { data, error, loading, reload } = useAsync(() => api("GET", "/admin/api/texts", query), [JSON.stringify(query)]);
  useEffect(() => {
    if (data) setItems(data.items);
  }, [data]);

  const set = (name) => (value) => setTyped((f) => ({ ...f, [name]: value }));
  const onItem = (item) => setItems((list) => replaceItem(list, item));

  return html`<section class="view stack">
    <div class="view-header"><h1>${t("texts.title")}</h1></div>
    <p class="muted">${t("texts.intro")}</p>
    <form class="card form" onSubmit=${(event) => event.preventDefault()} role="search">
      <div class="grid">
        <${Field} label=${t("texts.search_label")} name="q" type="text" value=${typed.q} onChange=${set("q")} placeholder=${t("texts.search_placeholder")} maxLength=${100} />
        <${Field} label=${t("texts.command_label")} name="command" type="text" value=${typed.command} onChange=${set("command")} placeholder=${t("texts.command_placeholder")} maxLength=${64} />
      </div>
      <div class="row-wrap">
        <${Field} label=${t("texts.only_edited")} name="overridden" type="bool" value=${typed.overridden} onChange=${set("overridden")} />
        <${Field} label=${t("texts.only_changed")} name="changed" type="bool" value=${typed.changed} onChange=${set("changed")} />
      </div>
    </form>
    ${items === null
      ? error
        ? html`<${EmptyState} icon="error" title=${t("common.view_error")} message=${t("common.view_error_hint")}>
            <button type="button" class="btn" onClick=${reload}>${t("common.retry")}</button>
          <//>`
        : html`<${Spinner} />`
      : html`<p class="muted" role="status">${t("texts.count", { count: data ? data.total : items.length })}</p>
          ${items.length
            ? html`<div class="stack">${items.map((item) => html`<${TextCard} key=${item.key} item=${item} onItem=${onItem} />`)}</div>`
            : html`<${EmptyState} icon="info" title=${t("texts.none")} />`}
          ${data ? html`<${Pagination} page=${data.page} pageSize=${data.pageSize} total=${data.total} onPage=${setPage} disabled=${loading} />` : null}`}
  </section>`;
}

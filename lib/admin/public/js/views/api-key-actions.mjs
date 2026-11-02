// Every key write of the SPA (feature 004, contracts/panel-ui.md 2 and 7.4-7.5): create, update, duplicate, revoke, with
// their confirmations and the step-up wiring. One file so the literals of the contract tests and the 2600-character
// window between a confirmation and its call have one home; the list and the editor share it.
import { t } from "../i18n.mjs";
import { api } from "../api.mjs";
import { confirm, toast, toastSuccess } from "../ui.mjs";
import { withStepUp } from "../reauth.mjs";
import { buildKeyBody, validateKey, widenings } from "./api-logic.mjs";

const base = "/admin/api/api";

/** The ban-risk warning of the "anyone" policy (FR-012); resolves true when the owner accepts. */
export async function askAnyone() {
  return confirm({ danger: true, title: t("api.anyone_title"), message: t("api.anyone_warning"), confirmLabel: t("api.anyone_confirm") });
}

/**
 * Create (`saved === null`, POST) or update (PUT) a key. Resolves `{ status: "invalid", errors }` (nothing sent),
 * `{ status: "cancelled" }` (the password or the "anyone" question was refused, nothing sent) or
 * `{ status: "created" | "updated", key, secret?, changed? }`. A server refusal is thrown as the ApiError it is.
 */
export async function saveKey({ draft, saved, names, limits, now = Date.now(), ask = askAnyone, step = withStepUp }) {
  const check = validateKey(draft, { names, limits, now });
  if (!check.ok) return { status: "invalid", errors: check.errors };
  let body = buildKeyBody(draft, saved);
  const id = saved ? saved.id : null;
  const reasons = widenings(saved, body);
  const send = () => (saved ? api("PUT", `${base}/keys/${encodeURIComponent(id)}`, body) : api("POST", `${base}/keys`, body));
  const guarded = () => step(send, { needed: reasons.length > 0, reasons });

  let result;
  try {
    result = await guarded();
  } catch (err) {
    // the predicate was bypassed: the server wants the "anyone" confirmation, ask it and retry once
    const wanted = err && err.code === "confirmation_required" && err.params && err.params.confirm;
    const missing = Array.isArray(wanted) && wanted.includes("policy_anyone") && !(body.confirm || []).includes("policy_anyone");
    if (!missing) throw err;
    if (!(await ask())) return { status: "cancelled" };
    body = { ...body, confirm: ["policy_anyone"] };
    result = await guarded();
  }
  if (!result.ok) return { status: "cancelled" };
  const answer = result.value;
  return saved ? { status: "updated", key: answer.key, changed: answer.changed } : { status: "created", key: answer.key, secret: answer.secret };
}

/** A duplicate is a creation: the password is asked, the body is empty (the server names the copy), the secret is shown once. */
export async function duplicateKey(key, { run, onSecret, onChanged }) {
  return run(async () => {
    const result = await withStepUp(() => api("POST", `${base}/keys/${encodeURIComponent(key.id)}/duplicate`, {}), { needed: true, reasons: ["create"] });
    if (!result.ok) return null;
    const created = result.value.key;
    onSecret({ secret: result.value.secret, name: created.name, last4: created.last4, after: "list" });
    toastSuccess(t("api.duplicate_done", { name: created.name }));
    if (onChanged) onChanged();
    return created;
  });
}

// the question names the queued messages the revoke will cancel; it sits directly above the call that sends `confirm: true`
async function askRevoke(key) {
  return confirm({
    title: t("api.revoke_title", { name: key.name }),
    message: key.queued ? t("api.revoke_message", { count: key.queued }) : t("api.revoke_message_none"),
    confirmLabel: t("api.revoke_confirm"),
  });
}

/** Revoke: final, no password. `cancelled: null` means the cancellation failed server-side (the claim-time guard still stops sends). */
export async function revokeKey(key, { run, onChanged }) {
  return run(async () => {
    if (!(await askRevoke(key))) return null;
    const answer = await api("POST", `${base}/keys/${encodeURIComponent(key.id)}/revoke`, { confirm: true });
    const cancelled = answer && typeof answer.cancelled === "number" ? answer.cancelled : null;
    toast(cancelled === null ? t("api.revoke_done_nocount", { name: key.name }) : t("api.revoke_done", { name: key.name, count: cancelled, cancelled }), { kind: "success" });
    if (onChanged) onChanged();
    return answer;
  });
}

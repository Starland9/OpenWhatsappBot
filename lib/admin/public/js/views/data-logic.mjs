// Pure logic of the data view (DATA-1 to DATA-3 of contracts/admin-http-api.md 2.10, FR-042 to FR-045): the eight
// tabs and the filters each one sends, the query of a tab, the action a row offers and the request it sends, the
// economy adjustment (payload, the same checks the server makes, and the pre-check that a debit must not take the
// balance below zero). No DOM access and no import: node:test loads this file. The server stays authoritative; every
// check here answers with the field codes of the API so a refusal reads the same wherever it comes from.

/** The tabs, in display order; a kind is also the `:kind` of the API */
export const KINDS = Object.freeze(["reminders", "economy", "keywords", "sticker-commands", "afk", "tasks", "ideas", "quotes"]);
export const DEFAULT_KIND = "reminders";

export const PAGE_SIZE = 25;
/** The server's own default page size: a request for it needs no `pageSize` */
export const SERVER_PAGE_SIZE = 50;
export const SEARCH_MAX = 100;
export const REASON_MAX = 200;
/** Largest balance and largest single amount (the server's limit) */
export const MAX_BALANCE = 2000000000;
export const MODES = Object.freeze(["add", "set"]);
export const TEXT_EXCERPT = 160;

export const GROUP_JID = /^\d{5,20}(?:-\d{1,20})?@g\.us$/;
export const CHAT_JID = /^\d{5,20}(?:-\d{1,20})?@(?:g\.us|s\.whatsapp\.net|lid)$/;
const USER_JID = /^\d{5,20}(?::\d{1,4})?@(?:s\.whatsapp\.net|lid)$/;

/** Which of the filters a tab sends (the others do not apply to its data) */
export const FILTERS = Object.freeze({
  reminders: Object.freeze(["q", "chat", "status"]),
  economy: Object.freeze(["groupJid", "q"]),
  keywords: Object.freeze(["q", "chat"]),
  "sticker-commands": Object.freeze(["q"]),
  afk: Object.freeze(["q"]),
  tasks: Object.freeze(["q", "chat"]),
  ideas: Object.freeze(["q", "chat"]),
  quotes: Object.freeze(["q", "chat"]),
});

/** The tab named by `?tab=`, else the first one */
export const tabOf = (tab) => (KINDS.includes(tab) ? tab : DEFAULT_KIND);

/** `data.tab.<kind>`-style key suffix: the kind itself (hyphens are allowed in a panel key) */
export const tabKey = (kind) => `data.tab.${kind}`;

/** Does this filter apply to this tab? */
export const appliesTo = (kind, filter) => Boolean(FILTERS[kind] && FILTERS[kind].includes(filter));

/** The filters a tab starts with */
export const emptyFilters = () => ({ q: "", chat: "", status: "pending", groupJid: "" });

const text = (value) => (value === undefined || value === null ? "" : String(value));

/**
 * The DATA-1 query of a tab. Empty filters and the defaults are left out (`status=pending`, page 1, the server's own
 * page size); a filter that does not apply to the tab is never sent (an unknown parameter would be refused).
 */
export function tabQuery(kind, filters = {}, page = 1, pageSize = PAGE_SIZE) {
  const query = {};
  if (appliesTo(kind, "groupJid")) {
    const group = text(filters.groupJid).trim();
    if (group) query.groupJid = group;
  }
  if (appliesTo(kind, "q")) {
    const q = text(filters.q).trim();
    if (q) query.q = q.slice(0, SEARCH_MAX);
  }
  if (appliesTo(kind, "chat")) {
    const chat = text(filters.chat).trim();
    if (chat) query.chat = chat;
  }
  if (appliesTo(kind, "status") && filters.status === "all") query.status = "all";
  if (page > 1) query.page = page;
  if (pageSize !== SERVER_PAGE_SIZE) query.pageSize = pageSize;
  return query;
}

/** The economy tab has nothing to show until a group is chosen; the other tabs always load */
export const canLoad = (kind, filters = {}) => (kind === "economy" ? GROUP_JID.test(text(filters.groupJid).trim()) : true);

/** Field errors of the filters before a request is made: `{ chat?, groupJid? }` with API field codes */
export function filterErrors(kind, filters = {}) {
  const errors = {};
  if (appliesTo(kind, "chat")) {
    const chat = text(filters.chat).trim();
    if (chat && !CHAT_JID.test(chat)) errors.chat = { code: "invalid_jid" };
  }
  if (appliesTo(kind, "groupJid")) {
    const group = text(filters.groupJid).trim();
    if (group && !GROUP_JID.test(group)) errors.groupJid = { code: "invalid_jid" };
  }
  return errors;
}

// ---- rows ------------------------------------------------------------------------------------------------------

/** "237690000001" for a phone number, "99990001 (LID)" for a LID, a group without its server part */
export function shortJid(jid) {
  const value = text(jid);
  const at = value.indexOf("@");
  if (at < 0) return value;
  const user = value.slice(0, at);
  return value.slice(at + 1) === "lid" ? `${user} (LID)` : user;
}

/** One line cut to `max` characters (code points), with an ellipsis */
export function excerpt(value, max = TEXT_EXCERPT) {
  const chars = Array.from(text(value).replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

/** The key of a row in a list */
export function rowKey(kind, row) {
  if (kind === "afk") return row.jid;
  if (kind === "economy") return `${row.groupJid}:${row.userJid}`;
  return row.id;
}

/** economy keeps no delete; every other tab can act on a row */
export const isRemovable = (kind) => KINDS.includes(kind) && kind !== "economy";

/** What the button of a row does: a reminder is cancelled, an AFK status cleared, the rest deleted */
export function actionOf(kind) {
  if (kind === "reminders") return "cancel";
  if (kind === "afk") return "clear";
  return "delete";
}

/** Does this row offer its action? A reminder only while it is pending */
export function canAct(kind, row) {
  if (!isRemovable(kind) || !row) return false;
  return kind === "reminders" ? row.status === "pending" : true;
}

/** The `:id` of a row: the user JID for afk, the numeric id otherwise */
export const removalId = (kind, row) => (kind === "afk" ? row.jid : row.id);

/** DATA-2 path of a row */
export const removalPath = (kind, id) => `/admin/api/data/${kind}/${encodeURIComponent(id)}`;

/** The page to show once a row is gone: back one page when it was the last row of a page after the first */
export const pageAfterRemoval = (page, rowsOnPage) => (page > 1 && rowsOnPage <= 1 ? page - 1 : page);

/** The items without the row `id` of the tab */
export function withoutRow(items, kind, id) {
  return (items || []).filter((row) => String(removalId(kind, row)) !== String(id));
}

// ---- economy adjustment ------------------------------------------------------------------------------------------

/** The form a new adjustment starts from */
export const emptyAdjustment = (groupJid = "") => ({ groupJid, userJid: "", mode: "add", amount: null, reason: "" });

/**
 * A member as the API wants it: a typed phone number ("+237 690 000 001") becomes `<digits>@s.whatsapp.net`, a JID is
 * trimmed and lower-cased, a device suffix kept for the server to drop.
 */
export function normalizeMember(value) {
  const raw = text(value).trim();
  if (!raw) return "";
  if (!raw.includes("@")) {
    const digits = raw.replace(/\D/g, "");
    return digits ? `${digits}@s.whatsapp.net` : raw;
  }
  return raw.toLowerCase();
}

/** The balance the account would have after the adjustment; null when the amount is not a whole number yet */
export function projectedBalance(mode, amount, balance) {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount)) return null;
  const current = Number.isFinite(balance) ? balance : 0;
  return mode === "set" ? amount : current + amount;
}

/** The balance the list shows for this member of this group, or null when the member is not listed */
export function knownBalance(items, groupJid, userJid) {
  const wanted = normalizeMember(userJid);
  if (!wanted) return null;
  const row = (items || []).find((item) => item.groupJid === groupJid && item.userJid === wanted);
  return row ? Number(row.balance) || 0 : null;
}

/**
 * Check an adjustment like the server does: `{ field: { code, params? } }`, empty when it would be accepted.
 * `balance` is the member's current balance when the list shows it, else null: the "negative result" pre-check of a
 * debit then waits for the server, which knows the real balance (`422 negative_balance`, nothing written).
 */
export function validateAdjustment(form = {}, balance = null) {
  const errors = {};
  const group = text(form.groupJid).trim();
  if (!group) errors.groupJid = { code: "required" };
  else if (!GROUP_JID.test(group)) errors.groupJid = { code: "invalid_jid" };

  const member = normalizeMember(form.userJid);
  if (!member) errors.userJid = { code: "required" };
  else if (!USER_JID.test(member)) errors.userJid = { code: "invalid_jid" };

  if (!MODES.includes(form.mode)) errors.mode = { code: "not_allowed", params: { allowed: [...MODES] } };

  const amount = form.amount;
  if (amount === null || amount === undefined || amount === "") {
    errors.amount = { code: "required" };
  } else if (typeof amount !== "number" || !Number.isSafeInteger(amount)) {
    errors.amount = { code: "invalid_type" };
  } else if (form.mode === "set" && (amount < 0 || amount > MAX_BALANCE)) {
    errors.amount = { code: "out_of_range", params: { min: 0, max: MAX_BALANCE } };
  } else if (Math.abs(amount) > MAX_BALANCE) {
    errors.amount = { code: "out_of_range", params: { min: -MAX_BALANCE, max: MAX_BALANCE } };
  } else if (form.mode === "add" && Number.isFinite(balance)) {
    // only when the list shows the member's balance: for any other member the server decides
    const projected = projectedBalance("add", amount, balance);
    if (projected < 0) errors.amount = { code: "negative_balance" };
    else if (projected > MAX_BALANCE) errors.amount = { code: "out_of_range", params: { min: -MAX_BALANCE, max: MAX_BALANCE } };
  }

  const reason = text(form.reason).trim();
  if (!reason) errors.reason = { code: "required" };
  else if (Array.from(reason).length > REASON_MAX) errors.reason = { code: "too_long", params: { max: REASON_MAX } };
  return errors;
}

/** Is the adjustment ready to send? */
export const isAdjustmentValid = (form, balance = null) => Object.keys(validateAdjustment(form, balance)).length === 0;

/** The DATA-3 body: exactly the five properties the route accepts, the member normalized, the reason trimmed */
export function adjustmentPayload(form = {}) {
  return {
    groupJid: text(form.groupJid).trim(),
    userJid: normalizeMember(form.userJid),
    mode: form.mode,
    amount: form.amount,
    reason: text(form.reason).trim(),
  };
}

/**
 * The field errors of a refused adjustment, from an ApiError: a `validation_failed` keeps its own fields, a
 * `negative_balance` (nothing was written) is shown on the amount. Null for any other error (it becomes a toast).
 */
export function adjustmentErrors(error) {
  if (!error) return null;
  if (error.code === "negative_balance") return { amount: { code: "negative_balance" } };
  if (error.code === "validation_failed" && error.fields && Object.keys(error.fields).length) return { ...error.fields };
  return null;
}

/** The list rows after an adjustment: the member's new balance replaces the old one (a new member is not added) */
export function applyAdjustment(items, groupJid, userJid, balance) {
  const wanted = normalizeMember(userJid);
  return (items || []).map((row) => (row.groupJid === groupJid && row.userJid === wanted ? { ...row, balance } : row));
}

/** "+25" / "-5" / "0" for the delta an adjustment applied */
export const formatDelta = (delta) => (delta > 0 ? `+${delta}` : String(delta));

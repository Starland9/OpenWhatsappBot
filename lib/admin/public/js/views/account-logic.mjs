// Pure helpers for the account view (preferences, AUTH-6).

export const UI_LANGS = ["fr", "en"];
export const THEME_CHOICES = ["auto", "light", "dark"];

/** AUTH-6 body: only what changed, at least one property; null when nothing changed. */
export function preferencesChange(current, wanted) {
  const body = {};
  if (wanted.uiLang && UI_LANGS.includes(wanted.uiLang) && wanted.uiLang !== (current && current.uiLang)) body.uiLang = wanted.uiLang;
  if (wanted.theme && THEME_CHOICES.includes(wanted.theme) && wanted.theme !== (current && current.theme)) body.theme = wanted.theme;
  return Object.keys(body).length ? body : null;
}

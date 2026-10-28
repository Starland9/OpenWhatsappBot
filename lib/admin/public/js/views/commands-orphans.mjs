// Rows of the command-state table whose command no longer exists (an alias was renamed): listed so the owner
// can remove them. Removing is "enable in that scope", which deletes the row.
import { html, Icon } from "../components/index.mjs";
import { t } from "../i18n.mjs";
import { groupOrphans, GLOBAL_SCOPE, shortJid } from "./commands-logic.mjs";

/**
 *   orphans  CMD-1 `orphans` ([{ command, scope }])
 *   busy     an action is running
 *   onRemove(command, scope) -> Promise
 */
export function OrphanRows({ orphans, busy, onRemove }) {
  const groups = groupOrphans(orphans);
  if (groups.length === 0) return null;
  return html`<section class="card" aria-labelledby="commands-orphans-title">
    <h2 class="card-title" id="commands-orphans-title">${t("commands.orphans_title")}</h2>
    <p class="muted">${t("commands.orphans_hint")}</p>
    <ul class="stack-sm">
      ${groups.map(
        ({ command, scopes }) => html`<li key=${command} class="stack-sm">
          <span class="mono">${command}</span>
          <ul class="row-wrap">
            ${scopes.map(
              (scope) => html`<li key=${scope} class="chip">
                <span class="chip-text mono" title=${scope}>${scope === GLOBAL_SCOPE ? t("commands.scope_everywhere") : shortJid(scope)}</span>
                <button type="button" class="icon-btn" disabled=${busy} aria-label=${t("commands.orphans_remove", { command, scope: scope === GLOBAL_SCOPE ? t("commands.scope_everywhere") : shortJid(scope) })} onClick=${() => onRemove(command, scope)}><${Icon} name="trash" /></button>
              </li>`,
            )}
          </ul>
        </li>`,
      )}
    </ul>
  </section>`;
}

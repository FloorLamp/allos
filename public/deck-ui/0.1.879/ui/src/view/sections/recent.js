import {h} from '../../../vendor/preact.mjs';
import htm from '../../../vendor/htm.mjs';
import {Section} from './section.js';
import {Row} from '../rows.js';
import {StateBlock} from '../page-state.js';
const html = htm.bind(h);
/** Controller rows retain selection, confirmation, menus and drag actions. */
export function Recent({rows = [], renderRow, fold, empty, limit = Infinity, onMore, label, onClear, more: remaining = 0}) {
  if (!rows.length && !empty) return null;
  const shown = rows.slice(0, limit), more = remaining + rows.length - shown.length;
  return html`<${Section} id="recent" label="Recent" class="dk-landing-section" count=${rows.length + remaining} fold=${fold} headerActions=${onClear ? html`<button type="button" tabindex="-1" class="dp-labelbtn clear" onClick=${onClear}>Clear</button>` : null}>
    ${label}
    ${!rows.length && empty ? html`<${StateBlock} inline=${true} line=${empty} />` : null}
    ${shown.map((row, i) => renderRow ? renderRow(row, i) : html`<${Row} row=${row} />`)}
    ${more ? html`<button type="button" class="dk-btn text" onClick=${onMore}>+${more} more</button>` : null}
  </${Section}>`;
}

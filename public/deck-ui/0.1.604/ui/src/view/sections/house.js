import {h} from '../../../vendor/preact.mjs';
import htm from '../../../vendor/htm.mjs';
import {Section} from './section.js';
import {Row} from '../rows.js';
const html = htm.bind(h);
/** Controller rows retain selection, confirmation, menus and drag actions. */
export function House({rows = [], renderRow, fold, empty, limit = Infinity, onMore, label, total}) {
  if (!rows.length && !empty) return null;
  const shown = rows.slice(0, limit), more = rows.length - shown.length;
  return html`<${Section} id="house" label="House" class=${`dk-landing-section${total != null ? ' dk-house-tiles' : ''}`} count=${rows[0]?.count ?? rows.length} fold=${fold}>
    ${label}
    ${!rows.length && empty ? html`<div class="dk-section-empty">${empty}</div>` : null}
    ${shown.map((row, i) => renderRow ? renderRow(row, i) : html`<${Row} row=${row} />`)}
    ${(total ?? more) ? html`<button type="button" class="dk-btn text" onClick=${onMore}>${total != null ? `All ${total} ›` : `+${more} more`}</button>` : null}
  </${Section}>`;
}

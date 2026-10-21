import {h} from '../../../vendor/preact.mjs';
import htm from '../../../vendor/htm.mjs';
import {Section} from './section.js';
import {Row} from '../rows.js';
const html = htm.bind(h);
/** Controller rows retain selection, confirmation, menus and drag actions. */
/** `state`: a failure in the section's place, instead of the empty row. */
export function House({rows = [], renderRow, fold, empty, limit = Infinity, onMore, label, total, state}) {
  if (!rows.length && !empty && !state) return null;
  const shown = rows.slice(0, limit), more = rows.length - shown.length;
  return html`<${Section} id="house" label="House" class=${`dk-landing-section${total != null ? ' dk-house-tiles' : ''}`} count=${rows[0]?.count ?? rows.length} fold=${fold}>
    ${label}
    ${state}
    ${!rows.length && !state ? empty : null}
    ${shown.map((row, i) => renderRow ? renderRow(row, i) : html`<${Row} row=${row} />`)}
    ${(total ?? more) ? html`<button type="button" class="dk-btn text" onClick=${onMore}>${total != null ? `All ${total} ›` : `+${more} more`}</button>` : null}
  </${Section}>`;
}

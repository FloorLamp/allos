import {h} from '../../../vendor/preact.mjs';
import htm from '../../../vendor/htm.mjs';
import {Section} from './section.js';
import {Row} from '../rows.js';
const html = htm.bind(h);
/** Controller rows retain selection, confirmation, menus and drag actions. */
export function Today({rows = [], renderRow, fold, empty, limit = Infinity, onMore, label}) {
  if (!rows.length && !empty) return null;
  const shown = rows.slice(0, limit), more = rows.length - shown.length;
  return html`<${Section} id="today" label="Today" class="dk-landing-section" count=${rows.length} fold=${fold}>
    ${label}
    ${!rows.length && empty ? html`<div class="dk-section-empty">${empty}</div>` : null}
    ${shown.map((row, i) => renderRow ? renderRow(row, i) : html`<${Row} row=${row} />`)}
    ${more ? html`<button type="button" class="dk-btn text" onClick=${onMore}>+${more} more</button>` : null}
  </${Section}>`;
}

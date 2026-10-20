import {h} from '../../../vendor/preact.mjs';
import htm from '../../../vendor/htm.mjs';
import {Row as GlanceRow} from './row.js';
import {Section} from './section.js';
import {Row} from '../rows.js';
const html = htm.bind(h);
/** Controller rows retain selection, confirmation, menus and drag actions. */
export function Needs({rows = [], renderRow, fold, limit = Infinity, onMore, label, row, onOpen, count}) {
  if (row) return html`<${GlanceRow} kind="problem" row=${row} onOpen=${onOpen} />`;
  if (!rows.length) return null;
  const shown = rows.slice(0, limit), more = rows.length - shown.length;
  return html`<${Section} id="needs" label="Needs you" class="dk-landing-section" count=${count ?? rows[0]?.count ?? rows.length} fold=${fold}>
    ${label}
    ${shown.map((row, i) => renderRow ? renderRow(row, i) : html`<${Row} row=${row} />`)}
    ${more ? html`<button type="button" class="dk-btn text" onClick=${onMore}>+${more} more</button>` : null}
  </${Section}>`;
}

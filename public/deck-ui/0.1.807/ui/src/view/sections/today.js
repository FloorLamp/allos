import {h} from '../../../vendor/preact.mjs';
import htm from '../../../vendor/htm.mjs';
import {Section} from './section.js';
import {Row} from '../rows.js';
import {Failure, Skeleton, StateBlock} from '../page-state.js';
const html = htm.bind(h);
/** Controller rows retain selection, confirmation, menus and drag actions. */
export function Today({rows = [], renderRow, fold, empty, limit = Infinity, onMore, label, loading = false, error, retry, host}) {
  if (!rows.length && !empty && !error) return null;
  const shown = rows.slice(0, limit), more = rows.length - shown.length;
  return html`<${Section} id="today" label="Today" class="dk-landing-section" count=${rows.length} fold=${fold}>
    ${label}
    ${error ? html`<${Failure} named=${true} backend="flightplan" error=${error} retry=${retry} host=${host} />` : !rows.length && loading ? html`<${Skeleton} inline=${true} />`
      : !rows.length && empty ? html`<${StateBlock} inline=${true} line=${empty} />` : null}
    ${shown.map((row, i) => renderRow ? renderRow(row, i) : html`<${Row} row=${row} />`)}
    ${more ? html`<button type="button" class="dk-btn text" onClick=${onMore}>+${more} more</button>` : null}
  </${Section}>`;
}

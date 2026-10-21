// A landing section of shared rows (RowList) that folds: Find's Due soon and Browse. The first `limit` rows, then `+N more` shows
// the rest in place; `all`: `All n ›` in the heading instead (as Asked lately's).
import {h} from '../../../vendor/preact.mjs';
import {useState} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {RowList} from '../rows.js';
import {Section} from './section.js';
const html = htm.bind(h);

export function RowsSection({id, label, items = [], limit = Infinity, fold, host, onOpen, all: inHeading = false}) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, limit), more = items.length - shown.length;
  return html`<${Section} id=${id} label=${label} class="dk-landing-section dk-rows-section" count=${items.length} fold=${fold}
    headerActions=${inHeading && more ? html`<button type="button" class="dp-labelbtn" onClick=${() => setAll(true)}>All ${items.length} ›</button>` : null}>
    <${RowList} inline=${true} host=${host} items=${shown} onOpen=${onOpen} />
    ${more && !inHeading ? html`<button type="button" class="dk-btn text dk-rows-more" onClick=${() => setAll(true)}>+${more} more</button>` : null}
  </${Section}>`;
}

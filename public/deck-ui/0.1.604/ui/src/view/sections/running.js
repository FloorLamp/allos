import {h} from '../../../vendor/preact.mjs';
import htm from '../../../vendor/htm.mjs';
import {Brand, Glyph} from '../../glyphs.js';
import {Section} from './section.js';
import {Row} from './row.js';
import {More} from './more.js';
const html = htm.bind(h);
export function Running({data, fold, onOpen, limit = Infinity}) {
  if (!data?.rows.length) return null;
  const rows = data.rows.slice(0, limit), more = (data.more ?? 0) + data.rows.length - rows.length;
  return html`<${Section} id="running" label="Running now" count=${data.rows.length + (data.more ?? 0)} fold=${fold}>
    ${rows.map((r, i) => html`<${Row} key=${i} kind=${r.mine ? 'mine' : 'running'} row=${r} onOpen=${onOpen} />`)}
    <${More} n=${more} url=${data.url} onOpen=${onOpen} what="running" /></${Section}>`;
}

import {h} from '../../../vendor/preact.mjs';
import htm from '../../../vendor/htm.mjs';
import {Brand, Glyph} from '../../glyphs.js';
import {Needs} from './needs.js';
import {Section} from './section.js';
import {Row} from './row.js';
import {More} from './more.js';
const html = htm.bind(h);
export function Problems({data, fold, onOpen, limit = Infinity}) {
  if (!data?.rows.length) return null;
  const rows = data.rows.slice(0, limit), more = (data.more ?? 0) + data.rows.length - rows.length;
  return html`<${Section} id="problems" label="Problems" count=${data.rows.length + (data.more ?? 0)} fold=${fold}>
    ${rows.map((r, i) => html`<${r.text.startsWith('Needs you:') ? Needs : Row} key=${i} kind=${'problem'} row=${r} onOpen=${onOpen} />`)}
    <${More} n=${more} url=${data.url} onOpen=${onOpen} what="in Spaceport" /></${Section}>`;
}

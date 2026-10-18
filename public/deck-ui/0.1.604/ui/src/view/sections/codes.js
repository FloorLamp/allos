import {h} from '../../../vendor/preact.mjs';
import htm from '../../../vendor/htm.mjs';
import {Section} from './section.js';
const html = htm.bind(h);
/** Native hosts keep code values in memory and perform the sensitive Copy action. */
export function Codes({rows = [], renderRow, fold}) {
  if (!rows.length) return null;
  return html`<${Section} id="codes" label="Codes" class="dk-landing-section" count=${rows.length} fold=${fold}>
    ${rows.map((row, i) => renderRow(row, i))}
  </${Section}>`;
}

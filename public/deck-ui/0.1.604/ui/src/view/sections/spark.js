import {h} from '../../../vendor/preact.mjs';
import htm from '../../../vendor/htm.mjs';
const html = htm.bind(h);
export const Spark = ({hours}) => {
  const max = Math.max(1, ...hours.filter(Number.isFinite));
  return html`<span class="dg-spark" aria-hidden="true">${hours.map((h, i) => html`<i key=${i} class=${h == null ? 'none' : h >= 0.9 ? 'hot' : ''}
    style=${`height: ${h == null ? 0 : Math.max(8, Math.round((100 * h) / max))}%`}></i>`)}</span>`;
};


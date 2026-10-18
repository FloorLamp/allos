import {h} from '../../../vendor/preact.mjs';
import htm from '../../../vendor/htm.mjs';
const html = htm.bind(h);
export const Row = ({row, onOpen, kind}) => html`<button type="button" class=${`dg-row ${kind} tone-${row.tone ?? 'live'}${row.working ? ' working' : ''}`} data-nav
    title=${row.tip ?? row.text} onClick=${() => row.url && onOpen(row.url)}>
  <span class="dg-mark" aria-hidden="true"></span>
  <span class="dg-text"><span class="dg-title">${row.text}</span>${row.sub ? html`<span class="dg-sub">${row.sub}</span>` : null}</span>
  ${row.age ? html`<span class="dg-age">${row.age}</span>` : null}
</button>`;


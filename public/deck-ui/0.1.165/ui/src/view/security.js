import {h} from '../../vendor/preact.mjs';
import htm from '../../vendor/htm.mjs';
const html = htm.bind(h);
export function Security({security}) {
  return html`<div aria-label="Security" aria-busy=${security.loading}>
    <h1>Security</h1>${security.sources.map(source => html`<section key=${source.id} aria-label=${source.id}>
      <h2 class="dk-label">${source.id} · ${source.state}</h2>
      <p>${source.generated ? `Checked ${source.generated}` : 'No source report'}</p>
      ${source.state === 'ok' && !source.items.length ? html`<p>No reported items</p>` : null}
      <div class="dp-rows" role="list">${source.items.map((item, i) => html`<div key=${item.id ?? i} class="dp-row" role="listitem">
        <span class="dp-lines"><span class="dp-title">${item.what ?? item.id ?? 'Unknown item'} · ${item.state ?? 'unknown'}</span>
          <span class="dp-sub">Where: ${item.where ?? 'unknown'} · Owner: ${item.owner ?? 'unknown'}</span>
          <span class="dp-sub">Created: ${item.created ?? 'unknown'} · Last used: ${item.lastUsed ?? 'unknown'}</span>
          <span class="dp-sub">Last rotated: ${item.lastRotated ?? 'unknown'} · Next due: ${item.nextDue ?? 'unknown'}</span>
        </span></div>`)}</div></section>`)}</div>`;
}

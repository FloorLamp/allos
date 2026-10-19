import {PageState} from './page-state.js';
import {PageHeader} from './page-header.js';
import {h} from '../../vendor/preact.mjs';
import htm from '../../vendor/htm.mjs';
const html = htm.bind(h);
export function Security({security, host}) {
  return html`<section class="dk-security dk-page" aria-label="Security" aria-busy=${security.loading}>
    <${PageHeader} title="Security" description="Security reports and source status." /><${PageState} state=${security.loading ? 'loading' : !security.sources.length ? 'empty' : undefined} hint="Connect a security source to see its reports.">${security.sources.map(source => html`<section key=${source.id} aria-label=${source.id}>
      <h3 class="dk-label">${source.id} · ${source.state}</h3>
      <${PageState} backend=${source.id} error=${source.error} host=${host} retry=${() => security.refresh()} state=${!source.items.length ? 'empty' : undefined} hint=${source.state === 'ok' || source.state === 'stale' ? 'No reported items.' : 'No source report yet.'}>
      ${source.generated ? html`<p>Checked ${source.generated}</p>` : null}
      <div class="dp-rows" role="list">${source.items.map((item, i) => html`<div key=${item.id ?? i} class="dp-row" role="listitem">
        <span class="dp-lines"><span class="dp-title">${item.what ?? item.id ?? 'Unknown item'} · ${item.state ?? 'unknown'}</span>
          <span class="dp-sub">Where: ${item.where ?? 'unknown'} · Owner: ${item.owner ?? 'unknown'}</span>
          <span class="dp-sub">Created: ${item.created ?? 'unknown'} · Last used: ${item.lastUsed ?? 'unknown'}</span>
          <span class="dp-sub">Last rotated: ${item.lastRotated ?? 'unknown'} · Next due: ${item.nextDue ?? 'unknown'}</span>
        </span></div>`)}</div><//></section>`)}</${PageState}></section>`;
}

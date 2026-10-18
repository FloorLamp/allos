import {Failures, StatusLink} from './failure.js';
import {failurePage} from '../failure.js';
import {h} from '../../vendor/preact.mjs';
import htm from '../../vendor/htm.mjs';
import {Block, Placeholders} from './rows.js';
import {ShellBar} from './shell-bar.js';
const html = htm.bind(h);
function Row({accounts, r}) {
  const busy = accounts.pending.has(r.key), why = accounts.notReady.get(r.key);
  return html`<div class="dp-row da-row" role="listitem" data-id=${r.id} data-backend=${r.backend} data-state=${r.state}>
    <span class="dp-lines"><span class="dp-title">${r.title}${r.person ? ` · ${r.person}` : ''}</span>
      ${r.service && r.service !== r.title ? html`<span class="da-identity">${r.service}</span>` : null}
      <span class=${`dp-sub${r.tone ? ' warn' : ''}`}>${r.sub}</span>
      <span class="dp-sub">${r.coverage}</span>
      <span class="dp-sub">${failurePage(r.backend)}</span>
      ${r.stale ? html`<span class="da-stale">Stale · ${r.stale}</span>` : null}</span>
    <span class="dp-end da-end">${(r.actions ?? []).map(action => html`<span>
      ${action.reach === 'lan' ? html`<span class="da-reach">at home or on VPN </span>` : null}
      <button type="button" class="dk-btn" data-op=${action.op ?? 'url'} disabled=${busy || !!why}
        onClick=${() => accounts.act(r, action)}>${why ?? (busy ? 'Looking…' : action.label)}</button></span>`)}</span>
  </div>`;
}
export function Accounts({accounts, host, opts = {}}) {
  const gs = accounts.groups();
  const bar = opts.nav ? html`<${ShellBar} brand=${opts.brand} nav=${opts.nav} backends=${accounts.backends} current=${opts.current ?? 'accounts'} />` : null;
  const body = accounts.loading ? html`<div aria-busy="true"><${Placeholders} n=${4} /></div>`
    : !gs.length ? html`<${Block} b=${{glyph: 'key', title: 'No accounts yet'}} />`
    : gs.map(g => html`<section key=${g.kind} class="da-group" data-kind=${g.kind} aria-label=${g.label}><h2 class="dk-label">${g.label}</h2>
      <div class="dp-rows dp-plain" role="list">${g.rows.map(r => html`<${Row} key=${r.key} accounts=${accounts} r=${r} />`)}</div></section>`);
  return html`<div class="da-page">${bar}<main class="da" aria-label="Sign-ins"><header class="da-head"><div><h1>Sign-ins</h1><p>Account access and recent imports.</p></div><button type="button" class="dk-btn" disabled=${accounts.loading} onClick=${() => accounts.refresh()}>Refresh</button></header><${Failures} failures=${accounts.failures.map(f => ({...f, retry: () => accounts.refresh()}))} host=${host} />${body}</main>
    <div class="da-status" role="status">${accounts.outcome ? html`<span class=${accounts.outcome.bad ? 'bad' : ''}>${accounts.outcome.text}${accounts.outcome.bad ? html`<${StatusLink} />` : null}</span>` : null}</div></div>`;
}

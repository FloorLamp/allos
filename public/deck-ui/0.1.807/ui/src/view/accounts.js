import {Failures, PageState, StatusLink} from './page-state.js';
import {PageHeader} from './page-header.js';
import {h} from '../../vendor/preact.mjs';
import htm from '../../vendor/htm.mjs';
import {ShellBar} from './shell-bar.js';
const html = htm.bind(h);
// the pressed action's own button says it is under way; the row's others wait with it
const UNDER_WAY = {'get-missing': 'Looking…', 'sign-in': 'Signing in…'};
function Row({accounts, r}) {
  const started = accounts.pending.get(r.key), busy = started != null, why = accounts.notReady.get(r.key);
  return html`<div class="dp-row da-row" role="listitem" data-id=${r.id} data-backend=${r.backend} data-state=${r.state}>
    <span class="dp-lines"><span class="dp-title">${r.title}${r.person ? ` · ${r.person}` : ''}</span>
      ${r.service && r.service !== r.title ? html`<span class="da-identity">${r.service}</span>` : null}
      <span class=${`dp-sub${r.tone ? ' warn' : ''}`}>${r.sub}</span>
      ${r.coverage ? html`<span class="dp-sub">${r.coverage}</span>` : null}
      ${r.stale ? html`<span class="da-stale">Stale · ${r.stale}</span>` : null}
</span>
    <span class="dp-end da-end">${(r.actions ?? []).map(action => html`<button type="button" class="dk-btn" data-op=${action.op ?? 'url'} disabled=${busy || !!why}
        onClick=${() => accounts.act(r, action)}>${why ?? (busy && started === action.op ? UNDER_WAY[action.op] ?? 'Started' : action.label)}</button>`)}</span>
  </div>`;
}
// actions that work only on the home network, said once for the group: `Sign in works at home or on VPN.`
function lanNote(rows) {
  const labels = [...new Set(rows.flatMap(r => (r.actions ?? []).filter(a => a.reach === 'lan').map(a => a.label)))];
  if (!labels.length) return null;
  const names = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1).toLowerCase()}` : labels[0];
  return `${names} ${labels.length > 1 ? 'work' : 'works'} at home or on VPN.`;
}
export function Accounts({accounts, host, opts = {}}) {
  const gs = accounts.groups();
  const bar = opts.nav ? html`<${ShellBar} brand=${opts.brand} nav=${opts.nav} backends=${accounts.backends} current=${opts.current ?? 'accounts'} />` : null;
  const body = gs.map(g => html`<section key=${g.kind} class="da-group" data-kind=${g.kind} aria-label=${g.label}><h2 class="dk-label">${g.label}</h2>
      ${lanNote(g.rows) ? html`<p class="dk-note da-reach">${lanNote(g.rows)}</p>` : null}
      <div class="dp-rows dp-plain" role="list">${g.rows.map(r => html`<${Row} key=${r.key} accounts=${accounts} r=${r} />`)}</div></section>`);
  return html`<div class="da-page">${bar}<main class="da dk-page" aria-label="Sign-ins"><${PageHeader} title="Sign-ins" description="Account access and recent imports." actions=${html`<button type="button" class="dk-btn" disabled=${accounts.loading} onClick=${() => accounts.refresh()}>Refresh</button>`} /><${Failures} inline=${gs.length > 0} failures=${accounts.failures.map(f => ({...f, retry: () => accounts.refresh()}))} host=${host} /><${PageState} state=${accounts.loading ? 'loading' : !gs.length && !accounts.failures.length ? 'empty' : undefined} hint="Connect an account to see its access and imports.">${body}<//></main>
    <div class=${`dk-toast da-status${accounts.outcome ? ' on' : ''}${accounts.outcome?.bad ? ' bad' : ''}`} role="status">${accounts.outcome ? html`<span>${accounts.outcome.text}</span>${accounts.outcome.bad ? html`<${StatusLink} />` : null}` : null}</div></div>`;
}

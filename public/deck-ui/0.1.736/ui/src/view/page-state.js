import {h} from '../../vendor/preact.mjs';
import htm from '../../vendor/htm.mjs';
import {describeFailure} from '../failure.js';
const html = htm.bind(h);

// The fleet status console is independent of the backend that failed.
export function StatusLink({host}) {
  const url = 'https://spaceport.wang.team/';
  return html`<a class="dk-btn text" href=${url} onClick=${host ? ev => { ev.preventDefault(); host.call('url.open', {url}); } : undefined}>Service status ↗</a>`;
}

/** Error reasons take precedence over state. Warming keeps the caller's last-data view visible. */
export function PageState({state, error, backend = 'bridge', title, hint, retry, host, children, inline = false}) {
  const failure = describeFailure(backend, error ?? {status: state === 'signed out' ? 401 : undefined},
    {device: host?.kind === 'shell'});
  const current = error ? failure.state : state;
  if (current === 'loading') return html`<div class="dk-state" role="status" aria-busy="true" aria-label="Loading">
    ${[72, 100, 88].map(width => html`<div class="dk-ph" aria-hidden="true" style=${{width: `${width}%`, height: 'var(--gap-m)'}} />`)}
    <span class="dk-sr">Loading…</span></div>`;
  if (current === 'empty') return html`<div class="dk-state" role="status"><b>Nothing here yet</b>${hint ? html`<p>${hint}</p>` : null}</div>`;
  if (current === 'warming' && !inline) return html`<div class="dk-page-state"><div class="dk-state" role="status"><p>Starting, showing your last data</p></div>${children}</div>`;
  if (current === 'signed out' || current === 'error' || inline && current === 'warming') {
    const access = host?.kind !== 'shell' && (failure.status === 401 || failure.action === null);
    return html`<div class=${inline ? 'dk-failure' : `dk-state${current === 'error' ? ' bad' : ''}`} role="alert">
      ${!inline && (title || current === 'signed out') ? html`<b>${title ?? 'Sign in to see this'}</b>` : null}
      <p>${failure.message}</p>
      ${retry && !access ? html`<button type="button" class="dk-btn" onClick=${retry}>Retry</button>` : null}
      ${failure.url ? html`<a class="dk-btn" href=${failure.url} onClick=${host ? ev => {
        ev.preventDefault(); host.call('url.open', {url: failure.url});
      } : undefined}>${failure.action}</a>` : null}
      ${!access || !inline && current === 'signed out' ? html`<${StatusLink} host=${host} />` : null}</div>`;
  }
  return children ?? null;
}

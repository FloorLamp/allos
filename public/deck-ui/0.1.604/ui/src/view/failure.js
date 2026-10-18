import {h} from '../../vendor/preact.mjs';
import htm from '../../vendor/htm.mjs';
import {describeFailure, failurePage} from '../failure.js';
const html = htm.bind(h);

// The fleet status console is independent of the backend that failed.
export function StatusLink({host}) {
  const url = 'https://spaceport.wang.team/';
  return html`<a class="dk-btn text" href=${url} onClick=${host ? ev => { ev.preventDefault(); host.call('url.open', {url}); } : undefined}>Service status ↗</a>`;
}

export function Failure({backend, error, retry, host}) {
  const f = describeFailure(backend, error, {device: host?.kind === 'shell'});
  const access = host?.kind !== 'shell' && (f.status === 401 || f.action === null);
  return html`<div class="dk-failure" role="alert"><p>${f.message}</p>
    ${retry && !access ? html`<button type="button" class="dk-btn" onClick=${retry}>Retry</button>` : null}
    ${!access ? html`<${StatusLink} host=${host} />` : null}
    ${f.url ? html`<a class="dk-btn" href=${f.url} onClick=${host ? ev => { ev.preventDefault(); host.call('url.open', {url: f.url}); } : undefined}>${f.action}</a>` : null}</div>`;
}

// Browser sessions cover all backends; one notice names every affected page.
export function Failures({failures, host}) {
  const signedOut = host?.kind !== 'shell' ? failures.filter(f => f.error?.status === 401) : [];
  const pages = [...new Set(signedOut.map(f => failurePage(f.backend)))];
  return html`<div class="dk-failures">${pages.length ? html`<${Failure} backend=${pages.join(', ')} error=${{status: 401}} host=${host} />` : null}
    ${failures.filter(f => !signedOut.includes(f)).map(f => html`<${Failure} ...${f} host=${host} />`)}</div>`;
}

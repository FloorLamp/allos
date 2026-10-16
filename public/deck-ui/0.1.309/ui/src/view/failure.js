import {h} from '../../vendor/preact.mjs';
import htm from '../../vendor/htm.mjs';
import {describeFailure} from '../failure.js';
const html = htm.bind(h);

// The fleet status console is independent of the backend that failed.
export function StatusLink({host}) {
  const url = 'https://spaceport.wang.team/';
  return html`<a class="dk-btn text" href=${url} onClick=${host ? ev => { ev.preventDefault(); host.call('url.open', {url}); } : undefined}>Service status ↗</a>`;
}

export function Failure({backend, error, retry, host}) {
  const f = describeFailure(backend, error, {device: host?.kind === 'shell'});
  return html`<div role="alert"><p>${f.message}</p>
    ${retry ? html`<button type="button" class="dk-btn" onClick=${retry}>Retry</button>` : null}
    <${StatusLink} host=${host} />
    ${f.url ? html`<a class="dk-btn" href=${f.url} onClick=${host ? ev => { ev.preventDefault(); host.call('url.open', {url: f.url}); } : undefined}>${f.action}</a>` : null}</div>`;
}

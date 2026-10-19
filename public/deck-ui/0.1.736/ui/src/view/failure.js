import {h} from '../../vendor/preact.mjs';
import htm from '../../vendor/htm.mjs';
import {failurePage} from '../failure.js';
import {PageState} from './page-state.js';
const html = htm.bind(h);

// Inline failures share PageState's copy and recovery controls.
export function Failure(props) {
  return html`<${PageState} ...${props} state="error" inline=${true} />`;
}

// Browser sessions cover all backends; one notice names every affected page.
export function Failures({failures, host}) {
  const signedOut = host?.kind !== 'shell' ? failures.filter(f => f.error?.status === 401) : [];
  const pages = [...new Set(signedOut.map(f => failurePage(f.backend)))];
  return html`<div class="dk-failures">${pages.length ? html`<${Failure} backend=${pages.join(', ')} error=${{status: 401}} host=${host} />` : null}
    ${failures.filter(f => !signedOut.includes(f)).map(f => html`<${Failure} ...${f} host=${host} />`)}</div>`;
}

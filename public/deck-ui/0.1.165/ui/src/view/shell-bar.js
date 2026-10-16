// One bar for backend sites and Tower. Hosts supply destinations and slots; Health checks backend identity before appearing.
import {h} from '../../vendor/preact.mjs';
import htm from '../../vendor/htm.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import {healthIdentity, watchHealthIdentity} from '../health.js';
const html = htm.bind(h);

const isNode = v => typeof v !== 'object' || v.type !== undefined || v.props !== undefined;

/** The needs slot: {count, label, href?} is a place's count (a badge, the label read out; 0 disappears); text or a node goes in as it is. */
function Needs({needs}) {
  if (needs == null || needs === false) return null;
  if (isNode(needs)) return html`<div class="ds-needs">${needs}</div>`;
  if (!needs.count) return null;
  const badge = html`<span class="ds-count" aria-hidden="true">${needs.count}</span><span class="ds-needs-label" aria-hidden="true">${needs.label}</span><span class="dk-sr">${needs.count} ${needs.label}</span>`;
  return html`<div class="ds-needs">${needs.href ? html`<a href=${needs.href}>${badge}</a>` : badge}</div>`;
}

/** brand {label, href, mark?}, places [{id, label, href, backend?}] (one with a `backend` shows only when `backends`, the host's registry names, has it), current (place id);
 *  needs ({count, label, href?} or text or a node: what waits on the owner), verdict (text or a node: a status) and signIn (text or a node). */
export function ShellBar({brand = {label: 'Deck', href: '/'}, places = [], backends = [], host = null, current, needs = null, verdict = null, signIn = null}) {
  const [ownerHost, setOwnerHost] = useState(null);
  useEffect(() => {
    let live = true;
    setOwnerHost(null);
    const update = me => { if (live) setOwnerHost(me ? host : null); };
    const off = host ? watchHealthIdentity(host, update) : null;
    const refresh = () => { if (host) healthIdentity(host); };
    const offNeeds = host?.on?.('needs', refresh);
    refresh();
    return () => { live = false; off?.(); offNeeds?.(); };
  }, [host]);
  return html`<header class="ds-bar"><div class="ds-in">
    <a class="ds-brand" href=${brand.href}>${brand.mark ?? null}${brand.label}</a>
    <nav class="ds-places" aria-label="Places">${places.filter(p => (!p.backend || backends.includes(p.backend)) && (p.backend !== 'allos' || host && ownerHost === host)).map(p => html`<a key=${p.id} href=${p.href} aria-current=${p.id === current ? 'page' : null}>${p.label}</a>`)}</nav>
    <${Needs} needs=${needs} />
    ${verdict != null ? html`<div class="ds-verdict" role="status">${verdict}</div>` : null}
    ${signIn != null ? html`<div class="ds-signin">${signIn}</div>` : null}
  </div></header>`;
}

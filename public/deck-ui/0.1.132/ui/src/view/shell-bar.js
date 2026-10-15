// One bar for backend sites and Tower. Hosts supply destinations and slots; Health checks backend identity before appearing.
import {h} from '../../vendor/preact.mjs';
import htm from '../../vendor/htm.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import {healthIdentity, watchHealthIdentity} from '../health.js';
const html = htm.bind(h);

/** brand {label, href, mark?}, places [{id, label, href, backend?}] (one with a `backend` shows only when `backends`, the host's registry names, has it), current (place id); verdict and signIn are text or Preact nodes. */
export function ShellBar({brand = {label: 'Deck', href: '/'}, places = [], backends = [], host = null, current, verdict = null, signIn = null}) {
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
    ${verdict != null ? html`<div class="ds-verdict" role="status">${verdict}</div>` : null}
    ${signIn != null ? html`<div class="ds-signin">${signIn}</div>` : null}
  </div></header>`;
}

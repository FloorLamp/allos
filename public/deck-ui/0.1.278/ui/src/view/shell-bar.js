// One bar for backend sites and Tower. Destinations are release data, independent of backend availability.
import {h} from '../../vendor/preact.mjs';
import {useId, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
const html = htm.bind(h);

const isNode = v => typeof v !== 'object' || v.type !== undefined || v.props !== undefined;

/** The needs slot: {count, label, href?} is an entry's count (a badge, the label read out; 0 disappears); text or a node goes in as it is. */
function Needs({needs}) {
  if (needs == null || needs === false) return null;
  if (isNode(needs)) return html`<div class="ds-needs">${needs}</div>`;
  if (!needs.count) return null;
  const badge = html`<span class="ds-count" aria-hidden="true">${needs.count}</span><span class="ds-needs-label" aria-hidden="true">${needs.label}</span><span class="dk-sr">${needs.count} ${needs.label}</span>`;
  return html`<div class="ds-needs">${needs.href ? html`<a href=${needs.href}>${badge}</a>` : badge}</div>`;
}

/** Hosts supply the resolved contract list and own the needs, verdict and sign-in slots. */
export function ShellBar({brand = {label: 'Deck', href: '/'}, nav = [], current, needs = null, verdict = null, signIn = null}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  return html`<header class="ds-bar"><div class="ds-in">
    <a class="ds-brand" href=${brand.href}>${brand.mark ?? null}${brand.label}</a>
    <div class=${`ds-menu${open ? ' open' : ''}`} onKeyDown=${e => {
      if (e.key === 'Escape' && open) {
        setOpen(false);
        e.currentTarget.querySelector('button').focus();
        e.stopPropagation();
      }
    }}>
      <button type="button" class="ds-toggle dk-btn text" aria-expanded=${open} aria-controls=${menuId} onClick=${() => setOpen(!open)}>Menu</button>
      <nav id=${menuId} class="ds-nav" aria-label="Navigation">${nav.map(p => html`<a key=${p.id} href=${p.href} aria-current=${p.id === current ? 'page' : null}>${p.label}</a>`)}</nav>
    </div>
    <${Needs} needs=${needs} />
    ${verdict != null ? html`<div class="ds-verdict" role="status">${verdict}</div>` : null}
    ${signIn != null ? html`<div class="ds-signin">${signIn}</div>` : null}
  </div></header>`;
}

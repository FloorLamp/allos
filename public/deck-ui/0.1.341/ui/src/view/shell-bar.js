// One bar for backend sites and Tower. Destinations are release data, independent of backend availability.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useId, useRef, useState} from '../../vendor/hooks.mjs';
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
  const [sheetOpen, setSheetOpen] = useState(false);
  const bar = useRef(null);
  const menuId = useId();
  const navId = useId();
  useEffect(() => {
    const outside = e => {
      if (!bar.current?.querySelector('.ds-menu')?.contains(e.target)) setOpen(false);
      if (!bar.current?.contains(e.target)) setSheetOpen(false);
    };
    const doc = bar.current.ownerDocument;
    doc.addEventListener('pointerdown', outside);
    doc.addEventListener('focusin', outside);
    return () => { doc.removeEventListener('pointerdown', outside); doc.removeEventListener('focusin', outside); };
  }, []);
  return html`<header ref=${bar} class=${`ds-bar${sheetOpen ? ' ds-sheet-open' : ''}`} onKeyDown=${e => {
    if (e.key === 'Escape' && sheetOpen) {
      setSheetOpen(false); setOpen(false);
      bar.current.querySelector('.ds-nav-toggle').focus();
      e.stopPropagation();
    }
  }}><div class="ds-in">
    <a class="ds-brand" href=${brand.href}>${brand.mark ?? null}${brand.label}</a>
    ${nav.length ? html`<button type="button" class="ds-nav-toggle dk-btn text" aria-expanded=${sheetOpen} aria-controls=${navId} onClick=${() => { setSheetOpen(!sheetOpen); setOpen(false); }}>Menu</button>` : null}
    <nav id=${navId} class="ds-nav" aria-label="Navigation" onClick=${e => {
      if (e.target.closest('a')) { setSheetOpen(false); setOpen(false); }
    }}>${nav.filter(p => p.group !== 'library').map(p => html`<a key=${p.id} href=${p.href} aria-current=${p.id === current ? 'page' : null}>${p.label}</a>`)}
    ${nav.some(p => p.group === 'library') ? html`<div class=${`ds-menu${open ? ' open' : ''}`} onKeyDown=${e => {
      if (e.key === 'Escape' && open) {
        setOpen(false);
        e.currentTarget.querySelector('button').focus();
        e.stopPropagation();
      }
    }}>
      <button type="button" class="ds-toggle dk-btn text" aria-expanded=${open} aria-controls=${menuId} onClick=${() => setOpen(!open)}>Library</button>
      <div id=${menuId} class="ds-library">${nav.filter(p => p.group === 'library').map(p => html`<a key=${p.id} href=${p.href} aria-current=${p.id === current ? 'page' : null}>${p.label}</a>`)}</div>
    </div>` : null}</nav>
    <${Needs} needs=${needs} />
    ${verdict != null ? html`<div class="ds-verdict" role="status">${verdict}</div>` : null}
    ${signIn != null ? html`<div class="ds-signin">${signIn}</div>` : null}
  </div></header>`;
}

/** Place immediately below the Find box; uses the same resolved contract as ShellBar. */
export function NavTiles({nav = [], current}) {
  return html`<nav class="ds-tiles" aria-label="Explore">${nav.map(p => html`<a key=${p.id} href=${p.href} aria-current=${p.id === current ? 'page' : null}>${p.label}</a>`)}</nav>`;
}

// One bar for backend sites and Tower. Destinations are release data, independent of backend availability.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Glyph} from '../glyphs.js';
const html = htm.bind(h);

// The bar is its own render root beside the page's: Preact's useId restarts per root, so the page's first field would share the
// bar's ids (and its label would name the bar's menu). A page-wide sequence keeps them apart.
let bars = 0;

const isNode = v => typeof v !== 'object' || v.type !== undefined || v.props !== undefined;

/** The needs slot: {count, label, href?} is an entry's count (a badge, the label read out; 0 disappears); text or a node goes in as it is.
 *  A count still loading or that could not load draws nothing: the Needs page says why, the bar never shows a partial or stale total. */
function Needs({needs}) {
  if (needs == null || needs === false) return null;
  if (isNode(needs)) return html`<div class="ds-needs">${needs}</div>`;
  if (needs.loading || needs.unavailable) return null;
  if (!needs.count) return null;
  const badge = html`<span class="ds-count" aria-hidden="true">${needs.count}</span><span class="ds-needs-label" aria-hidden="true">${needs.label}</span><span class="dk-sr">${needs.count} ${needs.label}</span>`;
  return html`<div class="ds-needs">${needs.href ? html`<a href=${needs.href}>${badge}</a>` : badge}</div>`;
}

/** Library's entries in their sections (nav entries' `section`, in nav order: nav.mjs keeps a section's entries together). */
export function librarySections(nav) {
  const sections = [];
  for (const p of nav) if (p.group === 'library') {
    if (sections.length && sections.at(-1).label === p.section) sections.at(-1).entries.push(p);
    else sections.push({label: p.section, entries: [p]});
  }
  return sections;
}

/** Where the open Library panel sits, in px from its trigger's left: under the trigger, left-aligned; right-aligned to it when that
 *  runs past the viewport's gutter; else pinned inside the gutter. */
export function libraryOffset({left, right}, width, viewport, gutter) {
  if (left + width <= viewport - gutter) return 0;
  return Math.max(right - left - width, gutter - left);
}

/** The link to move to from `at` in the other column (`dir` -1 left, 1 right): the nearest row beside it, else none. */
function besideLink(links, at, dir) {
  const r = links[at].getBoundingClientRect(), mid = r.top + r.height / 2;
  let best = null, gap = Infinity;
  for (const link of links) {
    const o = link.getBoundingClientRect();
    if (dir > 0 ? o.left < r.right : o.right > r.left) continue;
    const d = Math.abs(o.top + o.height / 2 - mid);
    if (d < gap) { gap = d; best = link; }
  }
  return best;
}

/** Hosts supply the resolved contract list and own the needs, verdict and sign-in slots. `actions` [{id, label, glyph?, run}] are the host's own
 *  commands (Android: Send file, Settings): first in the phone's Menu sheet, labelled; after the destinations on a wide bar, as their
 *  glyphs (named, with the label as the tooltip). */
export function ShellBar({brand = {label: 'Deck', href: '/'}, nav = [], current, needs = null, verdict = null, signIn = null, actions = [], onSheetChange}) {
  const [open, setOpen] = useState(false);
  const rowCount = needs && !isNode(needs) && !needs.loading && !needs.unavailable ? needs.count : 0;
  const [sheetOpen, setSheetOpen] = useState(false);
  const bar = useRef(null);
  const [n] = useState(() => ++bars);
  const menuId = `ds-library-${n}`, navId = `ds-nav-${n}`;
  const libraryFocus = useRef(null), panel = useRef(null), typed = useRef({text: '', at: 0});
  // the open panel anchors to its trigger, inside the viewport; in the phone's sheet it is a static section
  useLayoutEffect(() => {
    const el = panel.current;
    if (!open || !el) return;
    const win = el.ownerDocument.defaultView;
    const place = () => {
      el.style.left = '';
      if (win.getComputedStyle(el).position !== 'absolute') return;
      const gutter = parseFloat(win.getComputedStyle(el).getPropertyValue('--gutter')) || 16;
      el.style.left = `${libraryOffset(el.parentElement.getBoundingClientRect(), el.offsetWidth, el.ownerDocument.documentElement.clientWidth, gutter)}px`;
    };
    place();
    win.addEventListener('resize', place);
    return () => { win.removeEventListener('resize', place); el.style.left = ''; };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || libraryFocus.current == null) return;
    const links = bar.current?.querySelectorAll('.ds-library a');
    const at = libraryFocus.current;
    libraryFocus.current = null;
    links?.[at < 0 ? links.length - 1 : at]?.focus();
  }, [open]);
  useLayoutEffect(() => { setOpen(false); setSheetOpen(false); }, [current]);
  useLayoutEffect(() => { onSheetChange?.(sheetOpen); return () => onSheetChange?.(false); }, [sheetOpen, onSheetChange]);
  // the phone sheet fits its content up to the screen below the bar, scrolling inside past that
  useLayoutEffect(() => {
    if (!sheetOpen) return;
    const el = bar.current, win = el.ownerDocument.defaultView;
    const room = () => el.style.setProperty('--ds-sheet-room', `${Math.max(0, win.innerHeight - el.getBoundingClientRect().bottom)}px`);
    room();
    win.addEventListener('resize', room);
    return () => win.removeEventListener('resize', room);
  }, [sheetOpen]);
  useLayoutEffect(() => {
    if (!sheetOpen) return;
    const win = bar.current.ownerDocument.defaultView;
    const close = e => {
      if (e.key !== 'Escape') return;
      // Library owns Escape while focus is inside its disclosure.
      if (open && e.target?.nodeType && bar.current.querySelector('.ds-menu')?.contains(e.target)) return;
      setSheetOpen(false); setOpen(false);
      bar.current.querySelector('.ds-nav-toggle').focus();
      e.stopImmediatePropagation();
    };
    win.addEventListener('keydown', close, true);
    return () => win.removeEventListener('keydown', close, true);
  }, [sheetOpen, open]);
  useEffect(() => {
    const outside = e => {
      if (!bar.current?.querySelector('.ds-menu')?.contains(e.target)) setOpen(false);
      if (!bar.current?.contains(e.target)) setSheetOpen(false);
    };
    const doc = bar.current.ownerDocument;
    const blur = () => { setOpen(false); setSheetOpen(false); };
    doc.defaultView?.addEventListener('blur', blur);
    doc.addEventListener('pointerdown', outside);
    doc.addEventListener('focusin', outside);
    return () => { doc.defaultView?.removeEventListener('blur', blur); doc.removeEventListener('pointerdown', outside); doc.removeEventListener('focusin', outside); };
  }, []);
  return html`<header ref=${bar} class=${`ds-bar${sheetOpen ? ' ds-sheet-open' : ''}`} onKeyDown=${e => {
    if (e.key === 'Escape' && sheetOpen) {
      setSheetOpen(false); setOpen(false);
      bar.current.querySelector('.ds-nav-toggle').focus();
      e.stopPropagation();
    }
  }}><div class="ds-in">
    <a class="ds-brand" href=${brand.href}>${brand.mark ?? null}${brand.label}</a>
    ${nav.length || actions.length ? html`<button type="button" class="ds-nav-toggle dk-btn text" aria-expanded=${sheetOpen} aria-controls=${navId} onClick=${e => { e.currentTarget.focus({preventScroll: true}); setSheetOpen(!sheetOpen); setOpen(false); }}>Menu</button>` : null}
    <nav id=${navId} class="ds-nav" aria-label="Navigation" onClick=${e => {
      if (e.target.closest('a')) { setSheetOpen(false); setOpen(false); }
    }}>${actions.length ? html`<div class="ds-actions">${actions.map(a => html`<button key=${a.id} type="button" class=${`dk-btn${a.glyph ? ' glyphed' : ''}`} aria-label=${a.label} title=${a.label}
      onClick=${() => { setSheetOpen(false); setOpen(false); a.run(); }}>${a.glyph ? html`<${Glyph} name=${a.glyph} />` : null}<span class="ds-action-label">${a.label}</span></button>`)}</div>` : null}
    ${nav.filter(p => p.group !== 'library').map(p => html`<a key=${p.id} href=${p.href} aria-current=${p.id === current ? 'page' : null} data-count=${p.id === 'todo' && rowCount ? rowCount : null}>${p.glyph ? html`<span class="ds-tile"><${Glyph} name=${p.glyph} /></span>` : null}${p.label}</a>`)}
    ${nav.some(p => p.group === 'library') ? html`<div class=${`ds-menu${open ? ' open' : ''}`} onKeyDown=${e => {
      const links = [...e.currentTarget.querySelectorAll('.ds-library a')];
      // the phone's sheet always shows Library's rows: its keys work there with the disclosure closed
      const at = links.indexOf(e.target), shown = open || sheetOpen;
      if (e.key.length !== 1) typed.current.text = '';  // another key (an arrow, Home) starts the type-ahead over
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!shown) { libraryFocus.current = e.key === 'ArrowUp' ? -1 : 0; setOpen(true); }
        else links[at < 0 ? (e.key === 'ArrowDown' ? 0 : links.length - 1) : (at + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length]?.focus();
      } else if (shown && at >= 0 && (e.key === 'Home' || e.key === 'End')) {
        e.preventDefault(); links[e.key === 'Home' ? 0 : links.length - 1]?.focus();
      } else if (shown && at >= 0 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        // two columns: across to the row beside this one
        e.preventDefault(); besideLink(links, at, e.key === 'ArrowRight' ? 1 : -1)?.focus();
      } else if (shown && e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // type-ahead: the next entry whose name starts with what was typed (a pause starts over)
        const t = typed.current, now = e.timeStamp;
        t.text = (now - t.at > 700 ? '' : t.text) + e.key.toLowerCase(); t.at = now;
        // one letter (or the same one again): the next entry with it; more: the first from here starting with them all
        const same = [...t.text].every(c => c === t.text[0]), prefix = same ? t.text[0] : t.text, from = same ? at + 1 : Math.max(at, 0);
        const match = [...links.slice(from), ...links.slice(0, from)].find(a => a.textContent.toLowerCase().startsWith(prefix));
        if (match) { e.preventDefault(); match.focus(); }
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
        e.currentTarget.querySelector('button').focus();
        e.stopPropagation();
      }
    }}>
      <button type="button" class="ds-toggle dk-btn text" aria-expanded=${open} aria-controls=${menuId} onClick=${e => { e.currentTarget.focus({preventScroll: true}); setOpen(!open); }}>Library<${Glyph} name="expand" size=${14} class="ds-chevron" /></button>
      <div id=${menuId} ref=${panel} class="ds-library"><div class="ds-sections">${librarySections(nav).map((s, i) => html`<div key=${i} class="ds-section" role="group" aria-labelledby=${s.label ? `${menuId}-${i}` : null}>
        ${s.label ? html`<div id=${`${menuId}-${i}`} class="ds-section-label dk-label">${s.label}</div>` : null}
        ${s.entries.map(p => html`<a key=${p.id} tabindex="0" href=${p.href} aria-current=${p.id === current ? 'page' : null} data-hint=${p.hint}><span class="ds-tile"><${Glyph} name=${p.glyph} /></span>${p.label}</a>`)}
      </div>`)}</div></div>
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

import {h} from '../../vendor/preact.mjs';
import {useLayoutEffect, useRef, useState} from '../../vendor/hooks.mjs';
import {Glyph} from '../glyphs.js';

/** The page title, a short description, `links` (its own pages, navigation.js pageLinks: [{label, href, hint, menu}]) before its
 *  actions, those with `menu` (rare ones: a setup flow) in a More menu after them, and optional navigation. */
export function PageHeader({title, description, actions, links = [], tabs, inlineTabs = false}) {
  const shown = links.filter(l => !l.menu), more = links.filter(l => l.menu);
  return h('header', {class: 'dk-page-header'},
    h('div', {class: 'dk-page-heading'},
      h('div', {class: 'dk-page-titles'}, inlineTabs ? h('div', {class: 'dk-page-title-row'}, h('h1', {}, title), tabs) : h('h1', {}, title), description ? h('p', {}, description) : null),
      actions || links.length ? h('div', {class: 'dk-page-actions'}, shown.map(link => h('a', {key: link.href, class: 'dk-btn', href: link.href, title: link.hint ?? null}, link.label)),
        actions, more.length ? h(PageMore, {links: more}) : null) : null),
    tabs && !inlineTabs ? h('div', {class: 'dk-page-tabs'}, tabs) : null);
}

/** A header's More: its links in the shared menu (`.dk-menu`); a tap outside or Esc closes it, focus back on More. */
function PageMore({links}) {
  const [open, setOpen] = useState(false), ref = useRef(null);
  useLayoutEffect(() => {
    if (!open) return undefined;
    ref.current?.querySelector('[role="menuitem"]')?.focus();
    const away = ev => { if (!ref.current?.contains(ev.target)) setOpen(false); };
    const key = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); setOpen(false); ref.current?.querySelector('.dk-page-more-btn')?.focus(); } };
    document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true); };
  }, [open]);
  return h('div', {class: 'dk-page-more', ref},
    h('button', {type: 'button', class: 'dk-btn icon dk-page-more-btn', 'aria-label': 'More', title: 'More', 'aria-haspopup': 'menu', 'aria-expanded': String(open),
      onClick: () => setOpen(!open)}, h(Glyph, {name: 'more', size: 16})),
    open ? h('div', {class: 'dk-menu', role: 'menu', 'aria-label': 'More'},
      links.map(link => h('a', {key: link.href, role: 'menuitem', href: link.href, title: link.hint ?? null}, link.label))) : null);
}

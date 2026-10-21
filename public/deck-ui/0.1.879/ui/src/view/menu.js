// The one menu (the WAI-ARIA menu button's popup; foundation.css `.dk-menu`): Flightplan's Snooze, a House tile's More, the viewer's More.
// Open: the first item focused; ArrowDown/ArrowUp move (wrapping), Home/End the ends, Esc (before the page's own Esc) closes with focus
// back on the opener, Tab closes, a press outside closes. Choosing an item closes the menu, focus back on the opener, then runs it.
import {h} from '../../vendor/preact.mjs';
import {useLayoutEffect, useRef} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Glyph} from '../glyphs.js';
const html = htm.bind(h);

const ITEMS = '[role^="menuitem"]:not(:disabled)';

/** `items` [{key, label, hint?, glyph?, class?, checked? (a menuitemcheckbox), disabled?, run}]; `label` names the menu; `onClose()` closes it;
 *  `opener`: a ref to the button that opened it (else what had focus when it opened); `class` places it. Rendered only while open. */
export function Menu({items, label, onClose, opener = null, class: cls = ''}) {
  const ref = useRef(null), from = useRef(null), now = useRef(null);
  now.current = {onClose, opener};
  const button = () => now.current.opener?.current ?? from.current;
  const close = () => { now.current.onClose(); const back = button(); if (back?.isConnected) back.focus({preventScroll: true}); };
  const available = () => [...ref.current.querySelectorAll(ITEMS)].filter(el => el.getClientRects().length);
  // with the DOM: a key can come before a passive effect runs
  useLayoutEffect(() => {
    from.current = document.activeElement;
    available()[0]?.focus({preventScroll: true});
    // its opener toggles it on its own click
    const away = ev => { if (!ref.current?.contains(ev.target) && !button()?.contains?.(ev.target)) now.current.onClose(); };
    // before the page's own keys (a drawer's or the viewer's Esc): window, capturing
    const key = ev => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); return; }
      if (!ref.current?.contains(ev.target)) return;
      const all = available(), at = all.indexOf(document.activeElement);
      const next = {ArrowDown: (at + 1) % all.length, ArrowUp: (at + all.length - 1) % all.length, Home: 0, End: all.length - 1}[ev.key];
      if (ev.key === 'Tab') now.current.onClose();
      else if (next != null && all.length) { ev.preventDefault(); ev.stopPropagation(); all[next].focus({preventScroll: true}); }
    };
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', key, true); };
  }, []);
  return html`<div class=${`dk-menu${cls ? ` ${cls}` : ''}`} role="menu" aria-label=${label} ref=${ref}>${items.map(it => html`<button key=${it.key}
    type="button" class=${it.class} role=${it.checked == null ? 'menuitem' : 'menuitemcheckbox'} aria-checked=${it.checked == null ? null : String(!!it.checked)} disabled=${it.disabled}
    data-key=${it.key} onClick=${() => { close(); it.run(); }}>${it.glyph ? html`<${Glyph} name=${it.glyph} size=${16} />` : null}<span>${it.label}</span>${it.hint
      ? html`<span class="dk-menu-hint">${it.hint}</span>` : null}${it.checked ? html`<${Glyph} name="check" size=${14} class="dk-menu-on" />` : null}</button>`)}</div>`;
}

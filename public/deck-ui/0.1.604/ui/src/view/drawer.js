// A detail drawer: beside the list on a wide screen, a full sheet on a phone (foundation.css). Modal: Esc or the scrim closes, focus
// moves in and returns to what opened it.
import {h} from '../../vendor/preact.mjs';
import {useLayoutEffect, useRef} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {formatQuantity, toneOf} from '../quantity.js';
import {Glyph} from '../glyphs.js';
const html = htm.bind(h);

const FOCUSABLE = 'a[href], button:not(:disabled), input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** open, title, sub?, onClose, children (text or Preact nodes), label (the dialog's name, default the title). */
export function Drawer({open, title, sub = null, onClose, children, label}) {
  const ref = useRef(null);
  // Install focus and keys with the DOM: Escape can arrive before a passive effect runs.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const from = document.activeElement, el = ref.current;
    el?.focus();
    const key = ev => {
      if (el?.closest('[hidden]')) return;
      if ([...document.querySelectorAll('[aria-modal="true"]')].at(-1) !== el) return;
      if (ev.key === 'Escape') { ev.stopPropagation(); onClose?.(); return; }
      if (ev.key !== 'Tab' || !el) return;
      const f = [...el.querySelectorAll(FOCUSABLE)];
      if (!f.length) { ev.preventDefault(); return; }
      const first = f[0], last = f.at(-1);
      if (ev.shiftKey && (document.activeElement === first || document.activeElement === el)) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); if (from?.isConnected) from.focus(); };
  }, [open]);
  if (!open) return null;
  return html`<div class="dk-drawer-wrap"><div class="dk-scrim" onClick=${() => onClose?.()}></div>
    <aside class="dk-drawer" role="dialog" aria-modal="true" aria-label=${label ?? title} tabindex="-1" ref=${ref}>
      <header class="dk-drawer-head"><div class="dk-drawer-titles"><b>${title}</b>${sub ? html`<span>${sub}</span>` : null}</div>
        <button type="button" class="dk-btn icon" aria-label="Close" onClick=${() => onClose?.()}><${Glyph} name="close" size=${16} /></button></header>
      <div class="dk-drawer-body">${children}</div></aside></div>`;
}

/** The drawer's facts: [{label, quantity | value (text or node)}] as a definition list. */
export const Facts = ({facts = []}) => html`<dl class="dk-facts">${facts.map((f, i) => html`<div key=${i}><dt>${f.label}</dt>
  <dd class=${f.quantity ? `tone-${toneOf(f.quantity)}` : null}>${f.quantity ? formatQuantity(f.quantity) : f.value ?? '–'}</dd></div>`)}</dl>`;

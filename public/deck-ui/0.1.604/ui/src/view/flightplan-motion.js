import {useLayoutEffect, useRef, useState} from '../../vendor/hooks.mjs';

/** Keep keyboard position across redraws, then animate changed rows. Ghosts are inert and outside the accessible list. */
export function useFlightplanMotion(model) {
  const root = useRef(null), layer = useRef(null), before = useRef(null), animations = useRef(new Set()), focus = useRef(null);
  const [, redraw] = useState(0);
  const reduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const rows = () => [...(root.current?.querySelectorAll('.df-row, .df-card') ?? [])].filter(el => {
    const r = el.getBoundingClientRect();
    return r.width && r.height && !el.closest('.df-motion-layer');
  });
  const key = el => el.dataset.id ?? el.dataset.need;
  const controls = ['.df-check', '.df-tt', '.df-snz', '.df-go', '.df-card'];
  const available = el => el && !el.disabled && el.getClientRects().length && !el.closest('[hidden], [inert]');
  const rememberFocus = () => {
    const el = root.current?.ownerDocument.activeElement, row = el?.closest('.df-row, .df-card');
    if (!row || !root.current.contains(row) || row.closest('.df-motion-layer')) return;
    const ordered = rows();
    focus.current = {element: el, key: key(row), kind: controls.find(selector => el.matches(selector)),
      order: ordered.map(key), index: ordered.indexOf(row)};
  };
  const restoreFocus = () => {
    const anchor = focus.current, doc = root.current?.ownerDocument;
    if (!anchor || !doc || doc.hidden) return;
    const active = doc.activeElement;
    if (active?.isConnected && active !== doc.body) {
      if (active !== anchor.element) focus.current = null;
      return;
    }
    const live = rows(), byKey = new Map(live.map(row => [key(row), row])), same = byKey.get(anchor.key);
    // Disabling Done can blur it before the write answers. Keep its origin until retry or removal.
    if (same && anchor.element.isConnected && anchor.element.disabled) return;
    const row = same ?? anchor.order.slice(anchor.index + 1).map(id => byKey.get(id)).find(Boolean)
      ?? anchor.order.slice(0, anchor.index).reverse().map(id => byKey.get(id)).find(Boolean);
    const selector = 'button, a[href], [tabindex="0"]';
    const control = row && [...(row.matches(selector) ? [row] : []), ...row.querySelectorAll(selector)].filter(available);
    const target = same && available(anchor.element) ? anchor.element
      : control?.find(el => anchor.kind && el.matches(anchor.kind)) ?? control?.[0]
        ?? (!same ? root.current.querySelector('.df-input') ?? root.current.querySelector('[role="tabpanel"]:not([hidden])') : null);
    if (available(target)) { focus.current = null; target.focus({preventScroll: true}); }
  };
  useLayoutEffect(() => {
    const doc = root.current.ownerDocument;
    const chosen = event => {
      if (!focus.current || (event.type === 'focusin' && event.target === doc.body)) return;
      const origin = focus.current.element;
      if (event.target !== origin && !(event.type === 'pointerdown' && origin.contains(event.target))) focus.current = null;
    };
    doc.addEventListener('focusin', chosen);
    doc.addEventListener('pointerdown', chosen, true);
    const unsubscribe = model.subscribe(() => {
      rememberFocus();
      if (!reduced() && !before.current) before.current = new Map(rows().map(el => [key(el), {rect: el.getBoundingClientRect(), revision: el.dataset.revision, clone: el.cloneNode(true)}]));
      redraw(n => n + 1);
    });
    return () => { unsubscribe(); focus.current = null; doc.removeEventListener('focusin', chosen); doc.removeEventListener('pointerdown', chosen, true); for (const animation of animations.current) animation.cancel(); };
  }, [model]);
  useLayoutEffect(() => {
    restoreFocus();
    const previous = before.current;
    before.current = null;
    if (!previous || reduced()) return;
    const play = (el, frames, remove = false) => {
      const duration = Number.parseFloat(getComputedStyle(root.current).getPropertyValue('--t-rows')) || 160;
      const animation = el.animate(frames, {duration, easing: 'cubic-bezier(.2,.7,.2,1)'});
      animations.current.add(animation);
      animation.finished.catch(() => {}).finally(() => { animations.current.delete(animation); if (remove) el.remove(); });
    };
    for (const el of rows()) {
      const old = previous.get(key(el)), next = el.getBoundingClientRect();
      previous.delete(key(el));
      if (!old) play(el, [{opacity: 0, transform: 'translateY(6px)'}, {opacity: 1, transform: 'translateY(0)'}]);
      else {
        const x = old.rect.x - next.x, y = old.rect.y - next.y;
        const edited = old.revision != null && el.dataset.revision != null && old.revision !== el.dataset.revision;
        if (Math.abs(x) > 1 || Math.abs(y) > 1) play(el, [{transform: `translate(${x}px, ${y}px)`, opacity: edited ? .65 : 1}, {transform: 'translate(0, 0)', opacity: 1}]);
        else if (edited) play(el, [{opacity: .65}, {opacity: 1}]);
      }
    }
    for (const {rect, clone} of previous.values()) {
      if (!layer.current || rect.bottom < 0 || rect.top > innerHeight) continue;
      clone.removeAttribute('data-id'); clone.removeAttribute('data-need');
      clone.classList.replace('df-card', 'df-motion-card'); clone.classList.replace('df-row', 'df-motion-row');
      for (const el of [clone, ...clone.querySelectorAll('[id], [tabindex]')]) { el.removeAttribute('id'); el.removeAttribute('tabindex'); }
      Object.assign(clone.style, {position: 'fixed', top: `${rect.y}px`, left: `${rect.x}px`, width: `${rect.width}px`, height: `${rect.height}px`, margin: '0'});
      layer.current.append(clone);
      play(clone, [{opacity: 1, transform: 'translateX(0)'}, {opacity: 0, transform: 'translateX(12px)'}], true);
    }
  });
  return {root, layer};
}

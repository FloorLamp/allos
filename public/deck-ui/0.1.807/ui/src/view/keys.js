// Keys as SPEC.md names them, shared by the palette and the viewer: a keydown as `Mod+Enter`, `Shift+Tab`, `Esc`, `Space`; a hint's key
// as the platform writes it.

/** A key event as SPEC names keys: `Mod+F`, `Shift+N`, `PageDown`, `Esc`, `+`. `mod` the platform's (Meta on the Mac). */
export function keyName(ev, mod = 'Control') {
  const m = mod === 'Meta' ? ev.metaKey : ev.ctrlKey;
  const named = {Escape: 'Esc', ArrowDown: 'Down', ArrowUp: 'Up', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space', Enter: 'Enter', Tab: 'Tab',
    PageDown: 'PageDown', PageUp: 'PageUp', Home: 'Home', End: 'End', Backspace: 'Backspace', Delete: 'Delete'}[ev.key];
  const k = named ?? (ev.key.length === 1 ? (/[a-z]/i.test(ev.key) ? ev.key.toUpperCase() : ev.key) : ev.key);
  return `${m ? 'Mod+' : ''}${ev.shiftKey && (named || /[a-z]/i.test(k)) ? 'Shift+' : ''}${k}`;
}

/** A text box nothing corrects (the search box, a find, a filter: macOS's correction bubble would take ↓, a capital or a fixed word
 *  would change the query): autocorrect, autocapitalize, spellcheck and autocomplete off, as attributes. Preact would set `autocorrect`
 *  and `spellcheck` as the element's boolean properties, where `"off"` and `"false"` are true. A ref: `ref=${plainText(ref)}`. */
const PLAIN = [['autocomplete', 'off'], ['autocorrect', 'off'], ['autocapitalize', 'off'], ['spellcheck', 'false']];
const plainRefs = new WeakMap();
export function plainText(ref) {
  if (!plainRefs.has(ref)) plainRefs.set(ref, el => { ref.current = el; if (el) for (const [k, v] of PLAIN) el.setAttribute(k, v); });
  return plainRefs.get(ref);
}

/** A hint's key as the platform writes it (`Mod` ⌘ on the Mac, Ctrl elsewhere; the Mac's Shift ⇧, Backspace ⌫, Delete ⌦; arrows as
 *  ↑ ↓ ← →): `Ctrl+Shift+O`, `⌘⇧O`, `⌘⌫`. */
const ARROWS = {Up: '↑', Down: '↓', Left: '←', Right: '→'};
export const keycap = (k, mod = 'Control') => {
  const c = k.replace(/\b(Up|Down|Left|Right)\b/g, (m) => ARROWS[m]);
  return mod === 'Meta' ? c.replace(/Mod\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/\bBackspace\b/g, '⌫').replace(/\bDelete\b/g, '⌦') : c.replace(/Mod\+/g, 'Ctrl+');
};

// Find's photos all at once (palette SPEC.md, *Photos*; `+n` on a strip, a photos row's Enter): a grid of the set's previews, each
// opening its photo here (history: Back is the grid). Arrow keys move between them; Enter opens the focused one.
import {h} from '../../../vendor/preact.mjs';
import {useEffect, useRef, useState} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {Thumb, setItems} from '../photo-strip.js';
const html = htm.bind(h);

export function Photos({v, e, pane}) {
  const grid = useRef(null), [failed, setFailed] = useState(() => new Set());
  const items = setItems(e.set);
  useEffect(() => { v.firstPage(e, true); }, []);
  // the grid's own keys: ← → ↑ ↓ between the photos (a row of them at a time), Home and End
  pane.kind.current = {
    key(k) {
      const tiles = [...(grid.current?.querySelectorAll('.dk-photo') ?? [])];
      if (!tiles.length) return false;
      const at = tiles.indexOf(document.activeElement), first = tiles[0].getBoundingClientRect();
      const across = Math.max(1, tiles.filter(t => Math.abs(t.getBoundingClientRect().top - first.top) < 2).length);
      const to = {Right: at + 1, Left: at - 1, Down: at < 0 ? 0 : at + across, Up: at - across, Home: 0, End: tiles.length - 1}[k];
      if (to == null) return false;
      tiles[Math.max(0, Math.min(tiles.length - 1, to))]?.focus();
      return true;
    },
  };
  const fail = id => setFailed(f => f.has(id) ? f : new Set([...f, id]));
  return html`<div class="dv-scroll dv-textscroll"><div class="dv-photos" ref=${grid} role="group" aria-label=${e.set.title}>
    ${items.map((it, i) => failed.has(it.id) ? null : html`<${Thumb} key=${it.id} it=${it} host=${v.host} onFail=${fail} onOpen=${() => v.openPhotos(e.set, i)} />`)}
  </div></div>`;
}

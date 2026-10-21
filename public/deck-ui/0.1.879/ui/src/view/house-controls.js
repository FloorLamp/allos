// House's controls (contract/house.md *House*), shared by the House page (view/house.js) and a thing's page (view/thing-hub.js): an
// entity's tile (its control: a tap runs or asks; on, busy, warning and stale looks) and the one confirmation before anything that
// moves hardware but a light or a scene. Over a src/house.js model.
import {h} from '../../vendor/preact.mjs';
import {useLayoutEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Glyph} from '../glyphs.js';
import {control, stateText, temperatureUnit, warns} from '../house.js';
import {timeText} from '../format.js';
import {entityGlyph} from './rows.js';
const html = htm.bind(h);


/** When the states were last read (a tile while the stream is down). */
export const asOf = house => house.lastUpdated == null ? 'Waiting for states' : `as of ${timeText(house.lastUpdated)}`;

/** A quick control: a tile that runs (or asks) on a tap; on, busy and warning looks; the state under the name (also a thing's page's
 *  control: view/thing-hub.js). */
export function Tile({house, e}) {
  const s = house.state(e.id), c = control(e, s), busy = house.busy.has(e.id), toggle = ['light', 'switch', 'fan'].includes(e.domain);
  return html`<button type="button" class=${`dh-tile${c?.on && !warns(e, s) ? ' on' : ''}${warns(e, s) ? ' warn' : ''}${house.confirm?.entity_id === e.id ? ' confirming' : ''}${busy ? ' busy' : ''}${!house.live ? ' stale' : ''}`} data-id=${e.id}
    disabled=${!house.live || !c || c.disabled} aria-pressed=${toggle ? String(!!c?.on) : null} aria-busy=${busy ? 'true' : null} onClick=${() => house.act(e.id)}>
    <${Glyph} name=${entityGlyph(e)} size=${22} />
    <span class="dh-tname">${e.name}</span><span class="dh-tstate">${stateText(e, s, {unit: temperatureUnit(house)})}${!house.live ? ` · ${asOf(house)}` : ''}</span>
  </button>`;
}

/** The confirmation for a cover, a lock or a switch: the verb and the name, Confirm focused, Esc or Cancel to drop it. `anchor` (the
 *  tablet): beside the tile it asks about (below it, else above), not across the board. */
export function Confirm({house, anchor = false}) {
  const c = house.confirm, ok = useRef(null), box = useRef(null), [at, setAt] = useState(null);
  useLayoutEffect(() => { if (c) ok.current?.focus(); }, [c]);
  useLayoutEffect(() => {
    const tile = anchor && c?.entity_id ? document.querySelector(`.dh-tile[data-id="${CSS.escape(c.entity_id)}"]`) : null;
    if (!tile || !box.current) { setAt(null); return; }
    const t = tile.getBoundingClientRect(), b = box.current.getBoundingClientRect(), gap = 8;
    // whole tiles wide (the grid's gap between them), so the box never leaves a sliver of the tile beside it showing
    const step = t.width + gap, width = Math.min(innerWidth - 2 * gap, Math.ceil((b.width + 1) / step) * step - gap);
    setAt({top: t.bottom + gap + b.height <= innerHeight ? t.bottom + gap : Math.max(gap, t.top - gap - b.height),
      left: Math.max(gap, Math.min(t.left, innerWidth - gap - width)), width});
  }, [c, anchor]);
  if (!c) return null;
  // beside its tile, a scrim dims the rest of the board (a tap there cancels), so what the box covers reads as covered
  return html`${anchor ? html`<div class="dh-scrim" aria-hidden="true" onClick=${() => house.cancel()} />` : null}<div class=${`dh-confirm${at ? ' anchored' : ''}`} ref=${box} style=${at ? `top:${at.top}px;left:${at.left}px;width:${at.width}px` : null} role="alertdialog" aria-label=${`${c.verb} ${c.name}?`}>
    <span><b>${c.verb} ${c.name}?</b></span>
    <button type="button" class="dk-btn main" ref=${ok} onClick=${() => house.confirmed()}>${c.verb}</button>
    <button type="button" class="dk-btn" onClick=${() => house.cancel()}>Cancel</button>
  </div>`;
}

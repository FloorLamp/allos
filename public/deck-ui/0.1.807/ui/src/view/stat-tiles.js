// Tiles of figures over a list or chart: a label, one big figure, a delta against a comparison. Any measure: money is one preset.
import {h} from '../../vendor/preact.mjs';
import htm from '../../vendor/htm.mjs';
import {formatQuantity, toneOf} from '../quantity.js';
const html = htm.bind(h);

// flat has no mark: a dash would read as a minus
const ARROW = {up: '▲', down: '▼'};

/** A delta {text, pct?, tone, dir, label?} (quantity.js `delta`): an arrow as well as a colour, so a tone is never colour alone. */
export const Delta = ({d}) => d ? html`<span class=${`dk-delta tone-${d.tone ?? 'neutral'}`}>${ARROW[d.dir] ? html`<span aria-hidden="true">${ARROW[d.dir]}</span> ` : null}${d.text}${d.pct ? ` (${d.pct})` : ''}${d.label ? html`<span class="dk-delta-label"> ${d.label}</span>` : null}</span>` : null;

/** tiles: [{key, label, quantity | value (text), sub?, delta?, tip?, ref?}]; `onOpen(ref)` makes a tile with a `ref` a button; `compact` for
 *  short figures that sit side by side even in a drawer. */
export function StatTiles({tiles = [], onOpen, label = 'Totals', compact = false}) {
  return html`<div class=${`dk-tiles${compact ? ' compact' : ''}`} role="group" aria-label=${label}>${tiles.map(t => {
    const figure = t.quantity ? formatQuantity(t.quantity) : t.value ?? '–';
    const tone = t.quantity ? toneOf(t.quantity) : 'neutral';
    return html`<div class="dk-stat" key=${t.key} data-tile=${t.key} title=${t.tip ?? null}>
      <span class="dk-stat-label">${t.label}</span>
      ${t.ref != null && onOpen ? html`<button type="button" class=${`dk-figure tone-${tone} link`} onClick=${() => onOpen(t.ref)}>${figure}</button>`
        : html`<b class=${`dk-figure tone-${tone}`}>${figure}</b>`}
      ${t.delta ? html`<${Delta} d=${t.delta} />` : null}
      ${t.sub ? html`<span class="dk-stat-sub">${t.sub}</span>` : null}</div>`;
  })}</div>`;
}

// The one chip group (a segmented control: toggle chips, one pressed, `aria-pressed` in a labelled group; base.css `.dk-chip`,
// foundation.css `.dk-chips`): Flightplan's lists, priorities, areas and columns, House's domains, a link picker's kinds, a workbook's
// sheets, Money's review kinds and a payment's state; `RangeChips`, its preset for a chart's range (Over time, Usage, energy, cost per use).
// Keys: Tab reaches each chip; ArrowRight/ArrowDown and ArrowLeft/ArrowUp move between them (wrapping), Home/End the ends; Enter or
// Space presses the focused one.
import {h} from '../../vendor/preact.mjs';
import htm from '../../vendor/htm.mjs';
import {Button} from './controls.js';
const html = htm.bind(h);

const STEP = {ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1};

/** `options` [{value, label (text or markup), title?, class?, disabled?}]; `value` the pressed one's; `onChange(value)` on a press;
 *  `toggle`: pressing the pressed chip lets it go (`onChange(null)`); `disabled` every chip; `label` names the group; `class` the
 *  group's own; `groupRef` its element. */
export function ChipGroup({options, value, onChange, label, toggle = false, disabled = false, class: cls = '', groupRef = null}) {
  const keys = ev => {
    const step = STEP[ev.key], all = [...ev.currentTarget.querySelectorAll('.dk-chip:not(:disabled)')], at = all.indexOf(ev.target);
    if (at < 0 || step == null && ev.key !== 'Home' && ev.key !== 'End') return;
    ev.preventDefault();
    all[ev.key === 'Home' ? 0 : ev.key === 'End' ? all.length - 1 : (at + step + all.length) % all.length].focus({preventScroll: true});
  };
  return html`<div class=${`dk-chips${cls ? ` ${cls}` : ''}`} role="group" aria-label=${label} ref=${groupRef} onKeyDown=${keys}>${options.map(o => {
    const on = o.value === value;
    return html`<${Button} type="button" key=${String(o.value)} class=${`dk-chip${on ? ' on' : ''}${o.class ? ` ${o.class}` : ''}`} aria-pressed=${String(on)}
      title=${o.title} disabled=${disabled || o.disabled} onClick=${() => onChange(on && toggle ? null : o.value)}>${o.label}</${Button}>`;
  })}</div>`;
}

/** The ranges a chart offers, ending now: the chip's label and the words for it (`over the last 7 days`). */
export const RANGES = Object.freeze({
  '24h': {label: '24 h', words: '24 hours'},
  '7d': {label: '7 d', words: '7 days'},
  '30d': {label: '30 d', words: '30 days'},
  '1y': {label: '1 y', words: 'year'},
});

/** A chart's range picker: `range` the one drawn, `onRange(range)`, `ranges` which of RANGES to offer (none past one). */
export const RangeChips = ({range, onRange, ranges = Object.keys(RANGES), label = 'Range'}) => ranges.length > 1 ? html`<${ChipGroup} class="dk-ranges" label=${label}
  value=${range} onChange=${onRange} options=${ranges.map(r => ({value: r, label: RANGES[r].label, title: `The last ${RANGES[r].words}`}))} />` : null;

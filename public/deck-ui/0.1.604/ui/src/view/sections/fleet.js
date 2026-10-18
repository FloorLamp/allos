import {h} from '../../../vendor/preact.mjs';
import htm from '../../../vendor/htm.mjs';
import {More} from './more.js';
import {Section} from './section.js';
import {Spark} from './spark.js';
const html = htm.bind(h);
export function Fleet({fleet = [], fold, onOpen, url, limit = Infinity, compact = false}) {
  if (!fleet.length) return null;
  const busy = fleet.filter(m => m.busy).length;
  return html`<${Section} id="fleet" label="Fleet" count=${`${busy} of ${fleet.length} busy`} fold=${fold}><div class="dg-fleet">${fleet.slice(0, limit).map(m => html`
    <button type="button" class=${`dg-machine tone-${m.tone}`} key=${m.name} data-nav title=${m.tip} onClick=${() => onOpen(url)}>
      <span class="dg-mark" aria-hidden="true"></span><span class="dg-machine-name">${m.name}</span>
      ${compact ? html`<span class="dg-machine-status">${m.state !== 'online' ? m.state : m.busy ? `${m.busy}/${m.slots.length} slots` : 'idle'} · load ${m.load == null ? 'unknown' : m.load.toFixed(2)}</span>` : html`<span class="dg-slots" role="img" aria-label=${`${m.busy} of ${m.slots.length} slots in use`}>${m.slots.map((s, i) => html`<i key=${i} class=${`dg-slot s-${s}`}></i>`)}</span>
      <${Spark} hours=${m.hours} />
      <span class="dg-load">${m.load == null ? '–' : m.load.toFixed(2)}</span>`}
    </button>`)}</div><${More} n=${Math.max(0, fleet.length - limit)} url=${url} onOpen=${onOpen} what="" /></${Section}>`;
}


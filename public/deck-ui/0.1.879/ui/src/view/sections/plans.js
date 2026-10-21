import {h} from '../../../vendor/preact.mjs';
import htm from '../../../vendor/htm.mjs';
import {Brand} from '../../glyphs.js';
import {More} from './more.js';
import {Section} from './section.js';
import {Failure} from '../page-state.js';
const html = htm.bind(h);
/** `error` (with `retry`, `host`): the failed read in the section's place, its last plans kept under it. */
export function Plans({plans = [], onOpen, fold, limit = Infinity, url, error, retry, host}) {
  if (!plans.length && !error) return null;
  const tight = plans.filter(p => p.tight).length;
  return html`<${Section} id="plans" label="AI plans" count=${tight ? `${tight} tight` : `${plans.length}`} fold=${fold}>${error ? html`<${Failure} named=${true} backend="Tower plans" error=${error} retry=${retry} host=${host} />` : null}<div class="dg-plans" data-count=${Math.min(plans.length, limit)}>${plans.slice(0, limit).map(p => html`
    <button type="button" class=${`dg-plan${p.tight ? ' tight' : ''}`} key=${p.key} data-nav title=${p.windows.map(w => `${w.label} ${w.percent}%${w.tip ? ` · ${w.tip}` : ''}`).join('\n')}
        onClick=${() => onOpen(p.url)}>
      <span class="dg-plan-name"><${Brand} agent=${p.agentId} size=${16} />${p.account}</span>
      ${p.windows.map(w => html`<span class=${`dg-window tone-${w.tone}`} key=${w.label}>
        <span class="dg-window-label">${w.label}</span><span class="dg-window-pct">${w.percent}%</span>
        <span class="dg-bar" role="meter" aria-label=${`${p.name} ${w.label}`} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.min(100, w.percent)}>
          <span style=${`width: ${Math.min(100, w.percent)}%`}></span></span>
      </span>`)}
    </button>`)}</div><${More} n=${Math.max(0, plans.length - limit)} url=${url ?? plans[0]?.url} onOpen=${onOpen} what="" /></${Section}>`;
}


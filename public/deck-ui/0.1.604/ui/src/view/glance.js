// The menu bar's popover (palette SPEC.md, *Menu bar and tray*): glance.js's sections as cards, each folding (its header a button). This Mac's Sortie switch first (a
// three modes, native radio keys select one), then Problems and Running now as one-line rows (detail in the tooltip, age at
// the right, `+N more` to Spaceport), AI plans as one tile per account side by side, the projects' summary that opens to their lines,
// and the footer (Open Deck with its hotkey, Open Spaceport, Refresh: its arrows turning while it reads, the last update beside it). Arrows move between the controls; Esc hides.
import {h} from '../../vendor/preact.mjs';
import htm from '../../vendor/htm.mjs';
import {Glyph} from '../glyphs.js';
import {SORTIE_MODES} from '../glance.js';
const html = htm.bind(h);
import {Fleet} from './sections/fleet.js';
import {Plans} from './sections/plans.js';
import {Projects} from './sections/projects.js';
import {Problems} from './sections/problems.js';
import {Running} from './sections/running.js';


function Sortie({s, onSelect}) {
  if (!s) return null;
  return html`<section class=${`dg-card dg-sortie tone-${s.tone}`} aria-label="Sortie">
    <div class="dg-sortie-head">
      <span class="dg-sortie-icon" aria-hidden="true"><${Glyph} name="bolt" size=${16} /></span>
      <span class="dg-sortie-name">Jobs on ${s.host}</span>
      ${s.title ? html`<span class="dg-chip">${s.title}</span>` : null}
    </div>
    <div class="dg-modes" role="radiogroup" aria-label="Sortie mode" aria-busy=${s.busy ? 'true' : 'false'}
      onKeyDown=${e => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) e.stopPropagation(); }}>
      ${SORTIE_MODES.map(option => html`<label key=${option.value}>
        <input type="radio" name="sortie-mode" value=${option.value} checked=${s.mode === option.value} disabled=${!s.enabled}
          onChange=${() => onSelect(option.value)} />
        <span>${option.label}</span></label>`)}
    </div>
    <p class="dg-sortie-line" role=${s.error ? 'alert' : 'status'}>${s.line}</p>
  </section>`;
}

/** The popover: `v` glanceView's sections (+ loading, busy), `actions` createGlance's. */
export function Glance({v, actions}) {
  const open = url => actions.open(url), fold = {collapsed: v.collapsed ?? new Set(), toggle: id => actions.toggleSection(id)};
  const keys = e => {
    if (e.key === 'Escape') { e.preventDefault(); actions.hide(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = [...e.currentTarget.querySelectorAll('[data-nav]:not(:disabled)')].filter(el => el.offsetParent !== null);
    const i = all.indexOf(document.activeElement);
    const next = all[e.key === 'ArrowDown' ? Math.min(all.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1)];
    if (next) { e.preventDefault(); next.focus(); }
  };
  return html`<div class="dg panel" role="dialog" aria-label="Deck" onKeyDown=${keys}>
    <${Sortie} s=${v.sortie} onSelect=${mode => actions.setMode(mode).catch(() => {})} />
    ${v.loading ? html`<p class="dg-state" role="status">Loading…</p>` : null}
    ${v.error ? html`<p class="dg-state bad" role="status"><${Glyph} name="warn" size=${14} /> ${v.error}</p>` : null}
    <${Problems} data=${v.problems} fold=${fold} onOpen=${open} />
    <${Running} data=${v.running} fold=${fold} onOpen=${open} />
    ${!v.loading && !v.error && v.clear ? html`<p class="dg-state ok" role="status"><${Glyph} name="check" size=${14} /> All clear</p>` : null}
    <${Fleet} fleet=${v.fleet} fold=${fold} onOpen=${open} url=${v.tower} />
    <${Plans} plans=${v.plans} onOpen=${open} fold=${fold} />
    <${Projects} p=${v.projects} onOpen=${open} fold=${fold} />
    <footer class="dg-foot">
      <button type="button" class="dk-btn main" data-nav onClick=${() => actions.palette()}>Open Deck${v.hotkey ? html`<span class="dg-key">${v.hotkey}</span>` : null}</button>
      <button type="button" class="dk-btn" data-nav onClick=${() => open(v.tower)}>Open Spaceport</button>
      <button type="button" class=${`dk-btn icon dg-refresh${v.busy ? ' spinning' : ''}`} data-nav aria-label="Refresh" aria-busy=${v.busy ? 'true' : 'false'}
        title=${v.busy ? 'Refreshing…' : v.updated ? `Updated ${v.updated}` : 'Refresh'} disabled=${v.busy}
        onClick=${() => actions.refresh()}><${Glyph} name="refresh" size=${16} /></button>
      ${v.updated ? html`<span class="dg-updated">Updated ${v.updated}</span>` : null}
    </footer>
  </div>`;
}

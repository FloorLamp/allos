import {StatusLink} from '../failure.js';
import {describeFailure} from '../../failure.js';
// The Related rail (palette SPEC.md, *Related*; model relatedRail): the RELATED label, the where-else chips (the day, each cluster,
// the rarest subjects; two lines at most), then each group in bridge's order (its label and count, its items: glyph, title over
// reason, then `All n ›` when it holds more). An item re-targets the viewer (history), Mod+click its page; a chip or `All n ›` opens
// the group in the palette (or, with no palette, a chip the map and `All n` every item here), Mod+click on a chip the map. States:
// loading (the label and three placeholder items), nothing joined, failed with Retry; 404 has no rail. Phones: a bottom sheet.
import {h} from '../../../vendor/preact.mjs';
import {useEffect, useRef} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {docGlyph} from '../../../../palette/model.mjs';
import {Glyph} from '../../glyphs.js';

const html = htm.bind(h);

/** The rail's keyboard stops in order: each chip, then each group's items and its `All n ›`. */
export function railEntries(rail) {
  if (!rail) return [];
  return [
    ...rail.chips.map(chip => ({type: 'chip', chip, id: `chip:${chip.key}`})),
    ...rail.groups.flatMap(group => [...group.items.map(item => ({type: 'item', item, group, id: `item:${group.key}:${item.id}`})),
      ...(group.more > 0 ? [{type: 'more', group, id: `more:${group.key}`}] : [])]),
  ];
}

export function Rail({v, related, entries, railAt, mod}) {
  const list = useRef(null);
  const on = entries[railAt]?.id;
  useEffect(() => {
    list.current?.querySelector('.sel')?.scrollIntoView({block: 'nearest'});
    // the chips show two lines at most: leaving them, the first lines again
    if (!on?.startsWith('chip:')) list.current?.querySelector('.dv-where')?.scrollTo?.(0, 0);
  }, [on]);
  const modded = ev => mod === 'Meta' ? ev.metaKey : ev.ctrlKey;
  if (!related || related.busy) return html`<div class="dv-railin" aria-busy="true"><div class="dk-label">Related</div>
    ${[0, 1, 2].map(i => html`<div class="dv-ritem ph" key=${i}><span class="dk-ph dk-tile"></span><span class="lines"><span class="dk-ph" style="width:70%;height:10px"></span><span class="dk-ph" style="width:45%;height:8px"></span></span></div>`)}</div>`;
  if (related.error) return html`<div class="dv-railin"><div class="dk-label">Related</div><p class="dv-rnote">${describeFailure('bridge', related.error).message}<${StatusLink} host=${v.host} />
    <button class="dk-btn text" onClick=${() => v.retryRelated()}>Retry</button></p></div>`;
  const rail = related.rail;
  if (!rail || (!rail.chips.length && !rail.groups.length)) return html`<div class="dv-railin"><div class="dk-label">Related</div><p class="dv-rnote">Nothing joined to this yet</p></div>`;
  const sel = id => id === on ? ' sel' : '';
  return html`<div class="dv-railin" ref=${list}>
    <div class="dk-label">Related</div>
    ${rail.chips.length ? html`<div class="dv-where">${rail.chips.map(c => html`<button key=${c.key} class=${`dk-chip${sel(`chip:${c.key}`)}`} title=${`${c.label}: open as a list (${mod === 'Meta' ? '⌘' : 'Ctrl'}+click: the map)`}
      onClick=${ev => v.chip(c, {map: modded(ev)})}><${Glyph} name=${c.kind} size=${13} /><span>${c.label}</span></button>`)}</div>` : null}
    ${rail.groups.map(g => html`<section key=${g.key} class="dv-rgroup" data-kind=${g.kind}>
      <div class="dk-label">${g.label} · ${g.count}</div>
      ${g.items.map(it => html`<button key=${it.id} class=${`dv-ritem${sel(`item:${g.key}:${it.id}`)}`} title=${it.title} onClick=${ev => modded(ev) ? v.itemPage(it) : v.openRelated(it)}>
        <span class="dk-tile"><${Glyph} name=${docGlyph(it.document)} size=${16} /></span>
        <span class="lines"><b>${it.title}</b>${it.reason ? html`<span>${it.reason}</span>` : null}</span></button>`)}
      ${g.more > 0 ? html`<button class=${`dk-btn text dv-all${sel(`more:${g.key}`)}`} disabled=${related.more?.[g.kind] === 'busy'} onClick=${() => v.allOf(g)}>All ${g.count} ›</button>` : null}
    </section>`)}
  </div>`;
}

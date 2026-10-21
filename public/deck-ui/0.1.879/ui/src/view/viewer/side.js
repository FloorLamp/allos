import {Failure} from '../page-state.js';
// The viewer's side (palette SPEC.md, *Viewer*, *Related*): one column beside the document (under it on a phone) that scrolls on its
// own, with no toggles, its sections in order and never an empty one: Details (details.js: what was read, the corrections), People &
// things (a chip per record the document names, named-records.js: each opens its record, EntityLink's record-first rule; its
// clusters; the subjects no record is, each its group), Related (the day; each group in bridge's order: its label and count, its items:
// glyph, title over how it is joined, `itemLine`; `All n ›` lists every one in place). An item re-targets the viewer (history),
// Mod+click its page. States: Related loading (its label and three placeholder items), failed with Retry; nothing joined or a 404
// has no section.
import {h} from '../../../vendor/preact.mjs';
import {useEffect, useRef} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {docGlyph} from '../../../../palette/model.mjs';
import {Glyph} from '../../glyphs.js';
import {docLine} from '../rows.js';
import {EntityLink} from '../entity-link.js';
import {Details, detailsShow} from './details.js';

const html = htm.bind(h);

/** People & things' chips: each record, the clusters, then the subjects no record is (as their chips: their group); null until the
 *  records the document names are known (no chip shows, then moves). */
export function peopleOf(named, rail) {
  if (!named) return null;
  const clusters = (rail?.chips ?? []).filter(c => c.kind === 'cluster').map(c => ({kind: 'cluster', id: c.key.slice('cluster:'.length), label: c.label}));
  const subjects = named.subjects.map(name => (rail?.chips ?? []).find(c => c.kind === 'subject' && c.label === name) ?? {kind: 'subject', key: `subject:${name}`, label: name});
  return {records: [...named.records, ...clusters], subjects};
}

/** The side's keyboard stops in order: People & things' chips, then Related's day, each group's items and its `All n ›`. */
export function sideEntries(people, rail) {
  return [
    ...(people?.records ?? []).map(record => ({type: 'record', record, id: `record:${record.kind}:${record.id}`})),
    ...(people?.subjects ?? []).map(chip => ({type: 'chip', chip, id: `chip:${chip.key}`})),
    ...(rail?.chips ?? []).filter(c => c.kind === 'day').map(chip => ({type: 'chip', chip, id: `chip:${chip.key}`})),
    ...(rail?.groups ?? []).flatMap(group => [...group.items.map(item => ({type: 'item', item, group, id: `item:${group.key}:${item.id}`})),
      ...(group.more > 0 ? [{type: 'more', group, id: `more:${group.key}`}] : [])]),
  ];
}

const words = text => String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** The reason every item of a group shares (a cluster's name): said once, in the group's label. */
export function sharedReason(group) {
  const r = group.items[0]?.reason;
  return group.items.length > 1 && r && group.items.every(i => i.reason === r) ? r : null;
}
/** An item's second line: how it is joined (bridge's `reason`), unless that only repeats its title or the group's shared reason; then
 *  what and when it is (`Mail · May 2, 2025`). */
export function itemLine(item, shared = null) {
  const r = words(item.reason), title = new Set(words(item.title));
  const repeats = !r.length || item.reason === shared || r.every(w => title.has(w));
  return repeats ? docLine(item.document ?? {}) : docLine(item.document ?? {}, item.reason);
}

/** Whether the side has anything to show (never an empty column). */
export function sideShows({details, people, related}) {
  return detailsShow(details) || !!(people?.records.length || people?.subjects.length) || !!related && (related.busy || related.error || related.rail?.groups.length || related.rail?.chips.some(c => c.kind === 'day'));
}

/** v: the viewer; details: the Details state (or null); people: peopleOf's; related: v.railFor's; entries, railAt: the keyboard's stops
 *  and the one selected; onRecord(record): a record opened (the host's way); relatedRef: Related's section (R scrolls to it). */
export function Side({v, details, people, related, entries, railAt, mod, onRecord, relatedRef}) {
  const list = useRef(null);
  const on = entries[railAt]?.id;
  useEffect(() => { list.current?.querySelector('.sel')?.scrollIntoView({block: 'nearest'}); }, [on]);
  const sel = id => id === on ? ' sel' : '';
  const hasPeople = !!(people?.records.length || people?.subjects.length);
  return html`<aside class="dv-side" ref=${list} aria-label="About this document">
    ${detailsShow(details) ? html`<section class="dv-sec dv-sdetails" aria-label="Details"><${Details} d=${details} mod=${mod} /></section>` : null}
    ${hasPeople ? html`<section class="dv-sec" aria-label="People & things"><div class="dk-label">People & things</div>
      <div class="dv-chips">${people.records.map(r => html`<${EntityLink} key=${`${r.kind}:${r.id}`} kind=${r.kind} id=${r.id} label=${r.label} chip=${true} known=${true} avatar=${r.kind === 'person' ? {path: r.photo ?? null, name: r.label} : null} host=${v.host}
        selected=${!!sel(`record:${r.kind}:${r.id}`)} title=${`${r.label}: open ${r.kind === 'cluster' ? 'the cluster' : 'their page'}`} pages=${v.host.kind === 'web'} onOpen=${onRecord} />`)}
      ${people.subjects.map(c => html`<${Chip} key=${c.key} v=${v} chip=${c} sel=${sel(`chip:${c.key}`)} mod=${mod} />`)}</div></section>` : null}
    <${Related} v=${v} related=${related} sel=${sel} mod=${mod} sectionRef=${relatedRef} />
  </aside>`;
}

/** A chip that opens its group (a day, a subject no record is): the palette's, else (and Mod+click) the map. */
function Chip({v, chip, sel, mod}) {
  const modded = ev => mod === 'Meta' ? ev.metaKey : ev.ctrlKey;
  return html`<button class=${`dk-chip${sel}`} title=${`${chip.label}: open as a list (${mod === 'Meta' ? '⌘' : 'Ctrl'}+click: the map)`}
    onClick=${ev => v.chip(chip, {map: modded(ev)})}><${Glyph} name=${chip.kind} size=${13} /><span>${chip.label}</span></button>`;
}

function Related({v, related, sel, mod, sectionRef}) {
  const modded = ev => mod === 'Meta' ? ev.metaKey : ev.ctrlKey;
  if (!related) return null;
  if (related.busy) return html`<section class="dv-sec" aria-label="Related" aria-busy="true" ref=${sectionRef}><div class="dk-label">Related</div>
    ${[0, 1, 2].map(i => html`<div class="dv-ritem ph" key=${i}><span class="dk-ph dk-tile"></span><span class="lines"><span class="dk-ph" style="width:70%;height:10px"></span><span class="dk-ph" style="width:45%;height:8px"></span></span></div>`)}</section>`;
  if (related.error) return html`<section class="dv-sec" aria-label="Related" ref=${sectionRef}><div class="dk-label">Related</div>
    <${Failure} error=${related.error} retry=${() => v.retryRelated()} host=${v.host} /></section>`;
  const rail = related.rail, days = (rail?.chips ?? []).filter(c => c.kind === 'day');
  // nothing joined but its subjects and clusters (People & things): no section
  if (!rail || !days.length && !rail.groups.length) return null;
  const count = rail.groups.reduce((n, g) => n + g.count, 0);
  return html`<section class="dv-sec" aria-label="Related" ref=${sectionRef}>
    <div class="dk-label">Related${count ? html` · <span class="n">${count}</span>` : null}</div>
    ${days.length ? html`<div class="dv-chips">${days.map(c => html`<${Chip} key=${c.key} v=${v} chip=${c} sel=${sel(`chip:${c.key}`)} mod=${mod} />`)}</div>` : null}
    ${rail.groups.map(g => { const shared = sharedReason(g); return html`<section key=${g.key} class="dv-rgroup" data-kind=${g.kind}>
      <div class="dk-label" title=${shared ? `${g.label}: ${shared}` : null}>${shared ? `${g.label}: ${shared}` : g.label} · ${g.count}</div>
      ${g.items.map(it => { const line = itemLine(it, shared); return html`<button key=${it.id} class=${`dv-ritem${sel(`item:${g.key}:${it.id}`)}`} title=${[it.title, line].filter(Boolean).join('\n')} onClick=${ev => modded(ev) ? v.itemPage(it) : v.openRelated(it)}>
        <span class="dk-tile"><${Glyph} name=${docGlyph(it.document)} size=${16} /></span>
        <span class="lines"><b>${it.title}</b>${line ? html`<span>${line}</span>` : null}</span></button>`; })}
      ${g.more > 0 ? html`<button class=${`dk-btn text dv-all${sel(`more:${g.key}`)}`} disabled=${related.more?.[g.kind] === 'busy'} onClick=${() => v.allOf(g)}>All ${g.count} ›</button>` : null}
    </section>`; })}
  </section>`;
}

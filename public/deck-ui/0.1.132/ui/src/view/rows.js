// The palette's rows (palette SPEC.md, *Row anatomy*, *Row kinds*): one grid for every kind (tile, two lines, one trailing item),
// built from the model's rows: Recent (text, link, image with its thumbnail, file; age over the peer chip), commands with their key,
// house actions by domain (accent when on), the House row, Ask, identifiers (mono values), links, documents (docGlyph, docSubtitle,
// an order's `+n mails ›`), series (span and count, then the member chips that fit, the focused one in view, `+k`), projects,
// answers and none rows (bridge's lines), and citations (`[n]`). Selected, confirming and copied rows; the source chip and the group
// affordance as their own buttons. Also the section labels (`FOUND · searching…`, `All n ›`, Recent's Clear), placeholder rows, the state block, and `RowList`: plain rows for
// bridge's own pages (projects, attention) from documents and projects.
import {h} from '../../vendor/preact.mjs';
import {useLayoutEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import * as model from '../../../palette/model.mjs';
import {Glyph} from '../glyphs.js';
import {size} from '../viewer.js';
import {keycap} from './keys.js';

const html = htm.bind(h);


/** Recent's age (`now`, `12 min`, `3 h`, `yesterday`, `Tue`, `Sep 4`) at `now`. */
export function age(at, now = Date.now()) {
  const t = new Date(at), mins = (now - at) / 60000, today = new Date(now);
  if (!Number.isFinite(mins) || mins < 1) return 'now';
  if (mins < 60) return `${Math.floor(mins)} min`;
  const day = d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (day(t) === day(today)) return `${Math.floor(mins / 60)} h`;
  if (day(t) === day(new Date(now - 86400000))) return 'yesterday';
  if (mins < 7 * 1440) return t.toLocaleDateString('en-US', {weekday: 'short'});
  return t.toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
}

/** A section's label by its rows' kind (the Needs you and House rows have none). */
export const sectionOf = kind => ({needs: '', house: '', ask: 'ASK', command: 'COMMANDS', action: 'ACTIONS', recent: 'RECENT', citation: 'SOURCES'})[kind] ?? 'FOUND';

/** An open group's label: its section's, else its documents counted (`14 DOCUMENTS · 2 ALTERNATES`). */
export function scopeLabel(key, list) {
  if (key === 'section:actions') return 'ACTIONS';
  if (key === 'section:needs') return 'NEEDS YOU';
  if (key === 'section:recent') return 'RECENT';
  if (key.startsWith('topic:')) return `${list.length} ${list.length === 1 ? 'ACCOUNT' : 'ACCOUNTS'}`;
  if (key.startsWith('day:')) return `${list.length} ${list.length === 1 ? 'EVENT' : 'EVENTS'}`;
  if (key.startsWith('event:')) {
    const people = list.filter(r => r.kind === 'person' || r.kind === 'none').length, docs = list.length - people;
    return `${people} ${people === 1 ? 'ATTENDEE' : 'ATTENDEES'} · ${docs} ${docs === 1 ? 'DOCUMENT' : 'DOCUMENTS'}`;
  }
  if (key.startsWith('trips:')) return `${list.length} ${list.length === 1 ? 'TRIP' : 'TRIPS'}`;
  if (key.startsWith('tally:')) return `${list.length} ${list.length === 1 ? 'ORDER' : 'ORDERS'}`;
  if (key.startsWith('area:')) return [['project', 'PROJECT', 'PROJECTS'], ['series', 'SERVICE', 'SERVICES']]
    .map(([k, one, more]) => { const n = list.filter(r => r.kind === k).length; return n ? `${n} ${n === 1 ? one : more}` : null; }).filter(Boolean).join(' · ');
  const alt = list.filter(r => r.alternateOf).length, other = list.filter(r => r.kind === 'identifier' || r.kind === 'link').length, n = list.length - alt - other;
  return `${n} ${n === 1 ? 'DOCUMENT' : 'DOCUMENTS'}${alt ? ` · ${alt} ${alt === 1 ? 'ALTERNATE' : 'ALTERNATES'}` : ''}${other ? ` · ${other} ${other === 1 ? 'NUMBER OR LINK' : 'NUMBERS AND LINKS'}` : ''}`;
}

/** A house action's glyph by its domain, and whether its entity is on (a light, a switch, media playing; never a cover's open). */
export function actionLook(a) {
  const domain = a.domain || String(a.id).split('.')[0];
  const glyph = {light: 'light', lock: 'lock', media: 'play', media_player: 'play', script: 'bolt', scene: 'bolt', automation: 'bolt', thermostat: 'thermostat',
    climate: 'thermostat', water_heater: 'thermostat', input_select: 'thermostat', shade: 'shade', cover: 'shade'}[domain] ?? 'toggle';
  const on = !['cover', 'shade'].includes(domain) && ['on', 'playing', 'heat', 'cool', 'heat_cool', 'auto'].includes(a.state);
  return {glyph, on};
}

const PLAIN = /^[A-Za-z0-9]+$/;
const strip = u => String(u ?? '').replace(/^https?:\/\/(www\.)?/, '');

/** What a row shows, no DOM: {glyph, accent (the glyph in accent), thumb (a resource path), prefix, title, lines (title lines: 2 for
 *  Recent text), sub, subClass (mono, soft, accent), source (the chip's name), more (the group affordance), key (a command's),
 *  age, peer: {text, dir}, tip}. `n` a citation's number. */
export function lines(row, {n = 0, mod = 'Control'} = {}) {
  const out = {glyph: 'document', accent: false, thumb: null, prefix: '', title: '', lines: 1, sub: '', subClass: '', source: null, more: null, key: null, age: null, peer: null, tip: ''};
  switch (row.kind) {
    case 'recent': {
      const i = row.item;
      out.peer = {text: `${i.direction === 'sent' ? '→' : '←'} ${(i.peers ?? []).length > 1 ? `${i.peers[0]} +${i.peers.length - 1}` : i.peers?.[0] ?? ''}`.trim(), dir: i.direction === 'sent' ? 'sent' : 'received'};
      out.age = i.at ? age(i.at) : null;
      if (i.link) {
        try { const u = new URL(i.link); out.title = u.hostname.replace(/^www\./, ''); out.sub = (u.pathname + u.search).replace(/\/$/, ''); } catch { out.title = i.link; }
        Object.assign(out, {glyph: 'link', accent: true});
      } else if (i.kind === 'text') {
        out.title = String(i.preview ?? '').slice(0, 300).trim().replace(/[\t ]+/g, ' ') || '(blank text)';
        Object.assign(out, {glyph: 'text', lines: 2});
      } else if (i.kind === 'image') {
        const type = String(i.type ?? '').replace('image/', '').toUpperCase();
        Object.assign(out, {glyph: 'photo', title: i.name || 'Image', sub: [type && !i.name ? type : null, size(i.size)].filter(Boolean).join(' · '), thumb: i.thumb ? `/local/recent/${i.id}/thumb` : null});
      } else {
        Object.assign(out, {glyph: /^image\//.test(i.type ?? '') ? 'photo' : 'file', title: i.name || 'File', sub: size(i.size)});
      }
      const when = i.at ? new Date(i.at).toLocaleString('en-US', {dateStyle: 'medium', timeStyle: 'short'}) : '';
      out.tip = `${i.kind === 'file' && i.path ? i.path : i.kind === 'text' ? String(i.preview ?? '').slice(0, 600) : out.title}\n${i.direction === 'sent' ? 'Sent to' : 'Received from'} ${(i.peers ?? []).join(', ')}${when ? ` · ${when}` : ''}`;
      return out;
    }
    case 'action': {
      const a = row.action, look = actionLook(a);
      Object.assign(out, {glyph: look.glyph, accent: look.on, title: a.title, sub: a.subtitle || a.state || ''});
      out.tip = [a.title, out.sub, a.confirm ? 'Asks before it runs' : null].filter(Boolean).join('\n');
      return out;
    }
    case 'needs': return {...out, glyph: 'warn', warn: true, title: 'Needs you', more: `${row.count} ›`, tip: 'What only you can fix to keep your data flowing (Enter or Tab shows it)'};
    case 'need': {
      // a need (spaceport shared/BACKEND.md): what to do over why; a command to copy shows as itself
      const n = row.need, a = n.action ?? {}, cmd = a.kind === 'command' ? String(a.command ?? '') : '';
      const sub = cmd || n.detail || [model.sourceName(n.source), n.since ? `since ${model.dateLabel(String(n.since).slice(0, 10))}` : null].filter(Boolean).join(' · ');
      return {...out, glyph: 'warn', warn: true, title: n.title, sub: [n.from?.backend ?? n.backend, sub].filter(Boolean).join(' · '), subClass: cmd ? 'mono' : '', tip: [n.title, n.detail, cmd, a.label].filter(Boolean).join('\n')};
    }
    case 'house': return {...out, glyph: 'house', title: 'House', more: `${row.count} ${row.count === 1 ? 'action' : 'actions'} ›`, tip: 'House actions (Enter or Tab shows them)'};
    case 'command': return {...out, glyph: row.id === 'receive' ? 'receive' : row.id === 'share' ? 'share' : 'send', title: row.title, key: row.key ? keycap(row.key, mod) : null};
    case 'ask': return {...out, glyph: 'ask', accent: true, title: 'Ask', sub: row.query, subClass: 'soft', tip: row.query};
    case 'citation': {
      const ct = row.citation, quote = String(ct.quote ?? '').replace(/\s+/g, ' ').trim();
      Object.assign(out, {glyph: model.docGlyph({source: ct.source, type: ct.type}), prefix: n ? `[${n}]` : '', title: ct.title || 'Untitled',
        sub: [model.dateLabel(ct.date), quote ? `“${quote}”` : null].filter(Boolean).join(' · '), source: model.sourceName(ct.source) ?? 'Source'});
      out.tip = [out.title, out.sub].filter(Boolean).join('\n');
      return out;
    }
    case 'series': {
      const l = model.seriesLines(row.series);
      return {...out, glyph: 'series', title: l.title, sub: l.subtitle, more: `${row.series.count ?? row.series.members.length} ›`, tip: `${l.title}\n${l.subtitle}`};
    }
    case 'thing': {
      const t = row.thing, sub = row.result.subtitle ?? '', n = t.documents?.length ?? 0;
      return {...out, glyph: t.type === 'plant' ? 'plant' : 'thing', title: row.result.title || t.name, sub, more: `${n} ›`, tip: `${row.result.title || t.name}\n${sub}`};
    }
    case 'event': {
      const e = row.event, title = row.result.title, sub = row.result.subtitle ?? '';
      return {...out, glyph: 'day', title, sub, more: `${(e.attendees?.length ?? 0) + (e.documents?.length ?? 0)} ›`, tip: `${title}\n${sub}`};
    }
    case 'day': {
      const title = row.result.title, sub = row.result.subtitle ?? '';
      return {...out, glyph: 'day', title, sub, more: `${row.day.count} ›`, tip: `${title}\n${sub}`};
    }
    case 'person': case 'trip': {
      // bridge's person (a contact: their texts, papers, projects) and trip (flights, stays, cars sharing dates): Enter views it, Tab
      // lists its numbers and documents
      const e = row[row.kind], sub = row.result.subtitle ?? '', n = (e.ids?.length ?? 0) + (e.documents?.length ?? 0), title = row.result.title || e.name;
      return {...out, glyph: row.kind, title, sub, more: `${n} ›`, tip: `${title}\n${sub}`};
    }
    case 'topic': {
      const t = row.topic, sub = row.result.subtitle ?? '';
      return {...out, glyph: 'chart', title: t.title, sub, more: `${t.count ?? t.results?.length ?? 0} ›`, tip: `${t.title}\n${sub}`};
    }
    case 'trips': {
      // bridge's trips past its first four: Enter or Tab lists them
      const t = row.trips, sub = row.result.subtitle ?? '', title = row.result.title || t.title;
      return {...out, glyph: 'trip', title, sub, more: `${t.count ?? t.results?.length ?? 0} ›`, tip: `${title}\n${sub}`};
    }
    case 'area': {
      const a = row.area, sub = row.result.subtitle ?? '';
      return {...out, glyph: 'house', title: a.title, sub, more: `${a.results?.length ?? 0} ›`, tip: `${a.title}\n${sub}`};
    }
    case 'answer': case 'none': {
      // bridge's answer (a fact answering the query) and none (what is not there) rows: its own title and subtitle, a source chip
      // only with a document
      // a count's (`tally`) orders are its group: the group affordance instead of the source chip
      const r = row.result, d = r.document, n = r.tally ? r.tally.count ?? r.tally.results?.length ?? 0 : null;
      return {...out, glyph: row.kind === 'answer' ? 'check' : 'find', title: r.title, sub: r.subtitle ?? '', source: d && n == null ? model.sourceName(d.source) ?? 'Source' : null,
        ...(n != null ? {more: `${n} ›`} : {}),
        tip: [r.title, r.subtitle, d?.title ? `From ${d.title}` : null].filter(Boolean).join('\n')};
    }
    case 'project': {
      const l = model.projectLines(row.project);
      return {...out, glyph: 'project', title: l.title, sub: l.subtitle, more: `${row.project.count ?? 0} ›`, tip: [l.title, l.subtitle, row.project.summary].filter(Boolean).join('\n')};
    }
  }
  // identifier, link, document (a group's member too)
  const r = row.result ?? {}, d = r.document;
  out.title = r.title || d?.title || 'Untitled';
  if (row.kind === 'identifier') Object.assign(out, {glyph: 'key', sub: String(r.value ?? ''), subClass: PLAIN.test(String(r.value ?? '')) ? 'mono' : 'soft'});
  else if (row.kind === 'link') Object.assign(out, {glyph: 'link', accent: true, sub: strip(r.value), subClass: 'accent'});
  else {
    out.glyph = model.docGlyph(d);
    out.sub = row.alternateOf ? [`alternate of ${row.alternateOf}`, d?.type].filter(Boolean).join(' · ') : model.docSubtitle(d ?? {}, row.reason ?? null);
    if (!out.sub) out.sub = r.subtitle ?? '';
    if (d?.mails?.length) out.more = `+${d.mails.length} ${d.mails.length === 1 ? 'mail' : 'mails'} ›`;
  }
  if (!out.more && d) out.source = model.sourceName(d.source) ?? 'Source';
  out.tip = [out.title, out.sub, (row.kind === 'identifier' || row.kind === 'link') && d?.title ? `From ${d.title}` : null].filter(Boolean).join('\n');
  return out;
}

/** A confirmation's verb on its row: an action's first word (`Unlock`), Remove. */
export const verb = (what, action) => what === 'remove' ? 'Remove' : what === 'act' && action ? action.title.split(' ')[0] : 'Run';

// ---- series chips that fit (SPEC.md, *Series*: model fitChips; cases.json chipFit) -------------------------------------------------

let canvas = null;
/** A text's width in the chips' font (tokens styles.chip), measured once per label. */
const widths = new Map();
function textWidth(text, font) {
  const k = `${font}|${text}`;
  if (widths.has(k)) return widths.get(k);
  canvas ??= typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
  const g = canvas.getContext('2d');
  g.font = font;
  const w = g.measureText(text).width;
  widths.set(k, w);
  return w;
}

/** How many chips (`slots`, `+k` taking one) fit in `room` px: the widest label's chip (padding `gaps.s` each side, the outline, a
 *  `gaps.xs` gap) per slot, at least one. */
export function slotsFor(labels, room, font, pad = 8, gap = 4) {
  const widest = Math.max(...[...labels, `+${labels.length}`].map(l => textWidth(l, font)));
  return Math.max(1, Math.floor((room + gap) / (widest + 2 * pad + 2 + gap)));
}

/** The chips a series row shows: [{label, member (index, newest 0), more, focused}], the focused one kept in view. */
export function chipsFor(labels, slots, focus) {
  const shown = model.fitChips(labels, slots, focus);
  if (shown.length === labels.length) return shown.map((label, i) => ({label, member: i, more: false, focused: focus === i}));
  const room = Math.max(slots - 1, 0), start = focus == null || focus < room ? 0 : focus - room + 1;
  return shown.map((label, i) => i === shown.length - 1 ? {label, member: start + room, more: true, focused: false}
    : {label, member: start + i, more: false, focused: focus === start + i});
}

function SeriesChips({row, focus, act}) {
  const ref = useRef(null);
  const [slots, setSlots] = useState(0);
  const labels = model.seriesLines(row.series).chips.map(c => c.label);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el), font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const n = slotsFor(labels, el.clientWidth, font);
      setSlots(s => s === n ? s : n);
    };
    measure();
    let frame = 0;
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); }) : null;
    ro?.observe(el);
    return () => { cancelAnimationFrame(frame); ro?.disconnect(); };
  }, [labels.join('|')]);
  const chips = slots ? chipsFor(labels, slots, focus) : [];
  return html`<span class="dp-chips" ref=${ref}>${chips.map(ch => html`<button key=${`${ch.member}${ch.more ? '+' : ''}`} type="button" tabindex="-1"
    class=${`dp-chip${ch.focused ? ' on' : ''}${ch.more ? ' more' : ''}`} title=${ch.more ? 'More of this series (→)' : `View ${row.series.members[ch.member]?.title ?? ch.label}`}
    onClick=${ev => { ev.stopPropagation(); act.chip(row.id, ch.member, {more: ch.more}); }}>${ch.label}</button>`)}</span>`;
}

/** One row. act: {select, open, group, chip, source, menu, drag} (the palette's), mod. */
export function Row({row, n = 0, selected = false, confirm = null, copied = false, focus = null, act, mod, host, rowId}) {
  const l = lines(row, {n, mod});
  const drag = act.dragOf?.(row.id);
  const thumb = l.thumb && host?.caps.recent ? host.resource(l.thumb) : null;
  return html`<div class=${`dp-row${selected ? ' sel' : ''}${confirm ? ' confirm' : ''}`} role="option" id=${rowId} data-id=${row.id} data-kind=${row.kind}
    aria-selected=${selected ? 'true' : 'false'} title=${l.tip || null} draggable=${drag ? 'true' : null}
    data-chips=${row.kind === 'series' ? JSON.stringify(model.seriesLines(row.series).chips.map(c => c.label)) : null}
    data-chip=${row.kind === 'series' ? (focus ?? '') : null}
    onClick=${ev => { if (!ev.target.closest('button')) act.select(row.id); }}
    onDblClick=${ev => { if (!ev.target.closest('button')) act.open(row.id); }}
    onContextMenu=${ev => act.menu?.(ev, row.id)}
    onDragStart=${ev => act.drag?.(ev, row.id, drag)}>
    <span class=${`dp-tile${l.accent ? ' accent' : ''}${l.warn ? ' warn' : ''}${thumb ? ' thumb' : ''}`}>${thumb
      ? html`<img src=${thumb} alt="" loading="lazy" draggable="false" onError=${ev => { ev.target.remove(); }} />` : null}<${Glyph} name=${l.glyph} size=${18} /></span>
    <span class="dp-lines">
      <span class=${`dp-title${l.lines > 1 ? ' two' : ''}`}>${l.prefix ? html`<span class="dp-n">${l.prefix}</span>` : null}${l.title}</span>
      ${row.kind === 'series' ? html`<span class="dp-sub dp-serieslines"><span class="dp-span">${l.sub}</span><${SeriesChips} row=${row} focus=${focus} act=${act} /></span>`
        : l.sub ? html`<span class=${`dp-sub ${l.subClass}`}>${l.sub}</span>` : null}
    </span>
    <span class="dp-end">${confirm ? html`<span class="dp-confirm">Enter ${confirm} · Esc Cancel</span>`
      : copied ? html`<span class="dp-copied"><${Glyph} name="check" size=${14} /> Copied</span>`
      : l.more ? html`<button type="button" tabindex="-1" class="dp-pill" title="Show all (Tab)" onClick=${ev => { ev.stopPropagation(); act.group(row.id); }}>${l.more}</button>`
      : l.source ? html`<button type="button" tabindex="-1" class="dp-pill dp-src" title=${`Open in ${l.source}`} onClick=${ev => { ev.stopPropagation(); act.source(row.id); }}>${l.source} ↗</button>`
      : l.key ? html`<kbd class="dk-key">${l.key}</kbd>`
      : l.age != null ? html`<span class="dp-age"><span>${l.age}</span>${l.peer?.text ? html`<span class=${`dp-peer ${l.peer.dir}`}>${l.peer.text}</span>` : null}</span>` : null}</span>
  </div>`;
}

/** A section label (`FOUND · searching…`), `All n ›` and Recent's Clear at its right. */
export function Label({text, all = null, clear = false, onAll, onClear}) {
  return html`<div class="dp-label" role="presentation"><span class="dk-label">${text}</span>
    ${all ? html`<button type="button" tabindex="-1" class="dp-labelbtn" onClick=${onAll}>${all}</button>` : null}
    ${clear ? html`<button type="button" tabindex="-1" class="dp-labelbtn clear" onClick=${onClear}>Clear</button>` : null}</div>`;
}

/** Placeholder rows (`track` bars, a shimmer; still under reduce motion). */
export const Placeholders = ({n = 2}) => Array.from({length: n}, (_, i) => html`<div class="dp-row ph" key=${`ph${i}`} aria-hidden="true">
  <span class="dp-tile dk-ph"></span><span class="dp-lines"><span class="dk-ph" style=${`width:${62 - (i % 3) * 12}%;height:11px`}></span><span class="dk-ph" style=${`width:${38 + (i % 2) * 10}%;height:9px`}></span></span><span></span></div>`);

/** The one state block in the rows' place: the glyph, a title, one line, at most one action. `live` false where the page has its own
 *  live region saying it (the palette's). */
export const Block = ({b, onAction, live = true}) => html`<div class=${`dk-state dp-state${b.warn ? ' bad' : ''}`} role=${live ? (b.warn ? 'alert' : 'status') : null}>
  <div class="dk-tile"><${Glyph} name=${b.glyph} /></div><b>${b.title}</b>${b.line ? html`<p>${b.line}</p>` : null}
  ${b.action ? html`<div class="acts"><button type="button" class="dk-btn text" onClick=${onAction}>${b.action}</button></div>` : null}</div>`;

// ---- rows for bridge's own pages (projects, attention): documents, projects and plain lines --------------------------------------

/** items: [{id, document} | {id, project} | {id, glyph, title, sub}], each optionally with `sub` (its second line instead), `notes`
 *  ([{text, tone}] under its lines), `summary`, `href` (where a click goes), `badge` ({text, tone}: the trailing column) or `end`
 *  ({label, onClick}: a button there instead of the chip). opts: `current` (an id shown selected), `checkable` (a checkbox in each
 *  tile: `checked` ids, `onCheck(id, on)`), `onOpen(item, {page})`, `onSource(item)`, `loading` (placeholder rows, how many), `error`
 *  ({title, line, action, onAction}: the state block), `empty` ({title, line, glyph}). */
export function RowList({items = [], current = null, checkable = false, checked = [], onCheck, onOpen, onSource, loading = 0, error = null, empty = null}) {
  if (loading) return html`<div class="dp-rows dp-plain" aria-busy="true"><${Placeholders} n=${loading} /></div>`;
  if (error) return html`<${Block} b=${{glyph: 'warn', title: error.title, line: error.line ?? '', action: error.action ?? null, warn: true}} onAction=${error.onAction} />`;
  if (!items.length && empty) return html`<${Block} b=${{glyph: empty.glyph ?? 'document', title: empty.title, line: empty.line ?? ''}} />`;
  return html`<div class=${`dp-rows dp-plain${checkable ? ' checkable' : ''}`} role="list">${items.map(it => {
    const d = it.document, p = it.project;
    const row = d ? {kind: 'document', id: `doc:${d.id}`, result: {kind: 'document', title: d.title, document: d}, ...(it.reason ? {reason: it.reason} : {})}
      : p ? {kind: 'project', id: `project:${p.id}`, project: p} : null;
    const l = row ? lines(row) : {glyph: it.glyph ?? 'document', title: it.title ?? '', sub: '', subClass: ''};
    if (it.title != null && row) l.title = it.title;
    if (it.sub != null) l.sub = it.sub;
    const on = checked.includes(it.id), open = ev => { if (ev.target.closest('button, input, a')) return; onOpen?.(it, {page: ev.ctrlKey || ev.metaKey}); };
    return html`<div key=${it.id} class=${`dp-row${it.id === current ? ' sel' : ''}${on ? ' picked' : ''}${onOpen ? ' link' : ''}`} role="listitem" data-id=${it.id}
      onClick=${open} title=${l.tip || null}>
      <span class=${`dp-tile${l.accent || it.accent ? ' accent' : ''}`}><${Glyph} name=${l.glyph} size=${18} />${checkable ? html`<input type="checkbox" class="dp-check" aria-label="Select" checked=${on}
        onChange=${ev => onCheck?.(it.id, ev.target.checked)} />` : null}</span>
      <span class="dp-lines"><span class="dp-title">${l.title}</span>${l.sub ? html`<span class=${`dp-sub ${l.subClass ?? ''}`}>${l.sub}</span>` : null}
        ${it.notes?.length ? html`<span class="dp-notes">${it.notes.map(x => html`<span class=${`dp-note ${x.tone ?? ''}`}>${x.text}</span>`)}</span>` : null}
        ${it.summary ? html`<span class="dp-summary">${it.summary}</span>` : null}</span>
      <span class="dp-end">${it.end ? html`<button type="button" class="dk-btn" onClick=${ev => { ev.stopPropagation(); it.end.onClick(it); }}>${it.end.label}</button>`
        : it.badge ? html`<span class=${`dp-note ${it.badge.tone ?? ''}`}>${it.badge.text}</span>`
        : l.more ? html`<span class="dp-pill">${l.more}</span>`
        : l.source && d?.url ? html`<button type="button" class="dp-pill dp-src" title=${`Open in ${l.source}`} onClick=${ev => { ev.stopPropagation(); onSource?.(it); }}>${l.source} ↗</button>` : null}</span>
    </div>`;
  })}</div>`;
}

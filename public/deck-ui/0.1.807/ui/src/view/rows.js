import {statusTone} from '../status-tone.js';
import {collectionTarget} from '../collection-target.js';
import {age, dateText, dateTimeText, eventTitle, fieldLabel, isAddress, joinText, personLine, placeName, plural, sentence, uniqueText} from '../format.js';
import {PageState, StateBlock} from './page-state.js';
import {describeFailure} from '../failure.js';
// The palette's rows (palette SPEC.md, *Row anatomy*, *Row kinds*): one grid for every kind (tile, two lines, one trailing item),
// built from the model's rows: Recent (text, link, image with its thumbnail, file; age over the peer chip), commands with their key,
// house actions by domain (accent when on), the House row, Ask, identifiers (mono values), links, documents (docGlyph, docSubtitle,
// an order's `+n mails ›`), series (span and count, then the member chips that fit, the focused one in view, `+k`), clusters,
// answers and none rows (bridge's lines), and citations (`[n]`). Selected, confirming and copied rows; the source chip and the group
// affordance as their own buttons. Also the section labels (`FOUND · searching…`, `All n ›`, Recent's Clear), placeholder rows, the state block, and `RowList`: plain rows for
// bridge's own pages (clusters, attention) from documents and clusters.
import {h} from '../../vendor/preact.mjs';
import {useLayoutEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import * as model from '../../../palette/model.mjs';
import {Glyph} from '../glyphs.js';
import {size} from '../viewer.js';
import {keycap} from './keys.js';
import {formatQuantity, toneOf} from '../quantity.js';
import {Delta} from './stat-tiles.js';
import {describeRepeat, dueText, newYork, whenText} from '../flightplan.js';
import {verdictTone} from '../projects.js';
import {collectionText, useCollectionPage, CollectionSearch, CollectionPager} from './collection-page.js';

const html = htm.bind(h);


/** A document's second line as rows show it: the model's `docSubtitle` read as words, its type or `reason` in sentence case
 *  (`Invoice · Jun 24, 2025`, `Receipt that day`), a year the title already says left out (`2024 tax return` over `Tax return`). */
export function docLine(d = {}, reason = null) {
  if (d.order) return model.docSubtitle(d);
  const year = /^\d{4}$/.test(d.period ?? '') && String(d.title ?? '').includes(d.period);
  return model.docSubtitle(year ? {...d, period: null, date: null} : d, reason ? sentence(reason) : d.type ? fieldLabel(d.type) : null);
}

/** A section's label by its rows' kind (the Needs you and House rows have none). */
export const sectionOf = kind => ({needs: '', house: '', capture: 'ADD A TODO', choice: 'WHICH ONE?', code: 'CODES', ask: 'ASK', command: 'COMMANDS', action: 'ACTIONS', recent: 'RECENT', citation: 'SOURCES', collection: 'COLLECTIONS'})[kind] ?? 'FOUND';

/** An open group's label: its section's, else its documents counted (`14 DOCUMENTS · 2 ALTERNATES`). */
export function scopeLabel(key, list) {
  if (key === 'section:actions') return 'ACTIONS';
  if (key === 'section:needs') return 'NEEDS YOU';
  if (key === 'section:recent') return 'RECENT';
  if (key.startsWith('snooze:')) return 'SNOOZE UNTIL';
  if (key.startsWith('topic:')) return plural(list.length, 'ACCOUNT', 'ACCOUNTS');
  if (key.startsWith('day:')) return plural(list.length, 'EVENT', 'EVENTS');
  if (key.startsWith('event:')) {
    const people = list.filter(r => r.kind === 'person' || r.kind === 'none').length, docs = list.length - people;
    return joinText([plural(people, 'ATTENDEE', 'ATTENDEES'), plural(docs, 'DOCUMENT', 'DOCUMENTS')]);
  }
  if (key.startsWith('trips:')) return plural(list.length, 'TRIP', 'TRIPS');
  if (key.startsWith('tally:')) return plural(list.length, 'ORDER', 'ORDERS');
  if (key.startsWith('area:')) return [['cluster', 'CLUSTER', 'CLUSTERS'], ['series', 'SERVICE', 'SERVICES']]
    .map(([k, one, more]) => { const n = list.filter(r => r.kind === k).length; return n ? plural(n, one, more) : null; }).filter(Boolean).join(' · ');
  const alt = list.filter(r => r.alternateOf).length, other = list.filter(r => r.kind === 'identifier' || r.kind === 'link').length, n = list.length - alt - other;
  return joinText([plural(n, 'DOCUMENT', 'DOCUMENTS'), alt ? plural(alt, 'ALTERNATE', 'ALTERNATES') : null, other ? plural(other, 'NUMBER OR LINK', 'NUMBERS AND LINKS') : null]);
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

/** Calendar dates in display copy, using the palette's shared date labels. */
export const readableDates = text => text.replace(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?\b/g, d => dateText(d.slice(0, 10)));

/** What a row shows, no DOM: {glyph, accent (the glyph in accent), thumb (a resource path), prefix, title, titleClass (mono), lines
 *  (title lines: 2 for Recent text), dot (a tone: a dot before the title), sub, subClass (mono, soft, accent), source (the chip's name), more (the group affordance), key
 *  (a command's), button (a trailing button's label: a click is Enter on the row), age, peer: {text, dir}, tip}. `n` a citation's
 *  number; `now` the time the ages are from. */
export function lines(row, options = {}) {
  const out = rowLines(row, options);
  for (const key of ['sub', 'tip']) out[key] = readableDates(out[key]);
  return out;
}

function rowLines(row, {n = 0, mod = 'Control', now = Date.now()} = {}) {
  const out = {glyph: 'document', accent: false, thumb: null, prefix: '', title: '', titleClass: '', lines: 1, sub: '', subClass: '', source: null, more: null, key: null, button: null, age: null, peer: null, tip: ''};
  switch (row.kind) {
    case 'code': {
      // a one-time code (SPEC.md, *Codes*): the code in mono over who sent it and how long ago; the Copy button is Enter
      const c = row.code, from = c.from || 'a text';
      return {...out, glyph: 'key', accent: true, title: String(c.code), titleClass: 'mono', sub: `${from} · ${age(c.at, now)}`, button: 'Copy', tip: `Code from ${from}\nEnter copies it`};
    }
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
      const when = i.at ? dateTimeText(i.at) : '';
      out.tip = `${i.kind === 'file' && i.path ? i.path : i.kind === 'text' ? String(i.preview ?? '').slice(0, 600) : out.title}\n${i.direction === 'sent' ? 'Sent to' : 'Received from'} ${(i.peers ?? []).join(', ')}${when ? ` · ${when}` : ''}`;
      return out;
    }
    case 'action': {
      const a = row.action, look = actionLook(a);
      // its kind and state as words (`Lock · Locked`), not the house's raw states
      Object.assign(out, {glyph: look.glyph, accent: look.on, title: a.title, sub: joinText(String(a.subtitle || a.state || '').split(' · ').map(sentence))});
      out.tip = [a.title, out.sub, model.actionNeedsConfirmation(a) ? 'Asks before it runs' : null].filter(Boolean).join('\n');
      return out;
    }
    case 'todo': case 'task': case 'epic': {
      // a flightplan item (SPEC.md, *Flightplan in Find*): its facts in words; Done (Enter) and, while open, Snooze (Tab: its choices)
      const r = row.result, open = !['done', 'dropped'].includes(row.item.status);
      return {...out, glyph: row.kind === 'epic' ? 'series' : 'todo', title: r.title, sub: r.subtitle ?? '', tip: [r.title, r.subtitle].filter(Boolean).join('\n'),
        buttons: [...(open ? [{label: 'Done', group: false, tip: 'Done (Enter)'}] : []), ...(r.snooze?.length ? [{label: 'Snooze', group: true, tip: 'Snooze (Tab)'}] : [])]};
    }
    // a project (SPEC.md, *Flightplan in Find*): its verdict a dot before its title, the rest of flightplan's line under it
    case 'collection': return {...out, glyph: 'series', title: row.collection.label, sub: 'Collection', button: 'Open', tip: `Open ${row.collection.label}`};
    case 'project': return {...out, glyph: 'series', dot: verdictTone(row.project.verdict), title: row.result.title, sub: row.result.subtitle ?? '',
      tip: row.project.line ?? row.result.title};
    case 'snooze': return {...out, glyph: 'recent', title: row.result.title, sub: row.result.subtitle ?? '', tip: `Snooze until ${row.result.title.toLowerCase()}, ${row.result.subtitle}`};
    case 'capture': {
      // `todo <text>` (SPEC.md, *Capture*): flightplan's reading of it, Add; a reading that asks which one says so (its choices below)
      const p = row.preview, today = newYork(now).day;
      const facts = p ? [p.due ? dueText(p.due, today) : null, p.repeat ? `↻ ${describeRepeat(p.repeat)}` : null, p.remind ? `Reminds ${whenText(p.remind)}` : null].filter(Boolean).join(' · ') : '';
      const sub = row.error ?? (row.ask ? `“${row.ask.text}” reads more than one way: pick one` : p ? facts || 'No date' : 'Reading…');
      return {...out, glyph: 'todo', accent: true, title: p?.title || row.text, sub, subClass: row.error ? 'bad' : '', ...(row.ask || row.busy ? {} : {button: 'Add'}), tip: [p?.title || row.text, sub].join('\n')};
    }
    case 'choice': return {...out, glyph: 'day', title: row.choice.label, sub: row.text, button: 'Add', tip: `Add “${row.text}”: ${row.choice.label}`};
    case 'needs': return {...out, glyph: 'warn', warn: true, title: 'Needs you', more: `${row.count} ›`, tip: 'What only you can fix to keep your data flowing (Enter or Tab shows it)'};
    case 'need': {
      // Needs describe the problem; action payloads stay out of the row and its tooltip.
      const n = row.need, a = n.action ?? {};
      const sub = n.detail || joinText([model.sourceName(n.source), n.since ? `since ${dateText(String(n.since).slice(0, 10))}` : null]);
      return {...out, glyph: 'warn', warn: true, title: n.title, sub, subClass: '', tip: [n.title, n.detail, a.label].filter(Boolean).join('\n')};
    }
    case 'house': return {...out, glyph: 'house', title: 'House', more: `${plural(row.count, 'action')} ›`, tip: 'House actions (Enter or Tab shows them)'};
    case 'command': return {...out, glyph: row.id === 'note' ? 'document' : row.id === 'receive' ? 'receive' : row.id === 'share' ? 'share' : 'send', title: row.title, key: row.key ? keycap(row.key, mod) : null};
    case 'ask': return {...out, glyph: 'ask', accent: true, title: 'Ask', sub: row.query, subClass: 'soft', tip: row.query};
    case 'citation': {
      const ct = row.citation, quote = String(ct.quote ?? '').replace(/\s+/g, ' ').trim();
      Object.assign(out, {glyph: model.docGlyph({source: ct.source, type: ct.type}), prefix: n ? `[${n}]` : '', title: ct.title || 'Untitled',
        sub: joinText([dateText(ct.date), quote ? `“${quote}”` : null]), source: model.sourceName(ct.source) ?? 'Source'});
      out.tip = [out.title, out.sub].filter(Boolean).join('\n');
      return out;
    }
    case 'series': {
      const l = model.seriesLines(row.series);
      return {...out, glyph: 'series', title: l.title, sub: l.subtitle, more: `${row.series.count ?? row.series.members.length} ›`, tip: `${l.title}\n${l.subtitle}`};
    }
    case 'thing': {
      const t = row.thing, sub = row.result.subtitle ?? '', n = t.documents?.length ?? 0;
      return {...out, glyph: t.type === 'plant' ? 'plant' : 'thing', title: row.result.title || t.name, sub, more: collectionTarget(row) ? 'Details ›' : model.groupOf(row) ? `${n} ›` : null, tip: `${row.result.title || t.name}\n${sub}`};
    }
    case 'event': {
      // date · time · the place's name (never its street, suite and ZIP); a booking's long title as its kind and provider, the whole
      // title the tooltip
      const e = row.event, full = row.result.title ?? '', g = model.groupOf(row);
      const sub = joinText(String(row.result.subtitle ?? '').split(' · ').map(p => p === e.place || isAddress(p) ? placeName(p) : p));
      return {...out, glyph: 'day', title: eventTitle(full), sub, more: g ? `${g.rows.length} ›` : null, tip: joinText([full, row.result.subtitle], '\n')};
    }
    case 'day': {
      const title = row.result.title, sub = row.result.subtitle ?? '';
      return {...out, glyph: 'day', title, sub, more: `${row.day.count} ›`, tip: `${title}\n${sub}`};
    }
    case 'person': case 'trip': {
      // People open the shared profile; trips retain their confirmation and document group.
      // a person reads as on the People page (personLine: the relation in words, then organisation, role, last contact, documents);
      // each part once (bridge's line may start with the relation too)
      const e = row[row.kind], sub = row.kind === 'person' ? uniqueText([personLine(e), row.result.subtitle])
        : uniqueText([e.relation, e.documentCount != null ? plural(e.documentCount, 'document') : null, e.organisation, e.lastContact ? `Last contact ${e.lastContact}` : null, row.result.subtitle]), n = e.documentCount ?? ((e.ids?.length ?? 0) + (e.documents?.length ?? 0)), title = row.result.title || e.name;
      return {...out, glyph: row.kind, title, sub, more: row.kind === 'person' ? 'Profile ›' : model.groupOf(row) ? `${n} ›` : null, tip: `${title}\n${sub}`};
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
        ...(collectionTarget(row) ? {more: 'Details ›'} : n != null ? {more: `${n} ›`} : {}),
        tip: [r.title, r.subtitle, d?.title ? `From ${d.title}` : null].filter(Boolean).join('\n')};
    }
    case 'cluster': {
      const l = model.clusterLines({...row.cluster, count: null});
      l.subtitle = [l.subtitle, row.cluster.count != null ? plural(row.cluster.count, 'document') : null].filter(Boolean).join(' · ');
      return {...out, glyph: 'cluster', title: l.title, sub: l.subtitle, more: 'Details ›', tip: [l.title, l.subtitle, row.cluster.summary].filter(Boolean).join('\n')};
    }
  }
  // identifier, link, document (a group's member too)
  const r = row.result ?? {}, d = r.document;
  out.title = r.title || d?.title || 'Untitled';
  if (row.kind === 'identifier') Object.assign(out, {glyph: 'key', sub: String(r.value ?? ''), subClass: PLAIN.test(String(r.value ?? '')) ? 'mono' : 'soft'});
  else if (row.kind === 'link') Object.assign(out, {glyph: 'link', accent: true, sub: strip(r.value), subClass: 'accent'});
  else {
    out.glyph = model.docGlyph(d);
    out.sub = row.alternateOf ? joinText([`Alternate of ${row.alternateOf}`, d?.type && fieldLabel(d.type)]) : docLine(d ?? {}, row.reason ?? null);
    if (!out.sub) out.sub = r.subtitle ?? '';
    if (d?.mails?.length) out.more = `+${plural(d.mails.length, 'mail')} ›`;
  }
  if (!out.more && d) out.source = model.sourceName(d.source) ?? 'Source';
  out.tip = [out.title, out.sub, (row.kind === 'identifier' || row.kind === 'link') && d?.title ? `From ${d.title}` : null].filter(Boolean).join('\n');
  return out;
}

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

/** One row. act: {select, open, group, chip, source, menu, drag, confirm(yes)} (the palette's), mod; `confirm`: a pending confirmation's
 *  verb (its buttons in the trailing column). */
export function Row({row, n = 0, selected = false, confirm = null, copied = false, focus = null, act, mod, host, rowId, needAnswer = false}) {
  const touch = useRef(null);
  const l = lines(row, {n, mod});
  // the phone landing's need: the row is its action (a tap opens it), its chevron named for the action
  if (needAnswer && row.kind === 'need') {
    const a = row.need.action;
    if (a && ['url', 'op', 'command'].includes(a.kind)) l.go = a.label || {url: 'Open', op: 'Run', command: 'Copy'}[a.kind];
  }
  const drag = act.dragOf?.(row.id);
  const thumb = l.thumb && host?.caps.recent ? host.resource(l.thumb) : null;
  return html`<div class=${`dp-row${selected ? ' sel' : ''}${confirm ? ' confirm' : ''}`} role="option" id=${rowId} data-id=${row.id} data-kind=${row.kind}
    aria-selected=${selected ? 'true' : 'false'} title=${l.tip || null} draggable=${drag ? 'true' : null}
    data-chips=${row.kind === 'series' ? JSON.stringify(model.seriesLines(row.series).chips.map(c => c.label)) : null}
    data-chip=${row.kind === 'series' ? (focus ?? '') : null}
    onClick=${ev => { if (!ev.target.closest('button')) (row.kind === 'collection' ? act.open : act.select)(row.id); }}
    onDblClick=${ev => { if (row.kind !== 'collection' && !ev.target.closest('button')) act.open(row.id); }}
    onTouchStart=${ev => { touch.current = act.swipe && row.kind === 'recent' && ev.touches.length === 1 && !ev.target.closest('button') ? {x: ev.touches[0].clientX, y: ev.touches[0].clientY} : null; }}
    onTouchCancel=${() => { touch.current = null; }}
    onTouchEnd=${ev => {
      const start = touch.current; touch.current = null;
      const end = ev.changedTouches[0];
      if (start && end && Math.abs(end.clientX - start.x) > 72 && Math.abs(end.clientY - start.y) < 32) {
        ev.preventDefault(); act.swipe(row.id);
      }
    }}

    onContextMenu=${ev => act.menu?.(ev, row.id)}
    onDragStart=${ev => act.drag?.(ev, row.id, drag)}>
    <span class=${`dp-tile${l.accent ? ' accent' : ''}${l.warn ? ' warn' : ''}${thumb ? ' thumb' : ''}`}>${thumb
      ? html`<img src=${thumb} alt="" loading="lazy" draggable="false" onError=${ev => { ev.target.remove(); }} />` : null}<${Glyph} name=${l.glyph} size=${18} /></span>
    <span class="dp-lines">
      <span class=${`dp-title${l.lines > 1 ? ' two' : ''}${l.titleClass ? ` ${l.titleClass}` : ''}`}>${l.dot ? html`<span class=${`dp-dot dot-${l.dot}`} aria-hidden="true"></span>` : null}${l.prefix ? html`<span class="dp-n">${l.prefix}</span>` : null}${l.title}</span>
      ${row.kind === 'series' ? html`<span class="dp-sub dp-serieslines"><span class="dp-span">${l.sub}</span><${SeriesChips} row=${row} focus=${focus} act=${act} /></span>`
        : l.sub ? html`<span class=${`dp-sub ${l.subClass}`}>${l.sub}</span>` : null}
    </span>
    <span class="dp-end">${confirm ? html`<span class="dp-acts dp-confirm">
        <button type="button" tabindex="-1" class="dp-pill dp-act dp-yes" title=${`${confirm} (Enter)`} onClick=${ev => { ev.stopPropagation(); act.confirm?.(true); }}>${confirm}</button>
        <button type="button" tabindex="-1" class="dp-pill dp-act" title="Cancel (Esc)" onClick=${ev => { ev.stopPropagation(); act.confirm?.(false); }}>Cancel</button></span>`
      : copied ? html`<span class="dp-copied"><${Glyph} name="check" size=${14} /> Copied</span>`
      : l.buttons?.length ? html`<span class="dp-acts">${l.buttons.map(b => html`<button key=${b.label} type="button" tabindex="-1" class="dp-pill dp-act" title=${b.tip}
          onClick=${ev => { ev.stopPropagation(); (b.group ? act.group : act.open)(row.id); }}>${b.label}</button>`)}</span>`
      : l.button ? html`<button type="button" tabindex="-1" class="dp-pill dp-act" title=${`${l.button} (Enter)`} onClick=${ev => { ev.stopPropagation(); act.open(row.id); }}>${l.button}</button>`
      : l.go ? html`<button type="button" tabindex="-1" class="dp-go" aria-label=${l.go} title=${`${l.go} (Enter)`} onClick=${ev => { ev.stopPropagation(); act.open(row.id); }}><${Glyph} name="next" size=${16} /></button>`
      : l.more ? html`<button type="button" tabindex="-1" class="dp-pill" title=${collectionTarget(row) ? `${row.kind === 'person' ? 'Profile' : 'Details'} (Tab)` : 'Show all (Tab)'} onClick=${ev => { ev.stopPropagation(); act.group(row.id); }}>${l.more}</button>`
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

/** The controller's state block in the rows' place (SPEC.md, *States*): the shared layout. `live` false where the page has its own live
 *  region saying it (the palette's). */
export const Block = ({b, onAction, live = true}) => html`<${StateBlock} glyph=${b.glyph} title=${b.title} line=${b.line} action=${b.action}
  href=${b.href} onAction=${onAction} warn=${!!b.warn} status=${!!b.warn} live=${live} />`;

// ---- rows for bridge's own pages (clusters, attention): documents, clusters and plain lines --------------------------------------

const rowText = item => [collectionText(item), collectionText(item.document), collectionText(item.cluster), item.sub,
  ...(item.notes ?? []).map(note => note.text), item.badge?.text].join(' ');

/** items: [{id, document} | {id, cluster} | {id, glyph, title, sub}], each optionally with `sub` (its second line instead), `tip` (the
 *  whole text: the row's title and accessible name), `oneLine` (its lines never wrap, a phone's too: cut with an ellipsis), `age` (when, the
 *  trailing meta), `notes`
 *  ([{text, tone}] under its lines), `summary`, `href` (where a click goes), `quantity` (the trailing figure: a quantity.js quantity,
 *  tabular, in its tone — `money(-42.5)` for a ledger; with `delta` a second line under it), `badge` ({text, tone}: the trailing
 *  column) or `end` ({label, onClick}: a button there instead of the chip); `glyph: null` shows no tile and `dot` (a tone or category
 *  name: accent, ok, warn, bad, sent, received, muted) a small dot instead; `section` ({key, label}, quantity.js `dateSection`):
 *  consecutive items with one key sit under a sticky heading, with `sectionTotal(items, section)` (a quantity or null) at its right.
 *  opts: `current` (an id shown selected), `checkable` (a checkbox in each
 *  tile: `checked` ids, `onCheck(id, on)`), `onOpen(item, {page})`, `onSource(item)` (a document's source chip opens its source; without it, no chip), `loading` (placeholder rows, how many), `error`
 *  ({backend, error: HostError, title, action, onAction}: failure copy and recovery; backend defaults to bridge), `empty` ({title, line, glyph}),
 *  `items` left out until the first answer (loading until then), `warming` (keep last rows visible), `card` (a collection page's list: its rows in the shared list card), `inline` (states in a section's place: a drawer's, a page section's), `host` (native recovery links), `search` (true or a filter label: collection-page.js `CollectionSearch`, past one page or 20 rows; omit for lists already
 *  filtered by their collection page or a page's own search). */
export function RowList({search = false, ...opts}) {
  const error = opts.error?.error ?? opts.error;
  // no `items` yet is no answer yet: loading, never an empty state before the first answer
  const state = opts.warming || error?.state === 'warming' ? 'warming' : (opts.loading || opts.items === undefined) && !opts.items?.length ? 'loading'
    : !opts.items?.length && opts.empty ? 'empty' : undefined;
  const content = search ? html`<${SearchableRows} ...${opts} warming=${state === 'warming'} label=${typeof search === 'string' ? search : 'Search collection'} />`
    : html`<${PlainRows} ...${opts} />`;
  if (!state && !error) return content;
  // loading a list: placeholder rows where its rows will be (`loading` how many), not a block of lines
  if (state === 'loading' && !error && typeof opts.loading === 'number') return html`<div class=${`dp-rows dp-plain${opts.card ? ' card' : ''}`} aria-busy="true" aria-label="Loading">
    <${Placeholders} n=${opts.loading} /><span class="dk-sr" role="status">Loading…</span></div>`;
  return html`<${PageState} state=${state} error=${error?.state === 'warming' ? null : error} backend=${opts.error?.backend ?? 'bridge'} inline=${opts.inline}
    hasData=${!!opts.items?.length} host=${opts.host} title=${error ? opts.error?.title : opts.empty?.title} hint=${opts.empty?.line} glyph=${error ? undefined : opts.empty?.glyph}
    retry=${opts.error?.onAction}>
    ${content}
  <//>`;
}

function SearchableRows({items = [], label, ...opts}) {
  const page = useCollectionPage(items, {textOf: rowText});
  return html`<div class="dp-searchable"><${CollectionSearch} page=${page} label=${label} />
    <${PageState} state=${!opts.warming && !page.items.length ? 'empty' : undefined} inline=${opts.inline} title=${page.query ? 'No matches' : opts.empty?.title}
      hint=${page.query ? 'Try another search.' : opts.empty?.line}><${PlainRows} ...${opts} items=${page.items} /><//>
    <${CollectionPager} page=${page} /></div>`;
}

function PlainRows({items = [], current = null, checkable = false, checked = [], onCheck, onOpen, onSource, sectionTotal, card = false}) {
  const one = it => {
    const d = it.document, p = it.cluster;
    const row = d ? {kind: 'document', id: `doc:${d.id}`, result: {kind: 'document', title: d.title, document: d}, ...(it.reason ? {reason: it.reason} : {})}
      : p ? {kind: 'cluster', id: `cluster:${p.id}`, cluster: p} : null;
    const l = row ? lines(row) : {glyph: it.glyph ?? 'document', title: it.title ?? '', sub: '', subClass: ''};
    if (it.title != null && row) l.title = it.title;
    if (it.sub != null) l.sub = it.sub;
    const on = checked.includes(it.id), open = ev => { if (ev.target.closest('button, input, a')) return; onOpen?.(it, {page: ev.ctrlKey || ev.metaKey}); };
    const bare = !row && it.glyph === null && !checkable;
    return html`<div key=${it.id} class=${`dp-row${it.id === current ? ' sel' : ''}${on ? ' picked' : ''}${onOpen ? ' link' : ''}${it.quantity ? ' qty' : ''}${bare ? ' bare' : ''}${it.oneLine ? ' one' : ''}`} role="listitem" data-id=${it.id}
      onClick=${open} tabindex=${onOpen ? 0 : null} onKeyDown=${ev => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === ev.currentTarget) { ev.preventDefault(); onOpen?.(it, {page: ev.metaKey || ev.ctrlKey}); } }} title=${it.tip || l.tip || null} aria-label=${it.tip || null}>
      ${bare ? (it.dot ? html`<span class=${`dp-dot dot-${it.dot}`} aria-hidden="true"></span>` : html`<span></span>`)
        : html`<span class=${`dp-tile${l.accent || it.accent ? ' accent' : ''}`}><${Glyph} name=${l.glyph} size=${18} />${checkable ? html`<input type="checkbox" class="dp-check" aria-label="Select" checked=${on}
        onChange=${ev => onCheck?.(it.id, ev.target.checked)} />` : null}</span>`}
      <span class="dp-lines"><span class="dp-title">${!bare && it.dot ? html`<span class=${`dp-dot dot-${it.dot}`} aria-hidden="true"></span>` : null}${l.title}</span>${l.sub ? html`<span class=${`dp-sub ${l.subClass ?? ''}`}>${l.sub}</span>` : null}
        ${it.notes?.length ? html`<span class="dp-notes">${it.notes.map(x => html`<span class=${`dp-note ${x.tone ?? statusTone(x.text)}`} title=${x.text}>${x.text}</span>`)}</span>` : null}
        ${it.summary ? html`<span class="dp-summary">${it.summary}</span>` : null}</span>
      <span class="dp-end">${it.end ? html`<button type="button" class="dp-pill dp-act" disabled=${it.end.disabled} onClick=${ev => { ev.stopPropagation(); it.end.onClick(it); }}>${it.end.label}</button>`
        : it.quantity ? html`<span class="dp-figure"><span class=${`dp-qty tone-${toneOf(it.quantity)}`}>${formatQuantity(it.quantity)}</span>${it.delta ? html`<${Delta} d=${it.delta} />` : null}</span>`
        : it.badge ? html`<span class=${`dp-note ${it.badge.tone ?? statusTone(it.badge.text)}`} title=${it.badge.text}>${it.badge.text}</span>`
        : it.age ? html`<span class="dp-age"><span>${it.age}</span></span>`
        : l.more ? html`<span class="dp-pill">${l.more}</span>`
        : l.source && d?.url && onSource ? html`<button type="button" class="dp-pill dp-src" title=${`Open in ${l.source}`} onClick=${ev => { ev.stopPropagation(); onSource(it); }}>${l.source} ↗</button>` : null}</span>
    </div>`;
  };
  const sections = [];
  for (const it of items) {
    const last = sections.at(-1);
    if (last && it.section && last.section?.key === it.section.key) last.items.push(it); else sections.push({section: it.section ?? null, items: [it]});
  }
  const kind = `${checkable ? ' checkable' : ''}${card ? ' card' : ''}`;
  if (!sections.some(g => g.section)) return html`<div class=${`dp-rows dp-plain${kind}`} role="list">${items.map(one)}</div>`;
  return html`<div class=${`dp-rows dp-plain dp-sectioned${kind}`}>${sections.map((g, i) => {
    const total = g.section && sectionTotal ? sectionTotal(g.items, g.section) : null;
    return html`<section key=${g.section?.key ?? `s${i}`} class="dp-sec" aria-label=${g.section?.label ?? null}>
      ${g.section ? html`<h3 class="dp-sechead"><span>${g.section.label}</span>${total ? html`<span class=${`dp-qty tone-${toneOf(total)}`}>${formatQuantity(total)}</span>` : null}</h3>` : null}
      <div role="list">${g.items.map(one)}</div></section>`;
  })}</div>`;
}

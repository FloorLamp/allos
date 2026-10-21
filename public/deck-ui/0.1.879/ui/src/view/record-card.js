// The record card (palette SPEC.md, *Record card*; contract/collections.md): one compact record wherever a record opens in place: a
// collection page's row expanded, Find's selected record, the person card. Its parts, each only when it has something: copy chips, a
// two-column fact grid, the photos Find found of it (photo-strip.js CardPhotos), live state, up to five items grouped (repeats folded
// into one item with a count), the actions and Open (the full record view). Nothing is said for what is missing: an empty part is left
// out.
import {h, createContext} from '../../vendor/preact.mjs';
import {useContext, useEffect, useLayoutEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Glyph} from '../glyphs.js';
import {Avatar} from './avatar.js';
import {formatQuantity, toneOf} from '../quantity.js';
import {countText, dateText, readableDates} from '../format.js';
import {StatTiles} from './stat-tiles.js';
import {CardStrip} from './photo-strip.js';
import {EntityNav, LinkStops, useLinkable} from './entity-link.js';
import {siteUrl} from '../flightplan-paths.js';
const html = htm.bind(h);

/** Items alike enough to be one (the same title and the same date as shown) folded into the first of them, newest kept to open:
 *  `{...newest, count, members}` (members newest first) for a repeat, the item itself otherwise; the first one's place is kept. */
export function foldRepeats(items = [], {key = it => `${it.title ?? ''}\n${dateText(it.date)}`} = {}) {
  const groups = new Map();
  for (const it of items) {
    const k = key(it);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  return [...groups.values()].map(members => {
    if (members.length === 1) return members[0];
    const sorted = [...members].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
    return {...sorted[0], count: members.length, members: sorted};
  });
}

/** How many of each group's items show, `limit` in all: every group its first item, then the rest in order, a group never past its own
 *  `max`. */
export function budget(groups, limit) {
  const most = g => Math.min(g.items.length, g.max ?? Infinity);
  const shown = groups.map(g => Math.min(most(g), 1));
  let left = limit - shown.reduce((a, b) => a + b, 0);
  for (let i = 0; i < groups.length && left > 0; i++) {
    const more = Math.min(most(groups[i]) - shown[i], left);
    shown[i] += more; left -= more;
  }
  return shown;
}

const stopProps = stops => stops ? {tabindex: '-1', 'data-stop': ''} : {};
/** Inside Find's selected record: the card's controls are the palette's Tab stops (`data-stop`), out of the page's tab order, and
 *  its row's own `Open ›` is the card's Open (none repeated at its foot). */
export const CardStops = createContext(null);
const IN_ROW = {row: true};

/** An item that is a record (`link`: entity-link.js's {kind, id}; `host` for a person's) is a link to its page: a plain click still
 *  `onOpen` (a document in the page's own viewer), a middle or modified click its page; on a desktop the palette's pane (`EntityNav`). */
function Item({it, stops}) {
  const [open, setOpen] = useState(false), nav = useContext(EntityNav);
  const href = useLinkable(it.link ?? null, it.host ?? nav?.host);
  // a document's title as Find's row says it (a date in words)
  const title = html`<span class="dp-itemtitle">${typeof it.title === 'string' ? readableDates(it.title) : it.title}</span>`;
  const body = html`${it.tile ?? html`<${Glyph} name=${it.glyph ?? 'document'} size=${14} />`}${it.sub ? html`<span class="dp-itemlines">${title}<span class="dp-itemsub">${it.sub}</span></span>` : title}${it.when ? html`<span class="dp-itemwhen">${it.when}</span>` : null}`;
  const cls = `dp-carditem${it.tile ? ' tiled' : ''}`;
  const plain = ev => ev.button === 0 && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey;
  const main = href ? html`<a class=${cls} href=${nav ? siteUrl(href) : href} title=${it.title} data-entity=${it.link.kind} ...${stopProps(stops)}
      onClick=${ev => { ev.stopPropagation(); if (nav) { ev.preventDefault(); nav.open(it.link, href); } else if (it.onOpen && plain(ev)) { ev.preventDefault(); it.onOpen(it); } }}
      onAuxClick=${ev => { ev.stopPropagation(); if (nav) { ev.preventDefault(); nav.open(it.link, href); } }}>${body}</a>`
    : it.onOpen ? html`<button type="button" class=${cls} title=${it.title} ...${stopProps(stops)} onClick=${ev => { ev.stopPropagation(); it.onOpen(it); }}>${body}</button>`
    // a record with no page (an address bridge gives no id), or an item that opens nothing: named, nothing to press
    : html`<span class=${`${cls} still`} title=${it.title}>${body}</span>`;
  if (!it.count) return html`<li>${main}</li>`;
  return html`<li class="dk-card-repeat">${main}<button type="button" class="dp-chip dk-card-count" aria-expanded=${open ? 'true' : 'false'}
      aria-label=${open ? `Hide the ${it.count} copies` : `Show all ${it.count}`} title=${`${it.count} alike: the same title and date`} ...${stopProps(stops)}
      onClick=${ev => { ev.stopPropagation(); setOpen(!open); }}>×${it.count}</button>
    ${open ? html`<ul class="dk-card-members">${it.members.map(m => html`<${Item} key=${m.id} it=${{...m, count: 0, when: m.when ?? it.when, onOpen: it.onOpen}} stops=${stops} />`)}</ul>` : null}</li>`;
}

/** chips [{label, value, glyph}] copied with `onCopy(value)`; facts [{label, value | quantity}] (a value may be an `EntityLink`);
 *  live {label, meta, tiles, facts}; groups [{key, title, items: [{id, title, sub?, when?, date?, glyph? | tile? (a node in the glyph's
 *  place: a product's picture), onOpen?, link?}], total?, max?}] (folded, then `limit` items in all, each group at most its `max`, a
 *  group past its share saying `All n ›`: Open; an item with no `onOpen` or `link` opens nothing); actions [{label, onClick, primary?,
 *  expanded?}]; `onOpen` the full view (`openLabel`); `stops`: the palette's card, whose controls Tab steps through (`data-stop`, out of
 *  the page's tab order); `children` the record's own body (a note); `after` what an action unfolds, under the actions (a person's face
 *  picker). */
export function RecordCard({label, chips = [], onCopy, facts = [], live = null, groups = [], actions = [], onOpen, openLabel = 'Open', limit = 5, stops: own = false, children = null, after = null, loading = false}) {
  const inRow = useContext(CardStops), stops = !!inRow || own;
  const [copied, setCopied] = useState(null);
  useEffect(() => { if (copied == null) return undefined; const t = setTimeout(() => setCopied(null), 1200); return () => clearTimeout(t); }, [copied]);
  const known = facts.filter(f => f && (f.quantity || (f.value != null && f.value !== '')));
  const liveFacts = (live?.facts ?? []).filter(f => f.value != null && f.value !== ''), liveTiles = live?.tiles ?? [];
  const folded = groups.map(g => ({...g, items: foldRepeats(g.items)})).filter(g => g.items.length);
  const shown = budget(folded, limit);
  const buttons = [...actions.filter(Boolean), ...(onOpen && !inRow ? [{label: `${openLabel} ›`, onClick: onOpen, primary: true, title: 'The whole record'}] : [])];
  return html`<${LinkStops.Provider} value=${stops}><div class="dk-record-card" role="group" aria-label=${label ?? null} aria-busy=${loading ? 'true' : null}>
    ${chips.length ? html`<div class="dp-cardfacts" role="group" aria-label="Copy details">${chips.map((f, i) => html`<button key=${f.label} type="button" ...${stopProps(stops)}
      class=${`dp-chip dp-cardfact${copied === i ? ' copied' : ''}`} title=${`Copy ${f.label.toLowerCase()}: ${f.value}`} aria-label=${`Copy ${f.label.toLowerCase()} ${f.value}`}
      onClick=${ev => { ev.stopPropagation(); Promise.resolve(onCopy?.(f.value)).then(() => setCopied(i), () => {}); }}>
      <${Glyph} name=${copied === i ? 'check' : f.glyph ?? 'copy'} size=${12} /><span>${copied === i ? 'Copied' : f.value}</span></button>`)}</div>` : null}
    ${known.length ? html`<dl class="dk-card-facts">${known.map((f, i) => html`<div key=${i}><dt>${f.label}</dt>
      <dd class=${f.quantity ? `tone-${toneOf(f.quantity)}` : null}>${f.quantity ? formatQuantity(f.quantity) : f.value}</dd></div>`)}</dl>` : null}
    <${CardStrip} stops=${stops} />
    ${liveTiles.length || liveFacts.length ? html`<section class="dk-card-live" aria-label=${live.label ?? 'Live state'}>
      <div class="dk-card-head"><span>${live.title ?? 'Live'}</span>${live.meta ? html`<span class="dk-card-meta">${live.meta}</span>` : null}</div>
      ${liveTiles.length ? html`<${StatTiles} compact tiles=${liveTiles} label=${live.tilesLabel ?? 'Live figures'} />` : null}
      ${liveFacts.length ? html`<dl class="dk-card-facts">${liveFacts.map((f, i) => html`<div key=${i}><dt>${f.label}</dt><dd>${f.value}</dd></div>`)}</dl>` : null}
    </section>` : null}
    ${children}
    ${folded.map((g, i) => {
      // `All n ›` while the card lists fewer than the group holds (its items past its share, or more than bridge sent)
      const total = g.total ?? g.items.reduce((n, it) => n + (it.count || 1), 0), listed = g.items.slice(0, shown[i]).reduce((n, it) => n + (it.count || 1), 0);
      return html`<section key=${g.key ?? g.title} class="dk-card-group" aria-label=${g.label ?? g.title}>
        ${g.title ? html`<div class="dk-card-head"><span>${g.title}</span><span class="dk-card-meta">${countText(total)}</span>
          ${total > listed && onOpen ? html`<button type="button" class="dk-btn text dk-card-all" ...${stopProps(stops)} onClick=${ev => { ev.stopPropagation(); onOpen(); }}>All ${total} ›</button>` : null}</div>` : null}
        <ul class="dp-carditems">${g.items.slice(0, shown[i]).map(it => html`<${Item} key=${it.id} it=${it} stops=${stops} />`)}</ul></section>`;
    })}
    ${buttons.length ? html`<div class="dk-card-actions">${buttons.map(b => html`<button key=${b.label} type="button" class=${`dk-btn${b.primary ? ' dk-card-open' : ''}`}
      title=${b.title ?? null} disabled=${b.disabled} aria-expanded=${b.expanded == null ? null : String(b.expanded)} ...${stopProps(stops)} onClick=${ev => { ev.stopPropagation(); b.onClick(); }}>${b.label}</button>`)}</div>` : null}
    ${after}
  </div><//>`;
}

/** The palette's card keys (SPEC.md, *Record card*): `focus` (a new number each Tab into it) puts the focus on its first stop (then
 *  `onFocused`); Tab and Shift+Tab step through its stops, past either end or Esc back to the box (`onLeave`); Down and Up back to the
 *  box and on to the next or previous row (`onArrow('Down' | 'Up')`). Answers the key handler. */
export function useCardStops(ref, {focus, onFocused, onLeave, onArrow}) {
  useLayoutEffect(() => {
    if (!focus) return undefined;
    onFocused?.();
    const first = () => ref.current?.querySelector('[data-stop]');
    if (first()) { first().focus({preventScroll: true}); return undefined; }
    // Tab before the card has drawn (its read still on its way): its first control takes the focus once it is there
    const el = ref.current;
    if (!el || typeof MutationObserver === 'undefined') return undefined;
    const watch = new MutationObserver(() => { const stop = first(); if (stop) { watch.disconnect(); stop.focus({preventScroll: true}); } });
    watch.observe(el, {childList: true, subtree: true});
    return () => watch.disconnect();
  }, [focus]);
  return ev => {
    const stops = [...(ref.current?.querySelectorAll('[data-stop]') ?? [])], at = stops.indexOf(ev.target);
    if (at < 0) return;
    if (ev.key === 'Tab') {
      ev.preventDefault(); ev.stopPropagation();
      const next = stops[at + (ev.shiftKey ? -1 : 1)];
      if (next) next.focus({preventScroll: true}); else onLeave?.();
    } else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); onLeave?.(); }
    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); ev.stopPropagation(); onLeave?.(); onArrow?.(ev.key === 'ArrowDown' ? 'Down' : 'Up'); }
  };
}

/** Find's selected record (SPEC.md, *Record card*): its row (a person's picture in the tile's place: `lines`' avatar), then its card in
 *  place (`card`: the record's compact content, loaded on selection); Enter, a double click or Open › open the whole record (`act.open`). */
export function RecordRow({row, lines: l, glyph, selected = true, rowId, act, focus = 0, onFocused, onLeave, onArrow, card, host = null}) {
  const ref = useRef(null);
  const key = useCardStops(ref, {focus, onFocused, onLeave, onArrow});
  return html`<div ref=${ref} class=${`dp-row dp-card dp-record${selected ? ' sel' : ''}`} role="option" id=${rowId} data-id=${row.id} data-kind=${row.kind} data-card="record"
    aria-selected=${selected ? 'true' : 'false'} aria-label=${[l.title, l.sub].filter(Boolean).join(', ')} title=${l.tip || null} onKeyDown=${key}
    onClick=${ev => { if (!ev.target.closest('button, a, .dp-cardmore')) act.select(row.id); }} onDblClick=${ev => { if (!ev.target.closest('button, a, .dp-cardmore')) act.open(row.id); }}>
    ${l.avatar ? html`<${Avatar} host=${host} path=${l.avatar.path} name=${l.avatar.name} />` : html`<span class="dp-tile"><${Glyph} name=${glyph} size=${18} /></span>`}
    <span class="dp-lines"><span class="dp-title">${l.title}</span>${l.sub ? html`<span class=${`dp-sub ${l.subClass ?? ''}`}>${l.sub}</span>` : null}</span>
    <span class="dp-end"><button type="button" tabindex="-1" class="dp-pill" title=${row.kind === 'person' ? 'Profile (Enter)' : 'The whole record (Enter)'} onClick=${ev => { ev.stopPropagation(); act.open(row.id); }}>${row.kind === 'person' ? 'Profile ›' : 'Open ›'}</button></span>
    <span class="dp-cardmore"><${CardStops.Provider} value=${IN_ROW}>${card}<//></span>
  </div>`;
}

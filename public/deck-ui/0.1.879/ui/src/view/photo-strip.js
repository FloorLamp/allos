// The photo strip (palette SPEC.md, *Photos*): one line of thumbnails wherever photos of something show: Find's person card and record
// cards, under a trip's or a day's row, a record's full view, a car's card. As many as fit the line; when more than fit, the last place
// is `+n` (n the photos not shown). A thumbnail opens its photo in the viewer, `+n` all of them. A thumbnail that does not load leaves
// the line (the site has no photos route: no strip there); none loaded, no strip.
import {h, createContext} from '../../vendor/preact.mjs';
import {useContext, useLayoutEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {plural} from '../format.js';
const html = htm.bind(h);

/** How many places a line of `width` px holds, `tile` px each with `gap` between; at least one. */
export const placesFor = (width, tile, gap) => Math.max(1, Math.floor((width + gap) / (tile + gap)));

/** What a line of `places` shows of `n` thumbnails (of `total` photos): every one when all fit, else places − 1 of them and `+k` (k
 *  the photos not shown, the ones bridge did not send among them). `{shown, more}`. */
export function stripFit(n, places, total = n) {
  total = Math.max(total, n);
  if (total <= places) return {shown: n, more: 0};
  const shown = Math.min(n, Math.max(places - 1, 0));
  return {shown, more: total - shown};
}

/** Find's photos in a card ({set, host, open(i), all()}): the record card draws them (record-card.js). */
export const CardPhotos = createContext(null);
/** A set's thumbnails as the strip's items. */
export const setItems = set => (set?.thumbnails ?? []).map((t, i) => ({id: t.id, path: t.url, label: `Photo ${i + 1} of ${set.thumbnails.length}`}));

/** One photo's preview as a button (the strip's, the viewer's grid): a placeholder until it loads; `onFail(id)` when it cannot. */
export function Thumb({it, host, stops = {}, onOpen, onFail}) {
  const [src, setSrc] = useState(null), [ok, setOk] = useState(false);
  useLayoutEffect(() => {
    let active = true;
    setSrc(null); setOk(false);
    Promise.resolve().then(() => host.resource(it.path)).then(url => { if (active) url ? setSrc(url) : onFail(it.id); }, () => { if (active) onFail(it.id); });
    return () => { active = false; };
  }, [host, it.path]);
  return html`<button type="button" class="dk-photo" aria-label=${it.label} title=${it.label} ...${stops}
    onClick=${ev => { ev.stopPropagation(); onOpen(); }}>
    ${ok ? null : html`<span class="dk-ph" aria-hidden="true"></span>`}
    ${src ? html`<img src=${src} alt="" draggable="false" decoding="async" class=${ok ? 'ok' : ''} onLoad=${() => setOk(true)} onError=${() => onFail(it.id)} />` : null}
  </button>`;
}

/** items [{id, path (a resource path), label}], `total` how many photos there are (more than the items when bridge sent fewer); a
 *  thumbnail `onOpen(i)` (i its place among the items), `+n` `onAll()`; `label` the strip's name (`Photos · Robin Example`);
 *  `stops`: inside the palette's card, its thumbnails are the card's Tab stops (record-card.js `data-stop`), else out of the tab order
 *  as a row's buttons are (`row`). */
export function PhotoStrip({items = [], total = items.length, host, label, onOpen, onAll, stops = false, row = false}) {
  const ref = useRef(null);
  const [places, setPlaces] = useState(0), [failed, setFailed] = useState(() => new Set());
  const live = items.filter(it => !failed.has(it.id));
  const missing = items.length - live.length;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const cs = getComputedStyle(el), tile = parseFloat(cs.getPropertyValue('--photo')) || 56, gap = parseFloat(cs.columnGap) || 0;
      const n = placesFor(el.clientWidth, tile, gap);
      setPlaces(p => p === n ? p : n);
    };
    measure();
    let frame = 0;
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); }) : null;
    ro?.observe(el);
    return () => { cancelAnimationFrame(frame); ro?.disconnect(); };
  }, [!live.length]);
  if (!live.length) return null;
  // nowhere to show them all (`onAll` none): what fits, no `+n`
  const fit = onAll ? stripFit(live.length, places || live.length, Math.max(0, total - missing)) : {shown: Math.min(live.length, places || live.length), more: 0};
  const stop = stops ? {tabindex: '-1', 'data-stop': ''} : row ? {tabindex: '-1'} : {};
  const fail = id => setFailed(f => f.has(id) ? f : new Set([...f, id]));
  return html`<div class="dk-photostrip" ref=${ref} role="group" aria-label=${label ?? 'Photos'}>
    ${live.slice(0, places ? fit.shown : live.length).map(it => html`<${Thumb} key=${it.id} it=${it} host=${host} stops=${stop} onFail=${fail}
      onOpen=${() => onOpen?.(items.indexOf(it))} />`)}
    ${places && fit.more ? html`<button type="button" class="dk-photo dk-photomore" aria-label=${`All ${plural(fit.shown + fit.more, 'photo')}`}
      title=${`All ${plural(fit.shown + fit.more, 'photo')}`} ...${stop} onClick=${ev => { ev.stopPropagation(); onAll?.(); }}>+${fit.more}</button>` : null}
  </div>`;
}

/** The photos of the card it is in (CardPhotos); `stops` the card's Tab stops. */
export function CardStrip({stops}) {
  const c = useContext(CardPhotos);
  if (!c?.set) return null;
  return html`<${PhotoStrip} items=${setItems(c.set)} total=${c.set.total} host=${c.host} label=${c.set.title} stops=${stops}
    onOpen=${i => c.open(i)} onAll=${() => c.all()} />`;
}

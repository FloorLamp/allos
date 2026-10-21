import {StatusLink} from '../page-state.js';
import {describeFailure} from '../../failure.js';
// Pages (palette SPEC.md, *Kinds*: `pages`): every page's placeholder laid out at its aspect, each page bridge renders at the view's
// width in device pixels snapped to 800, 1600 or 2400 (wider again when a zoom needs it), the visible page first, then its neighbours,
// two at a time; pages far from view let go of theirs. A PDF fits its width; an image (a Recent one or one of Find's photos too) fits
// whole, never wider than its pixels; a photo of a set steps to the set's next or previous one (→ ←). Zoom (Mod+scroll, pinch, + / −,
// 0 fit, a double click between fit and 2×) and pan (drag, scroll); the match's boxes once its page has loaded; a failed page with
// Retry.
import {h} from '../../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useReducer, useRef, useState} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {pagePath, snap} from '../../viewer.js';

const html = htm.bind(h);
const EDGE = 14, GAP = 12, MIN = 0.25, MAX = 5;

/** The match's pages in page order, and where its best page is among them. */
export function matchPages(match, count) {
  if (!match || !(match.page >= 1 && match.page <= count)) return {pages: [], at: -1};
  const pages = [...new Set([match.page, ...(match.pages ?? [])])].filter(n => Number.isInteger(n) && n >= 1 && n <= count).sort((x, y) => x - y);
  return {pages, at: pages.indexOf(match.page)};
}

/** Which pages to ask for now: the visible one alone until it arrives, then its neighbours, two in flight at most. `have(n)` →
 *  {w, status} or undefined. */
export function wanted(visible, count, w, have) {
  const out = [];
  let busy = 0;
  for (let n = 1; n <= count; n++) if (have(n)?.status === 'loading') busy++;
  for (const n of [visible, visible + 1, visible - 1, visible + 2]) {
    if (n < 1 || n > count) continue;
    if (n !== visible && have(visible)?.status === 'loading') break;
    const r = have(n);
    if (r?.status === 'failed' || r?.status === 'loading' || (r?.status === 'ok' && r.w >= w)) continue;
    if (busy >= 2) break;
    busy++;
    out.push(n);
  }
  return out;
}

export function Pages({v, e, pane}) {
  // a lone image, its size its pixels': a Recent item's, one of Find's photos (its preview)
  const a = e.answer, one = e.recent ? `/local/recent/${e.recent.id}` : e.set ? e.set.thumbnails[e.at].url : null, recent = !!one, image = a.of === 'image';
  const scroller = useRef(null), recs = useRef(new Map()), pending = useRef(null), placed = useRef(false), drag = useRef(null);
  const saved = useRef(e.view.scrollTop != null ? {top: e.view.scrollTop, left: e.view.scrollLeft ?? 0} : null);
  const [box, setBox] = useState({w: 0, h: 0});
  const [zoom, setZoom] = useState(e.view.zoom ?? 1);
  const [natural, setNatural] = useState(null);
  const [visible, setVisible] = useState(e.view.page ?? 1);
  const [, bump] = useReducer(n => n + 1, 0);
  const sizes = recent ? [natural ?? {w: 4, h: 3}] : a.pages.map(p => ({w: p.w > 0 ? p.w : 1, h: p.h > 0 ? p.h : 1}));
  const count = sizes.length;
  const {pages: matches, at: bestAt} = matchPages(a.match, count);
  const [matchAt, setMatchAt] = useState(e.view.matchAt ?? bestAt);
  const dpr = globalThis.devicePixelRatio || 1;

  // the fit: a PDF's width; an image whole, never past its own pixels
  const avail = Math.max(160, box.w - 2 * EDGE);
  let fit = avail;
  if (image && sizes[0]) {
    const p = sizes[0], room = Math.max(160, box.h - 2 * EDGE);
    fit = Math.max(160, Math.min(avail, room * p.w / p.h, recent && !natural ? avail : p.w / dpr));
  }
  const pageW = Math.round(fit * zoom);
  const heights = sizes.map(p => Math.round(pageW * p.h / p.w));
  const tops = heights.reduce((t, hgt, i) => [...t, t[i] + hgt + GAP], [EDGE]);
  const want = snap(pageW * dpr);

  const visibleAt = el => {
    const mid = el.scrollTop + el.clientHeight * 0.4;
    for (let i = 0; i < count; i++) if (mid < tops[i + 1]) return i + 1;
    return Math.max(1, count);
  };
  /** Where the view's top is, width aside: the page there, how far down it (with its gap) and across the pages (fractions). */
  const anchor = el => {
    let i = 0;
    while (i < count - 1 && el.scrollTop >= tops[i + 1]) i++;
    return {page: i + 1, y: (el.scrollTop - tops[i]) / (heights[i] + GAP), x: el.scrollLeft / Math.max(1, Math.max(box.w, pageW + 2 * EDGE))};
  };
  const go = n => {
    const el = scroller.current;
    if (!el) return;
    n = Math.max(1, Math.min(count, n));
    el.scrollTop = Math.max(0, tops[n - 1] - 8);
    setVisible(n);
  };
  const toMatch = i => {
    const n = matches[i], el = scroller.current;
    if (n == null || !el) return;
    setMatchAt(i);
    const b = n === a.match.page ? a.match.boxes?.[0] : null;
    el.scrollTop = Math.max(0, b ? tops[n - 1] + b.y * heights[n - 1] - el.clientHeight / 3 : tops[n - 1] - 8);
    setVisible(n);
  };
  const zoomTo = (z, ax, ay) => {
    const el = scroller.current;
    z = Math.max(MIN, Math.min(MAX, z));
    if (!el || Math.abs(z - zoom) < 0.001) return;
    const x = ax ?? el.clientWidth / 2, y = ay ?? el.clientHeight / 2, r = z / zoom;
    pending.current = {left: (el.scrollLeft + x) * r - x, top: (el.scrollTop + y - EDGE) * r + EDGE - y};
    setZoom(z);
  };

  // the scroller's size
  useLayoutEffect(() => {
    const el = scroller.current;
    const measure = () => setBox(b => b.w === el.clientWidth && b.h === el.clientHeight ? b : {w: el.clientWidth, h: el.clientHeight});
    measure();
    // measured on the next frame: a size that changes the layout again must not loop the observer
    const ro = new ResizeObserver(() => requestAnimationFrame(measure));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // where it opens: as it was (history), else the match's first box in the upper third, else the top; a zoom keeps its anchor
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !box.w) return;
    if (pending.current) { el.scrollLeft = pending.current.left; el.scrollTop = pending.current.top; pending.current = null; }
    else if (!placed.current) {
      placed.current = true;
      // a view kept at another width (Deck's own window opened on the panel's): the same spot of the same page
      const at = e.view.at;
      if (saved.current && at && e.view.w !== box.w && at.page >= 1 && at.page <= count) {
        el.scrollTop = tops[at.page - 1] + at.y * (heights[at.page - 1] + GAP);
        el.scrollLeft = at.x * Math.max(box.w, pageW + 2 * EDGE);
      } else if (saved.current) { el.scrollTop = saved.current.top; el.scrollLeft = saved.current.left; }
      else if (bestAt >= 0) toMatch(bestAt);
    }
    setVisible(visibleAt(el));
  }, [box.w, box.h, zoom, natural]);
  // the pages in view asked for; far ones let go
  useEffect(() => {
    if (!box.w || !placed.current) return;
    const m = recs.current, el = scroller.current, visible = el ? visibleAt(el) : 1;
    if (recent) {
      if (!m.has(1)) { let src = null; try { src = v.host.resource(one); } catch { /* off the allowlist: failed */ } m.set(1, {w: want, status: src ? 'loading' : 'failed', src}); bump(); }
      return;
    }
    let moved = false;
    for (const n of wanted(visible, count, want, n => m.get(n))) {
      const old = m.get(n);
      m.set(n, {w: want, status: 'loading', src: v.host.resource(pagePath(e, n, want)), prev: old?.status === 'ok' ? old.src : null});
      moved = true;
    }
    for (const n of [...m.keys()]) if (Math.abs(n - visible) > 6) { m.delete(n); moved = true; }
    if (moved) bump();
  });
  // what the header shows, what the frame's keys reach
  useEffect(() => { pane.setInfo({page: visible, matches: matches.length, matchAt}); });
  Object.assign(e.view, {zoom, page: visible, matchAt});
  pane.kind.current = {
    step: d => toMatch(Math.max(0, Math.min(matches.length - 1, matchAt + d))),
    key(k) {
      const el = scroller.current;
      switch (k) {
        case 'Right': if (e.set) { v.stepPhoto(1); return true; } go(visible + 1); return true;
        case 'Left': if (e.set) { v.stepPhoto(-1); return true; } go(visible - 1); return true;
        case 'PageDown': go(visible + 1); return true;
        case 'PageUp': go(visible - 1); return true;
        case '+': case '=': case 'Shift++': zoomTo(zoom * 1.25); return true;
        case '-': case '_': zoomTo(zoom / 1.25); return true;
        case '0': zoomTo(1); return true;
        case 'Down': el && (el.scrollTop += 60); return true;
        case 'Up': el && (el.scrollTop -= 60); return true;
        case 'Home': go(1); return true;
        case 'End': go(count); return true;
      }
      return false;
    },
  };

  const loaded = (n, src, ok, img) => {
    const r = recs.current.get(n);
    if (!r || r.src !== src) return;
    r.status = ok ? 'ok' : 'failed';
    r.prev = null;
    if (recent && ok && img?.naturalWidth) setNatural({w: img.naturalWidth, h: img.naturalHeight});
    v.firstPage(e, ok);
    bump();
  };
  const retry = n => { recs.current.delete(n); bump(); };

  const onWheel = ev => {
    if (!(ev.ctrlKey || ev.metaKey)) return;
    ev.preventDefault();
    const r = scroller.current.getBoundingClientRect();
    zoomTo(zoom * Math.pow(1.1, -ev.deltaY / 100), ev.clientX - r.left, ev.clientY - r.top);
  };
  const onDown = ev => {
    if (ev.button !== 0 || ev.pointerType === 'touch' || ev.target.closest('button')) return;
    const el = scroller.current;
    drag.current = {x: ev.clientX, y: ev.clientY, left: el.scrollLeft, top: el.scrollTop};
    el.setPointerCapture?.(ev.pointerId);
  };
  const onMove = ev => {
    const d = drag.current, el = scroller.current;
    if (!d) return;
    el.scrollLeft = d.left - (ev.clientX - d.x);
    el.scrollTop = d.top - (ev.clientY - d.y);
  };
  const onUp = () => { drag.current = null; };
  const onDbl = ev => {
    if (ev.target.closest('button')) return;
    const r = scroller.current.getBoundingClientRect();
    zoomTo(zoom < 1.5 ? 2 : 1, ev.clientX - r.left, ev.clientY - r.top);
  };

  const width = Math.max(box.w, pageW + 2 * EDGE);
  return html`
    <div class=${`dv-scroll dv-pagescroll${image ? ' whole' : ''}`} ref=${scroller} onScroll=${ev => { const el = ev.currentTarget, n = visibleAt(el); Object.assign(e.view, {scrollTop: el.scrollTop, scrollLeft: el.scrollLeft, w: box.w, at: anchor(el)}); if (n !== visible) setVisible(n); }}
      onWheel=${onWheel} onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} onPointerCancel=${onUp} onDblClick=${onDbl}>
      <div class="dv-pages" style=${`width:${width}px;padding:${EDGE}px 0;${image ? `min-height:${Math.max(0, box.h - 2 * EDGE)}px;` : ''}`}>
        ${sizes.map((p, i) => {
          const n = i + 1, r = recs.current.get(n), ok = r?.status === 'ok';
          const boxes = ok && a.match?.page === n ? a.match.boxes ?? [] : [];
          return html`<div class="dv-page" key=${n} data-n=${n} style=${`width:${pageW}px;height:${heights[i]}px;margin-bottom:${i < count - 1 ? GAP : 0}px`}>
            ${ok ? null : html`<div class="dk-ph dv-ph"></div>`}
            ${r?.prev ? html`<img class="ok" src=${r.prev} alt="" draggable="false" />` : null}
            ${r?.src && r.status !== 'failed' ? html`<img key=${r.src} class=${ok ? 'ok' : ''} src=${r.src} alt=${`Page ${n}`} draggable="false"
              onLoad=${ev => loaded(n, r.src, true, ev.currentTarget)} onError=${() => loaded(n, r.src, false)} />` : null}
            ${boxes.map((b, j) => html`<div class="dv-box" key=${j} style=${`left:calc(${b.x * 100}% - 2px);top:calc(${b.y * 100}% - 2px);width:calc(${b.w * 100}% + 4px);height:calc(${b.h * 100}% + 4px)`}></div>`)}
            ${r?.status === 'failed' ? html`<div class="dv-fail"><span>${describeFailure('bridge', {code: 'http'}).message} Page ${n} ·</span><${StatusLink} host=${v.host} /><button class="dk-btn text" onClick=${() => retry(n)}>Retry</button></div>` : null}
          </div>`;
        })}
      </div>
    </div>`;
}

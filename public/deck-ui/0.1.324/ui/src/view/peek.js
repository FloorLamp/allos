// The focused row's preview (palette SPEC.md, *Preview*), no DOM but the image it loads: which rows have media (`mediaOf`) and the
// loads (`peeker`: after the selection rests, the newer one cancelling the older, a stale answer never shown).
import {resourcePath} from '../host/host.js';

/** How long (ms) the selection rests on a row before its preview loads: arrows held load nothing on the way. */
export const PEEK_DWELL = 120;
const MEDIA_ROWS = new Set(['document', 'answer', 'none']);

/** A row's media as a resource path, else null: a found document's (an answer's, a none row's) readable page 1, from bridge's
 *  `document.thumb` (a PDF's or a scan's first page, a photo, a video's poster); a Recent image's original (`caps.recent`: a
 *  shell's). Anything off the hosts' allowlist is none. */
export function mediaOf(row, caps = {}) {
  if (!row) return null;
  if (row.kind === 'recent') return row.item?.thumb && caps.recent ? resourcePath(`/local/recent/${row.item.id}`, {shell: true}) : null;
  if (!MEDIA_ROWS.has(row.kind) || row.alternateOf) return null;
  const path = resourcePath(row.result?.document?.thumb);
  if (!path) return null;
  const [base, query] = path.split('?');
  const params = new URLSearchParams(query);
  params.set('w', '2400');
  return `${base}?${params}`;
}

/** The preview's loads: `want(path)` with the selected row's media (null: none); `onShow({path, url, w, h})` once it loaded, `null`
 *  at once when the selection moves on. A load starts after `dwell` ms on one path; a newer `want` cancels the waiting or running one
 *  (its signal aborts), and an answer for any but the wanted path is dropped. The last `keep` loaded show again at once.
 *  `resource(path)` → URL (the host's; it may throw), `load(url, signal)` → {w, h}. */
export function peeker({resource, load, onShow, dwell = PEEK_DWELL, keep = 24, timers = globalThis}) {
  let wanted = null, timer = null, running = null;
  const seen = new Map(), warming = new Map();
  const cancel = () => { timers.clearTimeout(timer); timer = null; running?.abort(); running = null; };
  const start = path => {
    timer = null;
    let url;
    try { url = resource(path); } catch { return; }
    const ctl = running = new AbortController();
    load(url, ctl.signal).then(size => {
      if (ctl.signal.aborted || wanted !== path) return;
      running = null;
      const shown = {path, url, w: size?.w || 0, h: size?.h || 0};
      seen.delete(path);
      seen.set(path, shown);
      if (seen.size > keep) seen.delete(seen.keys().next().value);
      onShow(shown);
    }, () => { if (running === ctl) running = null; });
  };
  return {
    want(path = null) {
      if (path === wanted) return;
      cancel();
      wanted = path;
      const hit = path ? seen.get(path) : null;
      onShow(hit ?? null);
      if (path && !hit) timer = timers.setTimeout(() => start(path), dwell);
    },
    /** Warm only the adjacent rows, using the same bounded cache as the selected image. */
    prefetch(paths) {
      for (const path of paths.filter(Boolean)) {
        if (path === wanted || seen.has(path) || warming.has(path)) continue;
        const ctl = new AbortController();
        warming.set(path, ctl);
        let url;
        try { url = resource(path); } catch { warming.delete(path); continue; }
        load(url, ctl.signal).then(size => {
          if (ctl.signal.aborted) return;
          seen.set(path, {path, url, w: size?.w || 0, h: size?.h || 0});
          if (seen.size > keep) seen.delete(seen.keys().next().value);
        }, () => {}).finally(() => warming.delete(path));
      }
    },
    /** Nothing more: the palette went. */
    stop() { cancel(); wanted = null; for (const ctl of warming.values()) ctl.abort(); warming.clear(); },
  };
}

/** An image loaded off the page (the card then shows it from the browser's cache): its natural size. The signal drops it: `src`
 *  emptied, so the browser cancels the request. */
export function loadImage(url, signal) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const drop = () => { img.onload = img.onerror = null; img.src = ''; reject(new DOMException('dropped', 'AbortError')); };
    if (signal.aborted) return drop();
    signal.addEventListener('abort', drop, {once: true});
    img.onload = () => { signal.removeEventListener('abort', drop); resolve({w: img.naturalWidth, h: img.naturalHeight}); };
    img.onerror = () => { signal.removeEventListener('abort', drop); reject(new Error('no image')); };
    img.decoding = 'async';
    img.src = url;
  });
}

// The focused row's preview (palette SPEC.md, *Preview*), no DOM but the image it loads: which rows have media (`mediaOf`) and the
// loads (`peeker`: after the selection rests, the newer one cancelling the older, a stale answer never shown).
import {resourcePath} from '../host/host.js';

/** How long (ms) the selection rests on a row before its preview loads: arrows held load nothing on the way. */
export const PEEK_DWELL = 120;
const MEDIA_ROWS = new Set(['document', 'answer', 'none']);

/** A row's media as a resource path, else null: a found document's (an answer's, a none row's) page 1 small, bridge's
 *  `document.thumb` (a PDF's or a scan's first page, a photo, a video's poster); a Recent image's thumbnail (`caps.recent`: a
 *  shell's). Anything off the hosts' allowlist is none. */
export function mediaOf(row, caps = {}) {
  if (!row) return null;
  if (row.kind === 'recent') return row.item?.thumb && caps.recent ? resourcePath(`/local/recent/${row.item.id}/thumb`, {shell: true}) : null;
  if (!MEDIA_ROWS.has(row.kind) || row.alternateOf) return null;
  return resourcePath(row.result?.document?.thumb);
}

/** The preview's loads: `want(path)` with the selected row's media (null: none); `onShow({path, url, w, h})` once it loaded, `null`
 *  at once when the selection moves on. A load starts after `dwell` ms on one path; a newer `want` cancels the waiting or running one
 *  (its signal aborts), and an answer for any but the wanted path is dropped. The last `keep` loaded show again at once.
 *  `resource(path)` → URL (the host's; it may throw), `load(url, signal)` → {w, h}. */
export function peeker({resource, load, onShow, dwell = PEEK_DWELL, keep = 24, timers = globalThis}) {
  let wanted = null, timer = null, running = null;
  const seen = new Map();
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
    /** Nothing more: the palette went. */
    stop() { cancel(); wanted = null; },
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

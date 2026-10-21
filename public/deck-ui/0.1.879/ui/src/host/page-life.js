import {HostError} from './host.js';
// The page's reads: every fetch a page makes on the site (web.js, site.js, the viewer's bytes, the nav) lives as long as the page.
// Leaving it (`beforeunload`: a link, location.assign, a form, the address bar, Back, a reload) aborts each read still on its way and
// refuses new ones, so the browser never cancels one under the page: WebKit rejects a fetch its navigation cancels as a TypeError
// ("Load failed", "… due to access control checks"), which reads as offline and, unhandled, as the page's error. Each such read is
// `cancelled`, which callers draw as nothing; a cancellation no caller handled is not the page's error either (`unhandledrejection`).
// Back on the page (`pageshow`: the back/forward cache) or input on it (a navigation that stayed: a download) reads again.

/** A rejection that only says its read was cancelled (the page leaving, a view's own abort): nothing to draw, nothing to report. */
export const cancelled = e => e?.name === 'AbortError' || e?.name === 'HostError' && e.code === 'cancelled';

const lives = new WeakMap();
/** The window's one lifetime: `leaving` (true from beforeunload until the page is back), `fetch(url, init)`. */
export function pageLife(win = globalThis) {
  let life = lives.get(win);
  if (life) return life;
  let page = new AbortController();
  const leave = () => page.abort(new DOMException('the page is leaving', 'AbortError'));
  const stay = () => { if (page.signal.aborted) page = new AbortController(); };
  win.addEventListener?.('beforeunload', leave);
  win.addEventListener?.('pageshow', stay);
  for (const type of ['pointerdown', 'keydown']) win.addEventListener?.(type, stay, {capture: true});
  win.addEventListener?.('unhandledrejection', e => { if (cancelled(e.reason)) e.preventDefault(); });
  life = {
    get leaving() { return page.signal.aborted; },
    /** win.fetch for this page, its own signal joined to the page's: refused once the page is leaving, and its failure then
     *  `cancelled` whatever the browser said (the body's read too: `leaving`). */
    async fetch(url, init = {}) {
      const lifetime = page.signal;
      if (lifetime.aborted) throw new HostError('cancelled');
      const signal = init.signal ? AbortSignal.any([init.signal, lifetime]) : lifetime;
      // WebKit may collect a joined signal nothing in script holds while its fetch waits, and an abort then never reaches the fetch
      // (a camera's still past its deadline stays loading): the caller's signal holds it
      if (signal !== lifetime) init.signal.addEventListener('abort', () => signal.aborted, {once: true});
      try { return await win.fetch(url, {...init, signal}); }
      catch (e) { throw lifetime.aborted ? new HostError('cancelled') : e; }
    },
  };
  lives.set(win, life);
  return life;
}

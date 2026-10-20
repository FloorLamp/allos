// The site's one context: every page on deck.wang.team (Deck's own, Money from Purser, House from Habitat) reads the same Needs and
// the same member through it, so each host's bar says the same (contract/shell-bar.md *The site*).
// Needs: Flightplan's Needs you, the one list Flightplan's pollers fill from every backend (Bridge's review needs are retired from the
// site and reach it through Flightplan). Member: boarding's `/boarding/session`, the session Caddy and Deck turn into X-Member upstream.
import {HostError} from './host.js';
import {needsFor} from '../needs.js';
import {webHost} from './web.js';
import {deckBackendConfig} from './backends.js';
import {pageMember} from './member.js';

const sites = new WeakMap();

/** Deck's public backend origins: the page's `<meta name="deck-backends">` (Deck's own pages), else Deck's `/api/deck-backends`. */
async function origins(win) {
  const meta = win.document?.querySelector('meta[name="deck-backends"]');
  if (meta) return JSON.parse(meta.content);
  const res = await win.fetch('/api/deck-backends', {credentials: 'same-origin', cache: 'no-store'});
  if (!res.ok) throw new HostError('not-set-up', `Needs configuration: HTTP ${res.status}`);
  return res.json();
}

function siteOf(win) {
  let site = sites.get(win);
  if (site) return site;
  let configured = null;
  const host = () => configured ??= origins(win)
    .then(o => {
      const web = webHost(win, {backends: deckBackendConfig(o, {member: pageMember(win)})});
      return {...web, caps: {...web.caps, needs: false}, async call(op, args, options) {
        if (op === 'bridge.needs' || op === 'bridge.need') throw new HostError('unsupported', 'Use Flightplan Needs');
        return web.call(op, args, options);
      }};
    })
    .catch(error => { configured = null; throw error; });
  // A host of its own: Needs never waits on the page's host, and a page's local adapter never changes the count.
  const needsHost = {caps: {needs: false}, backends: ['flightplan'], async call(op, args, options) { return (await host()).call(op, args, options); }};
  site = {host, needs: needsFor(needsHost)};
  sites.set(win, site);
  return site;
}

/** Deck's web host over the site's backends (resolves once per page; a failed configuration read is retried on the next call). */
export const siteHost = (win = globalThis) => siteOf(win).host();
/** The site's Needs source: the one count every host's bar, Find, the Needs page and House's strip show. */
export const siteNeeds = (win = globalThis) => siteOf(win).needs;

/** Who is signed in: `{member: {id, name, role}}`, `{member: null}` when boarding says signed out, or null when there is no answer
 *  (no boarding on this origin, offline): then the bar shows neither a name nor Sign in. `page`: the member the page was served to
 *  when it says (member.js), asking boarding only on a page that does not (a refresh asks boarding). */
export async function siteSession(win = globalThis, {page = false} = {}) {
  const served = page ? pageMember(win) : undefined;
  if (served) return {member: served};
  try {
    const res = await win.fetch('/boarding/session', {credentials: 'same-origin', cache: 'no-store'});
    if (!res.ok) return null;
    const body = await res.json();
    return body && 'member' in body ? {member: body.member ? {id: body.member.id, name: body.member.name ?? body.member.id, role: body.member.role} : null} : null;
  } catch { return null; }
}

/** Sign out of boarding on this site, then its sign-in page. Pages listen for `deck-sign-out` to drop their sessions' work. */
export async function siteSignOut(win = globalThis) {
  win.dispatchEvent?.(new Event('deck-sign-out'));
  await win.fetch('/boarding/sign-out', {method: 'POST', credentials: 'same-origin', headers: {'content-type': 'application/json'}, body: '{}'}).catch(() => {});
  win.location.href = '/boarding/';
}

export const signInHref = (win = globalThis) => `/boarding/sign-in?to=${encodeURIComponent(win.location.pathname + win.location.search + win.location.hash)}`;

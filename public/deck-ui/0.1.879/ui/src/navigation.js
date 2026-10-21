// The published navigation contract is shared by web pages and native bundles.
import {pageLife} from './host/page-life.js';
const local = href => typeof href === 'string' && href.startsWith('/') && !href.startsWith('//') && !href.includes('\\');
/** The entries Find opens (palette model `findEntries`): each same-origin entry and page with its `url` on `base`. */
export const navTargets = (items, base) => (Array.isArray(items) ? items : []).filter(p => local(p.href)).map(p => ({...p, url: new URL(p.href, base).href,
  ...(Array.isArray(p.pages) ? {pages: p.pages.filter(q => local(q.href)).map(q => ({...q, url: new URL(q.href, base).href}))} : {})}));
/** The pages an entry's own page links in its header (nav `pages`, `via: header`, or `menu`: its More), [{label, href, hint, menu}];
 *  `owner`: false leaves out the owner's (`owner: true`). */
export const pageLinks = (nav, id, {owner = true} = {}) => ((Array.isArray(nav) ? nav : []).find(p => p.id === id)?.pages ?? [])
  .filter(p => ['header', 'menu'].includes(p.via) && (owner || !p.owner)).map(({label, href, hint, via}) => ({label, href, hint, menu: via === 'menu'}));
let pending;
export function loadNavigation() {
  // The web host's bundle carries it inline (build-web.mjs).
  if (typeof DECK_WEB === 'object') return pending ??= Promise.resolve(DECK_WEB.nav);
  return pending ??= pageLife().fetch(new URL('../contract/nav.json', import.meta.url)).then(r => {
    if (!r.ok) throw new Error('Navigation unavailable');
    return r.json();
  }).catch(e => { pending = null; throw e; });
}

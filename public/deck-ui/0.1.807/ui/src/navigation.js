// The published navigation contract is shared by web pages and native bundles.
let pending;
export function loadNavigation() {
  // The web host's bundle carries it inline (build-web.mjs).
  if (typeof DECK_WEB === 'object') return pending ??= Promise.resolve(DECK_WEB.nav);
  return pending ??= fetch(new URL('../contract/nav.json', import.meta.url)).then(r => {
    if (!r.ok) throw new Error('Navigation unavailable');
    return r.json();
  }).catch(e => { pending = null; throw e; });
}

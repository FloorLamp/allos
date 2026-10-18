// The published navigation contract is shared by web pages and native bundles.
let pending;
export function loadNavigation() {
  return pending ??= fetch(new URL('../contract/nav.json', import.meta.url)).then(r => {
    if (!r.ok) throw new Error('Navigation unavailable');
    return r.json();
  }).catch(e => { pending = null; throw e; });
}

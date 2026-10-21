// Leaflet for Deck's maps (view/map-view.js, contract/media.md *Map*; the camera wall's delivery map): pinned on cdnjs (its copy of
// the npm tarball's dist, byte for byte; the sha384 the page checks, test/fixtures holds the same files) with OpenStreetMap's tiles.
// A page that draws a map serves under `mapPolicy` (deck/src/web.mjs MAP_PAGES and the wall; Habitat's wall page: its `web.py`
// `map_policy`, the same three sources).

/** Leaflet, pinned, and OpenStreetMap's tiles. */
export const LEAFLET = Object.freeze({
  version: '1.9.4',
  script: {url: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js', integrity: 'sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH'},
  style: {url: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css', integrity: 'sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H'},
  tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
});

/** A map page's policy: the bundle's, with Leaflet's script and sheet (cdnjs) and OpenStreetMap's tiles; nothing else. */
export const mapPolicy = csp => csp.replace("script-src 'self'", "script-src 'self' https://cdnjs.cloudflare.com")
  .replace("style-src 'self'", "style-src 'self' https://cdnjs.cloudflare.com").replace("img-src 'self'", "img-src 'self' https://tile.openstreetmap.org");

let loading = null;
/** Leaflet once per page: its sheet before the page's own (so ours restyle it) and its script, each checked against its pin. */
export function loadLeaflet(doc = document) {
  const win = doc.defaultView;
  if (win.L?.version === LEAFLET.version) return Promise.resolve(win.L);
  const add = (tag, props, where) => new Promise((resolve, reject) => {
    const el = Object.assign(doc.createElement(tag), props, {crossOrigin: 'anonymous', referrerPolicy: 'no-referrer'});
    el.addEventListener('load', resolve, {once: true});
    el.addEventListener('error', () => { el.remove(); reject(new Error('the map did not load')); }, {once: true});
    doc.head[where](el);
  });
  loading ??= Promise.all([
    add('link', {rel: 'stylesheet', href: LEAFLET.style.url, integrity: LEAFLET.style.integrity}, 'prepend'),
    add('script', {src: LEAFLET.script.url, integrity: LEAFLET.script.integrity}, 'append'),
  ]).then(() => {
    if (win.L?.version !== LEAFLET.version) throw new Error('the map did not load');
    return win.L;
  }).catch(error => { loading = null; throw error; });
  return loading;
}

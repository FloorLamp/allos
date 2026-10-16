import {People} from './view/people.js';
import {openMap} from './view/map.js';
import {CollectionDetails} from './view/collection-details.js';
// The site's entry points (DESIGN.md §7): bridge's pages mount the shared UI into an element with the web host (host/web.js): the
// viewer (doc.html's pane), the palette (`/`, in page layout) and plain rows (clusters, attention). Each answers an unmount.
import {createSecurity} from './security.js';
import {Security} from './view/security.js';
import {h, render} from '../vendor/preact.mjs';
import {createController} from './controller.js';
import {createViewer} from './viewer.js';
import {Viewer} from './view/viewer/frame.js';
import {Palette} from './view/palette.js';
import {ShellBar, NavTiles} from './view/shell-bar.js';
import {StatTiles} from './view/stat-tiles.js';
import {Drawer} from './view/drawer.js';
import {RowList} from './view/rows.js';
import {createDetails} from './details.js';
import {Details} from './view/viewer/details.js';
import {createHouse} from './house.js';
import {House} from './view/house.js';
import {createAccounts} from './accounts.js';
import {Accounts} from './view/accounts.js';
import {createHealth} from './health.js';
import {Health} from './view/health.js';
import {createPapers} from './papers.js';
import {Papers} from './view/papers.js';
import {createThings} from './things.js';
import {Things} from './view/things.js';
import {createTaxes} from './taxes.js';
import {Taxes} from './view/taxes.js';
import {createInsurance} from './insurance.js';
import {Insurance} from './view/insurance.js';
import {createProperties} from './properties.js';
import {Properties} from './view/properties.js';
import {createVehicles} from './vehicles.js';
import {Vehicles} from './view/vehicles.js';
import {createFlightplan} from './flightplan.js';
import {Flightplan} from './view/flightplan.js';

const STYLES = ['tokens.css', 'base.css', 'view/viewer/viewer.css', 'view/palette.css', 'view/chart.css', 'view/shell-bar.css', 'view/foundation.css', 'view/house.css', 'view/accounts.css', 'view/health.css', 'view/vehicles.css', 'view/properties.css', 'view/insurance.css', 'view/things.css', 'view/taxes.css', 'view/papers.css', 'view/flightplan.css'];

/** The style sheets added here (href → settled once it loaded or failed). */
const adding = new Map();
/** The UI's style sheets in the page, once each (same origin: the CSP's style-src 'self'); answers once those added here settled. */
export function styles(doc = document) {
  const have = new Set([...doc.querySelectorAll('link[rel="stylesheet"]')].map(l => l.href)), waits = [];
  for (const f of STYLES) {
    const href = new URL(`./${f}`, import.meta.url).href;
    if (adding.has(href)) { waits.push(adding.get(href)); continue; }
    if (have.has(href)) continue;
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    adding.set(href, new Promise(r => { link.addEventListener('load', r, {once: true}); link.addEventListener('error', r, {once: true}); }));
    waits.push(adding.get(href));
    doc.head.append(link);
  }
  return Promise.all(waits);
}

/** A mount's drawing, from once its style sheets apply: drawn before them, a layout measured unstyled stays wrong (the viewer placed
 *  off its match page, a chart sized to the bare box). `draw()` redraws once shown; none after `unmount()`. */
function drawing(el, paint) {
  let state = 'waiting';
  const styled = styles(el.ownerDocument).then(() => { if (state === 'waiting') { state = 'shown'; paint(); } });
  return {styled, draw() { if (state === 'shown') paint(); }, unmount() { state = 'gone'; render(null, el); }};
}

/** The document viewer: opts {id, query, document} (or {recent}); `embedded` (default on the site): no close, a kind it cannot show
 *  stays as a state; `onClose`, `onGroup(key, title)` (none: a Related chip opens the map, `All n ›` every item in the rail);
 *  `details` (false: no Details pane; the page mounts its own, mountDetails). Answers {viewer, open(target), unmount()}. */
export function mountViewer(el, host, opts = {}) {
  const v = createViewer(host, {embedded: opts.embedded ?? host.kind === 'web', onClose: opts.onClose, onGroup: opts.onGroup, details: opts.details ?? true});
  let env = {mod: 'Control'};
  const d = drawing(el, () => render(h(Viewer, {v, env}), el));
  host.call('env.get', {}).then(r => { if (r) { env = r; d.draw(); } }, () => {});
  v.start();
  if (opts.health != null || opts.id != null || opts.recent != null) v.open(opts);
  return {viewer: v, open: target => v.open(target), unmount: () => d.unmount()};
}

/** The Details pane on its own (the site's document page, beside its viewer): what was read from document `id` and, with the
 *  host's `corrections` cap, the owner's corrections. opts: `document` (bridge.doc's answer the page has already: not asked again),
 *  `onChange(doc)` after each write (the page's head). Answers {details, unmount()}. */
export function mountDetails(el, host, opts = {}) {
  const d = createDetails(host, {onChange: opts.onChange});
  let env = {mod: 'Control'};
  const p = drawing(el, () => render(h(Details, {d, mod: env.mod}), el));
  host.call('env.get', {}).then(r => { if (r) { env = r; p.draw(); } }, () => {});
  if (opts.document) d.show(opts.document); else d.load(opts.id);
  return {details: d, unmount: () => p.unmount()};
}

/** The site's view: the document's page (its viewer, facts and details), the query along for its match. */
const docPage = ({id, query}) => { location.assign(`/doc/${id}${query ? `?q=${encodeURIComponent(query)}` : ''}`); };

/** The palette in a page (the site's `/`): the box, the rows, the hint line, full width (`layout` page). opts: `query` to start with,
 *  `ask` (true: ask it), `group` {key, title} to open (a Related chip from a document's page), `browse` {source, type, year, sort},
 *  `nav` (the same resolved bundled list passed to the shell: phone tiles below the box on an idle page),
 *  `landing` (an element of the page shown only on the empty query, with no group or answer: what expires, recent asks),
 *  `commands` (default: none on the web), `onView(target)` (default on the web: the document's page), `onChange(controller)` (the
 *  page's URL), `onPaint({what, ms})`. Answers {controller, find(text), ask(text), browse(filters), group(key, title), unmount()}. */
export function mountPalette(el, host, opts = {}) {
  let localViewer = null;
  const open = target => {
    if (opts.onView) return opts.onView(target);
    if (target.health) {
      localViewer = createViewer(host, {onClose: () => { localViewer.reset(); localViewer = null; d.draw(); }});
      localViewer.subscribe(() => d.draw());
      localViewer.open(target);
    } else if (host.kind === 'web') docPage(target);
  };
  const c = createController(host, {onMap: centre => openMap(host, centre), commands: opts.commands ?? host.kind !== 'web', onView: host.kind === 'web' || opts.onView ? open : null});
  c.vehicleMapping = opts.vehicleMapping;
  const layout = opts.layout ?? 'page';
  const d = drawing(el, () => render(localViewer ? h(Viewer, {v: localViewer, env: c.platform ?? {mod: 'Control'}}) : h(Palette, {c, mod: c.platform?.mod ?? 'Control', layout, nav: opts.nav, box: true, hint: opts.hint ?? true, onPaint: opts.onPaint}), el));
  const idle = () => !c.state.query && !c.state.scopes.length && !c.state.answer && !c.asking;
  const landing = opts.landing ?? null;
  const changed = () => {
    if (landing) landing.hidden = !idle();
    opts.onChange?.(c);
  };
  c.subscribe(changed);
  changed();
  const ready = Promise.all([c.start(), d.styled]).then(() => {
    d.draw();
    if (opts.group?.key) c.openGroup(opts.group.key, opts.group.title);
    else if (opts.browse && Object.values(opts.browse).some(Boolean)) c.browse(opts.browse);
    else if (opts.query) { c.edit(opts.query); if (opts.ask) c.key('Shift+Enter'); }
  });
  const focus = r => { el.querySelector('.dp-input')?.focus({preventScroll: true}); return r; };
  return {
    controller: c, ready,
    find(text) { c.reset(); c.edit(String(text)); focus(); },
    ask(text) { c.reset(); c.edit(String(text)); c.key('Shift+Enter'); focus(); },
    browse(filters) { return focus(c.browse(filters)); },
    group(key, title) { return focus(c.openGroup(key, title)); },
    unmount() { d.unmount(); },
  };
}

/** Plain rows on bridge's own pages (clusters, attention, the map's lists): documents, clusters and lines in the rows'
 *  anatomy (view/rows.js RowList). opts: `items`, `current`, `checkable`, `checked`, `onCheck`, `onOpen(item, {page})` (default: the
 *  item's `href`, else a document's page, a cluster's; Mod+click a new tab), `onSource(item)` (default: the document's page at its
 *  source through the host), `loading`, `error`, `empty`, `sectionTotal(items, section)`. Answers {update(opts), unmount()}. */
export function mountRows(el, host, opts = {}) {
  let o = opts, selected = null;
  const href = it => it.href ?? (it.document ? `/doc/${it.document.id}` : it.cluster ? `/clusters#${it.cluster.id}` : null);
  const open = (it, {page}) => {
    const to = href(it);
    if (!to) return;
    if (page) window.open(to, '_blank', 'noopener'); else location.assign(to);
  };
  const source = it => host.call('document.page', {id: it.document.id, url: it.document.url ?? null}).catch(() => {});
  const d = drawing(el, () => render(h('div', {},
    h(RowList, {...o, items: (o.items ?? []).map(it => it.cluster ? {...it, end: {label: 'Details', onClick: () => { selected = it; d.draw(); }}} : it), onOpen: o.onOpen ?? open, onSource: o.onSource ?? source}),
    h(CollectionDetails, {host, item: selected, onClose: () => { selected = null; d.draw(); }, onOpen: document => (o.onOpen ?? open)({document}, {page: false})})), el));
  return {update(next) { o = {...o, ...next}; d.draw(); }, unmount() { d.unmount(); }};
}

/** The site's shell bar (contract/shell-bar.md *Shell bar*). No host ops; slots are text or Preact nodes. */
export function mountShellBar(el, opts = {}) {
  const doc = el.ownerDocument;
  if (doc?.location?.protocol === 'https:' && doc.location.hostname.endsWith('.wang.team') && !doc.querySelector('script[src="/boarding/client.js"]')) {
    const script = doc.createElement('script');
    script.src = '/boarding/client.js';
    doc.head.append(script);
  }
  let o = opts;
  const d = drawing(el, () => render(h(ShellBar, o), el));
  return {update(next) { o = {...o, ...next}; d.draw(); }, unmount() { d.unmount(); }};
}

/** Phone navigation, mounted by the host immediately below its Find box. */
export function mountNavTiles(el, opts = {}) {
  let o = {...opts};
  const d = drawing(el, () => render(h(NavTiles, o), el));
  return {update(patch) { o = {...o, ...patch}; d.draw(); }, unmount() { d.unmount(); }};
}

/** Stat tiles (contract/foundation.md *Stat tiles*): opts {tiles, onOpen(ref), label}. Answers {update(opts), unmount()}. */
export function mountStatTiles(el, opts = {}) {
  let o = opts;
  const d = drawing(el, () => render(h(StatTiles, o), el));
  return {update(next) { o = {...o, ...next}; d.draw(); }, unmount() { d.unmount(); }};
}

/** The detail drawer (contract/foundation.md *Drawer*): opts {open, title, sub, onClose, children, label}; children is text or a Preact node.
 *  Answers {update(opts), unmount()}. */
export function mountDrawer(el, opts = {}) {
  let o = opts;
  const d = drawing(el, () => render(h(Drawer, o), el));
  return {update(next) { o = {...o, ...next}; d.draw(); }, unmount() { d.unmount(); }};
}

export {formatQuantity, money, delta, toneFor, dateSection} from './quantity.js';
export {StatTiles, Drawer};
export {Facts} from './view/drawer.js';

/** The House page (contract/house.md *House*), offered only where the host's registry has a habitat backend (`host.backends`); else nothing
 *  is drawn. opts: `view` tablet | phone | admin, `brand`, `nav`, `current` (the shell bar, phone and admin), `quick` (entity ids),
 *  `rooms` ({area: name}), `chart` (an entity charted hourly over 24 h; default the outdoor temperature, none on admin), `timeZone`,
 *  `clock`. Answers {house, update(opts), unmount()}; `house` is null when not offered. */
export function mountHouse(el, host, opts = {}) {
  if (!host.backends?.includes('habitat')) return {house: null, update() {}, unmount() {}};
  let o = opts;
  const view = o.view ?? 'tablet';
  const house = createHouse(host, {clock: o.clock, admin: view === 'admin', chart: view === 'admin' ? null : o.chart});
  const d = drawing(el, () => render(h(House, {house, host, opts: o}), el));
  house.subscribe(() => d.draw());
  house.start();
  return {house, update(next) { o = {...o, ...next}; d.draw(); }, unmount() { house.stop(); d.unmount(); }};
}

/** The Accounts page (contract/accounts.md *Accounts*), offered where the host has registered backends (`host.backends`); else nothing is
 *  drawn. Fetched now and whenever the host emits `needs` (a needs change); no timer. opts: `brand`, `nav`, `current`, `clock`. Answers {accounts, refresh(), update(opts), unmount()}; `accounts` is
 *  null when not offered. */
export function mountAccounts(el, host, opts = {}) {
  if (!host.backends?.length) return {accounts: null, refresh() {}, update() {}, unmount() {}};
  let o = opts;
  const accounts = createAccounts(host, {clock: o.clock});
  const d = drawing(el, () => render(h(Accounts, {accounts, opts: o}), el));
  accounts.subscribe(() => d.draw());
  const off = host.on?.('needs', () => accounts.refresh());
  accounts.start();
  return {accounts, refresh: () => accounts.refresh(), update(next) { o = {...o, ...next}; d.draw(); }, unmount() { off?.(); accounts.stop(); d.unmount(); }};
}

/** Health is hidden until allos.me verifies the owner; errors clear it. opts.onRecord overrides the shared viewer. */
export function mountHealth(el, host, opts = {}) {
  const health = createHealth(host);
  let viewer = null;
  const v = createViewer(host, {onClose: () => { viewer = null; v.reset(); d.draw(); }});
  const onRecord = opts.onRecord ?? (target => { viewer = v; v.open({health: target, title: target.title}); d.draw(); });
  const d = drawing(el, () => render(viewer ? h(Viewer, {v, env: {mod: 'Control'}}) : h(Health, {health, host, opts: {...opts, onRecord}}), el));
  health.subscribe(() => { if (!health.owner) { viewer = null; v.reset(); } d.draw(); });
  v.subscribe(() => d.draw());
  health.start();
  return {health, refresh: () => health.refresh(), unmount() { health.stop(); v.reset(); d.unmount(); }};
}

/** Vehicles: exact per-vehicle HA field ids in opts.mapping; papers/photos use the shared viewer. */
export function mountVehicles(el, host, opts = {}) {
  const vehicles = createVehicles(host, opts);
  let viewing = false;
  const viewer = createViewer(host, {onClose: () => { viewing = false; viewer.reset(); d.draw(); }});
  const onOpen = opts.onOpen ?? (document => { if (!document?.id) return; viewing = true; viewer.open({id: document.id, document}); d.draw(); });
  const d = drawing(el, () => render(viewing ? h(Viewer, {v: viewer, env: {mod: 'Control'}}) : h(Vehicles, {model: vehicles, host, onOpen}), el));
  vehicles.subscribe(() => d.draw());
  viewer.subscribe(() => d.draw());
  vehicles.refresh();
  return {vehicles, refresh: () => vehicles.refresh(), unmount() { vehicles.stop(); viewer.reset(); d.unmount(); }};
}

/** Properties and their indexed papers, using the shared document viewer. */
export function mountProperties(el, host, opts = {}) {
  const properties = createProperties(host, opts);
  let viewing = false;
  const viewer = createViewer(host, {onClose: () => { viewing = false; viewer.reset(); d.draw(); }});
  const onOpen = opts.onOpen ?? (document => { if (!document?.id) return; viewing = true; viewer.open({id: document.id, document}); d.draw(); });
  const d = drawing(el, () => render(viewing ? h(Viewer, {v: viewer, env: {mod: 'Control'}}) : h(Properties, {model: properties, host, onOpen}), el));
  properties.subscribe(() => d.draw());
  viewer.subscribe(() => d.draw());
  properties.refresh();
  return {properties, refresh: () => properties.refresh(), unmount() { properties.stop(); viewer.reset(); d.unmount(); }};
}

export function mountInsurance(el, host, opts = {}) {
  const insurance = createInsurance(host, opts);
  let viewing = false;
  const viewer = createViewer(host, {onClose: () => { viewing = false; viewer.reset(); d.draw(); }});
  const onOpen = opts.onOpen ?? (document => { if (!document?.id) return; viewing = true; viewer.open({id: document.id, document}); d.draw(); });
  const d = drawing(el, () => render(viewing ? h(Viewer, {v: viewer, env: {mod: 'Control'}}) : h(Insurance, {model: insurance, host, onOpen}), el));
  insurance.subscribe(() => d.draw());
  viewer.subscribe(() => d.draw());
  insurance.refresh();
  return {insurance, refresh: () => insurance.refresh(), unmount() { insurance.stop(); viewer.reset(); d.unmount(); }};
}

export function mountPapers(el, host, opts = {}) {
  const papers = createPapers(host, opts);
  let viewing = false;
  const viewer = createViewer(host, {onClose: () => { viewing = false; viewer.reset(); d.draw(); }});
  const onOpen = opts.onOpen ?? (document => { if (!document?.id) return; viewing = true; viewer.open({id: document.id, document}); d.draw(); });
  const d = drawing(el, () => render(viewing ? h(Viewer, {v: viewer, env: {mod: 'Control'}}) : h(Papers, {model: papers, host, onOpen}), el));
  papers.subscribe(() => d.draw());
  viewer.subscribe(() => d.draw());
  papers.refresh();
  return {papers, refresh: () => papers.refresh(), unmount() { papers.stop(); viewer.reset(); d.unmount(); }};
}

/** Read-only Security foundation; sources are protected HTTP adapters (SECURITY.md). */
export function mountSecurity(el, sources = {}) {
  const security = createSecurity(sources);
  const d = drawing(el, () => render(h(Security, {security}), el));
  security.subscribe(() => d.draw());
  security.refresh();
  return {security, refresh: () => security.refresh(), unmount() { security.stop(); d.unmount(); }};
}

export function mountTaxes(el, host, opts = {}) {
  const taxes = createTaxes(host, opts);
  let viewing = false;
  const viewer = createViewer(host, {onClose: () => { viewing = false; viewer.reset(); d.draw(); }});
  const onOpen = opts.onOpen ?? (document => { if (!document?.id) return; viewing = true; viewer.open({id: document.id, document}); d.draw(); });
  const d = drawing(el, () => render(viewing ? h(Viewer, {v: viewer, env: {mod: 'Control'}}) : h(Taxes, {model: taxes, host, onOpen}), el));
  taxes.subscribe(() => d.draw());
  viewer.subscribe(() => d.draw());
  taxes.refresh();
  return {taxes, refresh: () => taxes.refresh(), unmount() { taxes.stop(); viewer.reset(); d.unmount(); }};
}

export function mountThings(el, host, opts = {}) {
  const things = createThings(host, opts);
  let viewing = false;
  const viewer = createViewer(host, {onClose: () => { viewing = false; viewer.reset(); d.draw(); }});
  const onOpen = opts.onOpen ?? (document => { if (!document?.id) return; viewing = true; viewer.open({id: document.id, document}); d.draw(); });
  const d = drawing(el, () => render(viewing ? h(Viewer, {v: viewer, env: {mod: 'Control'}}) : h(Things, {model: things, host, onOpen}), el));
  things.subscribe(() => d.draw());
  viewer.subscribe(() => d.draw());
  things.refresh();
  return {things, refresh: () => things.refresh(), unmount() { things.stop(); viewer.reset(); d.unmount(); }};
}

/** Flightplan (contract/flightplan.md) on its own page: opts `brand`, `nav`, `current` (the nav bar), `tab` (todos | board; else
 *  the page's `#board`), `clock`. The page's `#needs` (the nav's Needs) scrolls to Needs you once it is read. Fetched now and on
 *  `refresh()`; no timer. Answers {flightplan, refresh(), unmount()}. */
export function mountFlightplan(el, host, opts = {}) {
  const flightplan = createFlightplan(host, {clock: opts.clock});
  const d = drawing(el, () => render(h(Flightplan, {model: flightplan, host, opts}), el));
  const hash = el.ownerDocument?.location?.hash ?? '';
  flightplan.subscribe(() => d.draw());
  flightplan.refresh().then(() => { if (hash === '#needs') setTimeout(() => el.querySelector('#needs')?.scrollIntoView?.({block: 'start'}), 0); });
  if ((opts.tab ?? (hash === '#board' ? 'board' : null)) === 'board') flightplan.setTab('board');
  return {flightplan, refresh: () => (flightplan.tab === 'board' ? flightplan.refreshBoard() : flightplan.refresh()), unmount() { flightplan.stop(); d.unmount(); }};
}

/** People without palette search chrome or literal search results. */
export function mountPeople(el, host, opts = {}) {
  const onOpen = opts.onOpen ?? (document => docPage({id: document.id}));
  const d = drawing(el, () => render(h(People, {host, onOpen}), el));
  return {unmount() { d.unmount(); }};
}

/** Consumer route entry: shell and standalone collection, with document scrolling.
 * opts.path defaults to the page pathname; opts.nav are resolved bundle nav. */
export function mountCollectionPage(el, host, opts = {}) {
  const id = (opts.path ?? el.ownerDocument.location.pathname).replace(/^\//, '').replace(/\/$/, '');
  const mount = {people: mountPeople, vehicles: mountVehicles, properties: mountProperties,
    insurance: mountInsurance, papers: mountPapers, taxes: mountTaxes, things: mountThings,
    // the page's bar is this one: Flightplan draws none of its own
    flightplan: (el, host, opts) => mountFlightplan(el, host, {...opts, nav: undefined})}[id];
  if (!mount) throw new Error('Unknown collection page');
  return mountPage(el, host, opts, id, mount);
}

/** Health with the common shell, for HTML documents served at /health (contract/health.md). */
export function mountHealthPage(el, host, opts = {}) {
  return mountPage(el, host, opts, 'health', (el, host, opts) => mountHealth(el, host, {...opts, nav: undefined}));
}

function mountPage(el, host, opts, id, mount) {
  const shell = el.ownerDocument.createElement('div'), content = el.ownerDocument.createElement('div');
  el.append(shell, content);
  content.className = 'dk-collection-page';
  const bar = mountShellBar(shell, {...opts, host, current: id});
  const page = mount(content, host, opts);
  return {page, unmount() { page.unmount(); bar.unmount(); shell.remove(); content.remove(); }};
}

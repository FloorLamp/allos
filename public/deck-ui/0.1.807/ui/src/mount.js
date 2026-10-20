// Public mounts load only the selected page graph. Handles are synchronous; ready resolves after module/style loading and initialization.
import {lazyMount} from './mount-runtime.js';
import {setFailurePage} from './failure.js';
export {styles} from './mount-runtime.js';
export {createNeeds, needsFor} from './needs.js';
export {siteHost, siteNeeds} from './host/site.js';
export {formatQuantity, money, delta, toneFor} from './quantity.js';
export {dateSection} from './format.js';
export {StatTiles} from './view/stat-tiles.js';
export {Drawer, Facts} from './view/drawer.js';

export function mountViewer(el, host, opts = {}) {
  return lazyMount(el, 'Viewer', () => import('./mounts/viewer.js'), m => m.mountViewer(el, host, opts), ['open'], 'viewer');
}

export function mountDetails(el, host, opts = {}) {
  return lazyMount(el, 'Details', () => import('./mounts/details.js'), m => m.mountDetails(el, host, opts), ['follow'], 'details');
}

export function mountPalette(el, host, opts = {}) {
  return lazyMount(el, 'Palette', () => import('./mounts/palette.js'), m => m.mountPalette(el, host, opts), ['find', 'ask', 'browse', 'group'], 'controller');
}

export function mountRows(el, host, opts = {}) {
  return lazyMount(el, 'Rows', () => import('./mounts/rows.js'), m => m.mountRows(el, host, opts), ['update'], null);
}

export function mountAsks(el, host, opts = {}) {
  return lazyMount(el, 'Asks', () => import('./mounts/asks.js'), m => m.mountAsks(el, host, opts), ['update'], null);
}

export function mountShellBar(el, opts = {}) {
  return lazyMount(el, 'ShellBar', () => import('./mounts/shell-bar.js'), m => m.mountShellBar(el, opts), ['update'], null);
}

export function mountNavTiles(el, opts = {}) {
  return lazyMount(el, 'NavTiles', () => import('./mounts/nav-tiles.js'), m => m.mountNavTiles(el, opts), ['update'], null);
}

export function mountStatTiles(el, opts = {}) {
  return lazyMount(el, 'StatTiles', () => import('./mounts/stat-tiles.js'), m => m.mountStatTiles(el, opts), ['update'], null);
}

export function mountDrawer(el, opts = {}) {
  return lazyMount(el, 'Drawer', () => import('./mounts/drawer.js'), m => m.mountDrawer(el, opts), ['update'], null);
}

export function mountHouse(el, host, opts = {}) {
  if (!host.backends?.includes('habitat')) return {house: null, offered: false, ready: Promise.resolve(), update() {}, unmount() {}};
  return lazyMount(el, 'House', () => import('./mounts/house.js'), m => m.mountHouse(el, host, opts), ['update'], 'house');
}

export function mountAccounts(el, host, opts = {}) {
  if (!host.backends?.length) return {accounts: null, offered: false, ready: Promise.resolve(), refresh() {}, update() {}, unmount() {}};
  return lazyMount(el, 'Accounts', () => import('./mounts/accounts.js'), m => m.mountAccounts(el, host, opts), ['refresh', 'update'], 'accounts');
}

export function mountHealth(el, host, opts = {}) {
  return lazyMount(el, 'Health', () => import('./mounts/health.js'), m => m.mountHealth(el, host, opts), ['refresh'], 'health');
}

export function mountVehicles(el, host, opts = {}) {
  return lazyMount(el, 'Vehicles', () => import('./mounts/vehicles.js'), m => m.mountVehicles(el, host, opts), ['refresh'], 'vehicles');
}

export function mountProperties(el, host, opts = {}) {
  return lazyMount(el, 'Properties', () => import('./mounts/properties.js'), m => m.mountProperties(el, host, opts), ['refresh'], 'properties');
}

export function mountInsurance(el, host, opts = {}) {
  return lazyMount(el, 'Insurance', () => import('./mounts/insurance.js'), m => m.mountInsurance(el, host, opts), ['refresh'], 'insurance');
}

export function mountPapers(el, host, opts = {}) {
  return lazyMount(el, 'Papers', () => import('./mounts/papers.js'), m => m.mountPapers(el, host, opts), ['refresh'], 'papers');
}

export function mountSecurity(el, sources = {}) {
  return lazyMount(el, 'Security', () => import('./mounts/security.js'), m => m.mountSecurity(el, sources), ['refresh'], 'security');
}

export function mountTaxes(el, host, opts = {}) {
  return lazyMount(el, 'Taxes', () => import('./mounts/taxes.js'), m => m.mountTaxes(el, host, opts), ['refresh'], 'taxes');
}

export function mountThings(el, host, opts = {}) {
  return lazyMount(el, 'Things', () => import('./mounts/things.js'), m => m.mountThings(el, host, opts), ['refresh'], 'things');
}

export function mountPurchases(el, host, opts = {}) {
  return lazyMount(el, 'Purchases', () => import('./mounts/purchases.js'), m => m.mountPurchases(el, host, opts));
}

export function mountFlightplan(el, host, opts = {}) {
  return lazyMount(el, 'Flightplan', () => import('./mounts/flightplan.js'), m => m.mountFlightplan(el, host, opts), ['refresh'], 'flightplan');
}

export function mountTodo(el, host, opts = {}) {
  return lazyMount(el, 'Todo', () => import('./mounts/todo.js'), m => m.mountTodo(el, host, opts), ['refresh'], 'flightplan');
}

export function mountPeople(el, host, opts = {}) {
  return lazyMount(el, 'People', () => import('./mounts/people.js'), m => m.mountPeople(el, host, opts), [], null);
}

export function mountNotes(el, host, opts = {}) {
  return lazyMount(el, 'Notes', () => import('./mounts/notes.js'), m => m.mountNotes(el, host, opts), ['refresh'], 'notes');
}

export function mountTexts(el, host, opts = {}) {
  return lazyMount(el, 'Texts', () => import('./mounts/texts.js'), m => m.mountTexts(el, host, opts), ['refresh'], 'texts');
}

export function mountGlance(el, host) {
  return lazyMount(el, 'Glance', () => import('./mounts/glance.js'), m => m.mountGlance(el, host), [], 'glance');
}

export function mountAttention(el, host, opts = {}) {
  return lazyMount(el, 'Attention', () => import('./mounts/attention.js'), m => m.mountAttention(el, host, opts), ['refresh'], 'attention');
}

export function mountClusters(el, host, opts = {}) {
  return lazyMount(el, 'Clusters', () => import('./mounts/clusters.js'), m => m.mountClusters(el, host, opts), ['refresh'], 'clusters');
}

export function mountProjects(el, host, opts = {}) {
  return lazyMount(el, 'Projects', () => import('./mounts/projects.js'), m => m.mountProjects(el, host, opts), ['refresh'], 'projects');
}

export function mountCollectionPage(el, host, opts = {}) {
  // A page owns its paths below it too (`/todo/<list>`, `/flightplan/FP-<id>`).
  const id = (opts.path ?? el.ownerDocument.location.pathname).split('/')[1] ?? '';
  const mount = {people: mountPeople, vehicles: mountVehicles, properties: mountProperties,
    insurance: mountInsurance, papers: mountPapers, taxes: mountTaxes, things: mountThings, purchases: mountPurchases, clusters: mountClusters, texts: mountTexts, notes: mountNotes,
    // the page's bar is this one: Flightplan and Todo draw none of their own
    flightplan: (el, host, opts) => mountFlightplan(el, host, {...opts, nav: undefined}), todo: (el, host, opts) => mountTodo(el, host, {...opts, nav: undefined})}[id];
  if (!mount) throw new Error('Unknown collection page');
  // bridge answers this page: its failures name the page (Texts), not Find
  setFailurePage((opts.nav ?? []).find(entry => entry.id === id)?.label ?? id.replace(/^./, c => c.toUpperCase()));
  return mountPage(el, host, opts, id, mount);
}

export function mountHealthPage(el, host, opts = {}) {
  return mountPage(el, host, opts, 'health', (el, host, opts) => mountHealth(el, host, {...opts, nav: undefined}));
}

export function mountMoneyPage(el, host, opts = {}) {
  return mountPage(el, host, opts, 'money', (content, host, options) =>
    lazyMount(content, 'Money', () => import('./mounts/money.js'), m => m.mountMoneyContent(content, host, options), ['refresh']));
}

function mountPage(el, host, opts, id, mount) {
  const shell = el.ownerDocument.createElement('div'), content = el.ownerDocument.createElement('div');
  el.append(shell, content);
  shell.className = 'ds-page-shell';
  content.className = 'dk-collection-page';
  const bar = mountShellBar(shell, {...opts, host, current: id});
  const page = mount(content, host, opts, bar);
  return {bar, page, ready: Promise.all([bar.ready, page.ready]), unmount() { page.unmount(); bar.unmount(); shell.remove(); content.remove(); }};
}

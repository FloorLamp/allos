import {render} from '../vendor/preact.mjs';
import {MOUNT_STYLES} from './mount-styles.js';
import {recordHref} from './collection-target.js';

const adding = new WeakMap();
// The web host's bundle (build-web.mjs): each sheet's hashed file, null for one already in the page's own stylesheet.
const bundled = typeof DECK_WEB === 'object' ? DECK_WEB.sheets : null;
/** Add a mount's required sheets once per document. Existing host-owned sheets are already available. */
export function styles(doc = document, mount = 'Palette') {
  let pending = adding.get(doc);
  if (!pending) adding.set(doc, pending = new Map());
  const have = new Set([...doc.querySelectorAll('link[rel="stylesheet"]')].map(l => l.href));
  const sheets = ['tokens.css', 'base.css', ...(MOUNT_STYLES[mount] ?? []).map(f => `view/${f}.css`)].filter(f => !bundled || bundled[f]);
  return Promise.all(sheets.map(f => {
    const href = bundled ? new URL(bundled[f], doc.baseURI).href : new URL(`./${f}`, import.meta.url).href;
    if (pending.has(href)) return pending.get(href);
    if (have.has(href)) return;
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    const settled = new Promise(resolve => {
      link.addEventListener('load', resolve, {once: true});
      link.addEventListener('error', resolve, {once: true});
    });
    pending.set(href, settled);
    doc.head.append(link);
    return settled;
  }));
}

/** Defer layout measurements until this mount's sheets settle; never paint after unmount. */
export function drawing(el, mount, paint) {
  let state = 'waiting';
  const styled = styles(el.ownerDocument, mount).then(() => {
    if (state === 'waiting') { state = 'shown'; paint(); }
  });
  return {styled, draw() { if (state === 'shown') paint(); }, unmount() { state = 'gone'; render(null, el); }};
}

/** Synchronous mount handle, async page graph. Actions queue; model getters become available after ready. */
export function lazyMount(el, name, load, mount, methods = [], model = null) {
  let instance = null, gone = false, error = null, failed = null, draining = false;
  const queued = [];
  const styled = styles(el.ownerDocument, name);
  const ready = Promise.all([load(), styled]).then(async ([module]) => {
    if (gone) return;
    instance = mount(module);
    // Drain on construction, before waiting for model startup. Later actions cannot overtake earlier queued input.
    draining = true;
    while (queued.length) {
      const {method, args, resolve, reject} = queued.shift();
      try { resolve(gone ? undefined : instance[method](...args)); } catch (error) { reject(error); }
    }
    draining = false;
    await instance.ready;
  });
  // Hosts may only need unmount(). Keep a failed import observable through ready without an unhandled rejection.
  ready.catch(reason => {
    failed = reason;
    for (const action of queued.splice(0)) action.reject(reason);
    if (gone) return;
    instance?.unmount();
    instance = null;
    error = el.ownerDocument.createElement('p');
    error.setAttribute('role', 'alert');
    error.textContent = 'This page could not load. Reload to try again.';
    el.replaceChildren(error);
  });
  const handle = {ready, draw() { instance?.draw?.(); }, unmount() {
    if (gone) return;
    gone = true;
    for (const action of queued.splice(0)) action.resolve();
    instance?.unmount();
    error?.remove();
  }};
  if (model) Object.defineProperty(handle, model, {enumerable: true, get: () => instance?.[model] ?? null});
  for (const method of methods) handle[method] = (...args) => {
    if (gone) return;
    if (failed) return Promise.reject(failed);
    if (instance && !draining) return instance[method](...args);
    return new Promise((resolve, reject) => queued.push({method, args, resolve, reject}));
  };
  return handle;
}

/** A collection record's page on the site: its full view over its collection's page in the shell's navigation, its row open under it
 *  (`/vehicles?record=<id>#<id>`: Back is the list with that row open), else null. */
export const recordPage = ({collection} = {}, nav = []) => {
  const href = collection && nav.find(p => p.collection === true && p.id === collection.collection)?.href;
  return href ? recordHref(collection, href) : null;
};
export const docPage = ({id, query}) => { location.assign(`/doc/${id}${query ? `?q=${encodeURIComponent(query)}` : ''}`); };

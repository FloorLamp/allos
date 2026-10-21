import {createDetailURL} from './detail-url.js';
import {h, render} from '../../vendor/preact.mjs';
import {mountRows, mountDrawer, mountStatTiles} from '../mount.js';
import {formatQuantity, money as moneyQuantity} from '../quantity.js';
import {dateSection, dateText} from '../format.js';
import {MONEY_ARGS} from '../host/money.js';
import {webSignIn} from '../failure.js';
import {HostError} from '../host/host.js';
import {createFixBar} from './fix.js';
import {transactionActions, transactionContent} from './transaction.js';
import {focusTransactionRow, transactionRowKeys} from './transaction-focus.js';

/** Purser's cents as money: `+$12.50` in, `−$42.50` out (`sign: false` drops the `+`). */
export const money = (cents, {sign = true} = {}) => formatQuantity({value: cents / 100, format: 'currency', unit: 'USD', sign: sign ? 'always' : 'auto'});
/** A transaction's day: `Oct 15` this year, `Oct 15, 2025` before. */
export const day = iso => dateText(String(iso).slice(0, 10), {now: new Date()});
export function quantity(value, unit, {currency = false} = {}) {
  if (value === null || !Number.isFinite(Number(value))) return '–';
  const n = Number(value);
  return formatQuantity(currency && /^[A-Z]{3}$/.test(unit ?? '') ? {value: n, format: 'currency', unit}
    : {value: n, unit, precision: Math.min(15, String(n).split('.')[1]?.length ?? 0)});
}

/** Translate the old page reads to the existing documented host operations; never fetch or delegate a standard read. */
export function moneyRead(path) {
  const url = new URL(path, 'https://money.invalid');
  if (!url.pathname.startsWith('/api/')) return null;
  const parts = url.pathname.slice(5).split('/');
  let name = parts[0] === 'account-management' ? 'accountManagement' : parts.join('.');
  const args = Object.fromEntries(url.searchParams);
  if (['merchant', 'txn'].includes(parts[0]) && parts.length === 2) {
    name = parts[0]; args.id = Number(parts[1]);
  }
  const op = `money.${name}`;
  if (!MONEY_ARGS[op]) return null;
  for (const key of ['limit', 'offset']) if (key in args) args[key] = Number(args[key]);
  return {op, args};
}

export function createMoneyContext(root, host, opts, navigate, onDispose) {
  const doc = root.ownerDocument;
  const abort = new AbortController();
  const handles = new Set(), rendered = new Set(), timers = new Set(), reads = new Map();
  const owner = host.kind === 'web' ? opts.owner : null;
  const base = opts.basePath ?? '/money';
  let current = new URL(`${opts.path ?? '/'}${opts.query ? `?${String(opts.query).replace(/^\?/, '')}` : ''}`, 'https://deck.wang.team');
  const based = href => {
    if (!href.startsWith('/') || href.startsWith('//') || href.startsWith('/boarding/') || href.startsWith('/money') || href.startsWith('/doc/')) return href;
    const url = new URL(href, 'https://money.invalid');
    return `${base}${url.pathname}${url.search}${url.hash}`;
  };
  const signIn = () => owner?.signIn?.() ?? webSignIn(opts.href ?? `https://deck.wang.team${base}${current.pathname}${current.search}`);
  const follow = href => navigate(based(href));
  const location = {
    get pathname() { return current.pathname; }, get search() { return current.search; },
    get href() { return opts.href ?? `https://deck.wang.team${base}${current.pathname}${current.search}`; },
    assign: follow, reload: () => owner?.reload?.(),
  };
  const history = {replaceState(_state, _unused, href) {
    current = new URL(href, current);
    opts.onReplace?.(based(href));
  }};
  const document = {
    createElement: doc.createElement.bind(doc), createTextNode: doc.createTextNode.bind(doc), body: root,
    querySelector: root.querySelector.bind(root), querySelectorAll: root.querySelectorAll.bind(root),
    addEventListener(type, fn, options = {}) { root.addEventListener(type, fn, {...options, signal: abort.signal}); },
    get title() { return doc.title; }, set title(value) { opts.onTitle?.(value); },
  };
  const api = async path => {
    if (abort.signal.aborted) throw new HostError('cancelled');
    const read = moneyRead(path);
    const key = read && JSON.stringify(read);
    if (read && !reads.has(key)) {
      const pending = Promise.resolve().then(() => host.call(read.op, read.args, {signal: abort.signal}));
      reads.set(key, pending);
      pending.then(() => reads.delete(key), () => reads.delete(key));
    }
    const result = read ? await reads.get(key)
      : path === '/api/session' ? await session() : owner?.get ? await owner.get(path) : (() => { throw new HostError('unsupported', 'Open in Deck web to use owner actions.'); })();
    if (abort.signal.aborted) throw new HostError('cancelled');
    return result;
  };
  const post = (path, body) => {
    if (abort.signal.aborted) return Promise.reject(new HostError('cancelled'));
    if (!owner?.post) return Promise.reject(new HostError('unsupported', 'Open in Deck web to use owner actions.'));
    return owner.post(path, body);
  };
  const session = async () => {
    const value = owner?.session ? await owner.session() : {owner: false, configured: false};
    if (abort.signal.aborted) throw new HostError('cancelled');
    return value;
  };
  const el = (tag, props = {}, ...kids) => {
    const e = Object.assign(doc.createElement(tag), props);
    if (props.href) e.setAttribute('href', props.href.startsWith('/boarding/') ? signIn() : based(props.href));
    e.append(...kids.filter(k => k !== null && k !== undefined && k !== false));
    return e;
  };
  const track = fn => (...args) => {
    const handle = fn(...args); handles.add(handle);
    if (abort.signal.aborted) handle.unmount?.();
    return handle;
  };
  const rows = (el, suppliedHost, options = {}) => mountRows(el, suppliedHost, {onOpen: (item, {page} = {}) => {
    if (!item.href) return;
    if (page) return host.call('url.open', {url: new URL(based(item.href), location.href).href});
    return follow(item.href);
  }, ...options});
  const mounts = {mountRows: track(rows), mountDrawer: track(mountDrawer), mountStatTiles: track(mountStatTiles), money: moneyQuantity, dateSection, host};
  const deckUi = path => {
    if (path === 'ui/vendor/preact.mjs') return Promise.resolve({h, render(v, el) { rendered.add(el); return render(v, el); }});
    if (path === 'ui/src/view/chart.js') return import('../view/chart.js');
    if (path === 'ui/src/view/rows.js') return import('../view/rows.js');
    throw new HostError('unsupported');
  };
  // the query keys drawers keep (`txn`, `detail`): Back between them is the page's, not a page change (index.js)
  const detailKeys = new Set();
  const detailURL = (key, show) => detailKeys.add(key) && createDetailURL({key, show,
    getURL: () => current,
    setURL: url => {
      if (base && (url.pathname === base || url.pathname.startsWith(base + '/')))
        url.pathname = url.pathname.slice(base.length) || '/';
      current = url;
    },
    based, window: doc.defaultView, web: host.kind === 'web',
    replace: href => opts.onReplace?.(href), onDispose,
  });
  const ctx = {detailURL, detailKeys, host, owner, $, api, post, el, session, mountMoneyPage: async () => mounts, deckUi, money, day, quantity, signIn,
    ready: () => Promise.all([...handles].map(handle => handle.ready)),
    document, location, history, window: {}, localStorage: owner?.storage?.local,
    sessionStorage: owner?.storage?.tab, confirm: text => owner?.confirm?.(text) ?? false,
    prompt: (text, value) => owner?.prompt?.(text, value), alert: text => owner?.alert?.(text),
    setTimeout(fn, ms) { const id = setTimeout(() => { timers.delete(id); if (!abort.signal.aborted) fn(); }, ms); timers.add(id); return id; },
    clearTimeout(id) { timers.delete(id); clearTimeout(id); }, transactionActions, transactionContent, focusTransactionRow,
    transactionRowKeys(el, open) { const dispose = transactionRowKeys(el, open); onDispose(dispose); },
  };
  function $(id) { return root.querySelector(`[data-money-id="${id}"]`); }
  ctx.fixBar = createFixBar(ctx);
  const normalize = () => {
    for (const a of root.querySelectorAll('a[href],form[action]')) {
      if (a.hasAttribute('data-entity')) continue; // EntityLink owns its site-wide destination.
      const key = a.tagName === 'FORM' ? 'action' : 'href', original = a.getAttribute(key);
      const href = original.startsWith('/boarding/') ? signIn() : based(original);
      if (href !== original) a.setAttribute(key, href);
    }
  };
  const observer = new doc.defaultView.MutationObserver(normalize);
  observer.observe(root, {childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'action']});
  normalize();
  root.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link || event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); follow(link.getAttribute('href'));
  }, {signal: abort.signal});
  onDispose(() => {
    abort.abort(); observer.disconnect();
    for (const id of timers) clearTimeout(id);
    for (const handle of handles) handle.unmount?.();
    for (const el of rendered) render(null, el);
  });
  return ctx;
}

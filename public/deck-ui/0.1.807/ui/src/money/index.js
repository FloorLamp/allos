import {Fragment, h, render} from '../../vendor/preact.mjs';
import {PageHeader} from '../view/page-header.js';
import {PageState, StateBlock} from '../view/page-state.js';
import {moneyPage, PLAID_PAGE} from './routes.js';
import {pageTemplate, pageTitle} from './templates.js';
import {createMoneyContext} from './context.js';

const PAGES = {
  page: () => import('./page.js'), overview: () => import('./overview.js'), reports: () => import('./reports.js'),
  merchant: () => import('./merchant.js'), merchants: () => import('./merchants.js'), accounts: () => import('./accounts.js'),
  classification: () => import('./classification.js'), review: () => import('./review.js'), imports: () => import('./imports.js'),
  link: () => import('./link.js'), subscriptions: () => import('./subscriptions.js'), investments: () => import('./investments.js'),
  'tax-spending': () => import('./tax-spending.js'),
};
const PRIMARY = [['/', 'Overview'], ['/transactions', 'Transactions'], ['/review', 'Review'], ['/spending', 'Spending'], ['/accounts', 'Accounts'], ['/rules', 'Rules']];
const GROUPS = {
  spending: [['/spending', 'By category'], ['/spending/merchants', 'By merchant'], ['/spending/recurring', 'Recurring'], ['/spending/tax', 'Tax spending']],
  accounts: [['/accounts', 'Accounts'], ['/accounts/connections', 'Connections'], ['/accounts/imports', 'Imports'], ['/accounts/investments', 'Investments']],
  rules: [['/rules', 'Rules'], ['/rules/categories', 'Categories']],
};
const DESCRIPTIONS = {
  page: 'Your spending, one transaction at a time.', overview: 'A clear view of your money this month.',
  reports: 'See where your money goes and how it changes.', merchant: 'Activity, categories and the details behind them.',
  merchants: 'Explore your spending by merchant.', accounts: 'Your accounts, history and connected sources.',
  classification: 'Keep your categories consistent.', review: 'A few decisions to keep your ledger in order.',
  imports: 'The source records behind your ledger.', link: 'Manage your bank connections.',
  subscriptions: 'Recurring payments, together in one place.', investments: 'Holdings, activity and account history.',
  'tax-spending': 'Prepare a clear spending record for tax review.',
};
let sequence = 0;

/** Tabs wider than their row scroll; a fade marks the side with more (`data-fade`: start, end or both). Answers its disposer. */
function fadeEdges(tabs, win) {
  const sync = () => {
    const room = tabs.scrollWidth - tabs.clientWidth, at = tabs.scrollLeft;
    tabs.dataset.fade = room <= 1 ? '' : [at > 1 ? 'start' : '', at < room - 1 ? 'end' : ''].filter(Boolean).join(' ');
  };
  tabs.addEventListener('scroll', sync, {passive: true});
  const observer = win?.ResizeObserver ? new win.ResizeObserver(sync) : null;
  observer?.observe(tabs);
  sync();
  return () => { tabs.removeEventListener('scroll', sync); observer?.disconnect(); };
}

/** Arrange the existing controls without changing their IDs, handlers or filter values. */
function layout(main, page, doc) {
  const make = (tag, className) => { const node = doc.createElement(tag); node.className = className; return node; };
  const head = main.querySelector('.head'), title = head.querySelector('h1');
  main.classList.add('dk-page');
  const intro = make('div', 'dm-page-intro');
  render(h(PageHeader, {title: title.textContent, description: DESCRIPTIONS[page], tabs: h('div', {class: 'dm-navigation-slot'})}), intro);
  intro.querySelector('h1').replaceWith(title); head.before(intro); head.classList.add('dm-navigation');
  intro.querySelector('.dm-navigation-slot').append(head);
  if (page === 'overview') {
    const next = make('div', 'dm-next'), transactions = make('a', 'btn primary');
    transactions.href = '/transactions?sort=newest&kind=spending'; transactions.textContent = 'View transactions';
    next.append(transactions, main.querySelector('a.btn')); main.append(next);
  }
  if (page === 'review') {
    const help = main.querySelector('aside'), disclosure = make('details', 'dm-keyboard-help'), summary = make('summary', 'dm-utility-title');
    summary.textContent = 'Keyboard shortcuts'; help.before(disclosure); disclosure.append(summary, help);
  }
  if (page !== 'page') return;
  const find = id => main.querySelector(`#${id}`);
  const filters = main.querySelector('.filters'), search = make('div', 'dm-search-row');
  search.append(find('q'), find('account'), find('kind'), find('filter-toggle'));
  filters.prepend(search);
  const advanced = find('filter-options'); advanced.classList.add('dm-advanced-filters');
  for (const [id, label] of [['preset', 'Period'], ['from', 'From'], ['to', 'To'], ['min', 'Minimum amount'], ['max', 'Maximum amount']]) {
    const input = find(id), field = make('label', 'dm-filter-field'), caption = make('span', 'dm-field-label');
    caption.textContent = label; input.before(field); field.append(caption, input);
  }
  const toolbar = make('div', 'dm-ledger-toolbar'), saved = make('details', 'dm-saved-views'), summary = make('summary', 'dm-utility-title');
  summary.textContent = 'Saved views'; saved.append(summary, find('saved-view-controls'), find('view-status'));
  toolbar.append(find('summary'), find('merchant-filter'), find('sort'), saved); filters.after(toolbar);
  const bulk = make('details', 'dm-bulk-actions'), bulkTitle = make('summary', 'dm-utility-title');
  bulk.id = 'bulk-actions'; bulkTitle.textContent = 'Categories & rules'; bulk.append(bulkTitle, find('fix'));
  const actions = make('div', 'dm-ledger-actions'); find('selection').before(actions); actions.append(find('selection'), bulk);
  advanced.append(find('clear'));
}

/** Scoped faithful Purser page renderer. Only the web may receive opts.owner; native content is read-only. */
export function mountMoneyContent(el, host, opts = {}) {
  const doc = el.ownerDocument;
  const root = doc.createElement('div'); root.className = 'dm-money'; el.append(root);
  const base = opts.basePath ?? '/money';
  opts = {path: doc.location ? doc.location.pathname + doc.location.search : '/', ...opts};
  const replaceURL = href => {
    if (opts.onReplace) opts.onReplace(href);
    else if (host.kind === 'web') doc.defaultView.history.replaceState(null, '', href);
  };
  let disposers = [], gone = false, revision = 0, ready;
  const openWeb = () => opts.onOpenWeb ? opts.onOpenWeb(webURL()) : host.call('url.open', {url: webURL()});
  const webURL = () => `https://deck.wang.team/money${route().pathname}${route().search}`;
  const route = () => {
    const path = opts.path ?? '/';
    const parsed = new URL(path, 'https://deck.wang.team');
    if (base && (parsed.pathname === base || parsed.pathname.startsWith(base + '/'))) parsed.pathname = parsed.pathname.slice(base.length) || '/';
    if (opts.query !== undefined) parsed.search = String(opts.query).replace(/^\?/, '');
    return parsed;
  };
  const inMoney = pathname => pathname === base || pathname.startsWith(base + '/');
  // On the web a Money link changes the page in place and pushes its address (Back returns); Connections alone loads its own
  // document (Plaid Link's policy, routes.js). Other hosts swap the page without an address.
  const navigate = href => {
    if (opts.onNavigate) return opts.onNavigate(href);
    const next = new URL(href, 'https://deck.wang.team');
    if (!next.pathname.startsWith('/api/') && next.origin === 'https://deck.wang.team' && inMoney(next.pathname)) {
      if (host.kind === 'web') {
        const address = next.pathname + next.search + next.hash;
        if (moneyPage(next.pathname.slice(base.length) || '/') === PLAID_PAGE) return doc.defaultView.location.assign(address);
        doc.defaultView.history.pushState(null, '', address);
      }
      return refresh({path: next.pathname, query: next.search, href: undefined});
    }
    return host.call('url.open', {url: next.href});
  };
  // Back and Forward between pushed Money addresses; a drawer's own query key (detail-url.js) stays with its page.
  let detailKeys = new Set();
  const shown = url => {
    for (const key of detailKeys) url.searchParams.delete(key);
    return url.pathname + url.search;
  };
  const popped = () => {
    const at = new URL(doc.defaultView.location.href);
    if (!inMoney(at.pathname)) return;
    const next = new URL(at); next.pathname = at.pathname.slice(base.length) || '/';
    if (shown(next) !== shown(route())) refresh({path: at.pathname, query: at.search, href: undefined});
  };
  if (host.kind === 'web' && !opts.onNavigate) doc.defaultView.addEventListener('popstate', popped);
  function notice(message) {
    const p = doc.createElement('p'); p.className = 'dm-web-notice'; p.setAttribute('role', 'status'); p.append(message, ' ');
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'btn'; button.textContent = 'Open in Deck web';
    button.addEventListener('click', openWeb); p.append(button); return p;
  }
  // a Money page this host cannot show: the shared unavailable state, its one action Deck web
  function unavailable(title, main = doc.createElement('main')) {
    main.classList.add('dk-page');
    const state = doc.createElement('div'); main.append(state);
    render(h(StateBlock, {glyph: 'details', alert: false, title, line: 'It comes to this app in a later update; Deck web has it now.', action: 'Open in Deck web', onAction: openWeb}), state);
    root.append(main);
  }
  function cleanup() { for (const dispose of disposers.splice(0).reverse()) dispose(); root.replaceChildren(); }
  async function load() {
    const mine = ++revision;
    cleanup();
    const url = route();
    const path = url.pathname;
    const page = moneyPage(path);
    root.dataset.moneyPage = page ?? 'not-found';
    opts.onTitle?.(page ? pageTitle(page) : 'Page not found · Money');
    if (!host.caps?.money) {
      const main = doc.createElement('main');
      render(h(PageHeader, {title: 'Money'}), main);
      unavailable('Money isn’t available here yet', main);
      return;
    }
    if (!page) {
      const main = doc.createElement('main'); main.className = 'dk-page';
      render(h(Fragment, null, h(PageHeader, {title: 'Money'}),
        h(PageState, {state: 'not found', hint: 'No Money page is at this address.', action: 'Money overview', href: `${base}/`})), main);
      root.append(main);
      return;
    }
    const main = pageTemplate(page, doc);
    layout(main, page, doc);
    const prefix = `dm-${++sequence}-`;
    for (const node of main.querySelectorAll('[id]')) { node.dataset.moneyId = node.id; node.id = prefix + node.id; }
    for (const node of main.querySelectorAll('[for],[aria-controls],[aria-labelledby],[aria-describedby]')) {
      for (const key of ['for', 'aria-controls', 'aria-labelledby', 'aria-describedby']) if (node.hasAttribute(key))
        node.setAttribute(key, node.getAttribute(key).split(' ').map(id => prefix + id).join(' '));
    }
    root.append(main);
    // the page's one state while it loads, fails or has nothing: in the body's place, under the header and tabs
    const slot = doc.createElement('div'); slot.className = 'dm-page-state';
    main.querySelector('.dm-page-intro').after(slot);
    const showState = (name, props) => {
      delete main.dataset.loading; delete main.dataset.failed; delete main.dataset.empty;
      if (name) main.dataset[name] = '';
      render(props ? h(PageState, props) : null, slot);
    };
    showState('loading', {state: 'loading'});
    const replace = replaceURL;
    const ctx = createMoneyContext(main, host, {...opts, path, query: url.search, onReplace(href) {
      const next = new URL(href, 'https://deck.wang.team');
      opts = {...opts, path: next.pathname, query: next.search};
      replace?.(href);
    }}, navigate, fn => {
      if (gone || mine !== revision) fn(); else disposers.push(fn);
    });
    detailKeys = ctx.detailKeys;
    let failed = false;
    /** The page could not load its content: one failure in its place, Retry reloads the page. */
    ctx.fail = error => {
      if (failed || gone || mine !== revision || error?.code === 'cancelled') return;
      failed = true;
      showState('failed', {error, backend: 'purser', title: 'Couldn’t load this page', retry: () => refresh(), host});
    };
    /** Nothing to show yet: one empty state in the page's place. */
    ctx.empty = ({title, line, glyph, action, href}) => {
      if (!failed) showState('empty', {state: 'empty', title, hint: line, glyph});
      if (action) slot.querySelector('.dk-state')?.append(ctx.el('div', {className: 'acts'}, ctx.el('a', {className: 'dk-btn main', href, textContent: action})));
    };
    const nav = root.querySelector('nav[aria-label="Money"]');
    // the page's place in the navigation: a merchant under By merchant, the OAuth return under Connections
    const place = {'/spending/merchant': '/spending/merchants', '/link/oauth': '/accounts/connections'}[path] ?? path;
    const group = place.split('/')[1];
    const active = place === '/' ? '/' : `/${group}`;
    const link = ([href, textContent], selected = active) => {
      const node = ctx.el('a', {href, textContent});
      if (href === selected) node.setAttribute('aria-current', 'page');
      if (href === '/review') node.dataset.reviewCount = '';
      return node;
    };
    nav.replaceChildren(...PRIMARY.map(entry => link(entry)));
    if (GROUPS[group]) {
      nav.parentElement.after(ctx.el('nav', {className: 'seg dm-subnav', ariaLabel: 'Money sections'}, ...GROUPS[group].map(entry => link(entry, place))));
    }
    nav.querySelector('[aria-current]')?.scrollIntoView?.({block: 'nearest', inline: 'nearest'});
    for (const tabs of root.querySelectorAll('.seg:is([aria-label="Money"], .dm-subnav)')) disposers.push(fadeEdges(tabs, doc.defaultView));
    // Purser's subnav count is independent of the global Needs union and never delays page readiness.
    ctx.api('/api/overview').then(value => {
      if (!gone && mine === revision) for (const node of root.querySelectorAll('[data-review-count]'))
        node.textContent = value.reviews ? `Review (${value.reviews})` : 'Review';
    }).catch(() => {});
    const native = host.kind !== 'web' || !opts.owner;
    if (native && page === 'page') ctx.$('bulk-actions').hidden = true;
    if (native) main.querySelector('.head').after(notice('Read-only Money. Changes, bank linking and exports are available in Deck web.'));
    if (native && page === 'tax-spending') {
      main.querySelector('form').hidden = true;
      ctx.$('status').textContent = 'Select categories and download tax spending in Deck web.';
      showState(null);
      return;
    }
    const module = await PAGES[page]();
    if (gone || mine !== revision) return;
    await module.mount(ctx);
    await ctx.ready();
    if (gone || mine !== revision) return;
    if (main.dataset.loading !== undefined) showState(null);
    if (native) {
      if (page === 'page' && ctx.$('view').options.length === 1 && !ctx.$('view-status').textContent)
        main.querySelector('.dm-saved-views').hidden = true;
      if (page === 'investments') ctx.$(`export`).hidden = true;
      // the owner notice (labels.js ownerNotice) already says where owner actions are
    }
  }
  function start() {
    const pending = load(), mine = revision;
    return pending.catch(error => {
      if (gone || mine !== revision) return;
      const main = root.querySelector('main'), slot = main?.querySelector('.dm-page-state');
      if (!slot) throw error;
      delete main.dataset.loading; main.dataset.failed = '';
      render(h(PageState, {error, backend: 'purser', title: 'Couldn’t load this page', retry: () => refresh(), host}), slot);
    });
  }
  function refresh(next = {}) {
    if (gone) return Promise.resolve();
    opts = {...opts, ...next};
    ready = start();
    return ready;
  }
  ready = start();
  return {get ready() { return ready; }, refresh, unmount() {
    gone = true; revision++; cleanup(); root.remove(); doc.defaultView?.removeEventListener('popstate', popped);
  }};
}

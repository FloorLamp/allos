import {moneyRoute} from './routes.js';
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
const ROUTES = {'/': 'overview', '/transactions': 'page', '/review': 'review', '/spending': 'reports',
  '/spending/merchants': 'merchants', '/spending/merchant': 'merchant', '/spending/recurring': 'subscriptions', '/spending/tax': 'tax-spending',
  '/accounts': 'accounts', '/accounts/connections': 'link', '/accounts/connections/oauth': 'link', '/accounts/imports': 'imports', '/accounts/investments': 'investments',
  '/rules': 'classification', '/rules/categories': 'classification'};
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

/** Arrange the existing controls without changing their IDs, handlers or filter values. */
function layout(main, page, doc) {
  const make = (tag, className) => { const node = doc.createElement(tag); node.className = className; return node; };
  const head = main.querySelector('.head'), title = head.querySelector('h1');
  const intro = make('header', 'dm-page-intro'), eyebrow = make('span', 'dm-eyebrow'), description = make('p', 'dm-page-description');
  eyebrow.textContent = 'Money'; description.textContent = DESCRIPTIONS[page];
  intro.append(eyebrow, title, description); head.before(intro); head.classList.add('dm-navigation');
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
  for (const [id, label] of [['preset', 'Period'], ['merchant', 'Merchant ID'], ['from', 'From'], ['to', 'To'], ['min', 'Minimum amount'], ['max', 'Maximum amount']]) {
    const input = find(id), field = make('label', 'dm-filter-field'), caption = make('span', 'dm-field-label');
    caption.textContent = label; input.before(field); field.append(caption, input);
  }
  const toolbar = make('div', 'dm-ledger-toolbar'), saved = make('details', 'dm-saved-views'), summary = make('summary', 'dm-utility-title');
  summary.textContent = 'Saved views'; saved.append(summary, find('saved-view-controls'), find('view-status'));
  toolbar.append(find('summary'), find('sort'), saved); filters.after(toolbar);
  const bulk = make('details', 'dm-bulk-actions'), bulkTitle = make('summary', 'dm-utility-title');
  bulk.id = 'bulk-actions'; bulkTitle.textContent = 'Categories & rules'; bulk.append(bulkTitle, find('fix'));
  const actions = make('div', 'dm-ledger-actions'); find('selection').before(actions); actions.append(find('selection'), bulk);
  advanced.append(find('sort-controls'));
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
  const navigate = href => {
    if (opts.onNavigate) return opts.onNavigate(href);
    const next = new URL(href, 'https://deck.wang.team');
    if (!next.pathname.startsWith('/api/') && next.origin === 'https://deck.wang.team' &&
        (next.pathname === base || next.pathname.startsWith(base + '/'))) {
      return refresh({path: next.pathname, query: next.search});
    }
    return host.call('url.open', {url: next.href});
  };
  function notice(message) {
    const p = doc.createElement('p'); p.className = 'dm-web-notice'; p.setAttribute('role', 'status'); p.append(message, ' ');
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'btn'; button.textContent = 'Open in Deck web';
    button.addEventListener('click', openWeb); p.append(button); return p;
  }
  function cleanup() { for (const dispose of disposers.splice(0).reverse()) dispose(); root.replaceChildren(); }
  async function load() {
    const mine = ++revision;
    cleanup();
    const url = route();
    const path = moneyRoute(url.pathname, url.search);
    if (path !== url.pathname) {
      opts = {...opts, path: `${base}${path}`, query: url.search};
      replaceURL(`${base}${path}${url.search}`);
    }
    const page = opts.page ?? ROUTES[path];
    root.dataset.moneyPage = page;
    opts.onTitle?.(pageTitle(page));
    if (!host.caps?.money) {
      const title = doc.createElement('h1'); title.textContent = 'Money';
      root.append(title, notice('Money is unavailable in this host.'));
      return;
    }
    if (!PAGES[page]) { root.append(notice('This Money page is unavailable.')); return; }
    const main = pageTemplate(page, doc);
    layout(main, page, doc);
    const prefix = `dm-${++sequence}-`;
    for (const node of main.querySelectorAll('[id]')) { node.dataset.moneyId = node.id; node.id = prefix + node.id; }
    for (const node of main.querySelectorAll('[for],[aria-controls],[aria-labelledby],[aria-describedby]')) {
      for (const key of ['for', 'aria-controls', 'aria-labelledby', 'aria-describedby']) if (node.hasAttribute(key))
        node.setAttribute(key, node.getAttribute(key).split(' ').map(id => prefix + id).join(' '));
    }
    root.append(main);
    const replace = replaceURL;
    const ctx = createMoneyContext(main, host, {...opts, path, query: url.search, onReplace(href) {
      const next = new URL(href, 'https://deck.wang.team');
      opts = {...opts, path: next.pathname, query: next.search};
      replace?.(href);
    }}, navigate, fn => {
      if (gone || mine !== revision) fn(); else disposers.push(fn);
    });
    const nav = root.querySelector('nav[aria-label="Money"]');
    const group = path.split('/')[1];
    const active = path === '/' ? '/' : `/${group}`;
    const link = ([href, textContent], selected = active) => {
      const node = ctx.el('a', {href, textContent});
      if (href === selected) node.setAttribute('aria-current', 'page');
      if (href === '/review') node.dataset.reviewCount = '';
      return node;
    };
    nav.replaceChildren(...PRIMARY.map(entry => link(entry)));
    if (GROUPS[group]) {
      const selected = path === '/spending/merchant' ? '/spending/merchants' : path === '/accounts/connections/oauth' ? '/accounts/connections' : path;
      nav.parentElement.after(ctx.el('nav', {className: 'seg dm-subnav', ariaLabel: 'Money sections'}, ...GROUPS[group].map(entry => link(entry, selected))));
    }
    nav.querySelector('[aria-current]')?.scrollIntoView?.({block: 'nearest', inline: 'nearest'});
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
      return;
    }
    const module = await PAGES[page]();
    if (gone || mine !== revision) return;
    await module.mount(ctx);
    await ctx.ready();
    if (gone || mine !== revision) return;
    if (native) {
      if (page === 'page' && ctx.$('view').options.length === 1 && !ctx.$('view-status').textContent)
        main.querySelector('.dm-saved-views').hidden = true;
      if (page === 'investments') ctx.$(`export`).hidden = true;
      if (['accounts', 'link', 'review'].includes(page)) ctx.$('signin').replaceChildren(ctx.el('span', {textContent: 'Owner actions are available in Deck web.'}));
      if (page === 'classification') ctx.$('actions').replaceChildren(ctx.el('span', {textContent: 'Edit rules and categories in Deck web.'}));
      if (['page', 'merchant'].includes(page)) ctx.$('fix').replaceChildren(ctx.el('span', {textContent: 'Change categories in Deck web.'}));
      if (page === 'subscriptions') ctx.$('status').textContent = 'Change subscription states in Deck web.';
    }
  }
  function start() {
    const pending = load(), mine = revision;
    return pending.catch(error => {
      if (gone || mine !== revision) return;
      const state = doc.createElement('p'); state.className = 'dm-load-error'; state.setAttribute('role', 'alert');
      state.append('Could not load Money. ', error.message || 'Try again.', ' ');
      const retry = doc.createElement('button'); retry.type = 'button'; retry.className = 'btn'; retry.textContent = 'Retry';
      retry.addEventListener('click', () => refresh()); state.append(retry);
      (root.querySelector('main') ?? root).append(state);
    });
  }
  function refresh(next = {}) {
    if (gone) return Promise.resolve();
    opts = {...opts, ...next};
    ready = start();
    return ready;
  }
  ready = start();
  return {get ready() { return ready; }, refresh, unmount() { gone = true; revision++; cleanup(); root.remove(); }};
}

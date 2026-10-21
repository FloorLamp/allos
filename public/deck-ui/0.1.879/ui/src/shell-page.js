import {Fragment, h, render} from '../vendor/preact.mjs';
import {bindBack} from './back.js';
import {PageState} from './view/page-state.js';
import {PageHeader} from './view/page-header.js';
import {failurePage} from './failure.js';
// Full-page native shells use the same mounts and navigation as the hosted pages.
import {shellHost, pageInput, androidActions} from './host/shell.js';
import {mountCollectionPage, mountHealthPage, mountMoneyPage, mountHouse, mountAccounts, mountProjects, mountShellBar} from './mount.js';
import {selftest} from './selftest.js';

const host = shellHost();
pageInput(host);
const env = await host.call('env.get');
const look = ({theme}) => { document.documentElement.dataset.theme = theme; };
look(env);
host.on('theme', look);
const nav = await (await fetch(new URL('../contract/nav.json', import.meta.url))).json();
const el = document.getElementById('app'), path = location.pathname;
const opts = {nav, path, actions: androidActions(host)};
// Texts keeps its string conversation IDs in the shared viewer.
if (path !== '/texts') opts.onOpen = doc => host.call('document.page', {id: Number(doc.id)});
if (path === '/flightplan' && location.hash === '#projects') {
  const shell = document.createElement('div'), content = document.createElement('main');
  el.append(shell, content);
  mountShellBar(shell, {...opts, host, current: 'flightplan'});
  mountProjects(content, host);
} else if (['/people', '/vehicles', '/properties', '/insurance', '/papers', '/taxes', '/things', '/purchases', '/texts', '/notes', '/flightplan'].includes(path)) {
  mountCollectionPage(el, host, opts);
} else if (path === '/health') {
  mountHealthPage(el, host, opts);
} else if (path === '/money' || path.startsWith('/money/')) {
  mountMoneyPage(el, host, {...opts, query: location.search});
} else {
  // As mountPage: this page's one bar, then the content mounted without its own bar.
  const shell = document.createElement('div'), content = document.createElement('div');
  shell.className = 'ds-page-shell';
  el.append(shell, content);
  mountShellBar(shell, {...opts, host, current: nav.find(n => n.href === path)?.id});
  const house = {'/house': 'phone', '/house/cameras': 'cameras'}[path];
  const page = house ? mountHouse(content, host, {...opts, nav: undefined, view: house})
    : path === '/accounts' ? mountAccounts(content, host, {...opts, nav: undefined}) : null;
  if (!page || page.offered === false) {
    const main = document.createElement('main');
    main.className = 'dk-page';
    content.append(main);
    // A page whose backend this phone has no grant for yet says so; a destination with no page in this bundle says that.
    const backend = house ? 'habitat' : 'rover';
    if (page) render(h(Fragment, null, h(PageHeader, {title: failurePage(backend)}), h(PageState, {error: {code: 'not-set-up'}, backend, host, named: true})), main);
    else {
      const label = nav.find(n => n.href === path)?.label ?? 'This page';
      render(h(PageState, {state: 'unavailable', title: `${label} isn’t available here yet`, hint: 'It arrives with a later Deck update. Find searches everything meanwhile.'}), main);
    }
  }
}
if (location.search === '?selftest') host.note('selftest.done', await selftest(host));

bindBack(host, () => {
  // A shared page is one layer above Find, including when opened by an entry intent.
  host.note('android.home', {});
  return true;
});
host.note('android.ready', {});

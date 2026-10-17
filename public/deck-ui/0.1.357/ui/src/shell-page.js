// Full-page native shells use the same mounts and navigation as the hosted pages.
import {shellHost, pageInput} from './host/shell.js';
import {mountCollectionPage, mountHealthPage, mountHouse, mountAccounts, mountShellBar} from './mount.js';
import {selftest} from './selftest.js';

const host = shellHost();
pageInput(host);
const env = await host.call('env.get');
const look = ({theme}) => { document.documentElement.dataset.theme = theme; };
look(env);
host.on('theme', look);
const nav = await (await fetch(new URL('../contract/nav.json', import.meta.url))).json();
const el = document.getElementById('app'), path = location.pathname;
const opts = {nav, path, onOpen: doc => host.call('document.page', {id: Number(doc.id)})};
if (['/people', '/vehicles', '/properties', '/insurance', '/papers', '/taxes', '/things', '/flightplan'].includes(path)) {
  mountCollectionPage(el, host, opts);
} else if (path === '/health') {
  mountHealthPage(el, host, opts);
} else {
  const shell = document.createElement('div'), content = document.createElement('main');
  el.append(shell, content);
  mountShellBar(shell, {host, nav, current: nav.find(n => n.href === path)?.id});
  if (path === '/house') mountHouse(content, host, opts);
  else if (path === '/accounts') mountAccounts(content, host, opts);
  else {
    // Keep the destination visible while its backend's shared page is being adopted.
    content.textContent = `${nav.find(n => n.href === path)?.label ?? 'Page'} is not available in this bundle yet.`;
    content.setAttribute('role', 'status');
  }
}
if (location.search === '?selftest') host.note('selftest.done', await selftest(host));

import {pageNavigation, documentId} from '../page-navigation.js';
import {h, render} from '../../vendor/preact.mjs';
import {createFlightplan} from '../flightplan.js';
import {Flightplan} from '../view/flightplan.js';
import {drawing} from '../mount-runtime.js';

/** Flightplan (contract/flightplan.md) on its own page: opts `brand`, `nav`, `current` (the nav bar), `tab` (todos | board; else
 *  the page's `#board`), `clock`. The page's `#needs` (the nav's Needs) scrolls to Needs you once it is read. Fetched now and on
 *  `refresh()`, and automatically while visible. Answers {flightplan, refresh(), unmount()}. */
export function mountFlightplan(el, host, opts = {}) {
  const flightplan = createFlightplan(host, {clock: opts.clock, needsSource: opts.needsSource});
  const d = drawing(el, 'Flightplan', () => render(h(Flightplan, {model: flightplan, host, opts}), el));
  const navigation = pageNavigation(el.ownerDocument);
  const setTab = flightplan.setTab.bind(flightplan), open = flightplan.open.bind(flightplan), close = flightplan.close.bind(flightplan);
  const write = () => navigation.replaceHash(`${flightplan.tab}${flightplan.drawer ? '/' + flightplan.drawer.item.id : ''}`);
  flightplan.setTab = tab => { setTab(tab); write(); };
  flightplan.open = task => { open(task); write(); };
  flightplan.close = () => { close(); write(); };
  let needsPending = false, previousHash = null, scrollScheduled = false;
  const scrollNeeds = () => {
    if (!needsPending || navigation.hash !== 'needs' || scrollScheduled) return;
    scrollScheduled = true;
    d.styled.then(() => el.ownerDocument.defaultView?.requestAnimationFrame(() => {
      scrollScheduled = false;
      if (!needsPending || navigation.hash !== 'needs') return;
      const target = el.querySelector('#needs');
      if (target) { target.scrollIntoView?.({block: 'start'}); needsPending = false; }
    }));
  };
  const apply = () => {
    const hash = navigation.hash, [tab, item] = hash.split('/');
    if (hash !== previousHash) { needsPending = hash === 'needs'; previousHash = hash; }
    const next = tab === 'board' ? 'board' : tab === 'todos' || tab === 'needs' ? 'todos' : opts.tab ?? 'todos';
    if (flightplan.tab !== next) setTab(next);
    const id = documentId(item);
    if (id && flightplan.drawer?.item.id !== id) open({id, title: 'Loading item…', kind: 'task'});
    else if (!id && flightplan.drawer) close();
    scrollNeeds();
  };
  navigation.subscribe(apply);
  flightplan.subscribe(scrollNeeds);
  const epic = documentId(new URLSearchParams(el.ownerDocument?.location?.search ?? '').get('epic'));
  if (navigation.hash === 'board' && epic) flightplan.setEpic(epic);
  apply();
  flightplan.refresh().then(scrollNeeds);
  return {flightplan, refresh: () => (flightplan.tab === 'board' ? flightplan.refreshBoard() : flightplan.refresh()), unmount() { navigation.stop(); flightplan.stop(); d.unmount(); }};
}

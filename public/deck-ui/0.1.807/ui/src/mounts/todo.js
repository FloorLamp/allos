import {h, render} from '../../vendor/preact.mjs';
import {createFlightplan} from '../flightplan.js';
import {Todo} from '../view/flightplan.js';
import {drawing} from '../mount-runtime.js';
import {parseTodo, todoPath} from '../flightplan-paths.js';
import {urlState} from './flightplan.js';

/** Todo (contract/flightplan.md *Pages*) on its own page, `/todo`: a list `/todo/<list>` (`/todo` and `/todo/today`: Needs you,
 *  today and upcoming), an item's drawer `…/FP-<id>`. opts as mountFlightplan's. Answers {flightplan, refresh(), unmount()}. */
export function mountTodo(el, host, opts = {}) {
  const fp = createFlightplan(host, {clock: opts.clock, needsSource: opts.needsSource});
  const d = drawing(el, 'Todo', () => render(h(Todo, {model: fp, host, opts}), el));
  const own = {open: fp.open.bind(fp), close: fp.close.bind(fp), setList: fp.setList.bind(fp)};
  let applying = false;
  const url = urlState(el.ownerDocument, () => apply());
  const at = place => `${todoPath(place)}${url.search}`;
  fp.setList = slug => { const r = own.setList(slug); if (!applying) url.push(at({list: slug})); return r; };
  fp.open = task => { own.open(task); if (!applying && fp.drawer) url.push(at({list: fp.list, id: task.id})); };
  fp.close = () => { const was = fp.drawer; own.close(); if (!applying && was) url.leave(at({list: fp.list})); };
  const apply = () => {
    applying = true;
    try {
      const r = parseTodo(url.path) ?? {list: 'all', id: null};
      if (r.list !== fp.list) own.setList(r.list);
      if (r.id && fp.drawer?.item.id !== r.id) own.open({id: r.id, title: 'Loading item…', kind: 'task'});
      else if (!r.id && fp.drawer) own.close();
    } finally { applying = false; }
  };
  apply();
  fp.refresh();
  return {flightplan: fp, refresh: () => fp.refresh(), unmount() { url.stop(); fp.stop(); d.unmount(); }};
}

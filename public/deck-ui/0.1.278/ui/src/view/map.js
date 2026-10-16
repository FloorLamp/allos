// Item-centred Related view, shared by web pages and desktop palettes.
import {h, render} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Drawer} from './drawer.js';
import {Failure} from './failure.js';
import {RowList} from './rows.js';
const html = htm.bind(h);

export function mapRequest({by, value}) {
  if (by === 'doc') return ['bridge.related', {id: Number(value)}];
  if (by === 'day') return ['bridge.day', {date: value}];
  if (by === 'project') return ['bridge.project', {id: value}];
  return ['bridge.subject', {name: value}];
}
export function MapPopout({host, centre, onClose}) {
  const [state, setState] = useState({}), [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setState({});
    const [op, args] = mapRequest(centre);
    host.call(op, args).then(answer => { if (active) setState({answer}); }, error => { if (active) setState({error}); });
    return () => { active = false; };
  }, [host, centre, retry]);
  const answer = state.answer;
  const groups = answer?.groups ?? [{label: 'Documents', items: answer?.items ?? answer?.results ?? (answer?.documents ?? []).map(document => ({document, title: document.title}))}];
  return html`<${Drawer} open=${true} title="Map" sub=${centre.label ?? centre.value} onClose=${onClose}>
    ${state.error ? html`<${Failure} host=${host} backend="bridge" error=${state.error} retry=${() => setRetry(n => n + 1)} />` : !answer ? html`<p role="status">Loading related items…</p>` : groups.map(group => html`<section><h2>${group.label}</h2>
      <${RowList} items=${group.items ?? []} onOpen=${item => { if (item.document?.id) host.call('document.page', {id: item.document.id, url: null}); }} empty=${{title: 'No related items'}} />
    </section>`)}
  <//>`;
}
export function openMap(host, centre) {
  const element = document.createElement('div');
  document.body.append(element);
  const close = () => { render(null, element); element.remove(); };
  render(h(MapPopout, {host, centre, onClose: close}), element);
}

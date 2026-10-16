import {Failure} from './failure.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {createPapers, paperRow, paperState, renewalState} from '../papers.js';
import {RowList} from './rows.js';
import {Drawer} from './drawer.js';
import {StatTiles} from './stat-tiles.js';
const html = htm.bind(h);

export function Papers({model, host, onOpen}) {
  const [, redraw] = useState(0), [selected, select] = useState(null);
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  const paper = model.papers.find(p => p.id === selected);
  const documents = [...new Map([paper?.document, paper?.renewal, ...(paper?.documents ?? [])].filter(d => d?.id).map(d => [d.id, d])).values()];
  return html`<main class="dk-papers" aria-label="Papers" aria-busy=${model.loading}>
    <header><h1>Papers</h1><button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => model.refresh()}>Refresh</button></header>
    ${model.error ? html`<${Failure} backend="bridge" error=${model.error} retry=${() => model.refresh()} host=${host} />` : null}
    ${!model.error ? html`<${RowList} items=${model.papers.map(paperRow)}
      onOpen=${r => select(r.id)} loading=${model.loading ? 3 : 0} empty=${{title: 'No indexed identity papers'}} />` : null}
    <${Drawer} open=${!!paper} title=${paper ? paperRow(paper).title : ''} onClose=${() => select(null)}>
      <${StatTiles} label="Identity paper" tiles=${paper ? [
        {key: 'scope', label: 'Scope', value: paper.scope ?? 'Unknown'},
        {key: 'expiry', label: 'Expiry', value: paper.expiry ?? 'Unknown'},
        {key: 'state', label: 'State', value: paperState(paper)},
        {key: 'renewal', label: 'Renewal', value: renewalState(paper)},
      ] : []} />
      <h2>Documents and renewal application</h2>
      <${RowList} items=${documents.map(d => ({id: d.id, title: d.title, sub: d.id === paper?.renewal?.id ? 'Pending renewal application' : d.date,
        end: {label: 'Open document', onClick: () => onOpen?.(d)}}))} onOpen=${r => onOpen?.(documents.find(d => d.id === r.id))} empty=${{title: 'No indexed documents'}} />
    <//>
  </main>`;
}
export function PapersPlace({host, onOpen}) {
  const [model] = useState(() => createPapers(host));
  useEffect(() => { model.refresh(); return () => model.stop(); }, [model]);
  return html`<${Papers} model=${model} host=${host} onOpen=${onOpen} />`;
}

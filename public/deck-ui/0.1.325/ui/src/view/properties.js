import {Failure} from './failure.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {createProperties, propertyRow} from '../properties.js';
import {RowList} from './rows.js';
import {Drawer} from './drawer.js';
import {StatTiles} from './stat-tiles.js';
const html = htm.bind(h);

export function Properties({model, host, onOpen}) {
  const [, redraw] = useState(0), [selected, select] = useState(null);
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  const home = model.homes.find(p => p.id === selected);
  const papers = home?.papers ?? [];
  const rows = model.homes.map(propertyRow);
  return html`<main class="dk-properties" aria-label="Properties" aria-busy=${model.loading}>
    <header><h1>Properties</h1><button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => model.refresh()}>Refresh</button></header>
    ${model.warning ? html`<${Failure} backend="bridge" error=${model.warning} retry=${() => model.refresh()} host=${host} />` : null}
    ${model.error ? html`<${Failure} backend="bridge" error=${model.error} retry=${() => model.refresh()} host=${host} />` : null}
    ${!model.error ? html`<${RowList} items=${rows} onOpen=${r => select(r.id)} loading=${model.loading ? 3 : 0}
      empty=${{title: 'No indexed properties'}} />` : null}
    <${Drawer} open=${!!home} title=${home?.name} onClose=${() => select(null)}>
      <${StatTiles} label="Home papers" tiles=${[{key: 'papers', label: 'Indexed papers', quantity: {value: papers.length}},
        {key: 'renewals', label: 'Recorded renewals', quantity: {value: papers.filter(p => p.renewal).length}}]} />
      <h2>Papers</h2>
      <${RowList} items=${papers.map((p, i) => ({id: `${p.document?.id}:${i}`, title: p.document?.title ?? p.kind,
        sub: `${p.kind} · ${p.expiry ? `expires ${p.expiry}` : 'Expiry not indexed'}${p.datesUnavailable ? ' · Dates unavailable' : ''}`,
        end: p.document?.id ? {label: 'Open paper', onClick: () => onOpen?.(p.document)} : null}))} empty=${{title: 'No indexed papers'}} />
      <h2>Renewals</h2>
      ${papers.some(p => p.renewal) ? papers.filter(p => p.renewal).map(p => html`<p>${p.kind}: ${p.renewal}</p>`) : html`<p>No indexed renewals</p>`}
      ${home?.missing?.length ? html`<p>Not indexed: ${home.missing.join(', ')}</p>` : null}
    <//>
  </main>`;
}
export function PropertiesPlace({host, onOpen}) {
  const [model] = useState(() => createProperties(host));
  useEffect(() => { model.refresh(); return () => model.stop(); }, [model]);
  return html`<${Properties} model=${model} host=${host} onOpen=${onOpen} />`;
}

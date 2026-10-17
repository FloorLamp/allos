import {Failure} from './failure.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {createThings, thingRow} from '../things.js';
import {resourcePath} from '../host/host.js';
import {RowList} from './rows.js';
import {Drawer} from './drawer.js';
import {StatTiles} from './stat-tiles.js';
const html = htm.bind(h);

function Photo({image, host, name}) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let active = true;
    setSrc(null);
    const path = resourcePath(image?.url);
    if (path) Promise.resolve(host.resource(path)).then(url => { if (active) setSrc(url); }, () => {});
    return () => { active = false; };
  }, [image?.url, host]);
  return src ? html`<img src=${src} alt=${name} />` : html`<p>No indexed photo available</p>`;
}

export function Things({model, host, onOpen}) {
  const [, redraw] = useState(0);
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  const thing = model.thing, documents = thing?.documents ?? [];
  const specs = thing ? {...thing.specs, brand: thing.brand ?? thing.specs?.brand, model: thing.model ?? thing.specs?.model,
    size: thing.variant?.size, colour: thing.variant?.colour} : {};
  return html`<main class="dk-things" aria-label="Things" aria-busy=${model.loading}>
    <header><h1>Things</h1><button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => model.refresh()}>Refresh</button></header>
    ${model.error ? html`<${Failure} backend="bridge" error=${model.error} retry=${() => model.refresh()} host=${host} />` : null}
    ${!model.error ? html`<${RowList} items=${model.things.map(thingRow)}
      onOpen=${r => model.open(r.id)} loading=${model.loading ? 3 : 0} empty=${{title: 'No indexed things'}} />` : null}
    <${Drawer} open=${model.id != null} title=${thing?.name ?? 'Thing'} onClose=${() => model.close()}>
      ${model.detailLoading ? html`<p role="status">Loading thing…</p>` : null}
      ${model.detailError ? html`<${Failure} backend="bridge" error=${model.detailError} retry=${() => model.open(model.id)} host=${host} />` : null}
      ${thing ? html`<${StatTiles} label="Purchase" tiles=${[
        ...(thing.person?.name ? [{key: 'owner', label: 'Owner', value: thing.person.name}] : []),
        {key: 'store', label: 'Bought from', value: thing.store ?? 'Unknown'},
        {key: 'date', label: 'Bought on', value: thing.purchaseDate ?? 'Unknown'},
        {key: 'status', label: 'Status', value: thing.status ?? 'Unknown'},
        {key: 'price', label: 'Price', value: thing.price ?? 'Unknown'},
        {key: 'warranty', label: 'Warranty', value: thing.warranty ?? 'Unknown'},
        {key: 'return', label: 'Return window', value: thing.returnWindow ?? 'Unknown'},
      ]} />
      <h2>Specs</h2>
      <${RowList} items=${Object.entries(specs).filter(([, v]) => v != null).map(([key, value]) => ({id: key, title: key, sub: typeof value === 'object' ? JSON.stringify(value) : String(value)}))} empty=${{title: 'No indexed specs'}} />
      <h2>Receipts and documents</h2>
      <${RowList} items=${documents.map(d => ({id: d.id, title: d.title, sub: d.date,
        end: {label: 'Open document', onClick: () => onOpen?.(d)}}))} onOpen=${r => onOpen?.(documents.find(d => d.id === r.id))} empty=${{title: 'No indexed receipts or documents'}} />
      <h2>Photos</h2><${Photo} image=${thing.image} name=${thing.name} host=${host} />` : null}
    <//>
  </main>`;
}
export function ThingsPlace({host, onOpen}) {
  const [model] = useState(() => createThings(host));
  useEffect(() => { model.refresh(); return () => model.stop(); }, [model]);
  return html`<${Things} model=${model} host=${host} onOpen=${onOpen} />`;
}

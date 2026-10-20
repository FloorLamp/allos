import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {createPhysicalThing} from '../physical-thing.js';
import {factValue, readableFacts} from '../readable-facts.js';
import {dateText, fieldLabel} from '../format.js';
import {Facts} from './drawer.js';
import {Failure, StateBlock, Skeleton} from './page-state.js';
import {RowList} from './rows.js';
import {useCollectionPage, CollectionSearch, CollectionPager} from './collection-page.js';
const html = htm.bind(h);

function Documents({documents = [], label, onOpen}) {
  const page = useCollectionPage(documents, {size: 20});
  return html`<section aria-label=${label}><h2>${label}</h2>
    <${CollectionSearch} page=${page} label=${`Search ${label.toLowerCase()}`} />
    <${RowList} inline=${true} items=${page.items.map(document => ({id: document.id, title: document.title, sub: dateText(document.date)}))}
      onOpen=${row => onOpen?.(documents.find(document => document.id === row.id))}
      empty=${{title: 'No indexed documents'}} />
    <${CollectionPager} page=${page} label=${`${label} pages`} /></section>`;
}

// A device's entities as facts: one entity is the device's own state (said once); more are each named by Habitat's name or their
// object id read as words (`light.desk_lamp` → `Desk lamp`), never the raw id.
const entityLabel = entity => entity.name ?? fieldLabel(String(entity.id ?? '').replace(/^[a-z_]+\./, '') || 'entity');
export function deviceFacts(device) {
  const entities = (device.entities ?? []).filter(e => e.id !== device.id);
  if (entities.length <= 1 && (!device.state || !entities[0]?.state || entities[0].state === device.state))
    return readableFacts({state: device.state ?? entities[0]?.state ?? null});
  return [...readableFacts({state: device.state}),
    ...entities.map(e => ({label: entityLabel(e), value: e.state ? factValue(e.state, 'state') : 'Unknown'}))];
}
const none = line => html`<${StateBlock} inline=${true} line=${line} />`;

/** `heading` false where a drawer's title already names the thing. */
export function PhysicalThingContent({thing, onOpen, heading = true}) {
  const devices = useCollectionPage(thing.devices ?? [], {size: 20});
  const alerts = useCollectionPage(thing.alerts ?? [], {size: 20});
  return html`<article aria-label="Physical thing" data-thing-id=${thing.id}>
    ${heading ? html`<h2>${thing.name}</h2>` : null}
    <${Facts} facts=${[...(thing.identifiers ?? []).map(i => ({label: fieldLabel(i.kind ?? 'identifier'), value: i.value})),
      ...readableFacts({room: thing.room, location: thing.location})]} />
    <section aria-label="Purchase"><h2>Purchase</h2>
      <${Facts} facts=${readableFacts(thing.purchase)} />
      ${!thing.purchase ? none('No indexed purchase') : null}</section>
    <section aria-label="Warranty"><h2>Warranty</h2>
      <${Facts} facts=${readableFacts(thing.warranty)} />
      ${!thing.warranty ? none('No indexed warranty') : null}</section>
    <${Documents} documents=${thing.manuals} label="Manuals" onOpen=${onOpen} />
    <${Documents} documents=${thing.documents} label="Receipts and documents" onOpen=${onOpen} />
    <section aria-label="Habitat devices"><h2>Habitat devices</h2>
      <${CollectionSearch} page=${devices} label="Search devices" />
      ${devices.items.map(device => html`<section key=${device.id}><h3>${device.name ?? device.id}</h3>
        <${Facts} facts=${deviceFacts(device)} /></section>`)}
      ${!devices.items.length ? none('No linked devices') : null}
      <${CollectionPager} page=${devices} label="Device pages" /></section>
    <section aria-label="Alerts"><h2>Alerts</h2>
      <${CollectionSearch} page=${alerts} label="Search alerts" />
      ${alerts.items.map(alert => html`<section key=${alert.id}><h3>${alert.title}</h3>
        <${Facts} facts=${readableFacts({state: alert.state, detail: alert.detail, since: alert.since})} /></section>`)}
      ${!alerts.items.length ? none('No indexed alerts') : null}
      <${CollectionPager} page=${alerts} label="Alert pages" /></section>
  </article>`;
}

/** `onThing(thing)` once it is read (a drawer's title); `heading` as PhysicalThingContent's. */
export function PhysicalThing({id, host, onOpen, heading = true, onThing}) {
  const [model] = useState(() => createPhysicalThing(host));
  const [, redraw] = useState(0);
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  useEffect(() => { if (model.thing) onThing?.(model.thing); }, [model.thing]);
  useEffect(() => { model.open(id); }, [model, id]);
  useEffect(() => () => model.stop(), [model]);
  // Never paint the prior identity while the effect starts its next read.
  if (model.id !== id || model.loading) return html`<${Skeleton} />`;
  if (model.error) return html`<${Failure} backend="bridge" error=${model.error} host=${host} retry=${() => model.open(id)} />`;
  return model.thing ? html`<${PhysicalThingContent} key=${id} thing=${model.thing} onOpen=${onOpen} heading=${heading} />` : null;
}

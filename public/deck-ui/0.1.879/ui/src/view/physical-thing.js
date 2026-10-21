import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {createPhysicalThing} from '../physical-thing.js';
import {readableFacts} from '../readable-facts.js';
import {fieldLabel, joinText} from '../format.js';
import {createThingLinks} from '../thing-links.js';
import {houseUnavailable, unavailable} from '../thing-hub.js';
import {Facts, Section} from './drawer.js';
import {HouseRecord} from './house-record.js';
import {Failure, Skeleton} from './page-state.js';
import {ThingCamera} from './camera.js';
import {Aliases, ThingLinks} from './thing-links.js';
import {HubLive, HubPapers, HubPurchase, HubRules, HubUsage, PartUnavailable, Unavailable} from './thing-hub.js';
const html = htm.bind(h);

/** The thing's page, its hub (contract/things.md *Hub*), in order: what it is (name, kind and room, aliases, its camera), Live,
 *  Usage and Health, Rules, Purchase and warranty, Papers, then its record (identifiers, where) and Linked. A part with nothing is
 *  left out; Habitat not answering bridge is one line in place of Live, Usage and Rules, Usage or Rules alone unread a line in its
 *  section. A house record (`thing.house`, bridge's join of house-model's record: *House record*) puts HouseRecord's sections in
 *  place of the record's facts and the kind and room line, the hub's parts before its history; Live then only when the record names no entities (its Live
 *  state has them), its warranty HouseRecord's. `heading` false where a title already names it; `onRetry` reads the thing again; `camera` the one its camera
 *  plays (viewer/thing.js), else one among its devices. */
export function PhysicalThingContent({thing, onOpen, heading = true, host = null, onRetry = null, view, camera = null}) {
  const [links] = useState(() => host ? createThingLinks(host) : null);
  const [, redraw] = useState(0);
  useEffect(() => links?.subscribe(() => redraw(n => n + 1)), [links]);
  useEffect(() => { links?.open(thing.id); }, [links, thing.id]);
  useEffect(() => () => links?.stop(), [links]);
  const aliases = (thing.aliases ?? []).filter(Boolean);
  const house = thing.house?.record ?? null, entities = house && [].concat(house.ha ?? []).length;
  // a house record's facts say its kind and room
  const what = house ? null : joinText([thing.kind ? fieldLabel(thing.kind) : null, thing.room]);
  const record = house ? [] : [...(thing.identifiers ?? []).map(i => ({label: fieldLabel(i.kind ?? 'identifier'), value: i.value})),
    ...readableFacts({room: thing.room, location: thing.location})];
  const hub = html`
    ${houseUnavailable(thing) ? html`<${Unavailable} retry=${() => onRetry?.()} />` : html`
      ${entities ? null : html`<${HubLive} thing=${thing} host=${host} />`}
      ${unavailable(thing, 'usage') ? html`<${PartUnavailable} title="Usage" retry=${() => onRetry?.()} />` : html`<${HubUsage} key=${`usage:${thing.id}`} thing=${thing} host=${host} />`}
      ${unavailable(thing, 'rules') ? html`<${PartUnavailable} title="Rules" retry=${() => onRetry?.()} />` : html`<${HubRules} thing=${thing} host=${host} />`}`}
    <${HubPurchase} thing=${house ? {...thing, warranty: null} : thing} host=${host} onOpen=${onOpen} />
    <${HubPapers} thing=${thing} links=${links?.links ?? []} onOpen=${onOpen} />`;
  return html`<article class="dk-hub thing-detail" aria-label="Physical thing" data-thing-id=${thing.id}>
    <header class="dk-hub-head">
      ${heading ? html`<h2 class="thing-name">${thing.name}</h2>` : null}
      ${what ? html`<p class="dk-hub-what">${what}</p>` : null}
      ${host ? html`<${Aliases} id=${thing.id} host=${host} aliases=${aliases} />` : aliases.length ? html`<p class="dk-aliases">Also called: ${aliases.join(', ')}</p>` : null}
    </header>
    <${ThingCamera} host=${host} camera=${camera} ids=${(thing.devices ?? []).flatMap(d => [d.id, ...(d.entities ?? []).map(e => e.id)])} title=${thing.name} />
    ${house ? html`<${HouseRecord} thing=${thing} host=${host} onOpen=${onOpen} view=${view}>${hub}<//>` : hub}
    ${record.length ? html`<${Section} title="Record" class="dk-section dk-hub-record"><${Facts} facts=${record} /><//>` : null}
    ${links ? html`<${ThingLinks} id=${thing.id} host=${host} onOpen=${onOpen} name=${thing.name} model=${links} />` : null}
  </article>`;
}

/** `onThing(thing)` once it is read (a drawer's title); `heading` as PhysicalThingContent's; `detail` bridge's detail already read
 *  (the record's viewer: collection-reader.js), shown without reading it again. */
export function PhysicalThing({id, host, onOpen, heading = true, onThing, detail = null, view, camera = null}) {
  const [model] = useState(() => createPhysicalThing(host));
  const [, redraw] = useState(0);
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  useEffect(() => { if (model.thing) onThing?.(model.thing); }, [model.thing]);
  useEffect(() => { if (detail && String(detail.id).toLowerCase() === String(id).toLowerCase()) model.show(detail); else model.open(id); }, [model, id]);
  useEffect(() => () => model.stop(), [model]);
  // Never paint the prior identity while the effect starts its next read.
  if (model.id !== id || model.loading) return html`<${Skeleton} />`;
  if (model.error) return html`<${Failure} backend="bridge" error=${model.error} host=${host} retry=${() => model.open(id)} />`;
  return model.thing ? html`<${PhysicalThingContent} key=${id} thing=${model.thing} onOpen=${onOpen} heading=${heading} host=${host} onRetry=${() => model.open(id)} view=${view} camera=${camera} />` : null;
}

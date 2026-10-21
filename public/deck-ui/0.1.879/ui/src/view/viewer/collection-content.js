import {h} from '../../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useMemo, useState} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {collectionTarget} from '../../collection-target.js';
import {collectionAnswer, normalizeCollectionAnswer} from '../../collection-reader.js';
import {createCollectionEntity} from '../../collection-entity.js';
import {normalizePersonProfile} from '../../people.js';
import {PersonCardOf, PersonProfileContent} from '../person-profile.js';
import {VehicleCard, VehicleDetail} from '../vehicles.js';
import {PropertyCard, PropertyDetail} from '../properties.js';
import {PolicyCard, PolicyDetail} from '../insurance.js';
import {ThingCard, ThingDetail} from '../things.js';
import {PaperCard, PaperDetail} from '../papers.js';
import {TaxCard, TaxDetail} from '../taxes.js';
import {ClusterCard, ClusterDetail} from '../clusters.js';
import {Failure} from '../page-state.js';
const html = htm.bind(h);

/** Shared detail content for viewer history and Find's desktop pane; `compact`: the record's card instead (Find's selected record,
 *  SPEC.md *Record card*), `onFull` its Open; `onOpen(document)` a document it lists, `onRecord(target)` another record it names (a
 *  person's cluster, a cluster's thing: {collection, id}); `photos` the photos Find found of it (a Photos section: under a person's
 *  hero, else first). Loaded pages are consumed directly. */
export function CollectionContent({host, target, payload, view = {}, onOpen, onRecord, onMap, onClose, mapping, onReady, compact = false, onFull, photos = null}) {
  const [state, setState] = useState({}), [retry, setRetry] = useState(0);
  const normalized = collectionTarget(target) ?? collectionTarget(payload);
  const key = normalized ? `${normalized.collection}:${normalized.id}` : '';
  useEffect(() => {
    const request = new AbortController();
    setState({});
    // a card reads once the selection rests on its record, and keeps its answer for the record's full view (Enter)
    const read = () => collectionAnswer(host, normalized, {signal: request.signal, keep: compact}).then(answer => {
      if (!request.signal.aborted) setState({key, answer});
    }, error => { if (!request.signal.aborted) setState({key, error}); });
    const rest = !payload && normalized ? compact && !retry ? setTimeout(read, 120) : (read(), null) : null;
    return () => { clearTimeout(rest); request.abort(); };
  }, [host, key, payload, retry]);
  const rawAnswer = payload ?? (state.key === key ? state.answer : null);
  const answer = useMemo(() => normalizeCollectionAnswer(rawAnswer), [rawAnswer]);
  if (state.key === key && state.error) return html`<${Failure} backend="bridge" error=${state.error} host=${host} retry=${() => setRetry(n => n + 1)} />`;
  if (!answer) return html`<p class=${compact ? 'dk-note' : null} role="status">Loading details…</p>`;
  return html`<${LoadedCollection} key=${key} host=${host} answer=${answer} view=${view} onOpen=${onOpen} onRecord=${onRecord} onMap=${onMap} onClose=${onClose} mapping=${mapping} onReady=${onReady}
    compact=${compact} onFull=${onFull} photos=${photos} />`;
}

/** The record's card from its loaded answer: the same card its collection's page opens in place. */
function CompactCollection({target, answer, model, host, onOpen, onRecord, onFull}) {
  const props = {host, onOpen, onFull, model};
  switch (target.collection) {
    case 'people': return html`<${PersonCardOf} host=${host} profile=${normalizePersonProfile(answer.person)} onOpen=${onOpen} onFull=${onFull} />`;
    case 'vehicles': return model.cars[0] ? html`<${VehicleCard} ...${props} car=${model.cars[0]} />` : html`<p class="dk-note" role="status">Loading vehicle…</p>`;
    case 'properties': return model.homes[0] ? html`<${PropertyCard} ...${props} home=${model.homes[0]} />` : html`<p class="dk-note" role="status">Loading property…</p>`;
    case 'insurance': return html`<${PolicyCard} ...${props} policy=${answer.insurance} />`;
    case 'things': return html`<${ThingCard} ...${props} listed=${answer.thing} thing=${answer.thing} />`;
    case 'papers': return html`<${PaperCard} ...${props} paper=${answer.paper} />`;
    case 'taxes': return html`<${TaxCard} ...${props} packet=${answer.packet} />`;
    case 'clusters': return model.detail ? html`<${ClusterCard} ...${props} host=${host} onRecord=${onRecord} detail=${model.detail} />` : html`<p class="dk-note" role="status">Loading cluster…</p>`;
  }
  return null;
}

function LoadedCollection({host, answer, view, onOpen, onRecord, onMap, onClose, mapping, onReady, compact, onFull, photos}) {
  const adapter = useMemo(() => createCollectionEntity(host, answer, {mapping}), [host, answer, mapping]);
  const [, redraw] = useState(0), {model, target} = adapter;
  useEffect(() => {
    const off = model?.subscribe(() => redraw(n => n + 1));
    adapter.start();
    return () => { off?.(); model?.stop(); };
  }, [adapter]);
  useEffect(() => {
    if (target?.collection === 'vehicles' && model?.cars.length) model.showPhotos([model.cars[0].vehicle.id]);
  }, [model, model?.cars, target?.collection]);
  const ready = target?.collection === 'vehicles' ? !!model.cars[0] : target?.collection === 'properties' ? !!model.homes[0] : target?.collection === 'clusters' ? !!model.detail : !!target;
  useLayoutEffect(() => { if (ready) onReady?.(); }, [ready, onReady]);
  if (!target) return null;
  if (compact) return html`<div class=${`dk-${target.collection}`} data-collection=${target.collection} data-entity-id=${target.id}>
    ${model?.error ? html`<${Failure} backend="bridge" error=${model.error} host=${host} retry=${() => model.refresh()} />` : null}
    <${CompactCollection} target=${target} answer=${answer} model=${model} host=${host} onOpen=${onOpen} onRecord=${onRecord} onFull=${onFull} /></div>`;
  const props = {host, onOpen, view, model};
  let content;
  switch (target.collection) {
    case 'people': content = html`<${PersonProfileContent} ...${props} profile=${normalizePersonProfile(answer.person)} onMap=${onMap} photos=${photos}
      onCluster=${onRecord ? cluster => onRecord({collection: 'clusters', id: String(cluster.id)}) : undefined} />`; break;
    case 'vehicles': content = model.cars[0] ? html`<${VehicleDetail} ...${props} car=${model.cars[0]} />` : html`<p role="status">Loading vehicle…</p>`; break;
    case 'properties': content = model.homes[0] ? html`<${PropertyDetail} ...${props} home=${model.homes[0]} />` : html`<p role="status">Loading property…</p>`; break;
    case 'insurance': content = html`<${PolicyDetail} ...${props} policy=${answer.insurance} />`; break;
    case 'things': content = html`<${ThingDetail} ...${props} thing=${answer.thing} />`; break;
    case 'papers': content = html`<${PaperDetail} ...${props} paper=${answer.paper} />`; break;
    case 'taxes': content = html`<${TaxDetail} ...${props} packet=${answer.packet} />`; break;
    case 'clusters': content = model.detail ? html`<${ClusterDetail} key=${model.detail.cluster.id} ...${props} onRecord=${onRecord}
      onPage=${({document}) => document ? host.call('document.page', {id: document.id, url: document.url ?? null}) : Promise.resolve()} />` : html`<p role="status">Loading cluster…</p>`; break;
  }
  return html`<div class=${`dk-${target.collection}`} data-collection=${target.collection} data-entity-id=${target.id} onKeyDown=${event => {
    if ((event.key === ' ' || event.key === 'Enter') && event.target.closest?.('button, a')) event.stopPropagation();
  }}>
    ${model?.error ? html`<${Failure} backend="bridge" error=${model.error} host=${host} retry=${() => model.refresh()} />` : null}${target.collection === 'people' ? null : photos}${content}</div>`;
}


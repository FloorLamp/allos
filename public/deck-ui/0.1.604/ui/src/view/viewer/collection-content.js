import {h} from '../../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useMemo, useState} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {collectionTarget} from '../../collection-target.js';
import {collectionAnswer, normalizeCollectionAnswer} from '../../collection-reader.js';
import {createCollectionEntity} from '../../collection-entity.js';
import {normalizePersonProfile} from '../../people.js';
import {PersonProfileContent} from '../person-profile.js';
import {VehicleDetail} from '../vehicles.js';
import {PropertyDetail} from '../properties.js';
import {PolicyDetail} from '../insurance.js';
import {ThingDetail} from '../things.js';
import {PaperDetail} from '../papers.js';
import {TaxDetail} from '../taxes.js';
import {ClusterDetail} from '../clusters.js';
import {Failure} from '../failure.js';
const html = htm.bind(h);

/** Shared detail content for viewer history and collection drawers. Loaded pages are consumed directly. */
export function CollectionContent({host, target, payload, view = {}, onOpen, onMap, onClose, mapping, onReady}) {
  const [state, setState] = useState({}), [retry, setRetry] = useState(0);
  const normalized = collectionTarget(target) ?? collectionTarget(payload);
  const key = normalized ? `${normalized.collection}:${normalized.id}` : '';
  useEffect(() => {
    const request = new AbortController();
    setState({});
    if (!payload && normalized) collectionAnswer(host, normalized, {signal: request.signal}).then(answer => {
      if (!request.signal.aborted) setState({key, answer});
    }, error => { if (!request.signal.aborted) setState({key, error}); });
    return () => request.abort();
  }, [host, key, payload, retry]);
  const rawAnswer = payload ?? (state.key === key ? state.answer : null);
  const answer = useMemo(() => normalizeCollectionAnswer(rawAnswer), [rawAnswer]);
  if (state.key === key && state.error) return html`<${Failure} backend="bridge" error=${state.error} host=${host} retry=${() => setRetry(n => n + 1)} />`;
  if (!answer) return html`<p role="status">Loading details…</p>`;
  return html`<${LoadedCollection} key=${key} host=${host} answer=${answer} view=${view} onOpen=${onOpen} onMap=${onMap} onClose=${onClose} mapping=${mapping} onReady=${onReady} />`;
}

function LoadedCollection({host, answer, view, onOpen, onMap, onClose, mapping, onReady}) {
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
  const props = {host, onOpen, view, model};
  let content;
  switch (target.collection) {
    case 'people': content = html`<${PersonProfileContent} ...${props} profile=${normalizePersonProfile(answer.person)} onMap=${onMap}
      onCluster=${cluster => host.call('url.open', {url: `https://deck.wang.team/clusters#${encodeURIComponent(cluster.id)}`})} />`; break;
    case 'vehicles': content = model.cars[0] ? html`<${VehicleDetail} ...${props} car=${model.cars[0]} />` : html`<p role="status">Loading vehicle…</p>`; break;
    case 'properties': content = model.homes[0] ? html`<${PropertyDetail} ...${props} home=${model.homes[0]} />` : html`<p role="status">Loading property…</p>`; break;
    case 'insurance': content = html`<${PolicyDetail} ...${props} policy=${answer.insurance} />`; break;
    case 'things': content = html`<${ThingDetail} ...${props} thing=${answer.thing} />`; break;
    case 'papers': content = html`<${PaperDetail} ...${props} paper=${answer.paper} />`; break;
    case 'taxes': content = html`<${TaxDetail} ...${props} packet=${answer.packet} />`; break;
    case 'clusters': content = model.detail ? html`<${ClusterDetail} key=${model.detail.cluster.id} ...${props} onSelect=${onClose ? () => onClose() : undefined}
      onPage=${({document}) => document ? host.call('document.page', {id: document.id, url: document.url ?? null}) : Promise.resolve()} />` : html`<p role="status">Loading cluster…</p>`; break;
  }
  return html`<div class=${`dk-${target.collection}`} data-collection=${target.collection} data-entity-id=${target.id} onKeyDown=${event => {
    if ((event.key === ' ' || event.key === 'Enter') && event.target.closest?.('button, a')) event.stopPropagation();
  }}>
    ${model?.error ? html`<${Failure} backend="bridge" error=${model.error} host=${host} retry=${() => model.refresh()} />` : null}${content}</div>`;
}


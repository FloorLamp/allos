import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Chart} from './chart.js';
import {Facts, Section} from './drawer.js';
import {RowList} from './rows.js';
import {Failure, StateBlock} from './page-state.js';
import {useCollectionPage, CollectionSearch, CollectionPager} from './collection-page.js';
import {describeFailure} from '../failure.js';
const html = htm.bind(h);

// Registry ids alone associate devices, areas and states; names never establish identity.
export function habitatDeviceRows(registry, states) {
  const live = new Map(states.map(state => [state.entity_id, state]));
  return registry.devices.filter(device => !device.disabled_by).map(device => {
    const entities = registry.entities.filter(entity => entity.device_id === device.id && !entity.disabled_by && !entity.hidden_by);
    return {id: device.id, title: device.name_by_user || device.name || device.model || 'Device',
      sub: [registry.areas.find(area => area.area_id === device.area_id)?.name,
        ...entities.map(entity => live.get(entity.entity_id)?.state)].filter(Boolean).join(' · ')};
  });
}
export const electricityData = (months, exported = false) => ({unit: 'kWh', points: months.map(month => ({period: month.period, value: exported ? month.export : month.import}))});

export function HabitatThings({host}) {
  const [data, setData] = useState(null), [error, setError] = useState(null), [retry, setRetry] = useState(0);
  const [selected, select] = useState(null), [detail, setDetail] = useState(null), [detailError, setDetailError] = useState(null);
  useEffect(() => {
    const request = new AbortController();
    setData(null); setError(null); select(null);
    Promise.all(['ha.registry', 'ha.states', 'envoy'].map(op => host.call(`habitat.${op}`, {}, {signal: request.signal})))
      .then(([registry, states, envoy]) => { if (!request.signal.aborted) setData({registry, states, envoy}); },
        error => { if (!request.signal.aborted) setError(describeFailure('habitat', error)); });
    return () => request.abort();
  }, [host, retry]);
  useEffect(() => {
    const request = new AbortController();
    setDetail(null); setDetailError(null);
    if (selected) host.call('habitat.ha.device', {query: {id: selected}}, {signal: request.signal})
      .then(value => { if (!request.signal.aborted) setDetail(value); },
        error => { if (!request.signal.aborted) setDetailError(describeFailure('habitat', error)); });
    return () => request.abort();
  }, [host, selected, retry]);
  const devices = useCollectionPage(data ? habitatDeviceRows(data.registry, data.states) : [], {size: 20});
  return html`<section aria-label="Habitat things">
    ${error ? html`<${Failure} backend="habitat" error=${error} host=${host} retry=${() => setRetry(n => n + 1)} />` : !data ? html`<p role="status">Loading Habitat…</p>` : html`
      <${Section} title="Devices" actions=${html`<button class="dk-btn" type="button" onClick=${() => setRetry(n => n + 1)}>Refresh Habitat</button>`}><${CollectionSearch} page=${devices} label="Search devices" />
        <${RowList} items=${devices.items} onOpen=${row => select(row.id)} empty=${{title: 'No devices'}} />
        <${CollectionPager} page=${devices} label="Device pages" /><//>
      ${selected ? html`<section aria-label="Device details"><button class="dk-btn" onClick=${() => select(null)}>Close device</button>
        ${detailError ? html`<${Failure} backend="habitat" error=${detailError} host=${host} retry=${() => setRetry(n => n + 1)} />` : detail?.device.id === selected ? html`<h2>${detail.device.name_by_user || detail.device.name || 'Device'}</h2>
          <${Facts} facts=${[{label: 'Room', value: detail.area?.name}, ...detail.entities.filter(e => !e.disabled_by && !e.hidden_by).map(entity => ({label: entity.name || entity.original_name || entity.entity_id,
            value: detail.states.find(state => state.entity_id === entity.entity_id)?.state ?? 'Unknown'}))].filter(fact => fact.value)} />` : html`<p role="status">Loading device…</p>`}</section>` : null}
      <${Section} title="Electricity">${data.envoy.months.length ? html`
        <h3>Grid imports</h3><${Chart} label="Grid imports" data=${electricityData(data.envoy.months)} />
        <h3>Grid exports</h3><${Chart} label="Grid exports" data=${electricityData(data.envoy.months, true)} />
        ${data.envoy.months.some(month => month.partial) ? html`<p>Partial months include only recorded days.</p>` : null}` : html`<${StateBlock} inline=${true} line="No electricity readings" />`}<//>`}
  </section>`;
}

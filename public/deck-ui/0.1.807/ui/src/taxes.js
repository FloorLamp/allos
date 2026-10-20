import {describeFailure} from './failure.js';
import {maskIdentifiers, maskedIdentifier} from './identifiers.js';
import {plural} from './format.js';
export const missingLabel = item => `${item.person?.name ?? 'Unassigned'} · ${item.kind} · ${/\d/.test(item.scope ?? '') ? maskedIdentifier(item.scope) : item.scope}`;
export const taxRow = packet => ({id: String(packet.year), title: `${packet.year} tax packet`, glyph: 'document',
  sub: packet.subtitle ?? `${packet.done}/${packet.total} checklist items present · ${packet.missing.length ? `${plural(packet.missing.length, 'expected item')} missing` : 'No missing items'}`});
export function createTaxes(host) {
  let stopped = false, generation = 0, request, detailRequest, detailGeneration = 0;
  const subscribers = new Set();
  const changed = () => { for (const fn of subscribers) fn(); };
  const model = {
    packets: [], loading: false, warming: false, error: null, year: null, packet: null, detailLoading: false, detailError: null,
    close() { detailRequest?.abort(); detailGeneration++; model.year = null; model.packet = null; model.detailLoading = false; model.detailError = null; changed(); },
    async open(year) {
      if (stopped) return;
      model.close(); model.year = year; model.detailLoading = true;
      const current = ++detailGeneration; detailRequest = new AbortController(); changed();
      try {
        const packet = await host.call('bridge.taxPacket', {year}, {signal: detailRequest.signal});
        if (!stopped && current === detailGeneration) model.packet = packet;
      } catch (e) { if (!stopped && current === detailGeneration) model.detailError = describeFailure('bridge', e); }
      if (!stopped && current === detailGeneration) { model.detailLoading = false; changed(); }
    },
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    async refresh() {
      if (stopped) return;
      request?.abort(); request = new AbortController();
      const {signal} = request, current = ++generation;
      model.close(); model.warming = false; model.loading = true; model.error = null; changed();
      try {
        const answer = await host.call('bridge.taxes', {}, {signal,
          onWarming: () => { if (!signal.aborted) { model.warming = true; changed(); } },
        });
        const packets = maskIdentifiers(answer?.results ?? []);
        if (!stopped && current === generation) model.packets = packets;
      } catch (e) {
        if (!stopped && current === generation) { model.error = describeFailure('bridge', e); if (model.error.state !== 'warming') model.packets = []; }
      }
      if (!stopped && current === generation) { model.warming = false; model.loading = false; changed(); }
    },
    stop() { stopped = true; request?.abort(); detailRequest?.abort(); generation++; detailGeneration++; subscribers.clear(); },
  };
  return model;
}

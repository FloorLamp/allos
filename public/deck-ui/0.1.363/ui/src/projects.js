import {HostError} from './host/host.js';
// Document undertakings, named Clusters in the published navigation.
export function createProjects(host) {
  const listeners = new Set();
  let listRequest, detailRequest, mutation, stopped = false;
  const notify = () => { if (!stopped) for (const fn of listeners) fn(); };
  const model = {
    clusters: [], detail: null, id: null, all: false, loading: false, detailLoading: false, busy: false, error: null,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async refresh() {
      if (stopped) return;
      listRequest?.abort();
      const request = listRequest = new AbortController();
      model.loading = true; model.error = null; notify();
      try {
        if (!host.caps.clusters) throw new HostError('unsupported');
        const answer = await host.call('bridge.clusters', {all: model.all}, {signal: request.signal});
        if (!stopped && !request.signal.aborted) model.clusters = answer.clusters ?? [];
      } catch (error) { if (!stopped && !request.signal.aborted) model.error = error; }
      finally { if (!stopped && !request.signal.aborted) { model.loading = false; notify(); } }
    },
    async select(id) {
      detailRequest?.abort();
      model.id = id; model.detail = null; model.error = null; model.detailLoading = !!id; notify();
      if (!id || stopped) return;
      const request = detailRequest = new AbortController();
      try {
        const answer = await host.call('bridge.cluster', {id}, {signal: request.signal});
        if (!stopped && !request.signal.aborted) { model.detail = answer; model.id = answer.cluster.id; }
      } catch (error) { if (!stopped && !request.signal.aborted) model.error = error; }
      finally { if (!stopped && !request.signal.aborted) { model.detailLoading = false; notify(); } }
    },
    async edit(action, payload = {}, id = model.id) {
      if (stopped || model.busy || !id) return;
      const selected = model.id;
      mutation = new AbortController();
      model.busy = true; model.error = null; notify();
      try {
        const answer = await host.call('bridge.clusterEdit', {id, action, ...payload}, {signal: mutation.signal});
        if (stopped) return;
        await model.refresh();
        if (model.id === selected) await model.select(answer.id);
      } catch (error) { if (!stopped) model.error = error; }
      finally { if (!stopped) { model.busy = false; notify(); } }
    },
    stop() { stopped = true; listRequest?.abort(); detailRequest?.abort(); mutation?.abort(); listeners.clear(); },
  };
  return model;
}

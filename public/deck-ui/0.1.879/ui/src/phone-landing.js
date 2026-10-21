// Phone-only reads for the shared landing. Today opens Flightplan's existing item drawer; plan/fleet transforms are shared with the popover.
import {planGroups, fleetStatus} from './glance-data.js';
import {glanceView} from './glance.js';
import {newYork} from './flightplan.js';

/** Tower publishes Sortie's jobs per worker; normalize that transport into the popover's existing slot reader. */
export function towerFleet(live) {
  const workers = live?.sortie?.workers;
  if (!Array.isArray(workers)) throw new Error('Tower fleet did not answer');
  return fleetStatus({running: workers.flatMap(w => w.running ?? []), workers: workers.map(w => ({...w,
    running: (w.running ?? []).map(j => j.id), info: {reserve: w.reserve, why: w.why, load: {perCore: w.loadPerCore}}}))});
}

export function createPhoneLanding(host, {now = () => Date.now()} = {}) {
  const listeners = new Set();
  let request = null, stopped = false;
  const notify = () => { if (!stopped) for (const fn of listeners) fn(); };
  const model = {
    date: newYork(now()).day, today: [], plans: [], fleet: [], errors: {}, loading: false,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async refresh() {
      if (stopped) return;
      request?.abort(); const mine = request = new AbortController();
      model.loading = true; notify();
      const read = async (key, op, args, take) => {
        try {
          const r = await host.call(op, args, {signal: mine.signal});
          if (stopped || mine.signal.aborted) return;
          take(r); delete model.errors[key];
        } catch (e) { if (!stopped && !mine.signal.aborted) model.errors[key] = e; }
        finally { if (!stopped && !mine.signal.aborted) notify(); }
      };
      await Promise.all([
        ...(host.backends?.includes('flightplan') ? [read('today', 'flightplan.today', {query: {repo: 'none'}}, r => {
          model.date = r?.date ?? newYork(now()).day;
          model.today = (r?.items ?? []).filter(i => !i.repo && !['task', 'epic', 'need'].includes(i.kind) && !['done', 'dropped', 'needs-you'].includes(i.status))
            .sort((a, b) => (a.due ?? model.date).localeCompare(b.due ?? model.date) || a.id - b.id);
        })] : []),
        // AI plans and Fleet are the owner's: only a host with the `tower` cap asks for them.
        ...(host.caps.tower ? [read('plans', 'bridge.tower', {name: 'plans'}, r => {
          if (!Array.isArray(r?.plans)) throw new Error('Tower plans did not answer');
          model.plans = glanceView({glance: {plans: planGroups(r)}}, now()).plans;
        }),
        read('fleet', 'bridge.tower', {name: 'live'}, r => { model.fleet = glanceView({glance: {fleet: towerFleet(r)}}, now()).fleet; })] : []),
      ]);
      if (!stopped && !mine.signal.aborted) { model.loading = false; notify(); }
    },
    stop() { stopped = true; request?.abort(); listeners.clear(); },
  };
  return model;
}

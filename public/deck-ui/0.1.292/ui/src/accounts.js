import {describeFailure} from './failure.js';
// Shared Accounts contract: registry reads, origin deduplication and per-backend last good lists.
import {ago} from './quantity.js';
export {ago} from './quantity.js';
export const KINDS = [['money', 'Money'], ['health', 'Health'], ['utility', 'Utilities'], ['website', 'Websites'], ['api', 'API connections'], ['cloud', 'Home and device clouds']];
const order = ['needs-you', 'failing', 'paused', 'unknown', 'ok'];
export function subtitle(a, now) {
  const state = {'needs-you': 'Needs you', failing: 'Failing', paused: 'Paused', unknown: 'State not known', ok: 'OK'}[a.state] ?? 'State not known';
  const at = a.sensitive ? a.lastRun?.at : a.lastSuccess?.at;
  return state + (a.lastRun?.why ? ` · ${a.lastRun.why}` : '') + (at ? ` · last ${a.sensitive ? 'run' : 'success'} ${ago(at, now)}` : '');
}
export function rowOf(a, now) {
  const r = {id: a.id, key: `${a.backend}/${a.id}`, backend: a.backend, owner: a.owner ?? a.backend, group: a.group,
    title: a.institution ?? a.service?.name ?? a.id, person: a.person, sub: subtitle(a, now), state: a.state,
    tone: ['needs-you', 'failing'].includes(a.state) ? 'warn' : '',
    coverage: [a.data?.count != null ? `${a.data.count} ${a.data.kind ?? 'items'}` : null,
      [a.data?.from, a.data?.to].filter(Boolean).join(' – ')].filter(Boolean).join(' · '), stale: a.stale};
  if (!a.sensitive) Object.assign(r, {connection: a.connection, credential: a.credential?.ref, actions: a.actions ?? []});
  return r;
}
export function groups(accounts, now) {
  return KINDS.map(([kind, label]) => ({kind, label, rows: accounts.filter(a => a.group === kind).map(a => rowOf(a, now))
    .sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || a.title.localeCompare(b.title))})).filter(g => g.rows.length);
}
export function createAccounts(host, {clock = Date.now, outcomeMs = 4000} = {}) {
  const fns = new Set(), timers = new Set(), lists = new Map();
  const a = {accounts: [], loading: true, error: null, failures: [], outcome: null, pending: new Set(), notReady: new Map(),
    backends: host.backends ?? [], subscribe(fn) { fns.add(fn); return () => fns.delete(fn); },
    async start() {
      if (!host.resume) return a.refresh();
      try {
        const r = await host.resume('accounts');
        if (r?.window?.url) await host.call('url.open', {url: r.window.url});
        if (r) say(r.message ?? 'Started');
      } catch (e) { say(describeFailure('rover', e).message, true); }
      return a.refresh();
    }, stop() { for (const t of timers) clearTimeout(t); },
    async refresh() {
      await Promise.all(a.backends.map(async backend => {
        const previous = lists.get(backend);
        try {
          const r = await host.call(`${backend}.accounts`, {});
          lists.set(backend, {accounts: r?.accounts ?? [], generated: r?.generated ?? new Date(clock()).toISOString()});
          for (const key of a.pending) if (key.startsWith(`${backend}/`)) a.pending.delete(key);
          for (const key of a.notReady.keys()) if (key.startsWith(`${backend}/`)) a.notReady.delete(key);
        } catch (e) {
          if (e?.code !== 'unsupported' || previous) lists.set(backend, {...previous, error: describeFailure(backend, e)});
        }
      }));
      const merged = new Map();
      for (const [backend, list] of lists) for (const account of list.accounts ?? []) {
        const origin = account.from ?? {backend, id: account.id};
        const key = JSON.stringify([origin.backend, origin.id]);
        if (!merged.has(key) || !account.from) merged.set(key, {...account, backend,
          owner: origin.backend, stale: list.error ? list.generated : null});
      }
      a.accounts = [...merged.values()];
      a.failures = [...lists].filter(([, l]) => l.error).map(([backend, l]) => ({backend, error: l.error}));
      a.error = [...lists].filter(([, l]) => l.error).map(([b, l]) => l.error.message).join('; ') || null;
      a.loading = false; changed();
    },
    groups: () => groups(a.accounts, clock()),
    async act(row, action) {
      if (a.pending.has(row.key) || a.notReady.has(row.key)) return null;
      try {
        const r = action.kind === 'url' ? await host.call('url.open', {url: action.url})
          : await host.call(`${row.backend}.${action.op}`, {query: {id: row.id}});
        if (action.kind === 'op') a.pending.add(row.key);
        if (r?.window?.url) await host.call('url.open', {url: r.window.url});
        say(r?.message ?? (action.reach === 'lan' || r?.window?.reach === 'lan' ? 'at home or on VPN' : 'Started'));
        return r;
      } catch (e) {
        // a 401 the backend's session landing can renew (rover's): there at once, the click retried on return (contract/accounts.md)
        if (e?.renew) { e.renew('accounts'); return null; }
        if (e?.status === 503) a.notReady.set(row.key, 'Action isn’t ready');
        say(describeFailure(row.backend, e).message, true); return null;
      }
    },
  };
  function changed() { for (const fn of fns) fn(a); }
  function say(text, bad = false) {
    const o = a.outcome = {text, bad};
    const t = setTimeout(() => { timers.delete(t); if (a.outcome === o) { a.outcome = null; changed(); } }, outcomeMs);
    timers.add(t); changed();
  }
  return a;
}

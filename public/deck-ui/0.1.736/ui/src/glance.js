// The menu bar's popover (palette SPEC.md, *Menu bar and tray*): what the shell's `glance.get` holds (`deck glance --json --worker
// <host>`, the Sortie switch's state) as the sections the page draws, within one screen: this Mac's Sortie switch first, at most 3
// problems, at most 4 rows running (this Mac's first; a PR, batch or task once), one tile per AI plan account, the projects' summary
// and the first 3 (flightplan's order: priority, then the owner's); the fleet's machines (Sortie's: slots, load by hour). Each section
// folds, remembered in the shell's prefs.
// `createGlance(host)`: the state as the shell last pushed it (`glance.changed`) and its actions.
import {age} from './quantity.js';

export const PROBLEMS = 3, RUNNING = 4, PROJECTS = 3;
/** The prefs key of the folded sections (a comma list of their ids). */
export const COLLAPSED = 'glanceCollapsed';

const AGENT = {claude: 'Claude', codex: 'Codex'};
/** A project's verdict (flightplan CONTRACT.md, *Projects*) as its mark: waiting on you warn, stuck bad, the rest live. */
const VERDICT = {'waiting-on-you': 'warn', stuck: 'bad', moving: 'ok', idle: 'idle', 'not-split': 'idle'};
/** Windows a tile leaves out (owner, 2026-10-17: no Fable). */
const HIDDEN = new Set(['week, Fable']);

const time = iso => (iso ? Date.parse(iso) : NaN);
const ageOf = (iso, now) => (Number.isFinite(time(iso)) ? age(time(iso), now) : '');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "resets in 3 h" / "full Mon 04:06 before reset" for a plan window. */
export function windowTip(w, now = Date.now()) {
  const full = time(w.fullAt), reset = time(w.resetsAt);
  if (Number.isFinite(full)) {
    const at = new Date(full).toLocaleString('en-US', {weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false});
    return `full ${at} before reset`;
  }
  if (!Number.isFinite(reset)) return '';
  const s = Math.max(0, (reset - now) / 1000);
  return `resets in ${s < 3600 ? `${Math.max(1, Math.floor(s / 60))} min` : s < 172800 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} d`}`;
}

/** A window's tone: bad at 100 %, warn from 80 % or when it fills before its reset (MenuBar's PlanRow, Tray's PlanLine). */
export const windowTone = w => ((w.percent ?? 0) >= 100 ? 'bad' : (w.percent ?? 0) >= 80 || w.fullAt ? 'warn' : 'ok');

export const SORTIE_MODES = [{value: 'off', label: 'Off'}, {value: 'auto', label: 'Throttle when in use'}, {value: 'max', label: 'Max'}];
export const modeLabel = mode => SORTIE_MODES.find(option => option.value === mode)?.label;
export const shortModeLabel = mode => mode === 'auto' ? 'Throttled' : modeLabel(mode);

/** Runtime indicators use worker-reported policy/activity, never text or a requested but unapplied mode. */
export function fleetRuntime(machine) {
  const state = (kind, label, tone, glyph) => ({kind, label, tone, glyph});
  if (['offline', 'asleep'].includes(machine.state)) return state('offline', machine.state === 'asleep' ? 'Asleep' : 'Offline', 'idle', 'close');
  if (!['online', 'drained'].includes(machine.state)) return state('unknown', 'Worker status unavailable', 'idle', 'ask');
  if (machine.mode === 'off') return state('off', `${machine.busy ? 'Finishing work · ' : ''}Off · no new jobs`, 'idle', 'toggle');
  if (machine.state === 'drained' || machine.paused === true) return state('paused', `${machine.busy ? 'Finishing work · ' : ''}Paused`, 'warn', 'lock');
  const running = machine.busy > 0, prefix = running ? 'Running' : 'Ready';
  if (machine.inUse === true && machine.appliedMode === 'max') return state('in-use-max', `${prefix} at Max while machine is in use`, 'accent', 'bolt');
  if (machine.inUse === true && machine.throttled === true) return state('in-use-throttled', `${prefix} throttled while machine is in use`, 'warn', 'person');
  if (machine.throttled === true) return state('throttled', machine.inUse === false ? `${prefix} throttled while machine is not in use` : `${prefix} throttled · activity unknown`, 'warn', 'chart');
  if (machine.inUse === false) return state('idle-machine', `${prefix} while machine is not in use`, 'ok', 'play');
  if (machine.inUse === true) return state('in-use', `${prefix} while machine is in use · runtime policy unknown`, 'idle', 'person');
  return state('unknown', `${prefix} · activity and runtime policy unknown`, 'idle', 'ask');
}

/** Keep the coordinator's confirmed mode visible while a requested change settles. */
export function sortieLine(sortie, worker) {
  if (!sortie) return null;
  if (sortie.error) return sortie.error;
  if (sortie.busy) return sortie.pendingMode ? `Setting ${modeLabel(sortie.pendingMode)}…` : 'Updating…';
  return sortie.mode === 'auto' && sortie.state === 'on' && sortie.line === modeLabel('auto') && worker?.reason ? `${sortie.line} · ${worker.reason}` : sortie.line;
}

/** The sections from `glance.get`'s answer `{glance, sortie, updated, hotkey}` at `now`. */
export function glanceView({glance, sortie, host, updated, hotkey} = {}, now = Date.now()) {
  const g = glance ?? {}, items = g.items ?? [], worker = g.worker ?? null, tower = g.tower ?? 'https://spaceport.wang.team';
  const problems = [...(g.receiving ? [{kind: 'problem', severity: 'warn', text: `Not receiving: ${g.receiving}`}] : []), ...items.filter(i => i.kind === 'problem')];
  const tight = items.filter(i => i.kind === 'plan');
  const localHost = host ?? g.host ?? sortie?.host;
  const seen = new Set(), running = [];
  const add = (item, row) => {
    if (!localHost || item.host !== localHost || !item.id) return;
    const key = item.jobId != null ? `sortie:${item.jobId}` : item.id;
    if (seen.has(key)) return;
    seen.add(key); running.push(row);
  };
  for (const r of worker?.running ?? []) add(r, {text: r.text, sub: 'this machine', age: ageOf(r.since, now), url: r.url, mine: true, working: true});
  for (const i of items.filter(i => i.kind === 'running')) {
    const sub = [i.detail, i.done ? `${i.done} done` : null].filter(Boolean).join(' · ');
    add(i, {text: i.text, sub, age: ageOf(i.since, now), url: i.url, mine: true, working: true});
  }
  return {
    tower,
    sortie: sortie ? {host: sortie.host, mode: sortie.mode, modeLabel: shortModeLabel(sortie.mode), pendingMode: sortie.pendingMode, error: sortie.error, busy: !!sortie.busy, enabled: !!sortie.enabled && !sortie.busy, line: sortieLine(sortie, worker), title: worker?.title ?? null,
      tone: sortie.state === 'unreachable' || worker?.problem ? 'bad' : sortie.state === 'on' ? 'ok' : 'warn'} : null,
    problems: {rows: problems.slice(0, PROBLEMS).map(i => ({text: i.text, tip: i.detail || i.text, age: ageOf(i.since, now), url: i.url, tone: i.severity === 'bad' ? 'bad' : 'warn'})),
      more: Math.max(0, problems.length - PROBLEMS), url: tower},
    running: {rows: running.slice(0, RUNNING), more: Math.max(0, running.length - RUNNING), url: `${tower.replace(/\/$/, '')}/agents/`},
    plans: (g.plans ?? []).map(p => ({key: `${p.agent}:${p.account}`, name: `${AGENT[p.agent] ?? p.agent} ${p.name}`, agent: AGENT[p.agent] ?? p.agent, agentId: p.agent, account: p.name,
      url: `${tower.replace(/\/$/, '')}/usage/`, tight: tight.some(t => t.text.startsWith(`${AGENT[p.agent] ?? p.agent} ${p.name}:`)),
      windows: p.windows.filter(w => !HIDDEN.has(w.window)).map(w => ({label: w.window, percent: Math.round(w.percent ?? 0), tone: windowTone(w), tip: windowTip(w, now)}))})),
    fleet: (g.fleet ?? []).map(m => {
      const busy = m.slots.filter(s => s !== 'free' && s !== 'reserve').length;
      const tone = m.state === 'drained' ? 'warn' : m.state === 'online' ? (busy ? 'live' : 'ok') : m.state === 'asleep' || m.intermittent ? 'idle' : 'bad';
      const local = m.name === localHost;
      // The native status read confirms the selected policy; worker application is separate and only known when reported.
      const mode = local && modeLabel(sortie?.mode) ? sortie.mode : modeLabel(m.mode) ? m.mode : null;
      const appliedMode = modeLabel(m.appliedMode) ? m.appliedMode : null;
      const syncing = !!mode && !!appliedMode && mode !== appliedMode;
      const pending = local && sortie?.busy && modeLabel(sortie.pendingMode) ? sortie.pendingMode : null;
      return {name: m.name, state: m.state, tone, slots: m.slots, busy, load: m.loadPerCore, hours: m.loadHours ?? [],
        local, mode, appliedMode,
        runtime: fleetRuntime({...m, busy, mode, appliedMode}),
        tip: [`${m.name}${local ? ' (this machine)' : ''}: ${m.state}`, mode ? `Selected: ${modeLabel(mode)}` : null,
          syncing ? `Worker reports ${modeLabel(appliedMode)}; syncing` : null, pending ? `Setting ${modeLabel(pending)}…` : null,
          `${busy} of ${m.slots.length} slots`, m.loadPerCore == null ? null : `load ${m.loadPerCore} per core`, m.why].filter(Boolean).join(' · ')};
    }),
    projects: g.projects?.projects?.length ? {summary: g.projects.summary,
      rows: g.projects.projects.slice(0, PROJECTS).map(p => ({id: p.id, line: p.line, tone: VERDICT[p.verdict] ?? 'live', url: `https://deck.wang.team/flightplan?epic=${p.id}#board`})),
      more: Math.max(0, g.projects.projects.length - PROJECTS), url: 'https://deck.wang.team/flightplan#board'} : null,
    error: g.error ?? (glance === null ? 'deck glance did not answer' : null),
    updated: updated ? new Date(updated).toLocaleTimeString('en-US', {hour: '2-digit', minute: '2-digit', hour12: false}) : null,
    clear: !problems.length && !running.length,
    hotkey: hotkey ?? null,
  };
}

/** The shell's state and actions: `subscribe(fn)` with each view, `setMode(mode)` the Sortie control, `refresh()`, `open(url)`, `palette()`. */
export function createGlance(host, {now = () => Date.now()} = {}) {
  let state = {glance: undefined, sortie: null, updated: null}, busy = false, collapsed = new Set();
  const subs = new Set();
  const view = () => ({...glanceView(state, now()), loading: state.glance === undefined, busy, collapsed});
  const publish = () => { const v = view(); for (const fn of subs) fn(v); return v; };
  const take = s => { if (s) state = s; return publish(); };
  const off = host.on('glance.changed', take);
  return {
    subscribe(fn) { subs.add(fn); fn(view()); return () => subs.delete(fn); },
    async load() {
      // the sections folded last time (the shell's prefs; owner, 2026-10-17: collapsible sections)
      const kept = await host.call('prefs.get', {key: COLLAPSED}).catch(() => null);
      if (typeof kept?.value === 'string') collapsed = new Set(kept.value.split(',').filter(Boolean));
      return take(await host.call('glance.get'));
    },
    /** A section folded or opened, kept for the next open. */
    toggleSection(id) {
      collapsed = new Set(collapsed);
      if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
      publish();
      return host.call('prefs.set', {key: COLLAPSED, value: [...collapsed].join(',')}).catch(() => {});
    },
    async refresh() { busy = true; publish(); try { return take(await host.call('glance.refresh')); } finally { busy = false; publish(); } },
    async setMode(mode) {
      if (!SORTIE_MODES.some(option => option.value === mode)) throw new Error('Unknown Sortie mode');
      if (!state.sortie?.enabled || state.sortie.busy || state.sortie.mode === mode) return;
      const was = state.sortie;
      state = {...state, sortie: {...was, busy: true, pendingMode: mode}}; publish();
      try { state = {...state, sortie: (await host.call('sortie.set', {mode})) ?? was}; }
      catch (e) {
        const confirmed = state.sortie?.busy === false ? state.sortie : was;
        state = {...state, sortie: {...confirmed, error: 'Couldn’t update Sortie. Try again.'}}; throw e;
      }
      finally { publish(); }
    },
    open: url => host.call('url.open', {url}).then(() => host.call('window.hide', {reason: 'opened'})),
    palette: () => host.call('palette.show'),
    hide: () => host.call('window.hide'),
    stop() { off(); subs.clear(); },
  };
}

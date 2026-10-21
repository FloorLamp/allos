// Every Habitat rule on one page (contract/house.md *Rules*): Habitat's `habitat.rules` rows in its own words, searched, filtered and
// grouped by area; a row opened in place reads its newest runs (`habitat.runs`) and, for the owner, its shadow report and the mode
// switch (`habitat.rule`), asked first. No DOM: view/house-rules.js draws it.
import {habitatClient} from './habitat.js';
import {describeFailure} from './failure.js';
import {fieldLabel, plural} from './format.js';

const list = (r, key) => Array.isArray(r) ? r : r?.[key] ?? [];
/** Habitat's areas in the order a person walks the house; any other after them, by name. */
export const AREAS = ['Bedrooms', 'Primary suite', 'Kitchen & living', 'Cafe', 'Utility & entry', 'Climate', 'Garage', 'Deliveries',
  'Cameras & tablets', 'Appliances', 'Yard', 'Notifications', 'Watchdogs', 'Practices', 'Away'];
const OTHER = 'Other';
/** Fired lately: within a day. */
export const RECENT_MS = 24 * 3600000;

/** A Habitat rule row as the page reads it: `mode` live | shadow | off (Habitat's switch, or off while it is disabled). */
export function ruleOf(r) {
  const name = String(r.name);
  return {
    name, title: r.title && r.title !== name ? r.title : name.split('.').map(fieldLabel).join(' · '), summary: r.summary ?? null,
    area: r.area || OTHER, mode: r.enabled === false ? 'off' : r.mode === 'live' ? 'live' : 'shadow', switchMode: r.mode,
    inputs: r.inputs ?? r.entities ?? [], outputs: r.outputs ?? [], lastFired: r.last_fired ?? null, outcome: r.last_outcome ?? null,
    healthy: r.healthy !== false, shadow: r.shadow ?? null, automation: r.automation ?? null, shadowOnly: !!r.shadow_only,
    transition: r.transition ?? null,
  };
}

/** What a rule's last action came to, in words: `Done`, `Recorded in shadow`, `Failed: <error>`; null when it never fired. */
export function outcomeText(outcome) {
  if (!outcome) return null;
  if (outcome.ok === false) return outcome.error ? `Failed: ${outcome.error}` : 'Failed';
  return outcome.shadow ? 'Recorded in shadow' : 'Done';
}

const folded = s => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
/** The words a search matches a rule by: its title, id, summary, area and every entity (ids and the House's names). */
export const ruleText = (r, names = new Map()) => folded([r.title, r.name, r.summary, r.area,
  ...[...r.inputs, ...r.outputs].flatMap(id => [id, names.get(id)?.name])].filter(Boolean).join(' '));

/** The rules a search and the filters keep: `query` (every word somewhere in ruleText), `mode`, `area`, `unhealthy`, `recent`
 *  (fired within RECENT_MS of `now`). */
export function filterRules(rules, {query = '', mode = null, area = null, unhealthy = false, recent = false} = {}, {now = Date.now(), names} = {}) {
  const words = folded(query).trim().split(/\s+/).filter(Boolean);
  return rules.filter(r => (!mode || r.mode === mode) && (!area || r.area === area) && (!unhealthy || !r.healthy)
    && (!recent || r.lastFired && now - Date.parse(r.lastFired) <= RECENT_MS)
    && (!words.length || (text => words.every(w => text.includes(w)))(ruleText(r, names))));
}

/** Rules by area, in AREAS' order then by name; each area's rules by title. */
export function groupRules(rules) {
  const by = new Map();
  for (const r of rules) { if (!by.has(r.area)) by.set(r.area, []); by.get(r.area).push(r); }
  const rank = a => { const i = AREAS.indexOf(a); return i < 0 ? AREAS.length : i; };
  return [...by.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([area, items]) => ({area, rules: items.sort((x, y) => x.title.localeCompare(y.title))}));
}

/** The header's counts: `142 rules · 118 live · 20 shadow · 4 unhealthy` (off and unhealthy only when there are some). */
export function countsText(rules) {
  const n = mode => rules.filter(r => r.mode === mode).length, sick = rules.filter(r => !r.healthy).length;
  return [plural(rules.length, 'rule'), `${n('live')} live`, `${n('shadow')} shadow`, n('off') ? `${n('off')} off` : null,
    sick ? `${sick} unhealthy` : null].filter(Boolean).join(' · ');
}

/** Whether the owner may switch the rule to `mode` now: live from shadow once its seven-day report is ready (never a shadow-only
 *  rule), shadow (roll back) from live; nothing mid-transition or while off. */
export function canSwitch(r, mode, report) {
  if (r.transition || r.mode === 'off') return false;
  if (mode === 'shadow') return r.mode === 'live';
  return mode === 'live' && r.mode === 'shadow' && !r.shadowOnly && !!report?.ready;
}

/** The page's model. opts: `owner` (switches offered; Habitat refuses anyone else's), `clock`. */
export function createRules(host, {owner = false, clock = Date.now} = {}) {
  const habitat = habitatClient(host), listeners = new Set();
  const m = {
    rules: null, names: new Map(), error: null, loading: true, owner, clock,
    runs: new Map(), reports: new Map(), confirm: null, busy: null, outcome: null,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async start() { await Promise.all([m.refresh(), readNames()]); },
    async refresh() {
      try { m.rules = list(await habitat.rules(), 'rules').map(ruleOf); m.error = null; }
      catch (e) { m.error = e; }
      finally { m.loading = false; changed(); }
    },
    rule: name => m.rules?.find(r => r.name === name) ?? null,
    /** A row opened: its newest ten runs, and for the owner a shadow rule's report (whether it may go live). */
    async open(name) {
      const r = m.rule(name);
      if (!r) return;
      if (m.confirm?.name !== name) m.confirm = null;
      m.outcome = null;
      await Promise.all([readRuns(name), m.owner && r.mode === 'shadow' && !r.shadowOnly ? readReport(name) : null]);
    },
    /** The owner asks for a switch: confirmed before anything changes. */
    ask(name, mode) {
      const r = m.rule(name);
      if (!m.owner || !r || m.busy || !canSwitch(r, mode, m.reports.get(name))) return;
      m.confirm = {name, mode}; m.outcome = null; changed();
    },
    cancel() { if (m.confirm) { m.confirm = null; changed(); } },
    async confirmed() {
      const c = m.confirm;
      if (!c) return;
      m.confirm = null; m.busy = c.name; changed();
      try {
        await habitat.rule(c.name, c.mode);
        m.outcome = {name: c.name, text: c.mode === 'live' ? 'Now live: Habitat acts, Home Assistant’s automation is off' : 'Back in shadow: Home Assistant acts again'};
      } catch (e) { m.outcome = {name: c.name, text: describeFailure('Habitat', e).message, bad: true}; }
      m.busy = null;
      await m.refresh();
      if (m.rule(c.name)?.mode === 'shadow') await readReport(c.name);
      changed();
    },
  };
  function changed() { for (const fn of listeners) fn(); }
  async function readNames() {
    try { m.names = new Map(list(await habitat.entities(), 'entities').map(e => [e.id, e])); changed(); }
    catch { /* the chips say ids */ }
  }
  async function readRuns(name) {
    m.runs.set(name, {loading: true, items: m.runs.get(name)?.items ?? [], error: null}); changed();
    try { m.runs.set(name, {loading: false, items: (await host.call('habitat.runs', {query: {id: name, limit: 10}})).runs ?? [], error: null}); }
    catch (e) { m.runs.set(name, {loading: false, items: [], error: e}); }
    changed();
  }
  async function readReport(name) {
    try { m.reports.set(name, list(await habitat.shadowreport(name), 'reports').find(r => r.rule === name) ?? null); }
    catch { m.reports.set(name, null); }
    changed();
  }
  return m;
}

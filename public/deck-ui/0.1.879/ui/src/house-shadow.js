// Shadow reports (contract/house.md *Admin pages*; habitat docs/contract/per-rule-shadow-reports.md): each ported rule's days
// against Home Assistant's automation (`habitat.shadowreport`), its blockers, every unexplained run and its daily counts in words, and
// the owner's cut over or roll back (`habitat.rule`), asked first. Habitat answers 503 with Retry-After while it builds a report: asked
// again until it is ready, for at most PENDING_MS. No DOM: view/house-shadow.js draws it.
import {habitatClient} from './habitat.js';
import {describeFailure} from './failure.js';
import {dateRange, dateText, dateTimeText, fieldLabel, joinText, plural, sentence} from './format.js';
import {ruleOf} from './house-rules.js';

/** How long a report Habitat is still building is waited for before the page says so. */
export const PENDING_MS = 60000;
const list = (r, key) => Array.isArray(r) ? r : r?.[key] ?? [];

/** An entity by its House name (`names`: Habitat's entities by id), else the name Home Assistant gave it in `observed`, else its id in
 *  words (`script.landscape_lights` → `Landscape lights`). */
export const entityName = (id, names = new Map()) => names.get(id)?.name ?? fieldLabel(String(id).split('.').slice(1).join('.') || id);

const KINDS = {habitat_only: 'Habitat only', ha_only: 'Home Assistant only', unverified: 'Unverified', mismatch: 'Mismatch'};
/** A diff's kind in words: `habitat_only` → `Habitat only`. */
export const kindText = kind => KINDS[kind] ?? fieldLabel(kind);

/** A value in words: lists joined, a nested object's own values (`{variables: {turn: 'off'}}` → `Turn off`). */
const valueText = (key, value) => value == null || value === '' ? null
  : Array.isArray(value) ? `${fieldLabel(key)} ${value.join(', ')}`
  : typeof value === 'object' ? joinText(Object.entries(value).map(([k, v]) => valueText(k, v)))
  : `${fieldLabel(key)} ${value}`;

/** A proposed action in words: `script.turn_on` on `script.landscape_lights` with `{variables: {turn: 'off'}}` → `Turn on Landscape
 *  lights (Turn off)`. */
export function actionText(a = {}, names = new Map()) {
  const targets = [a.target?.entity_id ?? []].flat().map(id => entityName(id, names));
  const data = joinText(Object.entries(a.data ?? {}).map(([k, v]) => valueText(k, v)), ', ');
  return joinText([fieldLabel(String(a.action ?? '').split('.').pop()), targets.join(', '), data ? `(${data})` : null], ' ');
}

/** What Home Assistant showed after a run, each entity once in its last state: `Landscape lights on`. */
export function observedText(observed = [], names = new Map()) {
  const last = new Map();
  for (const o of observed) if (o?.entity_id) last.set(o.entity_id, o);
  return joinText([...last.values()].map(o => joinText([names.get(o.entity_id)?.name ?? o.attributes?.friendly_name ?? entityName(o.entity_id),
    o.state != null ? String(o.state).replace(/_/g, ' ') : null, o.evidence ? `(${fieldLabel(o.evidence).toLowerCase()})` : null], ' ')), ', ');
}

/** A report's line: its mode, days clean, open diffs, what limits its evidence and its window; unknowns left out. */
export function reportLine(r, {now = null} = {}) {
  return joinText([r.mode === 'live' ? 'Live' : 'Shadow', r.days_clean != null ? `${plural(r.days_clean, 'day')} clean` : null,
    r.open_diffs ? plural(r.open_diffs, 'open diff') : 'No open diffs', r.coverage === false ? 'Not enough history yet' : null,
    r.logbook_available === false ? 'Home Assistant’s logbook unavailable' : null,
    r.since && r.until ? dateRange(String(r.since).slice(0, 10), String(r.until).slice(0, 10), {now}) : null]);
}

/** A blocker in Habitat's words, its leading key read out: `shadow_only: FP-1613: …` → `Shadow only: FP-1613: …`. */
export const blockerText = reason => sentence(String(reason).replace(/^([a-z]+(?:_[a-z]+)+):/, (_, key) => `${fieldLabel(key)}:`));

/** A day's counts in words; none: `No runs`. */
export const dayLine = d => joinText([d.agree ? `${d.agree} agree` : null, d.matching_noop ? `${d.matching_noop} agree doing nothing` : null,
  d.habitat_only ? `${d.habitat_only} Habitat only` : null, d.ha_only ? `${d.ha_only} Home Assistant only` : null,
  d.unverified ? `${d.unverified} unverified` : null]) || 'No runs';

/** A report as the page's rows: the rule (its line, Ready or Not ready), its blockers, every unexplained run (one fold), its days (one
 *  fold), all under the rule's heading. `open`: the folds open, by id. */
export function reportRows(r, {names = new Map(), now = null, open = new Set()} = {}) {
  const title = ruleOf({name: r.rule}).title, section = {key: r.rule, label: title};
  const diffs = list(r, 'unexplained').map((e, i) => {
    const at = e.habitat ?? e.ha;
    return {id: `${r.rule}:diff:${i}`, glyph: 'warn', section, title: joinText([kindText(e.kind), at ? dateTimeText(at, {now}) : null]),
      sub: joinText([list(e, 'actions').length ? `Habitat: ${list(e, 'actions').map(a => actionText(a, names)).join('; ')}` : null,
        list(e, 'observed').length ? `Seen: ${observedText(e.observed, names)}` : 'Nothing seen in Home Assistant'])};
  });
  const days = list(r, 'daily').map(d => ({id: `${r.rule}:day:${d.date}`, glyph: 'day', title: dateText(d.date, {now, weekday: true}), sub: dayLine(d)}));
  const fold = (id, title, sub, glyph, items) => items.length ? [{id, fold: true, section, title, sub, glyph, items, open: open.has(id)}] : [];
  return [
    {id: r.rule, glyph: 'bolt', section, title, sub: reportLine(r, {now}),
      badge: r.mode === 'live' ? {text: 'Live', tone: 'accent'} : r.ready ? {text: 'Ready', tone: 'accent'} : {text: 'Not ready', tone: 'warn'}},
    ...list(r, 'blockers').map((reason, i) => ({id: `${r.rule}:blocker:${i}`, glyph: 'warn', section, title: blockerText(reason)})),
    ...fold(`${r.rule}:diffs`, plural(diffs.length, 'unexplained run'), 'What each side did', 'warn', diffs),
    ...fold(`${r.rule}:days`, 'Daily counts', plural(days.length, 'day'), 'day', days),
  ];
}

/** Habitat still building the report: its 503 with Retry-After. */
const pending = e => e?.status === 503 && (e.retryAfter > 0 || /shadow_report_pending/.test(e.message ?? ''));

/** The page's model. opts: `query` ({rule, days}: the page's address), `canSwitch` (the owner, never the read-only agent member;
 *  Habitat refuses anyone else's switch), `clock`, `wait(ms)` (between pending reads). */
export function createShadow(host, {query = {}, canSwitch = false, clock = Date.now, wait = ms => new Promise(r => setTimeout(r, ms))} = {}) {
  const habitat = habitatClient(host), listeners = new Set();
  let stopped = false;
  const m = {
    reports: null, names: new Map(), loading: true, pending: false, error: null, canSwitch, clock,
    confirm: null, busy: null, outcome: null,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async start() { await Promise.all([m.refresh(), readNames()]); },
    stop() { stopped = true; },
    async refresh() {
      m.loading = !m.reports; m.error = null; changed();
      const until = clock() + PENDING_MS;
      for (;;) {
        try {
          const answer = await host.call('habitat.shadowreport', {query: {days: 7, ...query}});
          m.reports = list(answer, 'reports'); m.pending = false;
          break;
        } catch (e) {
          if (stopped) return;
          if (pending(e) && clock() < until) { m.pending = true; changed(); await wait(1000 * (e.retryAfter || 1)); if (stopped) return; continue; }
          // still building after PENDING_MS: a timeout, said as one
          m.pending = false; m.error = pending(e) ? Object.assign(new Error('Habitat is still building the shadow reports'), {code: 'timeout'}) : e;
          break;
        }
      }
      m.loading = false; changed();
    },
    report: name => m.reports?.find(r => r.rule === name) ?? null,
    /** The owner asks to cut a ready shadow rule over, or roll a live one back: confirmed before anything changes. */
    ask(name) {
      const r = m.report(name);
      if (!m.canSwitch || !r || m.busy || (r.mode !== 'live' && !r.ready)) return;
      m.confirm = {name, mode: r.mode === 'live' ? 'shadow' : 'live'}; m.outcome = null; changed();
    },
    cancel() { if (m.confirm) { m.confirm = null; changed(); } },
    async confirmed() {
      const c = m.confirm;
      if (!c) return;
      m.confirm = null; m.busy = c.name; changed();
      try {
        await habitat.rule(c.name, c.mode);
        m.outcome = {name: c.name, text: c.mode === 'live' ? 'Now live: Habitat acts, Home Assistant’s automation is off' : 'Back in shadow: Home Assistant acts again'};
      } catch (e) { m.outcome = {name: c.name, text: `Switch failed: ${describeFailure('Habitat', e).message}`, bad: true}; }
      m.busy = null;
      await m.refresh();
    },
  };
  function changed() { if (!stopped) for (const fn of listeners) fn(); }
  async function readNames() {
    try { m.names = new Map(list(await habitat.entities(), 'entities').map(e => [e.id, e])); changed(); }
    catch { /* names from what Home Assistant said, else the ids in words */ }
  }
  return m;
}

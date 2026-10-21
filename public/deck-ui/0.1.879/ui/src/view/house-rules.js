// The Rules page (contract/house.md *Rules*): every Habitat rule grouped by area, the search and filters over them, a row opened in
// place (the shared record card) with what it reads and acts on, its newest runs, its shadow agreement and, for the owner, the mode
// switch asked first. The model is house-rules.js.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useMemo, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Glyph} from '../glyphs.js';
import {ago, age, dateText, dateTimeText, fieldLabel, plural} from '../format.js';
import {canSwitch, countsText, filterRules, groupRules, outcomeText, ruleText, RECENT_MS} from '../house-rules.js';
import {PageHeader} from './page-header.js';
import {PageState} from './page-state.js';
import {RowList, entityGlyph} from './rows.js';
import {RecordCard} from './record-card.js';
import {EntityLink} from './entity-link.js';
import {CollectionSearch, useCollectionPage} from './collection-page.js';
import {usePageSelection} from './page-selection.js';
const html = htm.bind(h);

const MODES = [['live', 'Live'], ['shadow', 'Shadow'], ['off', 'Off']];
const MODE_TONE = {live: 'accent', shadow: '', off: 'muted'};
const MODE_WORDS = {
  live: 'Live: Habitat acts',
  shadow: 'Shadow: Habitat records what it would do; Home Assistant acts',
  off: 'Off: disabled',
};
const firedLine = (r, now) => r.lastFired ? [`Fired ${ago(r.lastFired, now)}`, outcomeText(r.outcome)].join(' · ') : 'Not fired in 30 days';
/** A run's action in words: `light.turn_on` → `Turn on`. */
const actionWords = action => fieldLabel(String(action).split('.').pop());

/** An entity as a chip: its thing's page where Habitat knows one (EntityLink), else a button that finds the rules using it. */
function EntityChip({id, names, onFind}) {
  const e = names.get(id), name = e?.name ?? id;
  if (e?.thing?.id) return html`<${EntityLink} kind="thing" id=${e.thing.id} label=${name} chip=${true} title=${`${name} (${id}): its page`} />`;
  return html`<button type="button" class="dk-chip" title=${`Rules that use ${name} (${id})`} onClick=${ev => { ev.stopPropagation(); onFind(id); }}>
    <${Glyph} name=${entityGlyph({id, domain: e?.domain})} size=${13} /><span>${name}</span></button>`;
}

function Entities({title, ids, names, onFind}) {
  if (!ids.length) return null;
  return html`<section class="dk-card-group" aria-label=${title}><div class="dk-card-head"><span>${title}</span><span class="dk-card-meta">${ids.length}</span></div>
    <div class="dp-cardfacts dh-rule-entities">${ids.map(id => html`<${EntityChip} key=${id} id=${id} names=${names} onFind=${onFind} />`)}</div></section>`;
}

function Runs({runs, names, now}) {
  if (!runs) return null;
  if (runs.loading && !runs.items.length) return html`<p class="dk-note" role="status">Loading runs…</p>`;
  if (runs.error) return html`<p class="dk-note warn" role="status">Runs unavailable</p>`;
  if (!runs.items.length) return null;
  return html`<section class="dk-card-group" aria-label="Recent runs"><div class="dk-card-head"><span>Recent runs</span><span class="dk-card-meta">${runs.items.length}</span></div>
    <ul class="dp-carditems">${runs.items.map((run, i) => {
      const what = [actionWords(run.action), run.entities.map(id => names.get(id)?.name ?? id).join(', ')].filter(Boolean).join(' ');
      return html`<li key=${`${run.time}-${i}`}><span class="dp-carditem" title=${`${dateTimeText(run.time, {now})} · ${outcomeText(run)}`}>
        <${Glyph} name=${run.ok === false ? 'warn' : 'check'} size=${14} /><span class="dp-itemtitle">${what} · ${outcomeText(run)}</span><span class="dp-itemwhen">${age(run.time, now)}</span></span></li>`;
    })}</ul></section>`;
}

/** A rule opened in place. */
function RuleCard({rules, r, now, onFind}) {
  const report = rules.reports.get(r.name), confirming = rules.confirm?.name === r.name, busy = rules.busy === r.name;
  const outcome = rules.outcome?.name === r.name ? rules.outcome : null;
  const target = r.mode === 'live' ? 'shadow' : 'live';
  const shadow = r.shadow && r.mode === 'shadow'
    ? `${plural(r.shadow.agree, 'run')} agree · ${r.shadow.disagree} differ${r.shadow.since ? ` · since ${dateText(String(r.shadow.since).slice(0, 10), {now})}` : ''}` : null;
  const automation = r.automation ? rules.names.get(r.automation)?.name ?? r.automation : null;
  const facts = [
    {label: 'Mode', value: MODE_WORDS[r.mode]},
    {label: 'Health', value: r.healthy ? 'Healthy' : r.outcome?.ok === false ? 'Unhealthy: its last run failed' : 'Unhealthy: disabled or a service it calls is down'},
    {label: 'Last fired', value: r.lastFired ? `${dateTimeText(r.lastFired, {now})} · ${outcomeText(r.outcome)}` : 'Not in 30 days'},
    {label: 'Replaces', value: automation ? `${automation} (Home Assistant)` : null},
    {label: 'Shadow agreement', value: shadow},
  ];
  // the owner's switch: asked first, in the card; going live needs a ready seven-day shadow report (Habitat's shadow reports)
  const allowed = rules.owner && canSwitch(r, target, report);
  const why = !rules.owner || r.mode === 'off' ? null : r.transition ? 'Switching…' : target === 'live' && r.shadowOnly ? 'Shadow only: never switched live'
    : target === 'live' && !report?.ready ? (rules.reports.has(r.name) ? 'Not ready to go live: its shadow report has blockers' : 'Checking its shadow report…') : null;
  const actions = !rules.owner ? [] : confirming
    ? [{label: target === 'live' ? 'Switch to live' : 'Switch to shadow', primary: true, onClick: () => rules.confirmed()}, {label: 'Cancel', onClick: () => rules.cancel()}]
    : [{label: busy ? 'Switching…' : target === 'live' ? 'Go live…' : 'Back to shadow…', disabled: !allowed || busy, onClick: () => rules.ask(r.name, target)}];
  return html`<${RecordCard} label=${r.title} facts=${facts} actions=${actions}>
    <${Entities} title="Reads" ids=${r.inputs} names=${rules.names} onFind=${onFind} />
    <${Entities} title="Acts on" ids=${r.outputs.filter(id => !r.inputs.includes(id))} names=${rules.names} onFind=${onFind} />
    <${Runs} runs=${rules.runs.get(r.name)} names=${rules.names} now=${now} />
    ${confirming ? html`<p class="dk-note" role="alert">${target === 'live'
      ? `Switch ${r.title} to live? Habitat acts and Home Assistant’s automation is turned off.`
      : `Switch ${r.title} back to shadow? Home Assistant’s automation acts again.`}</p>` : null}
    ${why && !confirming ? html`<p class="dk-note">${why}</p>` : null}
    ${outcome ? html`<p class=${`dk-note${outcome.bad ? ' warn' : ''}`} role="status">${outcome.text}</p>` : null}
  <//>`;
}

/** The page: `rules` (createRules), `navigation` (pageNavigation: the open row is the URL's hash, `/house/rules#<name>`). */
export function HouseRules({rules, navigation = null}) {
  const [, redraw] = useState(0);
  useEffect(() => rules.subscribe(() => redraw(n => n + 1)), [rules]);
  const [selected, select] = usePageSelection(navigation);
  const [mode, setMode] = useState(null), [area, setArea] = useState(''), [unhealthy, setUnhealthy] = useState(false), [recent, setRecent] = useState(false);
  const now = rules.clock(), all = rules.rules ?? [];
  // the open row reads its runs (and the owner's report) when it opens, from a click or the URL
  // (a microtask later: the model's change draws the page again, never from inside this effect)
  useEffect(() => {
    let live = true;
    if (selected && rules.rule(selected)) queueMicrotask(() => { if (live) rules.open(selected); });
    return () => { live = false; };
  }, [selected, !!rules.rules]);
  const chosen = useMemo(() => filterRules(all, {mode, area: area || null, unhealthy, recent}, {now}), [all, mode, area, unhealthy, recent]);
  const page = useCollectionPage(chosen, {textOf: r => ruleText(r, rules.names), size: 100000, key: 'rules'});
  const shown = groupRules(page.filtered);
  const areas = groupRules(all).map(g => g.area);
  const count = pick => all.filter(pick).length;
  const chip = (on, label, n, toggle) => html`<button type="button" class=${`dk-chip${on ? ' on' : ''}`} aria-pressed=${String(on)} onClick=${toggle}>
    <span>${label}</span><span class="dh-rule-count">${n}</span></button>`;
  const items = shown.flatMap(g => g.rules.map(r => ({id: r.name, glyph: 'bolt', title: r.title, sub: firedLine(r, now), summary: r.summary,
    badge: {text: fieldLabel(r.mode), tone: MODE_TONE[r.mode]}, notes: r.healthy ? [] : [{text: 'Unhealthy', tone: 'warn'}],
    section: {key: g.area, label: g.area}})));
  return html`<main class="dk-page dh-rules" aria-label="Rules" aria-busy=${rules.loading}>
    <${PageHeader} title="Rules" description=${rules.rules ? countsText(all) : 'What the house does on its own.'} />
    <${PageState} state=${rules.loading ? 'loading' : rules.error ? undefined : !all.length ? 'empty' : 'ready'} error=${rules.error} backend="habitat"
      title=${rules.error ? 'Rules unavailable' : 'No rules yet'} retry=${() => rules.refresh()}>
      <${CollectionSearch} page=${page} label="Search rules" placeholder="Name, room or device" always=${true}>
        <label class="dk-collection-filter"><span>Area</span><select class="dk-field" aria-label="Area" value=${area} onChange=${ev => setArea(ev.currentTarget.value)}>
          <option value="">Every area</option>${areas.map(a => html`<option key=${a} value=${a}>${a}</option>`)}</select></label>
      <//>
      <div class="dh-rule-filters" role="group" aria-label="Filters">
        ${MODES.map(([m, label]) => chip(mode === m, label, count(r => r.mode === m), () => setMode(mode === m ? null : m)))}
        ${chip(unhealthy, 'Unhealthy', count(r => !r.healthy), () => setUnhealthy(!unhealthy))}
        ${chip(recent, 'Fired today', count(r => r.lastFired && now - Date.parse(r.lastFired) <= RECENT_MS), () => setRecent(!recent))}
      </div>
      <${RowList} card=${true} items=${items} current=${selected} sectionTotal=${list => ({value: list.length, precision: 0})}
        onOpen=${r => select(r.id)} onClose=${() => select(null)}
        expand=${r => { const rule = rules.rule(r.id); return rule ? html`<${RuleCard} key=${r.id} rules=${rules} r=${rule} now=${now} onFind=${id => { select(null); page.setQuery(id); }} />` : null; }}
        empty=${{glyph: 'find', title: 'No rule matches', line: 'Try another word or clear the filters.'}} />
    <//>
  </main>`;
}

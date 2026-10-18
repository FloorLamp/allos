import {dateText, timeText} from '../quantity.js';
import {Failure, StatusLink} from './failure.js';
import {describeFailure, failurePage} from '../failure.js';
// The House page's views (contract/house.md *House*; habitat docs/design.md *Dashboards*) over src/house.js: the tablet (the kitchen's Fully
// Kiosk, 1280×800: the status strip, quick controls, an hourly chart, the ticker), the phone (the shell bar, status chips,
// quick controls, rooms as rows) and the admin (needs, rules, every entity, filtered). One confirmation bar for anything that
// moves hardware, one status line for outcomes. Built from deck-ui's own parts: the shell bar, rows, the chart.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Glyph} from '../glyphs.js';
import {control, entities, quick, readings, rooms, stateText, status, ticker, warns} from '../house.js';
import {Chart} from './chart.js';
import {Block, Placeholders, RowList, actionLook, age} from './rows.js';
import {ShellBar} from './shell-bar.js';

const html = htm.bind(h);

/** Keep large mirrored registries out of the DOM; every entry remains reachable. */
function Page({items, size = 50, label, children}) {
  const [offset, setOffset] = useState(0);
  const start = Math.min(offset, Math.max(0, Math.ceil(items.length / size) - 1) * size);
  return html`<div class="dh-paged">
    ${children(items.slice(start, start + size))}
    ${items.length > size ? html`<nav aria-label=${label} class="dh-pager">
      <button type="button" class="dk-btn" disabled=${start === 0} onClick=${() => setOffset(start - size)}>Previous</button>
      <span role="status">${start + 1}–${Math.min(start + size, items.length)} of ${items.length}</span>
      <button type="button" class="dk-btn" disabled=${start + size >= items.length} onClick=${() => setOffset(start + size)}>Next</button>
    </nav>` : null}
  </div>`;
}

function QuickControls({house, opts, size}) {
  return html`<${Page} items=${quick(house, opts.quick)} size=${size} label="Quick control pages">${items => html`<section class="dh-quick" aria-label="Quick controls">${items.map(e => html`<${Tile} key=${e.id} house=${house} e=${e} />`)}</section>`}</${Page}>`;
}

/** Battery and temperature share a sparse table; absent readings never create rows or columns. */
export function Readings({house}) {
  const {items, columns} = readings(house);
  if (!items.length) return null;
  return html`<section aria-label="Battery and temperature"><table>
    <caption>Battery and temperature</caption>
    <thead><tr><th scope="col">Device</th>${columns.map(key => html`<th key=${key} scope="col">${key === 'battery' ? 'Battery' : 'Temperature'}</th>`)}</tr></thead>
    <tbody>${items.map(row => html`<tr key=${row.id}><th scope="row">${row.name}</th>${columns.map(key => html`<td key=${key}>${row[key] ? `${row[key].value}${row[key].unit ? ` ${row[key].unit}` : ''}` : '–'}</td>`)}</tr>`)}</tbody>
  </table></section>`;
}

/** A glyph for an entity: its control's (rows.js actionLook), else by what it reads. */
const glyphOf = e => ({camera: 'photo', person: 'person', weather: 'thermostat', sensor: 'chart', binary_sensor: 'house'})[e.domain] ?? actionLook({domain: e.domain}).glyph;

/** Ticks every `ms` while mounted (the clock, the ages). */
function useTick(ms) {
  const [n, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set(x => x + 1), ms); return () => clearInterval(t); }, [ms]);
  return n;
}

/** A quick control: a tile that runs (or asks) on a tap; on, busy and warning looks; the state under the name. */
function Tile({house, e}) {
  const s = house.state(e.id), c = control(e, s), busy = house.busy.has(e.id), toggle = ['light', 'switch', 'fan'].includes(e.domain);
  return html`<button type="button" class=${`dh-tile${c?.on && !warns(e, s) ? ' on' : ''}${warns(e, s) ? ' warn' : ''}${busy ? ' busy' : ''}${!house.live ? ' stale' : ''}`} data-id=${e.id}
    disabled=${!house.live || !c || c.disabled} aria-pressed=${toggle ? String(!!c?.on) : null} aria-busy=${busy ? 'true' : null} onClick=${() => house.act(e.id)}>
    <${Glyph} name=${glyphOf(e)} size=${22} />
    <span class="dh-tname">${e.name}</span><span class="dh-tstate">${stateText(e, s)}${!house.live ? ` · ${asOf(house)}` : ''}</span>
  </button>`;
}

// Images live only in this mounted tile. A pause aborts pending work and discards the last frame.
// Keep failures across pauses: 404 waits for a changed camera list; other failures retry after 5, 15, then 60 seconds.
function Camera({host, e, cameras}) {
  const failed = useRef(() => {}), ref = useRef(null), [frame, setFrame] = useState(null), [message, setMessage] = useState('Loading camera…');
  useEffect(() => {
    let visible = false, active = false, pending = null, timer = null, url = null, generation = 0, again = false, failures = 0, permanent = false, retryAt = 0;
    const discard = () => { if (url?.startsWith('blob:')) URL.revokeObjectURL(url); url = null; setFrame(null); };
    const schedule = ms => { clearTimeout(timer); timer = setTimeout(refresh, ms); };
    const fail = err => {
      discard(); again = false;
      permanent = err?.status === 404;
      const delay = [5000, 15000, 60000][Math.min(failures++, 2)];
      retryAt = Date.now() + delay;
      setMessage(permanent ? `${failurePage(`Habitat camera ${e.name}`)}: Camera not found. Check your camera setup.`
        : describeFailure(`Habitat camera ${e.name}`, err, {retryIn: `${delay / 1000} seconds while visible and online`}).message);
      clearTimeout(timer);
      if (!permanent && active) schedule(delay);
    };
    failed.current = () => fail({code: 'http'});
    const refresh = async () => {
      if (!active || permanent) return;
      if (retryAt > Date.now()) { schedule(retryAt - Date.now()); return; }
      clearTimeout(timer);
      if (pending) { again = true; return; }
      const controller = pending = new AbortController(), version = generation;
      try {
        const r = await host.resource('habitat.snapshot', {query: {camera: e.id.slice(7), h: Math.max(1, Math.ceil(ref.current.getBoundingClientRect().height))}}, {signal: controller.signal});
        if (!active || version !== generation) { if (r.url?.startsWith('blob:')) URL.revokeObjectURL(r.url); return; }
        discard(); url = r.url; setFrame(url); setMessage(''); failures = 0; retryAt = 0; schedule(5000);
      } catch (err) {
        if (version === generation && active) fail(err);
      } finally {
        if (pending === controller) { pending = null; if (again) { again = false; refresh(); } }
      }
    };
    const sync = () => {
      const next = visible && !document.hidden && navigator.onLine;
      if (next === active) return;
      active = next; generation++;
      clearTimeout(timer); pending?.abort(); pending = null; again = false;
      if (active) refresh();
      else { discard(); if (!permanent && !failures) setMessage(navigator.onLine ? 'Camera paused' : describeFailure(`Habitat camera ${e.name}`, {code: 'unreachable'}, {retryIn: 'when online and visible'}).message); }
    };
    const observer = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; sync(); });
    observer.observe(ref.current);
    document.addEventListener('visibilitychange', sync);
    addEventListener('online', sync); addEventListener('offline', sync);
    const off = host.on('habitat.state', d => { if (d.entity_id === e.id && e.driver === 'frigate') refresh(); });
    return () => {
      active = false; generation++; pending?.abort(); clearTimeout(timer); discard(); observer.disconnect(); off();
      document.removeEventListener('visibilitychange', sync);
      removeEventListener('online', sync); removeEventListener('offline', sync);
    };
  }, [host, e.id, cameras]);
  return html`<div class="dh-camera" data-id=${e.id} ref=${ref}>
    ${frame ? html`<img src=${frame} alt=${e.name} loading="lazy" decoding="async" onError=${() => failed.current()} />` : html`<span role="status">${message}<${StatusLink} host=${host} /></span>`}
    <b>${e.name}</b>
  </div>`;
}

function Cameras({house, host}) {
  const cameras = JSON.stringify(house.entities.filter(e => e.domain === 'camera'));
  return html`<${Page} items=${house.entities.filter(e => e.domain === 'camera')} size=${4} label="Camera pages">${items => html`<section class="dh-cameras" aria-label="Cameras">${items.map(e => html`<${Camera} key=${e.id} host=${host} e=${e} cameras=${cameras} />`)}</section>`}</${Page}>`;
}

/** The confirmation for a cover, a lock or a switch: the verb and the name, Confirm focused, Esc or Cancel to drop it. */
function Confirm({house}) {
  const c = house.confirm, ok = useRef(null);
  useLayoutEffect(() => { if (c) ok.current?.focus(); }, [c]);
  if (!c) return null;
  return html`<div class="dh-confirm" role="alertdialog" aria-label=${`${c.verb} ${c.name}?`}>
    <span><b>${c.verb} ${c.name}?</b></span>
    <button type="button" class="dk-btn main" ref=${ok} onClick=${() => house.confirmed()}>${c.verb}</button>
    <button type="button" class="dk-btn" onClick=${() => house.cancel()}>Cancel</button>
  </div>`;
}

function Ticker({house, now}) {
  const items = ticker(house);
  if (!items.length) return null;
  return html`<ul class="dh-ticker" aria-label="Ticker">${items.map(t => html`<li key=${t.id}>${t.text}${t.at ? html`<span class="dh-age">${age(t.at, now)}</span>` : null}</li>`)}</ul>`;
}

const asOf = house => house.lastUpdated == null ? 'Waiting for states' : `as of ${timeText(house.lastUpdated, {hour: '2-digit', minute: '2-digit', hour12: false})}`;

const Live = ({house}) => html`<span class=${`dh-live${house.live ? ' on' : ''}`}>${house.live ? 'Live' : describeFailure('Habitat', {code: 'unreachable'}, {retryIn: 'up to 30 seconds'}).message}${!house.live ? html` · ${asOf(house)} <${StatusLink} />` : null}</span>`;

function Tablet({house, host, opts, now}) {
  const tz = opts.timeZone ? {timeZone: opts.timeZone} : {};
  return html`<div class="dh dh-tablet">
    <header class="dh-strip">
      <div class="dh-clock"><b>${timeText(now, {hour: 'numeric', minute: '2-digit', ...tz})}</b>
        <span>${dateText(now, {weekday: 'short', month: 'short', day: 'numeric', ...tz})}</span></div>
      ${status(house).map(s => html`<div key=${s.id} class=${`dh-stat ${s.tone ?? ''}`} data-id=${s.id}><span>${s.label}</span><b>${s.value}</b></div>`)}
      <${Live} house=${house} />
    </header>
    <main class="dh-main">
      <section class="dh-left">
        <${Cameras} house=${house} host=${host} />
        ${house.chart?.points.length ? html`<div class="dh-chart"><${Chart} data=${house.chart} label=${house.chart.title} /></div>` : null}
      </section>
      <${QuickControls} house=${house} opts=${opts} size=${12} />
    </main>
    <${Ticker} house=${house} now=${now} />
  </div>`;
}

/** An entity as a row: its state under the name (or `sub`, the state then a note), its control's verb as the button. */
const entityRow = (house, e, sub = null) => {
  const s = house.state(e.id), c = control(e, s);
  return {id: e.id, glyph: glyphOf(e), title: e.name, sub: sub ?? stateText(e, s), accent: !!c?.on && !warns(e, s),
    notes: sub ? [{text: stateText(e, s), tone: warns(e, s) ? 'warn' : ''}] : null,
    end: c && !c.disabled ? {disabled: !house.live, label: house.busy.has(e.id) ? '…' : c.verb, onClick: () => house.act(e.id)} : null};
};

function Phone({house, host, opts, now}) {
  return html`<div class="dh dh-phone">
    <div class="dh-chips">${status(house).filter(s => !(opts.nav && s.id === 'needs')).map(s => html`<span key=${s.id} class=${`dh-chip ${s.tone ?? ''}`} data-id=${s.id}>${s.label} <b>${s.value}</b></span>`)}<${Live} house=${house} /></div>
    <${Ticker} house=${house} now=${now} />
    <${Cameras} house=${house} host=${host} />
    <h2 class="dk-label">Quick</h2>
    <${QuickControls} house=${house} opts=${opts} size=${8} />
    <${Readings} house=${house} />
    ${house.chart?.points.length ? html`<div class="dh-chart"><${Chart} data=${house.chart} label=${house.chart.title} /></div>` : null}
    <${Page} items=${rooms(house, opts.rooms)} label="Room pages">${items => items.map(r => html`<section key=${r.area ?? '-'} class="dh-room" data-area=${r.area}><h2 class="dk-label">${r.name}</h2>
      <${Page} items=${r.entities} label=${`${r.name} entity pages`}>${entries => html`<${RowList} items=${entries.map(e => entityRow(house, e))} />`}</${Page}></section>`)}</${Page}>
  </div>`;
}

/** A need's button: a page to open, Habitat's op (gesture), or a command to copy. */
export const needEnd = (house, host, need, report = () => {}) => {
  const a = need.action ?? {};
  const run = a.kind === 'url' ? () => host.call('url.open', {url: a.url}).catch(() => {})
    : a.kind === 'op' ? () => house.need(need.id)
    : () => host.call('clipboard.copy', {text: a.command}).then(() => report('Copied'), e => report(describeFailure('This device’s clipboard', e).message, true));
  return {label: a.label ?? 'Fix', onClick: run};
};

function Setting({house, name, spec}) {
  const [value, setValue] = useState(spec.value), [error, setError] = useState('');
  useEffect(() => setValue(spec.value), [spec.value]);
  const supported = ['bool', 'str', 'int', 'float'].includes(spec.type);
  return html`<form onSubmit=${ev => {
    ev.preventDefault();
    const number = ['int', 'float'].includes(spec.type), parsed = number ? Number(value) : value;
    if (number && (String(value).trim() === '' || !Number.isFinite(parsed) || spec.type === 'int' && !Number.isSafeInteger(parsed))) { setError('Enter a valid number'); return; }
    setError(''); house.setting(name, parsed);
  }}>
    <label>${name}${spec.unit ? ` (${spec.unit})` : ''}
      <input class="dk-field" aria-label=${name} type=${spec.type === 'bool' ? 'checkbox' : ['int', 'float'].includes(spec.type) ? 'number' : 'text'}
        step=${spec.type === 'float' ? 'any' : '1'} checked=${spec.type === 'bool' ? value : undefined}
        value=${spec.type === 'bool' ? undefined : value} disabled=${!supported || house.settingBusy.has(name)}
        onInput=${ev => setValue(spec.type === 'bool' ? ev.target.checked : ev.target.value)} />
    </label><span>${spec.doc}</span>
    <button class="dk-btn" type="submit" disabled=${!supported || house.settingBusy.has(name)}>Save</button>
    ${error ? html`<span role="alert">${error}</span>` : null}
  </form>`;
}

function Admin({house, host, now}) {
  const [q, setQ] = useState(''), [domain, setDomain] = useState(null), [copyNote, setCopyNote] = useState(null);
  const list = entities(house, {q, domain}), shown = list.slice(0, 300);
  const domains = [...new Set(house.entities.map(e => e.domain))].sort();
  const rules = house.rules ?? [];
  return html`<div class="dh dh-admin">
    <div class="dh-chips"><${Live} house=${house} /></div>
    <section aria-label="Driver health"><h2 class="dk-label">Driver health</h2>
      ${house.health ? html`<p>${house.health.degraded ? 'Degraded' : house.health.ok ? 'Healthy' : 'Unhealthy'}</p>
        <${RowList} items=${Object.entries(house.health.drivers ?? {}).map(([name, driver]) => ({id: name, title: name,
          sub: JSON.stringify(driver), badge: {text: driver.ok ? 'Healthy' : 'Unhealthy', tone: driver.ok ? '' : 'warn'}}))} />` : html`<p>Health unavailable</p>`}
    </section>
    <section aria-label="Typed settings"><h2 class="dk-label">Typed settings</h2>
      ${house.settings ? Object.entries(house.settings).map(([name, spec]) => html`<${Setting} key=${name} house=${house} name=${name} spec=${spec} />`) : html`<p>Settings unavailable</p>`}
      ${house.settings && !Object.keys(house.settings).length ? html`<p>No typed settings.</p>` : null}
    </section>
    <section aria-label="House needs"><h2 class="dk-label">House needs</h2>
      ${house.needs.length ? house.needs.map(nd => html`<div key=${nd.id}>
        <${RowList} items=${[{id: nd.id, glyph: 'warn', title: nd.title,
          sub: [nd.detail, nd.since ? `since ${age(Date.parse(nd.since), now)}` : null,
            nd.acknowledged_at ? `Acknowledged: ${nd.acknowledged_at}` : null,
            nd.snoozed_until ? `Snoozed until: ${nd.snoozed_until}` : null].filter(Boolean).join(' · '), end: needEnd(house, host, nd, (text, bad = false) => setCopyNote({text, bad}))}]} />
        <div role="group" aria-label=${`Manage ${nd.title}`}>
          ${[['acknowledge', 'Acknowledge'], ['resolve', 'Resolve'], ['snooze', 'Snooze for 1 hour']].map(([op, label]) => html`<button type="button" class="dk-btn" onClick=${() => house.need(nd.id, op)}>${label}</button>`)}
        </div></div>`)
        : html`<p class="dh-none">Nothing needs you.</p>`}</section>
    ${copyNote ? html`<p role="status">${copyNote.text}${copyNote.bad ? html`<${StatusLink} host=${host} />` : null}</p>` : null}
    <section aria-label="Rules"><h2 class="dk-label">Rules</h2>
      ${house.rules == null ? html`<div class="dp-rows dp-plain"><${Placeholders} n=${2} /></div>` : html`<${RowList} items=${rules.map(r => ({id: `rule:${r.name}`, glyph: 'bolt', title: r.name,
        sub: [r.last_run ? `ran ${age(Date.parse(r.last_run), now)}` : 'never ran', r.shadow_count ? `${r.shadow_count} in shadow` : null,
          r.shadow_diff_count ? `${r.shadow_diff_count} differ from HA` : null, r.mode].filter(Boolean).join(' · '),
        end: {label: r.mode === 'live' ? 'Roll back' : 'Cut over',
          disabled: house.ruleBusy.has(r.name) || r.mode !== 'live' && !house.reports.find(report => report.rule === r.name)?.ready,
          onClick: () => house.rule(r.name, r.mode === 'live' ? 'shadow' : 'live')},
        badge: {text: r.mode, tone: r.mode === 'live' ? 'accent' : ''}}))} empty=${{glyph: 'bolt', title: 'No rules yet'}} />`}</section>
    <section aria-label="Entities"><h2 class="dk-label">Entities · ${list.length}</h2>
      <div class="dh-filter">
        <input class="dk-field" type="search" placeholder="Filter by name or id" aria-label="Filter entities" value=${q} onInput=${ev => setQ(ev.target.value)} />
        <div class="dh-domains" role="group" aria-label="Domain">${domains.map(d => html`<button type="button" key=${d} class=${`dk-chip${d === domain ? ' on' : ''}`}
          aria-pressed=${String(d === domain)} onClick=${() => setDomain(d === domain ? null : d)}>${d}</button>`)}</div>
      </div>
      <${RowList} items=${shown.map(e => entityRow(house, e, [e.id, e.driver, e.area].filter(Boolean).join(' · ')))} empty=${{glyph: 'find', title: 'No entity matches'}} />
      ${list.length > shown.length ? html`<p class="dh-none">${list.length - shown.length} more: filter to find them</p>` : null}</section>
  </div>`;
}

/** The House: opts {view: tablet | phone | admin, brand, nav, current (a shell bar when `nav` is given; its verdict the needs),
 *  quick (entity ids), rooms ({area: name}), timeZone}. */
export function House({house, host, opts = {}}) {
  const view = opts.view ?? 'tablet', now = house.clock();
  useTick(30000); // the clock and ages
  useLayoutEffect(() => { if (view === 'tablet') house.rendered(); });
  useEffect(() => {
    const key = ev => { if (ev.key === 'Escape') house.cancel(); };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [house]);
  const bar = opts.nav || house.error ? html`<${ShellBar} brand=${opts.brand} nav=${opts.nav} current=${opts.current ?? 'house'}
    verdict=${house.needsSource?.count ? `Needs you: ${house.needsSource.count}` : null} />` : null;
  const body = house.loading ? html`<div class="dp-rows dp-plain" aria-busy="true"><${Placeholders} n=${4} /></div>`
    : house.error ? html`<${Failure} backend="Habitat" error=${house.error} retry=${() => { house.stop(); house.error = null; house.start(); }} host=${host} />`
    : view === 'admin' ? html`<${Admin} house=${house} host=${host} now=${now} />`
    : view === 'phone' ? html`<${Phone} house=${house} host=${host} opts=${opts} now=${now} />`
    : html`<${Tablet} house=${house} host=${host} opts=${opts} now=${now} />`;
  return html`<div class=${`dh-page dh-${view}-page`} data-view=${view}>${bar}${body}
    <${Confirm} house=${house} />
    <div class="dh-status" role="status">${house.outcome ? html`<span class=${house.outcome.bad ? 'bad' : ''}>${house.outcome.text}${house.outcome.bad ? html`<${StatusLink} />` : null}</span>` : null}</div>
  </div>`;
}


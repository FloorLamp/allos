import {Facts} from './drawer.js';
import {readableFacts} from '../readable-facts.js';
import {PageHeader} from './page-header.js';
import {age, dateText, dateTimeText, fieldLabel, timeText} from '../format.js';
import {StatusLink} from './page-state.js';
import {PageState} from './page-state.js';
import {describeFailure} from '../failure.js';
// The House page's views (contract/house.md *House*; habitat docs/design.md *Dashboards*) over src/house.js: the tablet (the kitchen's Fully
// Kiosk, 1280×800: the status strip, quick controls, an hourly chart, the ticker), the phone (the shell bar, status, the ~20 controls
// people use most with a search over every control, the cameras) and the admin (needs, rules, every entity, filtered). One confirmation bar for anything that
// moves hardware, one status line for outcomes. Built from deck-ui's own parts: the shell bar, rows, the chart.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useMemo, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Glyph} from '../glyphs.js';
import {WALL_VIEWS, control, controls, entities, quick, roomName, stateText, status, temperatureUnit, ticker, warns} from '../house.js';
import {CollectionPager, CollectionSearch, useCollectionPage} from './collection-page.js';
import {HouseWall} from './house-wall.js';
import {Chart} from './chart.js';
import {Placeholders, RowList, actionLook} from './rows.js';
import {LocationHistory} from './location-history.js';
import {useStill} from './camera.js';
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

/** The tablet's quick controls fill their column: as many compact rows of three (house.css `.dh-tablet .dh-quick`, TILE tall) as its
 *  height holds, a pager under them past that. */
const TILE = 72, PAGER = 60, COLUMNS = 3;
/** A house whose quick controls fit in this many rows spreads the chart along the board's bottom, under cameras and controls alike
 *  (house.css `.dh-main.spread`), so neither column ends in an empty band. */
const SPREAD_ROWS = 5;

/** Calls `fit(el)` now and whenever `ref`'s element resizes, measured on the next frame, never inside the observer (chart.js: WebKit's
 *  loop error). */
function useFit(ref, fit, deps) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    fit(el);
    let frame = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => fit(el)); });
    ro.observe(el);
    return () => { cancelAnimationFrame(frame); ro.disconnect(); };
  }, deps);
}
function FittedQuick({house, opts, spread = false}) {
  const ref = useRef(null), [rows, setRows] = useState(4), count = quick(house, opts.quick).length;
  useFit(ref, el => {
    // spread: every control shows, the row sized to them (no measuring the height they set)
    if (spread) { setRows(Math.max(1, Math.ceil(count / COLUMNS))); return; }
    const q = el.querySelector('.dh-quick'), gap = q ? parseFloat(getComputedStyle(q).rowGap) || 0 : 0;
    const n = h => Math.max(1, Math.floor((h + gap) / (TILE + gap)));
    const all = n(el.clientHeight);
    setRows(count <= all * COLUMNS ? Math.max(1, Math.ceil(count / COLUMNS)) : n(el.clientHeight - PAGER));
  }, [count, spread]);
  return html`<div class="dh-fit" ref=${ref} style=${`--rows: ${rows}`}><${QuickControls} house=${house} opts=${opts} size=${rows * COLUMNS} /></div>`;
}

function QuickControls({house, opts, size}) {
  return html`<${Page} items=${quick(house, opts.quick)} size=${size} label="Quick control pages">${items => html`<section class="dh-quick" aria-label="Quick controls">${items.map(e => html`<${Tile} key=${e.id} house=${house} e=${e} />`)}</section>`}</${Page}>`;
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
  return html`<button type="button" class=${`dh-tile${c?.on && !warns(e, s) ? ' on' : ''}${warns(e, s) ? ' warn' : ''}${house.confirm?.entity_id === e.id ? ' confirming' : ''}${busy ? ' busy' : ''}${!house.live ? ' stale' : ''}`} data-id=${e.id}
    disabled=${!house.live || !c || c.disabled} aria-pressed=${toggle ? String(!!c?.on) : null} aria-busy=${busy ? 'true' : null} onClick=${() => house.act(e.id)}>
    <${Glyph} name=${glyphOf(e)} size=${22} />
    <span class="dh-tname">${e.name}</span><span class="dh-tstate">${stateText(e, s, {unit: temperatureUnit(house)})}${!house.live ? ` · ${asOf(house)}` : ''}</span>
  </button>`;
}

// The tile's still (view/camera.js useStill): refreshed while on screen, on its Frigate camera's state events; failures kept across pauses.
function Camera({host, e, cameras, state = null, cell = null}) {
  const ref = useRef(null), [shape, setShape] = useState(16 / 9);
  const {frame, message, failed} = useStill(host, e.id.slice(7), ref, {title: e.name, stateId: e.driver === 'frigate' ? e.id : null, state, key: cameras});
  if (cell) {
    // the tablet: the frame at its image's own shape, as large as its cell holds (never stretched or cropped)
    const w = Math.max(0, Math.floor(Math.min(cell.w, cell.h * shape))), h = Math.max(0, Math.floor(w / shape));
    return html`<div class="dh-camera" data-id=${e.id} ref=${ref}>
      <div class="dh-frame" style=${`width: ${w}px; height: ${h}px`}>
        ${frame ? html`<img src=${frame} alt=${e.name} decoding="async" onLoad=${ev => { const i = ev.currentTarget; if (i.naturalWidth && i.naturalHeight) setShape(i.naturalWidth / i.naturalHeight); }}
          onError=${failed} />` : html`<span role="status">${message}<${StatusLink} host=${host} /></span>`}
        <b>${e.name}</b>
      </div>
    </div>`;
  }
  return html`<div class="dh-camera" data-id=${e.id} ref=${ref}>
    ${frame ? html`<img src=${frame} alt=${e.name} loading="lazy" decoding="async" onError=${failed} />` : html`<span role="status">${message}<${StatusLink} host=${host} /></span>`}
    <b>${e.name}</b>
  </div>`;
}

/** Cameras by 4 (phone) or, on the tablet, up to 9 in a grid of at most three columns filling the space beside the chart. */
function Cameras({house, host, size = 4, fit = false}) {
  const all = house.entities.filter(e => e.domain === 'camera'), cameras = JSON.stringify(all);
  const focused = fit && all.find(e => e.id === house.cameraFocus);
  // Keep camera mounts (and snapshot backoff) when activity changes the focused subset.
  return html`<${Page} items=${focused ? [focused] : all} size=${size} label="Camera pages">${items => fit ? html`<${CameraGrid} items=${items} host=${host} house=${house} cameras=${cameras} />`
    : html`<section class="dh-cameras" aria-label="Cameras">${items.map(e => html`<${Camera} key=${e.id} host=${host} e=${e} state=${house.state(e.id)} cameras=${cameras} />`)}</section>`}</${Page}>`;
}

/** The tablet's cameras: the grid (up to four columns) whose cells hold the largest wide frame in the space above the chart; each frame
 *  then takes its own image's shape within its cell. */
function CameraGrid({items, host, house, cameras}) {
  const ref = useRef(null), [grid, setGrid] = useState(null), n = items.length;
  useFit(ref, el => {
    if (!n) return;
    const gap = parseFloat(getComputedStyle(el).rowGap) || 0, W = el.clientWidth, H = el.clientHeight;
    let best = null;
    for (let cols = 1; cols <= Math.min(n, 4); cols++) {
      const rows = Math.ceil(n / cols), w = (W - (cols - 1) * gap) / cols, h = (H - (rows - 1) * gap) / rows, size = Math.min(w, h * 16 / 9);
      if (!best || size > best.size) best = {cols, rows, w, h, size};
    }
    setGrid(g => (g && g.cols === best.cols && g.rows === best.rows && Math.abs(g.w - best.w) < 1 && Math.abs(g.h - best.h) < 1 ? g : best));
  }, [n]);
  return html`<section class="dh-cameras" aria-label="Cameras" ref=${ref} style=${grid ? `--cols: ${grid.cols}; --camera-rows: ${grid.rows}` : null}>
    ${grid ? items.map(e => html`<${Camera} key=${e.id} host=${host} e=${e} state=${house.state(e.id)} cameras=${cameras} cell=${grid} />`) : null}</section>`;
}

/** The confirmation for a cover, a lock or a switch: the verb and the name, Confirm focused, Esc or Cancel to drop it. `anchor` (the
 *  tablet): beside the tile it asks about (below it, else above), not across the board. */
function Confirm({house, anchor = false}) {
  const c = house.confirm, ok = useRef(null), box = useRef(null), [at, setAt] = useState(null);
  useLayoutEffect(() => { if (c) ok.current?.focus(); }, [c]);
  useLayoutEffect(() => {
    const tile = anchor && c?.entity_id ? document.querySelector(`.dh-tile[data-id="${CSS.escape(c.entity_id)}"]`) : null;
    if (!tile || !box.current) { setAt(null); return; }
    const t = tile.getBoundingClientRect(), b = box.current.getBoundingClientRect(), gap = 8;
    // whole tiles wide (the grid's gap between them), so the box never leaves a sliver of the tile beside it showing
    const step = t.width + gap, width = Math.min(innerWidth - 2 * gap, Math.ceil((b.width + 1) / step) * step - gap);
    setAt({top: t.bottom + gap + b.height <= innerHeight ? t.bottom + gap : Math.max(gap, t.top - gap - b.height),
      left: Math.max(gap, Math.min(t.left, innerWidth - gap - width)), width});
  }, [c, anchor]);
  if (!c) return null;
  // beside its tile, a scrim dims the rest of the board (a tap there cancels), so what the box covers reads as covered
  return html`${anchor ? html`<div class="dh-scrim" aria-hidden="true" onClick=${() => house.cancel()} />` : null}<div class=${`dh-confirm${at ? ' anchored' : ''}`} ref=${box} style=${at ? `top:${at.top}px;left:${at.left}px;width:${at.width}px` : null} role="alertdialog" aria-label=${`${c.verb} ${c.name}?`}>
    <span><b>${c.verb} ${c.name}?</b></span>
    <button type="button" class="dk-btn main" ref=${ok} onClick=${() => house.confirmed()}>${c.verb}</button>
    <button type="button" class="dk-btn" onClick=${() => house.cancel()}>Cancel</button>
  </div>`;
}

/** What the house says now: a line along the tablet's bottom; on the phone, chips like the status's. */
function Ticker({house, now, chips = false}) {
  const items = ticker(house);
  if (!items.length) return null;
  return html`<ul class=${`dh-ticker${chips ? ' dh-chips' : ''}`} aria-label="Ticker">${items.map(t => html`<li key=${t.id} class=${chips ? 'dh-chip' : null}>${t.text}${t.at ? html`<span class="dh-age">${age(t.at, now)}</span>` : null}</li>`)}</ul>`;
}

const asOf = house => house.lastUpdated == null ? 'Waiting for states' : `as of ${timeText(house.lastUpdated)}`;

const Live = ({house}) => html`<span class=${`dh-live${house.live ? ' on' : ''}`}>${house.live ? 'Live' : describeFailure('Habitat', {code: 'unreachable'}, {retryIn: 'up to 30 seconds'}).message}${!house.live ? html` · ${asOf(house)} <${StatusLink} />` : null}</span>`;

function Tablet({house, host, opts, now}) {
  const tz = opts.timeZone ? {timeZone: opts.timeZone} : {};
  const chart = house.chart?.points.length ? html`<div class="dh-chart"><${Chart} data=${house.chart} label=${house.chart.title} readout="legend" timeZone=${opts.timeZone} /></div>` : null;
  const spread = !!chart && quick(house, opts.quick).length <= COLUMNS * SPREAD_ROWS;
  return html`<div class="dh dh-tablet">
    <header class="dh-strip">
      <div class="dh-clock"><b>${timeText(now, tz)}</b>
        <span>${dateText(now, {...tz, now, weekday: true})}</span></div>
      ${status(house).map(s => html`<div key=${s.id} class=${`dh-stat ${s.tone ?? ''}`} data-id=${s.id}><span>${s.label}</span><b>${s.value}</b></div>`)}
      <${Live} house=${house} />
    </header>
    <main class=${`dh-main${spread ? ' spread' : ''}`}>
      <section class="dh-left">
        <${Cameras} house=${house} host=${host} size=${9} fit />
        ${spread ? null : chart}
      </section>
      <${FittedQuick} house=${house} opts=${opts} spread=${spread} />
      ${spread ? chart : null}
    </main>
    <${Ticker} house=${house} now=${now} />
  </div>`;
}

/** An entity as a row: its state under the name (or `sub`, the state then a note), its control's verb as the button. */
const entityRow = (house, e, sub = null) => {
  const s = house.state(e.id), c = control(e, s);
  const text = stateText(e, s, {unit: temperatureUnit(house)});
  return {id: e.id, glyph: glyphOf(e), title: e.name, sub: sub ?? text, accent: !!c?.on && !warns(e, s),
    notes: sub ? [{text, tone: warns(e, s) ? 'warn' : ''}] : null,
    end: c && !c.disabled ? {disabled: !house.live, label: house.busy.has(e.id) ? '…' : c.verb, onClick: () => house.act(e.id)} : null};
};

/** The phone's (and a desktop's) House: the TOP controls people use most (quick(): Habitat's ranking, then the quick order) as one
 *  grid, a search over every control by name, room or alias in their place while typed (`/` focuses it, Esc clears it), then the
 *  cameras and the status. Every other device is Find's House group's, every entity the admin's. */
const TOP = 20;
function Phone({house, host, opts, now}) {
  const all = useMemo(() => controls(house, opts.rooms), [house.entities, house.quickEntities, opts.rooms]);
  const page = useCollectionPage(all, {textOf: textOfControl, size: TOP});
  const box = useRef(null);
  useEffect(() => {
    const key = ev => {
      const input = box.current?.querySelector('input'), typing = ev.target instanceof Element && ev.target.closest('input, textarea, select, [contenteditable]');
      if (ev.key === '/' && !typing && input && !ev.metaKey && !ev.ctrlKey && !ev.altKey) { ev.preventDefault(); input.focus(); }
      else if (ev.key === 'Escape' && ev.target === input && page.query) { ev.preventDefault(); page.setQuery(''); }
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [page]);
  const shown = page.query ? page.items.map(r => r.e) : quick(house, opts.quick).slice(0, TOP);
  return html`<div class="dh dh-phone">
    <section class="dh-controls" aria-label="Controls">
      <h2 class="dk-label">${page.query ? 'Matching controls' : 'Most used'}</h2>
      <div class="dh-search" ref=${box}><${CollectionSearch} page=${page.query ? page : {...page, total: 0}} label="Find a control" placeholder="Name, room or alias" /></div>
      ${shown.length ? html`<section class="dh-quick" aria-label=${page.query ? 'Matching controls' : 'Most used controls'}>${shown.map(e => html`<${Tile} key=${e.id} house=${house} e=${e} />`)}</section>`
        : html`<p class="dh-none">${page.query ? `No control matches “${page.query}”.` : 'No controls yet.'}</p>`}
      ${page.query ? html`<${CollectionPager} page=${page} label="Matching control pages" />` : null}
    </section>
    <${Cameras} house=${house} host=${host} />
    <section class="dh-now" aria-label="Status"><div class="dh-now-head"><h2 class="dk-label">Status</h2><${Live} house=${house} /></div>
      <dl class="dh-stats">${status(house).filter(s => !(opts.nav && s.id === 'needs')).map(s => html`<div key=${s.id} class=${`dh-stat ${s.tone ?? ''}`} data-id=${s.id}><dt>${s.label}</dt><dd>${s.value}</dd></div>`)}</dl>
      <${Ticker} house=${house} now=${now} chips /></section>
  </div>`;
}
const textOfControl = r => r.text;

/** A need's button: a page to open, Habitat's op (gesture), or a command to copy. */
export const needEnd = (house, host, need, report = () => {}) => {
  const a = need.action ?? {};
  const run = a.kind === 'url' ? () => host.call('url.open', {url: a.url}).catch(() => {})
    : a.kind === 'op' ? () => house.need(need.id)
    : () => host.call('clipboard.copy', {text: a.command}).then(() => report('Copied'), e => report(describeFailure('This device’s clipboard', e).message, true));
  return {label: a.label ?? 'Fix', onClick: run};
};

/** The settings: a row each (its name, its control), one Save for every changed value. */
function Settings({house}) {
  const specs = house.settings, [draft, setDraft] = useState({}), [errors, setErrors] = useState({});
  const supported = spec => ['bool', 'str', 'int', 'float'].includes(spec.type);
  const changed = Object.keys(draft).filter(name => specs?.[name] && draft[name] !== specs[name].value);
  const busy = house.settingBusy.size > 0;
  if (!specs) return html`<p>Settings unavailable</p>`;
  if (!Object.keys(specs).length) return html`<p>No settings.</p>`;
  return html`<form class="dh-settings" onSubmit=${async ev => {
    ev.preventDefault();
    const parsed = {}, bad = {};
    for (const name of changed) {
      const spec = specs[name], value = draft[name], number = ['int', 'float'].includes(spec.type), n = number ? Number(value) : value;
      if (number && (String(value).trim() === '' || !Number.isFinite(n) || spec.type === 'int' && !Number.isSafeInteger(n))) bad[name] = 'Enter a valid number';
      else parsed[name] = n;
    }
    setErrors(bad);
    if (Object.keys(bad).length) return;
    for (const [name, value] of Object.entries(parsed)) await house.setting(name, value);
    setDraft({});
  }}>
    ${Object.entries(specs).map(([name, spec]) => {
      const label = spec.doc || fieldLabel(name), bool = spec.type === 'bool', value = name in draft ? draft[name] : spec.value, id = `dh-setting-${name}`;
      return html`<div key=${name} class=${`dh-setting${bool ? ' bool' : ''}`}>
        <label class="dh-setting-name" for=${id}>${label}${spec.unit ? ` (${spec.unit})` : ''}</label>
        <input id=${id} class=${bool ? null : 'dk-field'} aria-label=${label} type=${bool ? 'checkbox' : ['int', 'float'].includes(spec.type) ? 'number' : 'text'}
          step=${spec.type === 'float' ? 'any' : '1'} checked=${bool ? value : undefined} value=${bool ? undefined : value}
          aria-invalid=${errors[name] ? 'true' : null} disabled=${!supported(spec) || busy}
          onInput=${ev => setDraft(d => ({...d, [name]: bool ? ev.target.checked : ev.target.value}))} />
        ${errors[name] ? html`<span class="dk-field-error" role="alert">${errors[name]}</span>` : null}
      </div>`;
    })}
    <div class="dh-settings-save"><button class="dk-btn main" type="submit" disabled=${!changed.length || busy}>${busy ? 'Saving…' : 'Save settings'}</button>
      ${changed.length ? html`<span class="dk-field-hint">${changed.length === 1 ? '1 change' : `${changed.length} changes`} not saved</span>` : null}</div>
  </form>`;
}

/** A rule's id as a title: `garage.left_open` → `Garage · Left open`. */
const ruleTitle = name => String(name).split('.').map(fieldLabel).join(' · ');
/** A service's facts: the checks' own words (no `Checks ·` path), a check's detail beside its status. */
function serviceFacts(driver) {
  const facts = readableFacts(Object.fromEntries(Object.entries(driver).filter(([key]) => key !== 'ok')))
    .map(f => ({...f, label: f.label.replace(/^Checks · /, '').replace(/\bOk$/, 'Status'), value: f.label.endsWith('Ok') ? (f.value === 'Yes' ? 'Healthy' : 'Unhealthy') : f.value}));
  const out = [];
  for (const f of facts) {
    const detail = /^(.*) · Detail$/.exec(f.label), into = detail && out.find(o => o.label === detail[1] || o.label === `${detail[1]} · Status`);
    if (into) into.value = `${into.value} · ${f.value}`; else out.push({...f});
  }
  return out.map(f => ({...f, label: f.label.replace(/ · Status$/, '')}));
}

const serviceName = name => ({ha: 'Home Assistant', z2m: 'Zigbee2MQTT', zigbee: 'Zigbee', frigate: 'Frigate', habitat: 'Habitat', houston: 'Houston'}[name] ?? fieldLabel(name));
const serviceGlyph = name => ({ha: 'house', habitat: 'house', z2m: 'link', zigbee: 'link', frigate: 'video', houston: 'chart'}[name] ?? 'details');

function Admin({house, host, now}) {
  const [q, setQ] = useState(''), [domain, setDomain] = useState(null), [copyNote, setCopyNote] = useState(null);
  const list = entities(house, {q, domain}), shown = list.slice(0, 300);
  const domains = [...new Set(house.entities.map(e => e.domain))].sort();
  const rules = house.rules ?? [];
  return html`<div class="dh dh-admin">
    <div class="dh-chips"><${Live} house=${house} /></div>
    <section aria-label="Service health"><h2 class="dk-label">Service health</h2>
      ${house.health ? html`<p class=${`dh-health${house.health.ok && !house.health.degraded ? '' : ' warn'}`}>${house.health.degraded ? 'Degraded' : house.health.ok ? 'Healthy' : 'Unhealthy'}</p>
        ${Object.entries(house.health.drivers ?? {}).map(([name, driver]) => html`<section key=${name} class="dh-service" aria-label=${serviceName(name)}>
          <${RowList} items=${[{id: name, glyph: serviceGlyph(name), title: serviceName(name),
            badge: {text: driver.ok === true ? 'Healthy' : driver.ok === false ? 'Unhealthy' : 'Unknown', tone: driver.ok === false ? 'warn' : ''}}]} />
          <${Facts} facts=${serviceFacts(driver)} />
        </section>`)}` : html`<p>Health unavailable</p>`}
    </section>
    <section aria-label="Settings"><h2 class="dk-label">Settings</h2>
      <${Settings} house=${house} />
    </section>
    <section aria-label="House needs"><h2 class="dk-label">House needs</h2>
      ${house.needs.length ? house.needs.map(nd => html`<div key=${nd.id}>
        <${RowList} items=${[{id: nd.id, glyph: 'warn', title: nd.title,
          sub: [nd.detail, nd.since ? `since ${age(Date.parse(nd.since), now)}` : null,
            nd.acknowledged_at ? `Acknowledged: ${dateTimeText(nd.acknowledged_at, {now})}` : null,
            nd.snoozed_until ? `Snoozed until: ${dateTimeText(nd.snoozed_until, {now})}` : null].filter(Boolean).join(' · ')}]} />
        <div class="dh-need-actions" role="group" aria-label=${`Manage ${nd.title}`}>
          ${(end => html`<button type="button" class="dk-btn main" onClick=${end.onClick}>${end.label}</button>`)(needEnd(house, host, nd, (text, bad = false) => setCopyNote({text, bad})))}
          ${[['acknowledge', 'Acknowledge'], ['resolve', 'Resolve'], ['snooze', 'Snooze for 1 hour']].map(([op, label]) => html`<button type="button" class="dk-btn" onClick=${() => house.need(nd.id, op)}>${label}</button>`)}
        </div></div>`)
        : html`<p class="dh-none">Nothing needs you.</p>`}</section>
    ${copyNote ? html`<p role="status">${copyNote.text}${copyNote.bad ? html`<${StatusLink} host=${host} />` : null}</p>` : null}
    <section aria-label="Rules"><h2 class="dk-label">Rules</h2>
      ${house.rules == null ? html`<div class="dp-rows dp-plain"><${Placeholders} n=${2} /></div>` : html`<${RowList} items=${rules.map(r => ({id: `rule:${r.name}`, glyph: 'bolt', title: ruleTitle(r.name),
        sub: [r.last_run ? `Ran ${age(Date.parse(r.last_run), now)}` : 'Never ran', r.shadow_count ? `${r.shadow_count} in shadow` : null,
          r.shadow_diff_count ? `${r.shadow_diff_count} differ from HA` : null, fieldLabel(r.mode)].filter(Boolean).join(' · '),
        end: {label: r.mode === 'live' ? 'Roll back' : 'Cut over',
          disabled: house.ruleBusy.has(r.name) || r.mode !== 'live' && !house.reports.find(report => report.rule === r.name)?.ready,
          onClick: () => house.rule(r.name, r.mode === 'live' ? 'shadow' : 'live')},
        badge: {text: fieldLabel(r.mode), tone: r.mode === 'live' ? 'accent' : ''}}))} empty=${{glyph: 'bolt', title: 'No rules yet'}} />`}</section>
    <section aria-label="Entities"><h2 class="dk-label">Entities · ${list.length}</h2>
      <div class="dh-filter">
        <input class="dk-field" type="search" placeholder="Filter by name or id" aria-label="Filter entities" value=${q} onInput=${ev => setQ(ev.target.value)} />
        <div class="dh-domains" role="group" aria-label="Domain">${domains.map(d => html`<button type="button" key=${d} class=${`dk-chip${d === domain ? ' on' : ''}`}
          aria-pressed=${String(d === domain)} onClick=${() => setDomain(d === domain ? null : d)}>${fieldLabel(d)}</button>`)}</div>
      </div>
      <${RowList} items=${shown.map(e => entityRow(house, e, [e.driver ? serviceName(e.driver) : null, e.area ? roomName(e.area) : null].filter(Boolean).join(' · ') || null))} empty=${{glyph: 'find', title: 'No entity matches'}} />
      ${list.length > shown.length ? html`<p class="dh-none">${list.length - shown.length} more: filter to find them</p>` : null}</section>
  </div>`;
}

/** The House: opts {view: tablet | wall | phone | admin, wallNav (the wall's links), brand, nav, current (a shell bar when `nav` is given, never on the tablet; its needs badge the count),
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
  // the tablet and the camera wall are kiosks: the board alone, no shell bar or page header; a failure is the page's one state,
  // centred (signed out keeps the bar: the way back to Deck once signed in)
  const kiosk = view === 'tablet' || WALL_VIEWS.has(view);
  const bar = (kiosk ? house.error?.status === 401 : opts.nav) ? html`<${ShellBar} brand=${opts.brand} nav=${opts.nav} backends=${host.backends ?? []} current=${opts.current ?? 'house'}
    needs=${{count: house.needsSource?.count, label: 'Needs', href: opts.nav?.find(n => n.id === 'todo')?.href}} />` : null;
  const body = WALL_VIEWS.has(view) ? html`<${HouseWall} house=${house} host=${host} opts=${{...opts, view}} now=${now} />`
    : view === 'admin' ? html`<${Admin} house=${house} host=${host} now=${now} />`
    : view === 'phone' ? html`<${Phone} house=${house} host=${host} opts=${opts} now=${now} />`
    : html`<${Tablet} house=${house} host=${host} opts=${opts} now=${now} />`;
  return html`<div class=${`dh-page dh-${view}-page`} data-view=${view}>${bar}<main class=${`dk-house-content${kiosk ? '' : ' dk-page'}`}>
    ${kiosk ? null : html`<${PageHeader} title="House" description=${view === 'admin' ? 'Service health, settings, needs, rules and every entity.' : 'The controls you use most, the state of your house and its cameras.'} />`}<${PageState} state=${house.loading ? 'loading' : !house.entities.length ? 'empty' : 'ready'}
      error=${house.error} backend="habitat" title=${house.error && house.error.status !== 401 ? 'House unavailable' : undefined} hint="Connect devices in Habitat to see your house here."
      retry=${() => { house.stop(); house.error = null; house.start(); }} host=${host}>
      ${body}${view === 'admin' ? html`<${LocationHistory} host=${host} timeZone=${opts.timeZone} now=${now} />` : null}
    </${PageState}>
    </main><${Confirm} house=${house} anchor=${kiosk} />
    <div class="dh-status" role="status">${house.outcome ? html`<span class=${house.outcome.bad ? 'bad' : ''}>${house.outcome.text}${house.outcome.bad ? html`<${StatusLink} />` : null}</span>` : null}</div>
  </div>`;
}


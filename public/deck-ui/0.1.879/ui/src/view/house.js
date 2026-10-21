import {PageHeader} from './page-header.js';
import {countsText, ruleOf} from '../house-rules.js';
import {age, dateText, dateTimeText, fieldLabel, timeText} from '../format.js';
import {StatusLink} from './page-state.js';
import {PageState} from './page-state.js';
import {describeFailure} from '../failure.js';
// The House page's views (contract/house.md *House*; habitat docs/design.md *Dashboards*) over src/house.js: the tablet (the kitchen's Fully
// Kiosk, 1280×800: the status strip, quick controls, an hourly chart, the ticker), the phone (the shell bar, status, the ~20 controls
// people use most with a search over every control, the cameras) and the admin (needs, rules, every entity, filtered). One confirmation bar for anything that
// moves hardware, the toast for outcomes. Built from deck-ui's own parts: the shell bar, rows, the chart.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useMemo, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Glyph} from '../glyphs.js';
import {CAMERAS_VIEW, WALL_VIEWS, control, controls, entities, quick, roomName, serviceLine, serviceName, serviceNotes, stateText, status, temperatureUnit, ticker, warns} from '../house.js';
import {CollectionPager, CollectionSearch, useCollectionPage} from './collection-page.js';
import {HouseWall} from './house-wall.js';
import {Chart} from './chart.js';
import {Placeholders, RowList, entityGlyph} from './rows.js';
import {LocationHistory} from './location-history.js';
import {LiveCamera, useStill} from './camera.js';
import {ShellBar} from './shell-bar.js';
import {SharedScreen} from './avatar.js';
import {entityHref} from './entity-link.js';
import {LinkToThing, NewThingDrawer} from './thing-links.js';
import {Toast, useOutcome} from './toast.js';
import {Menu} from './menu.js';
import {ChipGroup} from './chip-group.js';
import {Confirm, Tile, asOf} from './house-controls.js';
import {houseTarget, thingPage} from '../thing-links.js';

const html = htm.bind(h);
/** The Cameras place's address on the site (contract/house.md *Cameras*); a host serving House elsewhere passes `camerasHref`. */
const CAMERAS_HREF = '/house/cameras';

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


/** Ticks every `ms` while mounted (the clock, the ages). */
function useTick(ms) {
  const [n, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set(x => x + 1), ms); return () => clearInterval(t); }, [ms]);
  return n;
}

/** A tile off the kiosks (the phone's and a desktop's House): its control, the thing its device is linked to (Habitat's `thing`, bridge's
 *  link: `/things#<UUID>`) and, for a member who may write, its menu: Link to a thing (`onLink(e)`), New thing (`onNew(e)`: one
 *  made for it, its device linked at once). */
function LinkedTile({house, e, onLink, onNew, web = true}) {
  const [open, setOpen] = useState(false), more = useRef(null);
  const thing = e.thing?.id ? e.thing : null;
  return html`<div class=${`dh-tile-box${thing ? ' linked' : ''}${house.linksThings ? ' menu' : ''}`}>
    <${Tile} house=${house} e=${e} />
    ${thing ? (web ? html`<a class="dh-tile-thing" href=${entityHref({kind: 'thing', id: thing.id})} title=${`Linked: ${thing.name}`}>Linked: ${thing.name}</a>`
      : html`<span class="dh-tile-thing" title=${`Linked: ${thing.name}`}>Linked: ${thing.name}</span>`) : null}
    ${house.linksThings ? html`<button type="button" class="dk-btn icon text dh-tile-more" aria-label=${`More: ${e.name}`} title="More" aria-haspopup="menu" aria-expanded=${String(open)}
      ref=${more} onClick=${() => setOpen(!open)}><${Glyph} name="more" size=${16} /></button>` : null}
    ${open ? html`<${Menu} class="dh-tile-menu" label=${e.name} opener=${more} onClose=${() => setOpen(false)} items=${[
      {key: 'link', label: thing ? 'Link to another thing' : 'Link to a thing', run: () => onLink(e)},
      {key: 'new', label: 'New thing', run: () => onNew(e)}]} />` : null}
  </div>`;
}

/** Links an entity's device (Habitat's `device`, kind `device`) or, without one, the entity itself to a thing the member picks. */
function LinkEntity({host, e, onClose, onLinked}) {
  return html`<${LinkToThing} host=${host} title="Link to a thing" target=${houseTarget(e)} current=${e.thing?.id ? e.thing : null} onClose=${onClose} onLinked=${onLinked} />`;
}

// The tile's still (view/camera.js useStill): refreshed while on screen, on its Frigate camera's state events; failures kept across pauses.
function Camera({host, e, cameras, state = null, cell = null, onOpen = null}) {
  const ref = useRef(null), [shape, setShape] = useState(16 / 9);
  const {frame, message, phase, failed, retry} = useStill(host, e.id.slice(7), ref, {title: e.name, stateId: e.driver === 'frigate' ? e.id : null, state, key: cameras});
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
  // the House page's and the Cameras place's: a press opens it live in its place; a failed still says so in a word, with Retry (the
  // reason in its tooltip), never loading forever; off screen it waits quietly
  const note = phase === 'failed' ? html`<span class="dh-camera-note" role="status" title=${message}><span class="dh-camera-why">Camera unreachable</span>
      <button type="button" class="dk-btn" aria-label=${`Retry ${e.name}`} onClick=${retry}>Retry</button></span>`
    : phase === 'missing' ? html`<span class="dh-camera-note" role="status" title=${message}><span class="dh-camera-why">Camera not found</span></span>`
    : phase === 'loading' ? html`<span class="dh-camera-note" role="status">${message}</span>` : null;
  return html`<div class="dh-camera" data-id=${e.id} data-phase=${phase} ref=${ref}>
    ${frame ? html`<img src=${frame} alt=${e.name} loading="lazy" decoding="async" onError=${failed} />` : note}
    <b>${e.name}</b>
    ${onOpen && phase !== 'missing' ? html`<button type="button" class="dh-camera-open" aria-label=${`Watch ${e.name} live`} onClick=${onOpen}><span class="dh-camera-cue" aria-hidden="true"><${Glyph} name="play" size=${16} />Live</span></button>` : null}
  </div>`;
}

/** The camera opened live on the House page and the Cameras place: [id, open(id), close()]. Opening adds a history entry, so Back closes
 *  it (as Esc and its close button do); another camera opened meanwhile replaces it. A reload keeps it open. */
function useOpenCamera() {
  const [open, setOpen] = useState(() => history.state?.deckCamera ?? null);
  const close = () => { if (history.state?.deckCamera) history.back(); else setOpen(null); };
  useEffect(() => {
    const pop = () => setOpen(history.state?.deckCamera ?? null);
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const key = ev => { if (ev.key === 'Escape' && !ev.defaultPrevented && !ev.target.closest?.('input, textarea, select')) { ev.preventDefault(); close(); } };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [open]);
  const openCamera = id => {
    history[history.state?.deckCamera ? 'replaceState' : 'pushState']({...history.state, deckCamera: id}, '');
    setOpen(id);
  };
  return [open, openCamera, close];
}

const cameraEntities = house => house.entities.filter(e => e.domain === 'camera');

/** The tablet's cameras: up to 9 in a grid of at most four columns filling the space beside the chart (one alone while activity
 *  focuses it). */
function Cameras({house, host}) {
  const all = cameraEntities(house), cameras = JSON.stringify(all);
  const focused = all.find(e => e.id === house.cameraFocus);
  // Keep camera mounts (and snapshot backoff) when activity changes the focused subset.
  return html`<${Page} items=${focused ? [focused] : all} size=${9} label="Camera pages">${items => html`<${CameraGrid} items=${items} host=${host} house=${house} cameras=${cameras} />`}</${Page}>`;
}

/** Cameras a person opens (the House page's row, the Cameras place): each its still; a press opens one live in its place, the grid's
 *  whole width (view/camera.js LiveCamera: its sound on, a sound button, pop out, a close button); closed, the still again and the
 *  focus back on it. `cameras`: every camera's list (a 404'd still waits for it to change). */
function PhoneCameras({items, host, house, cameras, label = 'Cameras', className = ''}) {
  const [open, openCamera, close] = useOpenCamera(), ref = useRef(null), last = useRef(null);
  useLayoutEffect(() => {
    if (open) { last.current = open; ref.current?.querySelector('.dk-live')?.scrollIntoView({block: 'nearest'}); return; }
    const was = last.current;
    last.current = null;
    if (was) ref.current?.querySelector(`.dh-camera[data-id="${CSS.escape(was)}"] .dh-camera-open`)?.focus({preventScroll: true});
  }, [open]);
  return html`<section class=${`dh-cameras${className ? ` ${className}` : ''}`} aria-label=${label} ref=${ref}>${items.map(e => e.id === open
    ? html`<${LiveCamera} key=${e.id} host=${host} camera=${e.id.slice(7)} title=${e.name} stateId=${e.driver === 'frigate' ? e.id : null} state=${house.state(e.id)}
        cameras=${cameras} onClose=${close} closeLabel=${`Close ${e.name} live`} />`
    : html`<${Camera} key=${e.id} host=${host} e=${e} state=${house.state(e.id)} cameras=${cameras} onOpen=${() => openCamera(e.id)} />`)}</section>`;
}

/** The House page's Cameras row, near its top: the first ROW_CAMERAS cameras (a press opens one live in the row's place) and the way to
 *  every one, the Cameras place (`href`). */
const ROW_CAMERAS = 4;
function CameraRow({house, host, href}) {
  const all = cameraEntities(house);
  if (!all.length) return null;
  return html`<section class="dh-camrow" aria-labelledby="dh-camrow-label">
    <div class="dh-section-head"><h2 class="dk-label" id="dh-camrow-label">Cameras</h2>
      <a class="dk-btn text" href=${href}>${all.length === 1 ? 'Cameras' : `All ${all.length} cameras`} ›</a></div>
    <${PhoneCameras} items=${all.slice(0, ROW_CAMERAS)} host=${host} house=${house} cameras=${JSON.stringify(all)} label="First cameras" className="dh-camrow-grid" />
  </section>`;
}

/** The Cameras place (`/house/cameras`, contract/house.md *Cameras*): every camera at once, no pager, in as many columns as read well
 *  (house.css: three wide, two at a tablet's width, one on a phone); a press plays one live in its place, with its sound, Pop out and
 *  close; one camera is heard at a time. */
function CamerasPlace({house, host}) {
  const all = cameraEntities(house);
  if (!all.length) return html`<p class="dh-none">No cameras yet.</p>`;
  return html`<div class="dh dh-cameras-place"><${PhoneCameras} items=${all} host=${host} house=${house} cameras=${JSON.stringify(all)} className="dh-cameras-all" /></div>`;
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

/** What the house says now: a line along the tablet's bottom; on the phone, chips like the status's. */
function Ticker({house, now, chips = false}) {
  const items = ticker(house);
  if (!items.length) return null;
  return html`<ul class=${`dh-ticker${chips ? ' dh-chips' : ''}`} aria-label="Ticker">${items.map(t => html`<li key=${t.id} class=${chips ? 'dh-chip' : null}>${t.text}${t.at ? html`<span class="dh-age">${age(t.at, now)}</span>` : null}</li>`)}</ul>`;
}


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
        <${Cameras} house=${house} host=${host} />
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
  return {id: e.id, glyph: entityGlyph(e), title: e.name, sub: sub ?? text, accent: !!c?.on && !warns(e, s),
    notes: sub ? [{text, tone: warns(e, s) ? 'warn' : ''}] : null,
    end: c && !c.disabled ? {disabled: !house.live, label: house.busy.has(e.id) ? '…' : c.verb, onClick: () => house.act(e.id)} : null};
};

/** The phone's (and a desktop's) House: the TOP controls people use most (quick(): Habitat's ranking, then the quick order) as one
 *  grid, a search over every control by name, room or alias in their place while typed (`/` focuses it, Esc clears it), then the
 *  cameras and the status. Every other device is Find's House group's, every entity the admin's. */
const TOP = 20;
function Phone({house, host, opts, now}) {
  const all = useMemo(() => controls(house, opts.rooms), [house.entities, house.quickEntities, opts.rooms]);
  // a link made here shows at once; Habitat's entities carry it within a minute (an entity-only link stays bridge's)
  const [linking, setLinking] = useState(null), [making, setMaking] = useState(null), [linked, setLinked] = useState({}), [outcome, say] = useOutcome();
  const tile = e => html`<${LinkedTile} key=${e.id} house=${house} e=${linked[e.id] ? {...e, thing: linked[e.id]} : e} onLink=${setLinking} onNew=${setMaking} web=${host.kind === 'web'} />`;
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
    <${CameraRow} house=${house} host=${host} href=${opts.camerasHref ?? CAMERAS_HREF} />
    <section class="dh-controls" aria-label="Controls">
      <h2 class="dk-label">${page.query ? 'Matching controls' : 'Most used'}</h2>
      <div class="dh-search" ref=${box}><${CollectionSearch} page=${page.query ? page : {...page, total: 0}} label="Find a control" placeholder="Name, room or alias" /></div>
      ${shown.length ? html`<section class="dh-quick" aria-label=${page.query ? 'Matching controls' : 'Most used controls'}>${shown.map(tile)}</section>`
        : html`<p class="dh-none">${page.query ? `No control matches “${page.query}”.` : 'No controls yet.'}</p>`}
      ${page.query ? html`<${CollectionPager} page=${page} label="Matching control pages" />` : null}
    </section>
    <section class="dh-now" aria-label="Status"><div class="dh-now-head"><h2 class="dk-label">Status</h2><${Live} house=${house} /></div>
      <dl class="dh-stats">${status(house).filter(s => !(opts.nav && s.id === 'needs')).map(s => html`<div key=${s.id} class=${`dh-stat ${s.tone ?? ''}`} data-id=${s.id}><dt>${s.label}</dt><dd>${s.value}</dd></div>`)}</dl>
      <${Ticker} house=${house} now=${now} chips /></section>
    ${linking ? html`<${LinkEntity} host=${host} e=${linking} onClose=${() => setLinking(null)}
      onLinked=${thing => { setLinked(l => ({...l, [linking.id]: thing})); say(`${linking.name} linked to ${thing.name}`); setLinking(null); }} />` : null}
    ${making ? html`<${NewThingDrawer} host=${host} from=${houseTarget(making)} current=${making.thing?.id ? making.thing : null} name=${making.name} onClose=${() => setMaking(null)}
      onCreated=${thing => {
        setLinked(l => ({...l, [making.id]: thing})); setMaking(null);
        // the site opens the new thing's page; a desktop's window has none, so it says so here
        if (host.kind === 'web') globalThis.location?.assign(thingPage(thing.id)); else say(`New thing: ${thing.name}`);
      }} />` : null}
    <${Toast} outcome=${outcome} />
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

const serviceGlyph = name => ({ha: 'house', habitat: 'house', z2m: 'link', zigbee: 'link', frigate: 'video', houston: 'chart'}[name] ?? 'details');

/** Every service in one list, one row each: its name, its detail in words, its failing checks; unhealthy ones first. */
const serviceRows = (health, now) => Object.entries(health.drivers ?? {})
  .sort(([a, x], [b, y]) => (x.ok === false ? 0 : 1) - (y.ok === false ? 0 : 1) || serviceName(a).localeCompare(serviceName(b)))
  .map(([name, driver]) => ({id: name, glyph: serviceGlyph(name), title: serviceName(name), sub: serviceLine(driver, now), notes: serviceNotes(driver),
    badge: driver.ok === true ? {text: 'Healthy', tone: ''} : driver.ok === false ? {text: 'Unhealthy', tone: 'warn'} : null}));

function Admin({house, host, now, rulesHref}) {
  const [q, setQ] = useState(''), [domain, setDomain] = useState(null), [copyNote, sayCopy] = useOutcome();
  const list = entities(house, {q, domain});
  const domains = [...new Set(house.entities.map(e => e.domain))].sort();
  // Habitat's own placement needs (an entity with no room): its health's `areas` needs
  const placement = (house.health?.needs ?? []).filter(n => n.source === 'areas');
  return html`<div class="dh dh-admin">
    <div class="dh-chips"><${Live} house=${house} /></div>
    <section aria-label="Service health"><h2 class="dk-label">Service health${house.health ? ` · ${house.health.degraded ? 'Degraded' : house.health.ok ? 'Healthy' : 'Unhealthy'}` : ''}</h2>
      ${house.health ? html`<${RowList} items=${serviceRows(house.health, now)} inline=${true} empty=${{title: 'No services reported'}} />` : html`<p class="dh-none">Health unavailable</p>`}
    </section>
    <section aria-label="Placement needs"><h2 class="dk-label">Placement needs</h2>
      ${house.health ? html`<${RowList} items=${placement.map(n => ({id: n.id, glyph: 'place', title: n.title, sub: n.detail ?? null}))} inline=${true}
        empty=${{title: 'Every entity has a room.'}} />` : html`<p class="dh-none">Health unavailable</p>`}
    </section>
    <section aria-label="Settings"><h2 class="dk-label">Settings</h2>
      <${Settings} house=${house} />
    </section>
    <section aria-label="House needs"><h2 class="dk-label">House needs</h2>
      ${house.needs.length ? house.needs.map(nd => html`<div key=${nd.id}>
        <${RowList} items=${[{id: nd.id, glyph: 'warn', title: nd.title,
          sub: [nd.detail, nd.since ? `since ${age(nd.since, now)}` : null,
            nd.acknowledged_at ? `Acknowledged: ${dateTimeText(nd.acknowledged_at, {now})}` : null,
            nd.snoozed_until ? `Snoozed until: ${dateTimeText(nd.snoozed_until, {now})}` : null].filter(Boolean).join(' · ')}]} />
        <div class="dh-need-actions" role="group" aria-label=${`Manage ${nd.title}`}>
          ${(end => html`<button type="button" class="dk-btn main" onClick=${end.onClick}>${end.label}</button>`)(needEnd(house, host, nd, sayCopy))}
          ${[['acknowledge', 'Acknowledge'], ['resolve', 'Resolve'], ['snooze', 'Snooze for 1 hour']].map(([op, label]) => html`<button type="button" class="dk-btn" onClick=${() => house.need(nd.id, op)}>${label}</button>`)}
        </div></div>`)
        : html`<p class="dh-none">Nothing needs you.</p>`}</section>
    <${Toast} outcome=${copyNote} status=${true} host=${host} />
    <section aria-label="Rules"><h2 class="dk-label">Rules</h2>
      ${house.rules == null ? html`<div class="dp-rows dp-plain"><${Placeholders} n=${1} /></div>`
        : html`<p class="dh-none">${countsText(house.rules.map(ruleOf))}${rulesHref ? html` · <a class="dk-entity" href=${rulesHref}>Every rule ›</a>` : null}</p>`}</section>
    <section aria-label="Entities"><h2 class="dk-label">Entities · ${list.length}</h2>
      <div class="dh-filter">
        <input class="dk-field" type="search" placeholder="Filter by name or id" aria-label="Filter entities" value=${q} onInput=${ev => setQ(ev.target.value)} />
        <${ChipGroup} label="Domain" toggle=${true} value=${domain} onChange=${setDomain} options=${domains.map(d => ({value: d, label: fieldLabel(d)}))} />
      </div>
      <${Page} key=${`${q} ${domain}`} items=${list} label="Entity pages">${shown => html`<${RowList} items=${shown.map(e => entityRow(house, e, [e.driver ? serviceName(e.driver) : null, e.area ? roomName(e.area) : null].filter(Boolean).join(' · ') || null))}
        empty=${{glyph: 'find', title: 'No entity matches'}} />`}</${Page}></section>
  </div>`;
}

/** What each scrolling view's header says. */
const HEADERS = {
  admin: ['House', 'Service health, placement, settings, needs, rules and every entity.'],
  [CAMERAS_VIEW]: ['Cameras', 'Every House camera. Press one to watch it live.'],
  phone: ['House', 'Your cameras, the controls you use most and the state of your house.'],
};

/** The House: opts {view: tablet | wall | phone | cameras | admin, wallNav (the wall's links), links (the phone's and admin's header links to their own pages), brand, nav, current (a shell bar when `nav` is given, never on the tablet; its needs badge the count),
 *  quick (entity ids), rooms ({area: name}), timeZone, camerasHref (the Cameras place, phone), member (Habitat's /api/member: the
 *  Cameras place shows nothing to a display nobody signed in to), rulesHref (every rule, the phone's and admin's header)}. */
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
  const bar = (kiosk ? house.error?.status === 401 : opts.nav) ? html`<${ShellBar} brand=${opts.brand} nav=${opts.nav} backends=${host.backends ?? []} current=${opts.current ?? (view === CAMERAS_VIEW ? 'cameras' : 'house')}
    needs=${{count: house.needsSource?.count, label: 'Needs', href: opts.nav?.find(n => n.id === 'todo')?.href}} />` : null;
  const body = WALL_VIEWS.has(view) ? html`<${HouseWall} house=${house} host=${host} opts=${{...opts, view}} now=${now} />`
    : view === 'admin' ? html`<${Admin} house=${house} host=${host} now=${now} rulesHref=${opts.rulesHref} />`
    : view === CAMERAS_VIEW ? html`<${CamerasPlace} house=${house} host=${host} />`
    : view === 'phone' ? html`<${Phone} house=${house} host=${host} opts=${opts} now=${now} />`
    : html`<${Tablet} house=${house} host=${host} opts=${opts} now=${now} />`;
  const [title, description] = HEADERS[view] ?? HEADERS.phone;
  // the cameras are a member's: a shared screen nobody signed in to (member null) is shown none
  const shared = view === CAMERAS_VIEW && opts.member === null;
  // a kiosk is a shared screen: anyone in the room sees it, so a person there is their initials (view/avatar.js)
  return html`<${SharedScreen.Provider} value=${kiosk}><div class=${`dh-page dh-${view}-page`} data-view=${view}>${bar}<main class=${`dk-house-content${kiosk ? '' : ' dk-page'}`}>
    ${kiosk ? null : html`<${PageHeader} title=${title} description=${description} links=${view === 'phone' || view === 'admin' ? opts.links ?? [] : []}
      actions=${opts.rulesHref && view !== CAMERAS_VIEW ? html`<a class="dk-btn" href=${opts.rulesHref}>Rules ›</a>` : null} />`}<${PageState} state=${shared ? 'signed out' : house.loading ? 'loading' : !house.entities.length ? 'empty' : 'ready'}
      error=${house.error} backend="habitat" title=${house.error && house.error.status !== 401 ? 'House unavailable' : undefined} hint="Connect devices in Habitat to see your house here."
      retry=${() => { house.stop(); house.error = null; house.start(); }} host=${host}>
      ${body}${view === 'admin' ? html`<${LocationHistory} host=${host} timeZone=${opts.timeZone} now=${now} />` : null}
    </${PageState}>
    </main><${Confirm} house=${house} anchor=${kiosk} />
    <${Toast} outcome=${house.outcome} status=${true} host=${host} />
  </div><//>`;
}

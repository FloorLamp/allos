// The camera wall (contract/house.md *Camera wall*): the Pixel tablet's 1280×800 kiosk, framed by its HA dashboard. A band (the
// clock, the weather and date, then the house's chips while each has something to say, the ticker) over a camera grid of three 16:9
// columns, the featured camera two columns by two rows and heard, every tile live video with its still standing in
// (view/camera.js); a tap on a tile features it with its sound, a tap on the featured one mutes or unmutes it. Habitat decides what
// the band and the grid hold (its `wall` entities). The featured tile takes the page's one sound (view/camera.js `sound`). While an
// order is on its way (the band's `delivery`), its map (view/delivery-map.js) takes the featured place and that camera, still heard,
// leads the small tiles; it returns when the delivery ends.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Glyph} from '../glyphs.js';
import {clockText, shortDayText} from '../format.js';
import {wall} from '../house.js';
import {describeFailure} from '../failure.js';
import {StatusLink} from './page-state.js';
import {Drawer} from './drawer.js';
import {useActive, useHeard, useLive, useSound, useStill} from './camera.js';
import {DeliveryMap} from './delivery-map.js';

const html = htm.bind(h);

/** HA's mdi icon names (the band's chips, the weather card, the ticker's items) as Deck's glyphs; an unknown one by its family. */
const MDI = {
  'weather-night': 'moon', 'weather-sunny': 'sun', 'weather-partly-cloudy': 'partly-cloudy', 'weather-cloudy': 'cloud', 'weather-fog': 'fog',
  'weather-hail': 'snow', 'weather-snowy': 'snow', 'weather-snowy-rainy': 'snow', 'weather-lightning': 'storm', 'weather-lightning-rainy': 'storm',
  'weather-pouring': 'rain', 'weather-rainy': 'rain', 'weather-windy': 'wind', 'weather-windy-variant': 'wind', 'umbrella-outline': 'rain',
  'snowflake-thermometer': 'snow', 'sun-thermometer-outline': 'sun', 'alert-circle-outline': 'warn', alert: 'warn', 'alert-outline': 'warn',
  'alert-octagon': 'warn', 'cloud-off-outline': 'offline', 'account-alert-outline': 'person', 'package-variant-closed': 'order',
  'moped-outline': 'delivery', 'car-clock': 'car', recycle: 'recycle', 'trash-can-outline': 'trash', car: 'car', 'power-plug': 'plug',
  'gas-station': 'fuel', 'battery-alert-variant-outline': 'battery', 'baby-carriage': 'stroller', 'washing-machine-alert': 'washer',
  'newspaper-variant-outline': 'news', calendar: 'day', 'checkbox-blank-circle-outline': 'todo', 'format-list-bulleted': 'list',
  bullhorn: 'announce', 'bullhorn-outline': 'announce', zigbee: 'link',
};
export const mdiGlyph = icon => {
  const name = String(icon ?? '').replace(/^mdi:/, '');
  return MDI[name] ?? (name.startsWith('weather-') ? 'cloud' : name.startsWith('calendar') ? 'day' : name.startsWith('alert') ? 'warn' : 'details');
};
/** Mushroom's colour names as the band's tones (house-wall.css `.tone-*`, from the theme's own tokens). */
const TONES = new Set(['red', 'amber', 'orange', 'purple', 'blue', 'green', 'teal', 'grey']);
const tone = color => `tone-${TONES.has(color) ? color : 'grey'}`;

/** One of the band's items: a glyph in its tone over nothing, its value over its context (the weather card's shape). */
function BandItem({item, kind, secondary = item.secondary}) {
  return html`<div class=${`dh-band-item ${kind ?? ''} ${tone(item.color)}`} data-id=${item.id ?? item.entity_id}>
    <${Glyph} name=${mdiGlyph(item.icon)} size=${30} />
    <span class="dh-band-text"><b>${item.primary}</b>${secondary ? html`<span>${secondary}</span>` : null}</span>
  </div>`;
}

/** How many of the chips (`widths`, in Habitat's order: the HA strip's priority) fit `room` whole, leaving room for the `+N` chip
 *  (`more` wide) when some do not: [shown, hidden]. */
export function fitChips(widths, room, more) {
  const total = widths.reduce((a, b) => a + b, 0);
  if (total <= room) return [widths.length, 0];
  let n = 0, used = 0;
  while (n < widths.length && used + widths[n] + more <= room) used += widths[n++];
  return [n, widths.length - n];
}

/** The band's chips: as many as fit whole in priority order, then `+N` for the rest, which opens them in a sheet. Each chip and the
 *  `+N` are measured off screen (a hidden copy), so what shows never shifts while it is measured. */
function Chips({chips, band}) {
  const measure = useRef(null), [shown, setShown] = useState(chips.length), [open, setOpen] = useState(false);
  const key = chips.map(c => `${c.id}:${c.primary}:${c.secondary}`).join('|');
  useLayoutEffect(() => {
    const fit = () => {
      const m = measure.current, b = band.current;
      if (!m || !b) return;
      const items = [...m.children], widths = items.slice(0, -1).map(li => li.getBoundingClientRect().width), more = items.at(-1).getBoundingClientRect().width;
      const style = getComputedStyle(b), others = [...b.children].filter(el => !el.matches('.dh-band-chips, .dh-band-ticker, .dh-band-measure, .dk-drawer-wrap'))
        .reduce((sum, el) => sum + el.getBoundingClientRect().width, 0);
      const room = b.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - others;
      setShown(fitChips(widths, room, more)[0]);
    };
    fit();
    let frame = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); });
    ro.observe(band.current);
    return () => { cancelAnimationFrame(frame); ro.disconnect(); };
  }, [key]);
  const hidden = chips.slice(shown);
  useEffect(() => { if (!hidden.length) setOpen(false); }, [hidden.length]);
  const item = c => html`<${BandItem} item=${c} kind="chip" />`;
  return html`
    <ul class="dh-band-measure" aria-hidden="true" ref=${measure}>${chips.map(c => html`<li key=${c.id}>${item(c)}</li>`)}<li><span class="dh-band-more">+${chips.length}</span></li></ul>
    ${shown || hidden.length ? html`<ul class="dh-band-chips" aria-label="Now">${chips.slice(0, shown).map(c => html`<li key=${c.id}>${item(c)}</li>`)}
      ${hidden.length ? html`<li><button type="button" class="dh-band-more" aria-label=${`${hidden.length} more`} aria-haspopup="dialog" onClick=${() => setOpen(true)}>+${hidden.length}</button></li>` : null}</ul>` : null}
    <${Drawer} open=${open && hidden.length > 0} title="More now" label="More now" onClose=${() => setOpen(false)}>
      <ul class="dh-band-sheet">${hidden.map(c => html`<li key=${c.id}>${item(c)}</li>`)}</ul>
    </${Drawer}>`;
}

/** The band: the clock, the weather and the date, each chip, the ticker. */
function Band({house, opts, now}) {
  const tz = opts.timeZone ? {timeZone: opts.timeZone} : {}, ref = useRef(null);
  const w = wall(house), day = shortDayText(now, tz);
  return html`<header class="dh-band" aria-label="House" ref=${ref}>
    <time class="dh-wall-clock" datetime=${new Date(now).toISOString()}>${clockText(now, tz)}</time>
    ${w.weather ? html`<${BandItem} item=${w.weather} kind="weather" secondary=${day} />`
      : html`<div class="dh-band-item weather tone-grey"><span class="dh-band-text"><b>${day}</b></span></div>`}
    ${w.chips.length ? html`<${Chips} chips=${w.chips} band=${ref} />` : null}
    ${w.ticker ? html`<div class="dh-band-ticker"><${BandItem} item=${w.ticker} kind="ticker" /></div>` : html`<div class="dh-band-ticker"></div>`}
    ${!house.live ? html`<span class="dh-live" role="status">${describeFailure('Habitat', {code: 'unreachable'}, {retryIn: 'up to 30 seconds'}).message}</span>` : null}
  </header>`;
}

/** Rows of three 16:9 columns as wide as the wall allows while the band keeps `BAND_MIN`; the band takes the rest (73 px of 800 on
 *  the Pixel tablet's 1280×800). Measured on the next frame after a resize, never inside the observer. */
export const BAND_MIN = 64, ROWS = 3, COLUMNS = 3;
export function wallGrid(width, height, gap) {
  let col = (width - (COLUMNS - 1) * gap) / COLUMNS, row = col * 9 / 16;
  const room = height - BAND_MIN - (ROWS - 1) * gap;
  if (row * ROWS > room) { row = Math.max(0, room / ROWS); col = row * 16 / 9; }
  return {col, row, grid: ROWS * row + (ROWS - 1) * gap};
}
function useWallGrid(ref) {
  const [g, setG] = useState(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const fit = () => {
      const gap = parseFloat(getComputedStyle(el).getPropertyValue('--wall-gap')) || 0;
      const next = wallGrid(el.clientWidth, el.clientHeight, gap);
      setG(o => o && Math.abs(o.col - next.col) < 0.5 && Math.abs(o.row - next.row) < 0.5 ? o : next);
    };
    fit();
    let frame = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); });
    ro.observe(el);
    return () => { cancelAnimationFrame(frame); ro.disconnect(); };
  }, []);
  return g;
}

/** One camera's tile: its live video while it plays, else its still; its name in the bottom-right corner unless the camera draws its own
 *  (`tile.osd`: an overlay would garble the camera's on-screen name). `audible`: this tile plays its camera's sound (the
 *  featured one, while the wall's sound is on); every other tile stays muted, so two streams never sound at once. A speaker
 *  chip on the featured tile says which, when its stream carries sound. `onBlocked`: the browser refused sound without a tap. */
function CameraTile({host, tile, place, onTap, audible = false, sound = null, onBlocked}) {
  const ref = useRef(null), video = useRef(null);
  const active = useActive(ref);
  const {state: live, audio: hasAudio} = useLive(host, tile.camera, video, {enabled: active});
  const {frame, message, failed} = useStill(host, tile.camera, ref, {title: tile.title, enabled: live !== 'live', key: tile.stream});
  const fit = tile.fit === 'contain' ? 'contain' : 'cover';
  const [mine, take, drop] = useSound();
  const wants = audible && tile.audio && live === 'live' && hasAudio;
  useEffect(() => { if (wants) take(); else drop(); }, [wants]);
  useHeard(video, wants && mine, onBlocked);
  const speaker = sound && tile.audio && live === 'live' && hasAudio;
  return html`<button type="button" class=${`dh-wall-tile ${place} fit-${fit}`} data-id=${tile.id} data-camera=${tile.camera} data-feed=${live === 'live' ? 'live' : frame ? 'still' : 'none'}
    data-sound=${speaker ? sound : null} ref=${ref} aria-label=${speaker ? `${tile.title}, sound ${sound === 'on' ? 'on' : 'off'}` : tile.title} onClick=${onTap}>
    <video ref=${video} class=${live === 'live' ? 'on' : ''} muted playsinline autoplay disablepictureinpicture aria-hidden="true"></video>
    ${live !== 'live' ? frame ? html`<img src=${frame} alt="" decoding="async" onError=${failed} />` : html`<span class="dh-wall-note" role="status">${message}</span>` : null}
    ${tile.osd ? null : html`<span class="dh-wall-caption"><b>${tile.title}</b></span>`}
    ${speaker ? html`<span class=${`dh-wall-sound ${sound}`} aria-hidden="true"><${Glyph} name=${sound === 'on' ? 'sound' : 'muted'} size=${20} />${sound === 'blocked' ? html`<span>Tap for sound</span>` : null}</span>` : null}
  </button>`;
}

/** The featured camera: a tapped tile's (the HA card's tap: select), else Habitat's; back to Habitat's after ten quiet minutes (its
 *  `interaction_seconds: 600`). The rest keep Habitat's order. Five tiles beside it: what fits the grid's first screen. While a
 *  delivery's map holds the featured place (`map`), that camera leads the grid's small tiles, one fewer. */
export const IDLE_MS = 10 * 60000, SHOWN = 1 + (ROWS * COLUMNS - 4);
export function arrange(cameras, chosen, {map = false} = {}) {
  const featured = cameras.find(c => c.id === chosen) ?? cameras[0];
  return featured ? [featured, ...cameras.filter(c => c !== featured)].slice(0, map ? SHOWN - 1 : SHOWN) : [];
}

function Wall({house, host, opts, now}) {
  const ref = useRef(null), g = useWallGrid(ref);
  const [chosen, setChosen] = useState(null), [touch, setTouch] = useState(0);
  // the wall's sound: on (the featured tile heard), off (muted by a tap on it), blocked (the browser wants a tap first)
  const [sound, setSound] = useState('on');
  const {cameras, delivery} = wall(house);
  useEffect(() => { if (!chosen) return undefined; const t = setTimeout(() => setChosen(null), IDLE_MS); return () => clearTimeout(t); }, [chosen, touch]);
  // a browser that refuses sound until a tap: the first tap anywhere turns it on
  useEffect(() => {
    if (sound !== 'blocked') return undefined;
    const on = () => setSound('on');
    addEventListener('pointerdown', on, {once: true, capture: true});
    return () => removeEventListener('pointerdown', on, {capture: true});
  }, [sound]);
  const shown = arrange(cameras, chosen, {map: !!delivery}), featured = shown[0];
  const tap = tile => {
    setTouch(n => n + 1);
    if (tile.id !== featured?.id) { setChosen(tile.id); setSound('on'); }
    else if (tile.audio) setSound(s => s === 'off' ? 'on' : s === 'on' ? 'off' : 'on');
  };
  return html`<div class="dh-wall" ref=${ref} style=${g ? `--wall-col: ${g.col}px; --wall-row: ${g.row}px; --wall-grid: ${g.grid}px` : null}>
    <${Band} house=${house} opts=${opts} now=${now} />
    <section class="dh-wall-grid" aria-label="Cameras">
      ${g && delivery ? html`<${DeliveryMap} key="delivery" delivery=${delivery} timeZone=${opts.timeZone} />` : null}
      ${g ? shown.map((tile, i) => html`<${CameraTile} key=${tile.id} host=${host} tile=${tile} place=${i === 0 && !delivery ? 'featured' : 'tile'}
        audible=${i === 0 && sound === 'on'} sound=${i === 0 ? sound : null} onBlocked=${() => setSound('blocked')} onTap=${() => tap(tile)} />`) : null}
      ${g && !cameras.length ? html`<p class="dh-wall-empty" role="status">Waiting for Habitat’s cameras<${StatusLink} host=${host} /></p>` : null}
    </section>
  </div>`;
}

/** The camera wall (`wall`). */
export const HouseWall = props => html`<${Wall} ...${props} />`;

import {formatQuantity} from '../quantity.js';
import {dateRange, dateText, isoDay, timeText, weekdayText} from '../format.js';
// A chart of one measure over periods (contract/chart.md, *Chart*): any backend's data in one shape (bridge's utility usage; purser's
// spending by month). Two panels on one time axis, never two scales on one: the measure as bars (and `extra` series as lines, same
// unit) above, `cost` as a line below when any point has one. Points of several `parts` (a topic's accounts) stack, a colour each. A
// period with no point is a gap (hatched, "No bill"). `stats` (contract/chart.md, *Chart*) show above it as tiles and below as a year
// table. Plain SVG, sized to its box (a ResizeObserver), colours from tokens.css; hover or a tap shows a period's values under the plot, a mouse click
// (or the tooltip's Open) hands the point's `ref` to `onOpen`; a hidden table carries the same numbers for screen readers.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {RANGES, RANGE_NAMES, domainOf, fromHabitat, momentText, panelsOf, rangeBounds, readingsAt, segmentsOf, seriesQuery, seriesSummary, timeTicks, valueText} from '../series.js';
import {Failure, Skeleton} from './page-state.js';

const html = htm.bind(h);
const TOP = 150, BOTTOM = 64, GAP = 18, AXIS = 30, LEFT = 52, RIGHT = 10, PAD = 24;

const monthly = p => /^\d{4}-\d{2}$/.test(p);
const grainOf = p => /^\d{4}$/.test(p) ? 'year' : monthly(p) ? 'month' : /^\d{4}-\d{2}-\d{2}$/.test(p) ? 'day' : 'hour';
const index = (p, grain) => grain === 'month' ? +p.slice(0, 4) * 12 + +p.slice(5, 7) - 1
  : grain === 'year' ? +p : Date.parse(`${p}${grain === 'day' ? 'T00:00:00Z' : ':00:00Z'}`) / (grain === 'day' ? 86400000 : 3600000);
const ofIndex = (n, grain) => grain === 'month' ? `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`
  : grain === 'year' ? String(n) : new Date(n * (grain === 'day' ? 86400000 : 3600000)).toISOString().slice(0, grain === 'day' ? 10 : 13);

// an hourly period (a UTC hour, contract/chart.md) shown in the house's zone with Deck's formatters (format.js): "Thu 4 AM"
const hourAt = p => Date.parse(`${p}:00:00Z`);
const hourText = (p, timeZone) => timeText(hourAt(p), {timeZone, compact: true});
const dayText = (p, timeZone) => dateText(hourAt(p), {timeZone, now: hourAt(p)});
const midnight = (p, timeZone) => isoDay(hourAt(p), {timeZone}) !== isoDay(hourAt(p) - 3600000, {timeZone});

/** Calendar periods as words; an hourly period in `timeZone` (default: the browser's), never UTC: `Thu 4 AM`. */
export const periodLabel = (p, timeZone) => grainOf(p) === 'hour' ? `${weekdayText(hourAt(p), {timeZone})} ${hourText(p, timeZone)}` : dateText(p);

/** An hourly axis's labels in `timeZone`: the hour (`10 PM`), and the day under the first bin and under each local midnight. */
export const hourLabel = (p, first, timeZone) => ({hour: hourText(p, timeZone), day: first || midnight(p, timeZone) ? dayText(p, timeZone) : null});

/** A number in a unit: `1,062 kWh`, `$264.67` (costUnit USD), `−530 kWh`. */
export function amount(v, unit) {
  if (v == null || !Number.isFinite(v)) return '–';
  return formatQuantity(unit === 'USD' ? {value: v, format: 'currency'} : {value: v, unit});
}
const short = (v, unit) => {
  const abs = Math.abs(v), sign = v < 0 ? '−' : '', cur = unit === 'USD' ? '$' : '';
  const n = abs >= 1e6 ? `${+(abs / 1e6).toFixed(1)}M` : abs >= 1e4 ? `${+(abs / 1e3).toFixed(0)}k` : abs >= 1e3 ? `${+(abs / 1e3).toFixed(1)}k` : `${+abs.toFixed(abs < 10 ? 1 : 0)}`;
  return `${sign}${cur}${n}`;
};

/** A unit's cost as people read it: `18.2¢/kWh`, `$3.10/gal`, `$5.20/1,000 gal`. */
export function rateText(v, unit) {
  if (v == null || !Number.isFinite(v)) return '–';
  if (unit?.startsWith('¢')) return `${formatQuantity({value: v, precision: 1})}${unit}`;
  if (unit?.startsWith('$')) return `${formatQuantity({value: v, format: 'currency'})}${unit.slice(1)}`;
  return `${v} ${unit ?? ''}`.trim();
}
/** Money in whole dollars (the stats' totals): `$1,234`; else as amount. */
const whole = (v, unit) => (unit === 'USD' && v != null && Number.isFinite(v)
  ? formatQuantity({value: v, format: 'currency', precision: 0}) : amount(v, unit));
/** A change in percent: `▲ 12%`, `▼ 3%`, `0%`; null when none. */
export const changeText = pct => (pct == null ? null : `${pct > 0 ? '▲ ' : pct < 0 ? '▼ ' : ''}${formatQuantity({value: Math.abs(pct), format: 'percent', precision: Math.abs(pct) < 10 && !Number.isInteger(Math.round(Math.abs(pct) * 10) / 10) ? 1 : 0})}`);

/** The points of each period (several when parts stack), and each period's stacked sums above and below zero. */
export function stacks(points) {
  const by = new Map();
  for (const p of points ?? []) (by.get(p.period) ?? by.set(p.period, []).get(p.period)).push(p);
  const sums = new Map([...by].map(([k, ps]) => [k, {pos: ps.reduce((n, p) => n + Math.max(0, p.value ?? 0), 0), neg: ps.reduce((n, p) => n + Math.min(0, p.value ?? 0), 0)}]));
  return {by, sums};
}

/** Round ticks covering [lo, hi] (0 among them when the range holds it): about `n`. */
export function ticks(lo, hi, n = 3) {
  if (lo === hi) { hi = lo + 1; }
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const out = [];
  for (let t = Math.floor(lo / step) * step; t <= hi + step * 1e-9; t += step) out.push(+t.toFixed(10));
  if (out.at(-1) < hi) out.push(+(out.at(-1) + step).toFixed(10));
  return out;
}

// A month needs this many px to read as a bar; a run of empty months this long splits old records from the recent ones.
const MIN_BIN = 14, BREAK = 12;

/** The months a monthly chart draws (no DOM; tested): the latest run after the last long empty stretch with fewer records before it than
 *  after (one 2016 bill does not stretch the axis over ten years), and no more months than fit the width; `full` draws them all. */
export function monthWindow(indices, plotW, full = false) {
  const idx = [...new Set(indices)].sort((a, b) => a - b), last = idx.at(-1);
  if (full) return idx[0];
  let start = idx[0];
  for (let k = idx.length - 2; k >= 0; k -= 1) {
    if (idx[k + 1] - idx[k] - 1 >= BREAK && k + 1 < idx.length - k - 1) { start = idx[k + 1]; break; }
  }
  return Math.max(start, last - Math.max(12, Math.floor(plotW / MIN_BIN)) + 1);
}

/** The chart's bins and scales (no DOM; tested): a bin per period from the first to the last of points, gaps and extra (months:
 *  `monthWindow`'s), scales over what is drawn; `hidden` the earlier periods with records it leaves out. */
export function layout(data, width, {full = false} = {}) {
  const points = data.points ?? [], gaps = data.gaps ?? [], extra = data.extra ?? [];
  const all = [...points.map(p => p.period), ...gaps, ...extra.flatMap(x => x.points.map(p => p.period))].filter(Boolean);
  if (!all.length) return null;
  const grain = grainOf(all[0]);
  const plotW = Math.max(40, width - LEFT - RIGHT);
  const indices = all.map(p => index(p, grain)), last = Math.max(...indices);
  const first = grain === 'month' ? monthWindow(indices, plotW, full) : Math.min(...indices);
  const periods = [];
  for (let n = first; n <= last; n += 1) periods.push(ofIndex(n, grain));
  const bin = plotW / periods.length;
  const x = i => LEFT + bin * (i + 0.5);
  const at = new Map(periods.map((p, i) => [p, i]));
  const shown = p => at.has(p.period);
  const earlier = [...new Set([...points, ...extra.flatMap(s => s.points)].filter(p => p.period && !shown(p)).map(p => p.period))].sort();
  const hidden = earlier.length ? {count: earlier.length, from: earlier[0], to: earlier.at(-1)} : null;
  const {sums} = stacks(points.filter(shown));
  const values = [...[...sums.values()].flatMap(v => [v.pos, v.neg]), ...extra.flatMap(s => s.points.filter(shown).map(p => p.value))].filter(v => v != null && Number.isFinite(v));
  // `zero: false` (a temperature): the axis spans the readings, not zero, its floor below the lowest so that bar still shows
  const readings = [...points, ...extra.flatMap(s => s.points)].filter(shown).map(p => p.value).filter(v => v != null && Number.isFinite(v));
  const lo = Math.min(...readings), hi = Math.max(...readings);
  const yt = data.zero === false && readings.length ? ticks(lo - Math.max(1, (hi - lo) / 10), hi, 4) : ticks(Math.min(0, ...values), Math.max(0, ...values, 1));
  const y = v => PAD + (TOP - PAD) * (1 - (v - yt[0]) / (yt.at(-1) - yt[0]));
  const costOf = new Map();
  for (const p of points) if (shown(p) && p.cost != null && Number.isFinite(p.cost)) costOf.set(p.period, (costOf.get(p.period) ?? 0) + p.cost);
  const costs = [...costOf.values()];
  const ct = costs.length ? ticks(Math.min(0, ...costs), Math.max(0, ...costs, 1), 2) : null;
  const top2 = TOP + GAP + AXIS;
  const cy = ct ? v => top2 + PAD + (BOTTOM - PAD) * (1 - (v - ct[0]) / (ct.at(-1) - ct[0])) : null;
  const height = ct ? top2 + BOTTOM + 6 : TOP + AXIS;
  // x labels: every k-th bin so each has ~34 px; a year under its January (or the first bin); bins too thin for months: years alone,
  // every k-th of them
  const every = Math.max(1, Math.ceil((grain === 'day' || grain === 'hour' ? 52 : 34) / bin));
  const yearsOnly = grain === 'month' && every > 3, yearEvery = Math.max(1, Math.ceil(34 / (bin * 12)));
  return {grain, periods, at, bin, x, y, yt, cy, ct, height, width, every, yearsOnly, yearEvery, plotW, top2, costOf, hidden,
    labels: grain === 'month' && !yearsOnly ? monthLabels(periods, every, bin) : null};
}

/** Which months carry a label (index: with its year?): every Januaries (a year starts there), then every `every`-th bin that keeps
 *  `every` bins from each label; the first bin's year only when no January's is within a year label's width. */
function monthLabels(periods, every, bin) {
  const out = new Map(), jan = periods.flatMap((p, i) => (p.endsWith('-01') ? [i] : []));
  if (every <= 3) for (const i of jan) out.set(i, true);
  for (let i = 0; i < periods.length; i += every) {
    if ([...out.keys()].every(j => Math.abs(j - i) >= every)) out.set(i, periods[i].endsWith('-01'));
  }
  if (out.has(0) && !out.get(0)) out.set(0, !jan.some(j => j > 0 && j * bin < 40));
  return out;
}

const barPath = (x, w, y0, y1) => {
  const up = y1 < y0, hgt = Math.abs(y1 - y0), r = Math.min(4, w / 2, hgt);
  if (hgt < 0.5) return '';
  return up
    ? `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`
    : `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
};
const linePath = pts => pts.map(([px, py], i) => `${i && pts[i - 1] ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
// a line broken where a period has no value
const segments = (L, pts, yOf) => {
  const out = [];
  let cur = [];
  for (const p of L.periods) {
    const v = pts.get(p);
    if (v == null) { if (cur.length) out.push(cur); cur = []; continue; }
    cur.push([L.x(L.at.get(p)), yOf(v), p]);
  }
  if (cur.length) out.push(cur);
  return out;
};

/** The box's width, kept as it resizes: measured on the next frame, never inside the observer (a re-render there changes the layout
 *  it observes: WebKit's loop error). */
export function useBoxWidth(box, setWidth) {
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    setWidth(el.clientWidth);
    let frame = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setWidth(el.clientWidth)); });
    ro.observe(el);
    return () => { cancelAnimationFrame(frame); ro.disconnect(); };
  }, []);
}

/** data: the chart's shape (contract/chart.md, *Chart*); onOpen(ref): a point's thing opened; label: what the chart is of (its aria label);
 *  readout: 'below' (the plot; the page grows) or 'legend' (over the legend line, the figure's height fixed: a kiosk's board);
 *  timeZone: the zone hourly periods read in (the house's), default the browser's. */
export function Chart({data, onOpen = null, label = '', readout = 'below', timeZone}) {
  const box = useRef(null);
  const [width, setWidth] = useState(0);
  const [focus, setFocus] = useState(null); // the period the readout shows
  const [full, setFull] = useState(false); // every month, not only the recent window
  useBoxWidth(box, setWidth);
  const recent = width ? layout(data, width) : null;
  const L = recent && full && recent.hidden ? layout(data, width, {full: true}) : recent;
  const {by: byPeriod} = stacks(data.points);
  const parts = data.parts ?? null;
  const partName = p => (parts && p.part != null ? parts[p.part]?.name ?? '' : '');
  const partClass = p => (parts && p.part != null ? ` dc-p${p.part % 11}` : '');
  const gaps = new Set(data.gaps ?? []);
  const unit = data.unit ?? '', costUnit = data.costUnit ?? 'USD';
  const extra = (data.extra ?? []).slice(0, 2);
  const shown = p => !L || L.at.has(p);
  // a bill with a cost and no usage (a maintenance invoice): its cost dot hollow, said so in the legend and the readout
  const costOnly = p => { const pts = byPeriod.get(p) ?? []; return pts.length > 0 && pts.every(pt => pt.value == null) && pts.some(pt => pt.cost != null); };
  const open = ref => { if (ref != null && onOpen) onOpen(ref); };
  const refsAt = p => (byPeriod.get(p) ?? []).filter(pt => pt.ref != null);
  const pick = (ev, p) => {
    const refs = refsAt(p);
    if ((ev.pointerType === 'mouse' || ev.pointerType === undefined) && refs.length === 1) return open(refs[0].ref);
    setFocus(p);
  };
  const at = focus != null && L?.at.has(focus) ? focus : null;

  let svg = null, tip = null;
  if (L) {
    const bw = Math.max(2, Math.min(28, L.bin * 0.68 - 2));
    const bars = L.periods.flatMap((p, i) => {
      let up = 0, down = 0;
      return (byPeriod.get(p) ?? []).filter(pt => pt.value != null).map((pt, k) => {
        const from = data.zero === false ? L.yt[0] : pt.value < 0 ? down : up, to = data.zero === false ? pt.value : from + pt.value;
        if (pt.value < 0) down = to; else up = to;
        const d = barPath(L.x(i) - bw / 2, bw, L.y(from), L.y(to));
        return d ? html`<path key=${`b${p}-${k}`} class=${`dc-bar${partClass(pt)}${at === p ? ' on' : ''}${pt.value < 0 && data.zero !== false ? ' neg' : ''}`} d=${d} />` : null;
      });
    });
    const hatch = L.periods.map((p, i) => (gaps.has(p) && !byPeriod.has(p) ? html`<rect key=${`g${p}`} class="dc-gap" x=${L.x(i) - L.bin / 2 + 1} y=${PAD} width=${Math.max(1, L.bin - 2)}
      height=${(L.cy ? L.top2 + BOTTOM : TOP) - PAD} />` : null));
    const lines = extra.map((s, k) => segments(L, new Map(s.points.map(x => [x.period, x.value])), L.y).map((seg, j) => html`<g key=${`x${k}-${j}`}>
      <path class=${`dc-line dc-x${k}`} d=${linePath(seg)} />
      ${seg.map(([px, py], m) => html`<circle key=${m} class=${`dc-dot dc-x${k}`} cx=${px} cy=${py} r="2.5" />`)}</g>`));
    const cost = L.cy ? segments(L, L.costOf, L.cy) : [];
    const yAxis = L.yt.map(t => html`<g key=${`y${t}`}><line class=${t === 0 ? 'dc-zero' : 'dc-grid'} x1=${LEFT} x2=${L.width - RIGHT} y1=${L.y(t)} y2=${L.y(t)} />
      <text class="dc-tick" x=${LEFT - 6} y=${L.y(t) + 4} text-anchor="end">${short(t, unit)}</text></g>`);
    const cAxis = L.ct ? L.ct.map(t => html`<g key=${`c${t}`}><line class=${t === 0 ? 'dc-zero' : 'dc-grid'} x1=${LEFT} x2=${L.width - RIGHT} y1=${L.cy(t)} y2=${L.cy(t)} />
      <text class="dc-tick" x=${LEFT - 6} y=${L.cy(t) + 4} text-anchor="end">${short(t, costUnit)}</text></g>`) : null;
    const xAxis = L.periods.map((p, i) => {
      if (L.yearsOnly) {
        // the first bin's year only when its January is not right after it
        const jan = L.periods.findIndex(x => x.endsWith('-01'));
        if (!(p.endsWith('-01') || (i === 0 && (jan < 0 || jan * L.bin >= 40))) || (+p.slice(0, 4) % L.yearEvery && i)) return null;
        return html`<g key=${`t${p}`}><text class="dc-tick dc-year" x=${L.x(i)} y=${TOP + 14} text-anchor=${i === 0 ? 'start' : 'middle'}>${p.slice(0, 4)}</text></g>`;
      }
      if (L.labels ? !L.labels.has(i) : i % L.every) return null;
      const hl = L.grain === 'hour' ? hourLabel(p, i === 0, timeZone) : null;
      const m = L.grain === 'month' || L.grain === 'day' ? dateText(p, {now: p.slice(0, 4)}) : hl ? hl.hour : p;
      const year = L.grain === 'month' && L.labels.get(i) ? p.slice(0, 4)
        : L.grain === 'day' && (i === 0 || p.endsWith('-01-01')) ? p.slice(0, 4) : hl ? hl.day : null;
      return html`<g key=${`t${p}`}><text class="dc-tick" x=${L.x(i)} y=${TOP + 14} text-anchor="middle">${L.every > 2 && L.grain === 'month' ? m.slice(0, 1) : m}</text>
        ${year ? html`<text class="dc-tick dc-year" x=${L.x(i)} y=${TOP + 26} text-anchor="middle">${year}</text>` : null}</g>`;
    });
    const hits = L.periods.map((p, i) => html`<rect key=${`h${p}`} class="dc-hit" x=${L.x(i) - L.bin / 2} y="0" width=${L.bin} height=${L.height}
      data-period=${p} onPointerEnter=${ev => { if (ev.pointerType === 'mouse') setFocus(p); }}
      onClick=${ev => pick(ev, p)} style=${refsAt(p).length && onOpen ? 'cursor:pointer' : null} />`);
    const fx = at != null ? L.x(L.at.get(at)) : null;
    svg = html`<svg class="dc-svg" width=${L.width} height=${L.height} viewBox=${`0 0 ${L.width} ${L.height}`} aria-hidden="true" focusable="false">
      <defs><pattern id="dc-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line class="dc-hatchline" x1="0" y1="0" x2="0" y2="6" /></pattern></defs>
      ${data.zero === false ? null : html`<text class="dc-unit" x="2" y="10">${unit}</text>`}
      ${L.cy ? html`<text class="dc-unit" x="2" y=${L.top2 + 2}>${costUnit === 'USD' ? 'Cost' : costUnit}</text>` : null}
      ${hatch}${yAxis}${cAxis}
      ${fx != null ? html`<line class="dc-cross" x1=${fx} x2=${fx} y1=${PAD} y2=${L.cy ? L.top2 + BOTTOM : TOP} />` : null}
      ${bars}${lines}
      ${cost.map((seg, j) => html`<g key=${`k${j}`}><path class="dc-line dc-cost" d=${linePath(seg)} />
        ${seg.map(([px, py, p], m) => html`<circle key=${m} class=${`dc-dot dc-cost${costOnly(p) ? ' dc-only' : ''}`} data-period=${p} cx=${px} cy=${py} r=${costOnly(p) ? 3.5 : 2.5} />`)}</g>`)}
      ${xAxis}${hits}
    </svg>`;
    if (at != null) {
      // under the plot, never over it: every month stays visible, names and filenames whole
      const pts = byPeriod.get(at) ?? [], one = pts.length === 1 ? pts[0] : null;
      const dates = one?.end ? dateRange(one.start ?? one.end, one.end) : null;
      const xs = extra.map((s, k) => ({k, name: s.name, unit: s.unit, ...s.points.find(x => x.period === at)})).filter(x => x.value != null);
      const row = (pt, k) => html`<div class="dc-tiprow" key=${`p${k}`}>
        ${parts ? html`<span class="dc-tipname"><span class=${`dc-key dc-k-bar${partClass(pt)}`}></span>${partName(pt)}</span>` : null}
        <span class="dc-tipval">${parts ? null : html`<span class="dc-key dc-k-bar"></span>`}${data.valueName ?? 'Usage'} <b>${pt.value == null ? 'not read' : amount(pt.value, pt.unit ?? unit)}</b></span>
        ${pt.cost != null ? html`<span class="dc-tipval">${parts ? null : html`<span class=${`dc-key dc-k-cost${pt.value == null ? ' dc-only' : ''}`}></span>`}${data.costName ?? 'Cost'} <b>${amount(pt.cost, costUnit)}</b></span>` : null}
        ${pt.rate != null && data.rateUnit ? html`<span class="dc-tipval">${data.rateUnit} <b>${rateText(pt.rate, data.rateUnit)}</b></span>` : null}</div>`;
      const refs = onOpen ? pts.filter(pt => pt.ref != null) : [];
      tip = html`<div class=${`dc-tip${readout === 'legend' ? ' dc-over' : ''}`} role="status" data-period=${at}>
        <div class="dc-tiphead"><b>${periodLabel(at, timeZone)}</b>${dates ? html`<span class="dc-dates">${dates}</span>` : null}</div>
        ${gaps.has(at) && !pts.length ? html`<div class="dc-tiprow">No bill</div>` : null}
        ${pts.map(row)}
        ${xs.length ? html`<div class="dc-tiprow">${xs.map(x => html`<span class="dc-tipval" key=${x.k}><span class=${`dc-key dc-k-x${x.k}`}></span>${x.name} <b>${amount(x.value, x.unit)}${x.partial ? ' (part)' : ''}</b></span>`)}</div>` : null}
        ${refs.length ? html`<div class="dc-opens">${refs.map((pt, k) => html`<button type="button" key=${`o${k}`} class="dk-btn dc-open" data-variant="quiet" onClick=${() => open(pt.ref)}>Open${pt.label ? html` <span class="dc-openlabel">${pt.label}</span>` : ''} ›</button>`)}</div>` : null}
      </div>`;
    }
  }
  const visible = (data.points ?? []).filter(p => shown(p.period));
  const used = new Set(visible.filter(p => p.value != null).map(p => p.part));
  const legend = html`<div class="dc-legend" aria-hidden="true">
    ${parts ? parts.map((pt, k) => (used.has(k) ? html`<span key=${`p${k}`} class="dc-legpart" title=${pt.name}><span class=${`dc-key dc-k-bar dc-p${k % 11}`}></span><span class="dc-legname">${pt.name}</span></span>` : null))
      : html`<span><span class="dc-key dc-k-bar"></span>${data.valueName ?? 'Usage'}${unit ? ` (${unit})` : ''}</span>`}
    ${visible.some(p => p.cost != null) ? html`<span><span class="dc-key dc-k-cost"></span>${data.costName ?? 'Cost'}</span>` : null}
    ${[...new Set(visible.map(p => p.period))].some(costOnly) ? html`<span data-legend="cost-only"><span class="dc-key dc-k-cost dc-only"></span>${data.costName ?? 'Cost'}, no ${(data.valueName ?? 'usage').toLowerCase()} read</span>` : null}
    ${extra.map((s, k) => (s.points.some(p => p.value != null && shown(p.period)) ? html`<span key=${k}><span class=${`dc-key dc-k-x${k}`}></span>${s.name}</span>` : null))}
    ${[...gaps].some(shown) ? html`<span><span class="dc-key dc-k-gap"></span>No bill</span>` : null}
  </div>`;
  const earlier = recent?.hidden;
  const windowNote = earlier ? html`<div class="dc-window">
    <span>${full ? `All months since ${periodLabel(L.periods[0])}`
      : `${earlier.count} earlier ${earlier.count === 1 ? 'month' : 'months'} not drawn (${earlier.from === earlier.to ? periodLabel(earlier.from) : `${periodLabel(earlier.from)}–${periodLabel(earlier.to)}`})`}</span>
    <button type="button" class="dk-btn dc-full" data-variant="quiet" aria-pressed=${full ? 'true' : 'false'} onClick=${() => setFull(f => !f)}>${full ? 'Show recent' : 'Show all'}</button></div>` : null;
  const rows = [...new Set([...(L?.periods ?? []), ...byPeriod.keys()])].sort();
  return html`<figure class="dc" aria-label=${label || data.title || 'Chart'} data-chart=${data.title ?? ''}>
    ${data.stats ? html`<${Tiles} data=${data} onOpen=${onOpen} />` : null}
    ${readout === 'legend' ? html`<div class="dc-top">${legend}${tip}</div>` : legend}
    <div class="dc-box" ref=${box}>${svg}</div>
    ${windowNote}${readout === 'legend' ? null : tip}
    ${data.stats ? html`<${Years} data=${data} />` : null}
    <div class="dk-sr"><table><caption>${label || data.title || ''}</caption>
      <thead><tr><th>Period</th>${parts ? html`<th>Account</th>` : null}<th>${data.valueName ?? 'Usage'}</th><th>${data.costName ?? 'Cost'}</th>${extra.map((s, k) => html`<th key=${k}>${s.name}</th>`)}</tr></thead>
      <tbody>${rows.flatMap(p => {
        const pts = byPeriod.get(p) ?? [null];
        return pts.map((pt, k) => html`<tr key=${`${p}-${k}`}><td>${periodLabel(p, timeZone)}</td>${parts ? html`<td>${pt ? partName(pt) : ''}</td>` : null}
          <td>${pt ? amount(pt.value, pt.unit ?? unit) : gaps.has(p) ? 'No bill' : '–'}</td>
          <td>${pt?.cost != null ? amount(pt.cost, costUnit) : '–'}</td>${extra.map((s, j) => html`<td key=${j}>${k ? '' : amount(s.points.find(x => x.period === p)?.value, s.unit)}</td>`)}</tr>`);
      })}</tbody></table></div>
  </figure>`;
}

const PER = {month: 'A month', delivery: 'A delivery', invoice: 'An invoice'};
const COUNTED = {delivery: ['delivery', 'deliveries'], invoice: ['invoice', 'invoices']};

/** The stats' tiles over the chart (contract/chart.md, *Chart*: `stats`): the last 12 months against the 12 before, the average a month,
 *  delivery or invoice, the cost of a unit, the highest and lowest period (its usage, else its cost; a click opens its bill), gaps
 *  (none counted: no tile), the house's meter. */
function Tiles({data, onOpen}) {
  const s = data.stats, unit = data.valueName === 'Cost' ? null : data.unit, costUnit = data.costUnit ?? 'USD';
  const pair = (v, c) => [unit && v != null ? whole(v, unit) : null, c != null ? whole(c, costUnit) : null].filter(Boolean).join(' · ') || '–';
  const l = s.last12, ch = l?.change;
  const vs = ch ? [unit && changeText(ch.value) ? `${changeText(ch.value)} ${unit}` : null, changeText(ch.cost) ? `${changeText(ch.cost)} cost` : null].filter(Boolean).join(' · ') : null;
  const tiles = [
    l ? {key: 'last12', label: 'Last 12 months', value: pair(l.value, l.cost), sub: vs ? `${vs} vs the 12 before` : 'no 12 months before', title: `${periodLabel(l.from)}–${periodLabel(l.to)}`} : null,
    s.average ? {key: 'average', label: PER[s.average.per] ?? 'A month', value: pair(s.average.value, s.average.cost), sub: 'on average'} : null,
    s.rate ? {key: 'rate', label: s.rate.basis && s.rate.basis !== 'usage' ? `${s.rate.unit} from grid` : s.rate.unit, value: rateText(s.rate.value, s.rate.unit),
      sub: s.rate.latest ? `${periodLabel(s.rate.latest.period)}: ${rateText(s.rate.latest.value, s.rate.unit)}` : ''} : null,
    s.high ? {key: 'high', label: 'Highest · lowest', value: `${periodLabel(s.high.period)} ${whole(s.high.value, unit ?? costUnit)}`,
      sub: s.low ? `${periodLabel(s.low.period)} ${whole(s.low.value, unit ?? costUnit)}` : '', ref: s.high.ref} : null,
    s.gaps != null ? {key: 'gaps', label: 'Missing bills', value: s.gaps ? String(s.gaps) : 'None', sub: s.gaps ? 'hatched on the chart' : 'a bill every month'} : null,
    // the unit in the label, so the value stays one line: "8,400 in · 6,900 out", wrapping only between its two numbers
    s.meter?.last12 ? {key: 'meter', label: 'Grid kWh, last 12 months', value: html`<span class="dc-nb">${whole(s.meter.last12.import)} in</span> · <span class="dc-nb">${whole(s.meter.last12.export)} out</span>`,
      sub: `net ${whole(s.meter.last12.net, 'kWh')}${s.meter.last12.partial ? ' (part)' : ''}`} : null,
  ].filter(Boolean);
  return html`<div class="dc-stats" data-stats=${tiles.map(t => t.key).join(' ')} data-n=${tiles.length}>${tiles.map(t => html`<div class="dc-tile" key=${t.key} data-tile=${t.key} title=${t.title ?? null}>
    <span class="dc-tlabel">${t.label}</span>
    ${t.ref != null && onOpen ? html`<button type="button" class="dc-tvalue dc-tlink" onClick=${() => onOpen(t.ref)}>${t.value}<span class="dc-tgo" aria-hidden="true"> ›</span></button>` : html`<b class="dc-tvalue">${t.value}</b>`}
    ${t.sub ? html`<span class="dc-tsub">${t.sub}</span>` : null}</div>`)}</div>`;
}

/** The stats' calendar years under the chart: usage, cost, the cost of a unit, the meter's import, export and net; a year the bills
 *  cover only part of says how many months. */
function Years({data}) {
  const s = data.stats, unit = data.valueName === 'Cost' ? null : data.unit, costUnit = data.costUnit ?? 'USD';
  const meter = new Map((s.meter?.years ?? []).map(y => [y.year, y]));
  const years = [...new Set([...(s.years ?? []).map(y => y.year), ...meter.keys()])].sort().reverse();
  if (!years.length) return null;
  const by = new Map((s.years ?? []).map(y => [y.year, y]));
  const rate = !!s.rate;
  const head = [unit ? data.valueName ?? 'Usage' : null, data.costName ?? 'Cost', rate ? s.rate.unit : null, ...(meter.size ? ['Import', 'Export', 'Net'] : [])].filter(Boolean);
  return html`<div class="dc-years" data-cols=${head.length}><table>
    <thead><tr><th>Year</th>${head.map(c => html`<th key=${c}>${c}</th>`)}</tr></thead>
    <tbody>${years.map(y => {
      const r = by.get(y), m = meter.get(y);
      const part = r?.months != null && r.months < 12 ? `${r.months} mo` : r && r.months == null
        ? (COUNTED[s.average?.per] ? `${r.count} ${COUNTED[s.average.per][r.count === 1 ? 0 : 1]}` : `${r.count}×`) : null;
      return html`<tr key=${y}><th scope="row">${y}${part ? html` <span class="dc-part">${part}</span>` : null}</th>
        ${[unit ? (r?.value != null ? whole(r.value, unit) : '–') : null, r?.cost != null ? whole(r.cost, costUnit) : '–', rate ? rateText(r?.rate, s.rate.unit) : null,
          ...(meter.size ? [m ? whole(m.import, 'kWh') : '–', m ? whole(m.export, 'kWh') : '–', m ? whole(m.net, 'kWh') : '–'] : [])].filter(v => v != null)
          .map((v, k) => html`<td key=${k} data-label=${head[k]}>${v}</td>`)}</tr>`;
    })}</tbody></table></div>`;
}

// The time series (contract/media.md *Time series*): measures over continuous time, a panel per unit on one time axis, lines broken at
// gaps (a lone reading a dot), a bucket's low and high a faint band; the same figure, legend, readout and hidden table as the chart.
const PANEL = 104, PANEL_GAP = 32, TIME_AXIS = 22;

/** The time series' geometry (no DOM; tested): its panels (by unit) with their scales and each series' segments as x/y, the time
 *  axis's marks, the height. */
export function seriesLayout(series, {width, since, until, timeZone}) {
  const plotW = Math.max(40, width - LEFT - RIGHT);
  const x = t => LEFT + (t - since) / Math.max(1, until - since) * plotW;
  let top = 0;
  const panels = panelsOf(series).map(({unit, series: list}, k) => {
    const lines = list.map(s => ({s, ...segmentsOf(s, since, until)}));
    const values = lines.flatMap(l => l.segments.flat().flatMap(p => [p.v, p.min, p.max]));
    const [lo, hi] = domainOf(unit, values);
    const yt = ticks(lo, hi, 3);
    const y0 = top + (k ? PANEL_GAP : PAD);
    const y = v => y0 + (PANEL - PAD) * (1 - (v - yt[0]) / (yt.at(-1) - yt[0]));
    top = y0 + PANEL - PAD;
    return {unit, yt, y, top: y0, bottom: top, lines: lines.map(l => ({...l, xy: l.segments.map(seg => seg.map(p => ({...p, x: x(p.t), y: y(p.v),
      ylo: p.min != null ? y(p.min) : null, yhi: p.max != null ? y(p.max) : null})))}))};
  });
  return {panels, x, plotW, width, since, until, ticks: timeTicks(since, until, plotW, {timeZone}), height: top + TIME_AXIS + 8, axisY: top};
}

const band = seg => seg.some(p => p.ylo != null && p.yhi != null && Math.abs(p.ylo - p.yhi) > 1)
  ? `${seg.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${(p.yhi ?? p.y).toFixed(1)}`).join('')}${[...seg].reverse().map(p => `L${p.x.toFixed(1)},${(p.ylo ?? p.y).toFixed(1)}`).join('')}Z` : null;

/** series: [{id, name, unit, points: [{time, value, min?, max?}], step?}]; range '24h' | '7d' | '30d' | '1y' and onRange(range) (the
 *  chips, `ranges` which); now: where the window ends; label: what it is of; loading, error/onRetry: the read's state. */
export function TimeSeries({series = [], range = '7d', onRange = null, ranges = RANGE_NAMES, now = Date.now(), timeZone, label = '', loading = false, error = null, onRetry = null, host = null}) {
  const box = useRef(null);
  const [width, setWidth] = useState(0);
  const [focus, setFocus] = useState(null); // the moment the readout shows
  useBoxWidth(box, setWidth);
  const {since, until} = rangeBounds(range, now);
  const L = width && series.length ? seriesLayout(series, {width, since, until, timeZone}) : null;
  // every reading's moment, for ←/→ and a pointer's nearest
  const moments = L ? [...new Set(L.panels.flatMap(p => p.lines.flatMap(l => l.segments.flat().map(q => q.t))))].sort((a, b) => a - b) : [];
  const near = t => moments.reduce((b, m) => (b == null || Math.abs(m - t) < Math.abs(b - t) ? m : b), null);
  const at = focus != null && moments.includes(focus) ? focus : null;
  const pointer = ev => {
    const r = ev.currentTarget.getBoundingClientRect();
    const t = since + (ev.clientX - r.left - LEFT) / (L.plotW) * (until - since);
    setFocus(near(Math.min(until, Math.max(since, t))));
  };
  const key = ev => {
    if (!moments.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
    ev.preventDefault();
    const i = at == null ? (ev.key === 'ArrowLeft' ? moments.length : -1) : moments.indexOf(at);
    const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? moments.length - 1 : Math.min(moments.length - 1, Math.max(0, i + (ev.key === 'ArrowLeft' ? -1 : 1)));
    setFocus(moments[next]);
  };
  const empty = !loading && !error && series.length && !moments.length && width;
  const words = (RANGES[range] ?? RANGES['7d']).words;
  let svg = null, tip = null;
  if (L && moments.length) {
    const fx = at != null ? L.x(at) : null;
    svg = html`<svg class="dc-svg" width=${L.width} height=${L.height} viewBox=${`0 0 ${L.width} ${L.height}`} aria-hidden="true" focusable="false">
      ${L.panels.map((p, k) => html`<g key=${`p${k}`} data-unit=${p.unit}>
        <text class="dc-unit" x="2" y=${p.top - 12}>${p.unit || ''}</text>
        ${p.yt.map(t => html`<g key=${`y${t}`}><line class=${t === 0 ? 'dc-zero' : 'dc-grid'} x1=${LEFT} x2=${L.width - RIGHT} y1=${p.y(t)} y2=${p.y(t)} />
          <text class="dc-tick" x=${LEFT - 6} y=${p.y(t) + 4} text-anchor="end">${short(t, p.unit === '%' ? '' : p.unit)}</text></g>`)}
        ${p.lines.map((l, j) => l.xy.map((seg, m) => html`<g key=${`s${j}-${m}`} class=${`ds-s ds-s${series.indexOf(l.s) % 4}`} data-series=${l.s.id}>
          ${band(seg) ? html`<path class="ds-band" d=${band(seg)} />` : null}
          ${seg.length > 1 ? html`<path class="dc-line ds-line" d=${linePath(seg.map(q => [q.x, q.y]))} />` : html`<circle class="ds-dot" cx=${seg[0].x} cy=${seg[0].y} r="2.5" />`}
          ${at != null ? seg.filter(q => q.t === at).map(q => html`<circle key="f" class="ds-dot on" cx=${q.x} cy=${q.y} r="3.5" />`) : null}
        </g>`))}
      </g>`)}
      ${L.ticks.map(t => html`<g key=${`t${t.t}`}><line class="dc-grid ds-tickline" x1=${L.x(t.t)} x2=${L.x(t.t)} y1=${L.axisY} y2=${L.axisY + 4} />
        <text class=${`dc-tick${t.strong ? ' dc-year' : ''}`} x=${L.x(t.t)} y=${L.axisY + 16} text-anchor="middle">${t.label}</text></g>`)}
      ${fx != null ? html`<line class="dc-cross" x1=${fx} x2=${fx} y1=${PAD} y2=${L.axisY} />` : null}
      <rect class="dc-hit" x=${LEFT} y="0" width=${L.plotW} height=${L.axisY} onPointerMove=${ev => { if (ev.pointerType === 'mouse') pointer(ev); }} onClick=${pointer} />
    </svg>`;
    if (at != null) {
      const readings = readingsAt(series, at, since, until);
      tip = html`<div class="dc-tip" role="status" data-time=${new Date(at).toISOString()}>
        <div class="dc-tiphead"><b>${momentText(at, range, {timeZone, now})}</b></div>
        <div class="dc-tiprow">${series.map((s, k) => html`<span class="dc-tipval" key=${s.id ?? k}><span class=${`dc-key ds-k ds-s${k % 4}`}></span>${s.name}
          <b>${readings[k] ? valueText(readings[k].v, s.unit) : 'no reading'}</b>${readings[k] && readings[k].min != null && readings[k].max != null && readings[k].max - readings[k].min > 0
            ? html`<span class="dc-dates">${valueText(readings[k].min, '')}–${valueText(readings[k].max, s.unit)}</span>` : null}</span>`)}</div>
      </div>`;
    }
  }
  const chips = onRange && ranges.length > 1 ? html`<div class="ds-ranges" role="group" aria-label="Range">${ranges.map(r => html`<button type="button" key=${r}
    class=${`dk-chip${r === range ? ' on' : ''}`} aria-pressed=${String(r === range)} title=${`The last ${RANGES[r].words}`} onClick=${() => { setFocus(null); onRange(r); }}>${RANGES[r].label}</button>`)}</div>` : null;
  const legend = series.length > 1 ? html`<div class="dc-legend" aria-hidden="true">${series.map((s, k) => html`<span key=${s.id ?? k}><span class=${`dc-key ds-k ds-s${k % 4}`}></span>${s.name}${s.unit ? ` (${s.unit})` : ''}</span>`)}</div>` : null;
  const summary = series.length && !loading && !error ? seriesSummary(series, {range, now}) : '';
  const byTime = moments.length ? series.map(s => new Map(segmentsOf(s, since, until).segments.flat().map(q => [q.t, q]))) : [];
  return html`<figure class="dc ds" aria-label=${label || 'Readings over time'} data-range=${range}>
    <div class="ds-top">${legend ?? html`<span class="ds-name">${series[0] ? `${series[0].name}${series[0].unit ? ` (${series[0].unit})` : ''}` : ''}</span>`}${chips}</div>
    ${error ? html`<${Failure} backend="Habitat" error=${error} retry=${onRetry} host=${host} />` : loading && !moments.length ? html`<div class="ds-wait" style=${`height:${PANEL + TIME_AXIS}px`}><${Skeleton} inline=${true} /></div>` : null}
    <div class="dc-box ds-box" ref=${box} tabindex=${moments.length ? '0' : null} role=${moments.length ? 'group' : null}
      aria-label=${moments.length ? `${label || 'Readings'}: ← and → read each point` : null} onKeyDown=${key} hidden=${!!error || (loading && !moments.length)}>${svg}
      ${empty ? html`<p class="ds-empty">No readings in the last ${words}</p>` : null}</div>
    ${tip}
    ${summary ? html`<p class="ds-summary">${summary}</p>` : null}
    <div class="dk-sr"><table><caption>${label || 'Readings'}, the last ${words}</caption>
      <thead><tr><th>Time</th>${series.map((s, k) => html`<th key=${k}>${s.name}${s.unit ? ` (${s.unit})` : ''}</th>`)}</tr></thead>
      <tbody>${moments.map(t => html`<tr key=${t}><td>${momentText(t, range, {timeZone, now})}</td>${byTime.map((m, k) => html`<td key=${k}>${m.has(t) ? valueText(m.get(t).v, series[k].unit) : '–'}</td>`)}</tr>`)}</tbody></table></div>
  </figure>`;
}

const kept = new Map(); // `${entity}|${range}|${minute}` → Habitat's answer, for the page's life (the same read never asks twice)
/** Habitat entities over time (contract/media.md *Time series*): `habitat.series` for each, the range the chips pick. */
export function EntitySeries({host, entities = [], range: initial = '7d', ranges = RANGE_NAMES, timeZone, label = '', now: fixed = null}) {
  const [range, setRange] = useState(initial), [state, setState] = useState({loading: true}), [retry, setRetry] = useState(0);
  const ids = entities.map(e => e.id).join(',');
  useEffect(() => {
    let active = true;
    const now = fixed ?? Math.floor(Date.now() / 60000) * 60000;
    setState(s => ({...s, loading: true, error: null, now}));
    Promise.all(entities.map(e => {
      const key = `${e.id}|${range}|${now}`;
      if (!kept.has(key)) kept.set(key, host.call('habitat.series', {query: seriesQuery(e.id, range, now)}).catch(error => { kept.delete(key); throw error; }));
      return kept.get(key).then(answer => fromHabitat(answer, {id: e.id, name: e.name, unit: e.unit}));
    })).then(list => { if (active) setState({series: list.filter(Boolean), now}); }, error => { if (active) setState({error, now}); });
    return () => { active = false; };
  }, [host, ids, range, retry]);
  if (!state.loading && !state.error && !state.series?.length) return null;
  return html`<${TimeSeries} series=${state.series ?? []} range=${range} onRange=${setRange} ranges=${ranges} now=${state.now ?? fixed ?? Date.now()} timeZone=${timeZone}
    label=${label} loading=${state.loading} error=${state.error} onRetry=${() => setRetry(n => n + 1)} host=${host} />`;
}

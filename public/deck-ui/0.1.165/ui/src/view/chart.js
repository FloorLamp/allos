// A chart of one measure over periods (CONTRACT.md, *Chart*): any backend's data in one shape (bridge's utility usage; purser's
// spending by month). Two panels on one time axis, never two scales on one: the measure as bars (and `extra` series as lines, same
// unit) above, `cost` as a line below when any point has one. Points of several `parts` (a topic's accounts) stack, a colour each. A
// period with no point is a gap (hatched, "No bill"). `stats` (CONTRACT.md, *Chart*) show above it as tiles and below as a year
// table. Plain SVG, sized to its box (a ResizeObserver), colours from tokens.css; hover or a tap shows a period's values, a mouse click
// (or the tooltip's Open) hands the point's `ref` to `onOpen`; a hidden table carries the same numbers for screen readers.
import {h} from '../../vendor/preact.mjs';
import {useLayoutEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';

const html = htm.bind(h);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TOP = 150, BOTTOM = 64, GAP = 18, AXIS = 30, LEFT = 52, RIGHT = 10, PAD = 8;

const monthly = p => /^\d{4}-\d{2}$/.test(p);
const grainOf = p => /^\d{4}$/.test(p) ? 'year' : monthly(p) ? 'month' : /^\d{4}-\d{2}-\d{2}$/.test(p) ? 'day' : 'hour';
const index = (p, grain) => grain === 'month' ? +p.slice(0, 4) * 12 + +p.slice(5, 7) - 1
  : grain === 'year' ? +p : Date.parse(`${p}${grain === 'day' ? 'T00:00:00Z' : ':00:00Z'}`) / (grain === 'day' ? 86400000 : 3600000);
const ofIndex = (n, grain) => grain === 'month' ? `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`
  : grain === 'year' ? String(n) : new Date(n * (grain === 'day' ? 86400000 : 3600000)).toISOString().slice(0, grain === 'day' ? 10 : 13);

/** Calendar periods, with hourly periods in UTC (independent of the browser's timezone). */
export const periodLabel = p => {
  const grain = grainOf(p);
  if (grain === 'year') return p;
  const month = MONTHS[+p.slice(5, 7) - 1];
  if (grain === 'month') return `${month} ${p.slice(0, 4)}`;
  return `${month} ${+p.slice(8, 10)}, ${p.slice(0, 4)}${grain === 'hour' ? ` · ${p.slice(11, 13)}:00 UTC` : ''}`;
};

/** A number in a unit: `1,062 kWh`, `$264.67` (costUnit USD), `−530 kWh`. */
export function amount(v, unit) {
  if (v == null || !Number.isFinite(v)) return '–';
  const abs = Math.abs(v), sign = v < 0 ? '−' : '';
  if (unit === 'USD') return `${sign}$${abs.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
  return `${sign}${abs.toLocaleString('en-US', {maximumFractionDigits: abs < 10 ? 1 : 0})}${unit ? ` ${unit}` : ''}`;
}
const short = (v, unit) => {
  const abs = Math.abs(v), sign = v < 0 ? '−' : '', cur = unit === 'USD' ? '$' : '';
  const n = abs >= 1e6 ? `${+(abs / 1e6).toFixed(1)}M` : abs >= 1e4 ? `${+(abs / 1e3).toFixed(0)}k` : abs >= 1e3 ? `${+(abs / 1e3).toFixed(1)}k` : `${+abs.toFixed(abs < 10 ? 1 : 0)}`;
  return `${sign}${cur}${n}`;
};

/** A unit's cost as people read it: `18.2¢/kWh`, `$3.10/gal`, `$5.20/1,000 gal`. */
export function rateText(v, unit) {
  if (v == null || !Number.isFinite(v)) return '–';
  if (unit?.startsWith('¢')) return `${v.toFixed(1)}${unit}`;
  if (unit?.startsWith('$')) return `$${v.toFixed(2)}${unit.slice(1)}`;
  return `${v} ${unit ?? ''}`.trim();
}
/** Money in whole dollars (the stats' totals): `$1,234`; else as amount. */
const whole = (v, unit) => (unit === 'USD' && v != null && Number.isFinite(v)
  ? `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', {maximumFractionDigits: 0})}` : amount(v, unit));
/** A change in percent: `▲ 12%`, `▼ 3%`, `0%`; null when none. */
export const changeText = pct => (pct == null ? null : `${pct > 0 ? '▲ ' : pct < 0 ? '▼ ' : ''}${Math.abs(pct).toLocaleString('en-US', {maximumFractionDigits: Math.abs(pct) < 10 ? 1 : 0})}%`);

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

/** The chart's bins and scales (no DOM; tested): the periods from the first to the last of points, gaps and extra, each a bin. */
export function layout(data, width) {
  const points = data.points ?? [], gaps = data.gaps ?? [], extra = data.extra ?? [];
  const all = [...points.map(p => p.period), ...gaps, ...extra.flatMap(x => x.points.map(p => p.period))].filter(Boolean);
  if (!all.length) return null;
  const grain = grainOf(all[0]);
  const first = Math.min(...all.map(p => index(p, grain))), last = Math.max(...all.map(p => index(p, grain)));
  const periods = [];
  for (let n = first; n <= last; n += 1) periods.push(ofIndex(n, grain));
  const plotW = Math.max(40, width - LEFT - RIGHT), bin = plotW / periods.length;
  const x = i => LEFT + bin * (i + 0.5);
  const at = new Map(periods.map((p, i) => [p, i]));
  const {sums} = stacks(points);
  const values = [...[...sums.values()].flatMap(v => [v.pos, v.neg]), ...extra.flatMap(s => s.points.map(p => p.value))].filter(v => v != null && Number.isFinite(v));
  const yt = ticks(Math.min(0, ...values), Math.max(0, ...values, 1));
  const y = v => PAD + (TOP - PAD) * (1 - (v - yt[0]) / (yt.at(-1) - yt[0]));
  const costOf = new Map();
  for (const p of points) if (p.cost != null && Number.isFinite(p.cost)) costOf.set(p.period, (costOf.get(p.period) ?? 0) + p.cost);
  const costs = [...costOf.values()];
  const ct = costs.length ? ticks(Math.min(0, ...costs), Math.max(0, ...costs, 1), 2) : null;
  const top2 = TOP + GAP + AXIS;
  const cy = ct ? v => top2 + PAD + (BOTTOM - PAD) * (1 - (v - ct[0]) / (ct.at(-1) - ct[0])) : null;
  const height = ct ? top2 + BOTTOM + 6 : TOP + AXIS;
  // x labels: every k-th bin so each has ~34 px; a year under its January (or the first bin); bins too thin for months: years alone,
  // every k-th of them
  const every = Math.max(1, Math.ceil((grain === 'day' || grain === 'hour' ? 52 : 34) / bin));
  const yearsOnly = grain === 'month' && every > 3, yearEvery = Math.max(1, Math.ceil(34 / (bin * 12)));
  return {grain, periods, at, bin, x, y, yt, cy, ct, height, width, every, yearsOnly, yearEvery, plotW, top2, costOf};
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
    cur.push([L.x(L.at.get(p)), yOf(v)]);
  }
  if (cur.length) out.push(cur);
  return out;
};

/** data: the chart's shape (CONTRACT.md, *Chart*); onOpen(ref): a point's thing opened; label: what the chart is of (its aria label). */
export function Chart({data, onOpen = null, label = ''}) {
  const box = useRef(null);
  const [width, setWidth] = useState(0);
  const [focus, setFocus] = useState(null); // {i, pinned}
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    setWidth(el.clientWidth);
    // measured on the next frame, never inside the observer: a re-render there changes the layout it observes (WebKit's loop error)
    let frame = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setWidth(el.clientWidth)); });
    ro.observe(el);
    return () => { cancelAnimationFrame(frame); ro.disconnect(); };
  }, []);
  const L = width ? layout(data, width) : null;
  const {by: byPeriod} = stacks(data.points);
  const parts = data.parts ?? null;
  const partName = p => (parts && p.part != null ? parts[p.part]?.name ?? '' : '');
  const partClass = p => (parts && p.part != null ? ` dc-p${p.part % 4}` : '');
  const gaps = new Set(data.gaps ?? []);
  const unit = data.unit ?? '', costUnit = data.costUnit ?? 'USD';
  const extra = (data.extra ?? []).slice(0, 2);
  const at = i => {
    const p = L.periods[i], pts = byPeriod.get(p) ?? [];
    return {p, pts, gap: gaps.has(p), extra: extra.map(s => ({name: s.name, unit: s.unit, ...s.points.find(x => x.period === p)}))};
  };
  const open = ref => { if (ref != null && onOpen) onOpen(ref); };
  const refsAt = i => (byPeriod.get(L.periods[i]) ?? []).filter(pt => pt.ref != null);
  const pick = (ev, i) => {
    const refs = refsAt(i);
    if ((ev.pointerType === 'mouse' || ev.pointerType === undefined) && refs.length === 1) return open(refs[0].ref);
    setFocus({i, pinned: true});
  };

  let svg = null, tip = null;
  if (L) {
    const bw = Math.max(2, Math.min(28, L.bin * 0.68 - 2));
    const bars = L.periods.flatMap((p, i) => {
      let up = 0, down = 0;
      return (byPeriod.get(p) ?? []).filter(pt => pt.value != null).map((pt, k) => {
        const from = pt.value < 0 ? down : up, to = from + pt.value;
        if (pt.value < 0) down = to; else up = to;
        const d = barPath(L.x(i) - bw / 2, bw, L.y(from), L.y(to));
        return d ? html`<path key=${`b${p}-${k}`} class=${`dc-bar${partClass(pt)}${focus?.i === i ? ' on' : ''}${pt.value < 0 ? ' neg' : ''}`} d=${d} />` : null;
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
      if (i % L.every && !(L.grain === 'month' && p.endsWith('-01') && L.every <= 3)) return null;
      const m = L.grain === 'month' ? MONTHS[+p.slice(5, 7) - 1] : L.grain === 'day' ? `${MONTHS[+p.slice(5, 7) - 1]} ${+p.slice(8, 10)}` : L.grain === 'hour' ? `${p.slice(11, 13)}:00` : p;
      const year = L.grain === 'month' && (i === 0 || p.endsWith('-01')) ? p.slice(0, 4)
        : L.grain === 'day' && (i === 0 || p.endsWith('-01-01')) ? p.slice(0, 4) : L.grain === 'hour' && (i === 0 || p.endsWith('T00')) ? `${MONTHS[+p.slice(5, 7) - 1]} ${+p.slice(8, 10)}` : null;
      return html`<g key=${`t${p}`}><text class="dc-tick" x=${L.x(i)} y=${TOP + 14} text-anchor="middle">${L.every > 2 && L.grain === 'month' ? m.slice(0, 1) : m}</text>
        ${year ? html`<text class="dc-tick dc-year" x=${L.x(i)} y=${TOP + 26} text-anchor="middle">${year}</text>` : null}</g>`;
    });
    const hits = L.periods.map((p, i) => html`<rect key=${`h${p}`} class="dc-hit" x=${L.x(i) - L.bin / 2} y="0" width=${L.bin} height=${L.height}
      data-period=${p} onPointerEnter=${ev => { if (ev.pointerType === 'mouse') setFocus(f => (f?.pinned ? f : {i, pinned: false})); }}
      onClick=${ev => pick(ev, i)} style=${refsAt(i).length && onOpen ? 'cursor:pointer' : null} />`);
    const fx = focus ? L.x(focus.i) : null;
    svg = html`<svg class="dc-svg" width=${L.width} height=${L.height} viewBox=${`0 0 ${L.width} ${L.height}`} aria-hidden="true" focusable="false"
      onPointerLeave=${ev => { if (ev.pointerType === 'mouse') setFocus(f => (f?.pinned ? f : null)); }}>
      <defs><pattern id="dc-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line class="dc-hatchline" x1="0" y1="0" x2="0" y2="6" /></pattern></defs>
      <text class="dc-unit" x="2" y="10">${unit}</text>
      ${L.cy ? html`<text class="dc-unit" x="2" y=${L.top2 + 2}>${costUnit === 'USD' ? 'Cost' : costUnit}</text>` : null}
      ${hatch}${yAxis}${cAxis}
      ${fx != null ? html`<line class="dc-cross" x1=${fx} x2=${fx} y1=${PAD} y2=${L.cy ? L.top2 + BOTTOM : TOP} />` : null}
      ${bars}${lines}
      ${cost.map((seg, j) => html`<g key=${`k${j}`}><path class="dc-line dc-cost" d=${linePath(seg)} />
        ${seg.map(([px, py], m) => html`<circle key=${m} class="dc-dot dc-cost" cx=${px} cy=${py} r="2.5" />`)}</g>`)}
      ${xAxis}${hits}
    </svg>`;
    if (focus && focus.i < L.periods.length) {
      const f = at(focus.i), one = f.pts.length === 1 ? f.pts[0] : null;
      const dates = one?.start && one?.end ? `${one.start} – ${one.end}` : one?.end ?? null;
      // beside the period, on the side with room, so it never covers the bar it describes
      const left = fx > L.width / 2 ? Math.max(0, fx - 232) : Math.min(fx + 12, Math.max(0, L.width - 220));
      const row = (pt, k) => html`<div class="dc-tippart" key=${`p${k}`}>
        ${parts ? html`<div class="dc-tiprow dc-tipname"><span class=${`dc-key dc-k-bar${partClass(pt)}`}></span>${partName(pt)}</div>` : null}
        <div class="dc-tiprow">${parts ? null : html`<span class="dc-key dc-k-bar"></span>`}${data.valueName ?? 'Usage'}<b>${pt.value == null ? 'not read' : amount(pt.value, pt.unit ?? unit)}</b></div>
        ${pt.cost != null ? html`<div class="dc-tiprow">${parts ? null : html`<span class="dc-key dc-k-cost"></span>`}${data.costName ?? 'Cost'}<b>${amount(pt.cost, costUnit)}</b></div>` : null}
        ${pt.rate != null && data.rateUnit ? html`<div class="dc-tiprow">${data.rateUnit}<b>${rateText(pt.rate, data.rateUnit)}</b></div>` : null}</div>`;
      tip = html`<div class=${`dc-tip${focus.pinned ? ' pinned' : ''}`} style=${`left:${left}px`} role="status">
        <div class="dc-tiphead">${periodLabel(f.p)}${dates ? html`<span class="dc-dates">${dates}</span>` : null}</div>
        ${f.gap && !f.pts.length ? html`<div class="dc-tiprow">No bill</div>` : null}
        ${f.pts.map(row)}
        ${f.extra.filter(x => x.value != null).map((x, k) => html`<div class="dc-tiprow" key=${k}><span class=${`dc-key dc-k-x${k}`}></span>${x.name}<b>${amount(x.value, x.unit)}${x.partial ? ' (part)' : ''}</b></div>`)}
        ${onOpen ? f.pts.filter(pt => pt.ref != null).map((pt, k) => html`<button type="button" key=${`o${k}`} class="dk-btn dc-open" onClick=${() => open(pt.ref)}>Open${pt.label ? html` <span class="dc-openlabel">${pt.label}</span>` : ''} ›</button>`) : null}
      </div>`;
    }
  }
  const legend = html`<div class="dc-legend" aria-hidden="true">
    ${parts ? parts.map((pt, k) => html`<span key=${`p${k}`} class="dc-legpart" title=${pt.name}><span class=${`dc-key dc-k-bar dc-p${k % 4}`}></span><span class="dc-legname">${pt.name}</span></span>`)
      : html`<span><span class="dc-key dc-k-bar"></span>${data.valueName ?? 'Usage'}${unit ? ` (${unit})` : ''}</span>`}
    ${(data.points ?? []).some(p => p.cost != null) ? html`<span><span class="dc-key dc-k-cost"></span>${data.costName ?? 'Cost'}</span>` : null}
    ${extra.map((s, k) => html`<span key=${k}><span class=${`dc-key dc-k-x${k}`}></span>${s.name}</span>`)}
    ${gaps.size ? html`<span><span class="dc-key dc-k-gap"></span>No bill</span>` : null}
  </div>`;
  const rows = L?.periods ?? [...byPeriod.keys()];
  return html`<figure class="dc" aria-label=${label || data.title || 'Chart'} data-chart=${data.title ?? ''}>
    ${data.stats ? html`<${Tiles} data=${data} onOpen=${onOpen} />` : null}
    ${legend}
    <div class="dc-box" ref=${box}>${svg}${tip}</div>
    ${data.stats ? html`<${Years} data=${data} />` : null}
    <div class="dk-sr"><table><caption>${label || data.title || ''}</caption>
      <thead><tr><th>Period</th>${parts ? html`<th>Account</th>` : null}<th>${data.valueName ?? 'Usage'}</th><th>${data.costName ?? 'Cost'}</th>${extra.map((s, k) => html`<th key=${k}>${s.name}</th>`)}</tr></thead>
      <tbody>${rows.flatMap(p => {
        const pts = byPeriod.get(p) ?? [null];
        return pts.map((pt, k) => html`<tr key=${`${p}-${k}`}><td>${periodLabel(p)}</td>${parts ? html`<td>${pt ? partName(pt) : ''}</td>` : null}
          <td>${pt ? amount(pt.value, pt.unit ?? unit) : gaps.has(p) ? 'No bill' : '–'}</td>
          <td>${pt?.cost != null ? amount(pt.cost, costUnit) : '–'}</td>${extra.map((s, j) => html`<td key=${j}>${k ? '' : amount(s.points.find(x => x.period === p)?.value, s.unit)}</td>`)}</tr>`);
      })}</tbody></table></div>
  </figure>`;
}

const PER = {month: 'A month', delivery: 'A delivery', invoice: 'An invoice'};
const COUNTED = {delivery: ['delivery', 'deliveries'], invoice: ['invoice', 'invoices']};

/** The stats' tiles over the chart (CONTRACT.md, *Chart*: `stats`): the last 12 months against the 12 before, the average a month,
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
    s.gaps != null ? {key: 'gaps', label: 'Missing bills', value: String(s.gaps), sub: s.gaps ? 'hatched on the chart' : 'none'} : null,
    s.meter?.last12 ? {key: 'meter', label: 'Grid, last 12 months', value: `${whole(s.meter.last12.import, 'kWh')} in · ${whole(s.meter.last12.export, 'kWh')} out`,
      sub: `net ${whole(s.meter.last12.net, 'kWh')}${s.meter.last12.partial ? ' (part)' : ''}`} : null,
  ].filter(Boolean);
  return html`<div class="dc-stats" data-stats=${tiles.map(t => t.key).join(' ')}>${tiles.map(t => html`<div class="dc-tile" key=${t.key} data-tile=${t.key} title=${t.title ?? null}>
    <span class="dc-tlabel">${t.label}</span>
    ${t.ref != null && onOpen ? html`<button type="button" class="dc-tvalue dc-tlink" onClick=${() => onOpen(t.ref)}>${t.value}</button>` : html`<b class="dc-tvalue">${t.value}</b>`}
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
  return html`<div class="dc-years"><table>
    <thead><tr><th>Year</th>${unit ? html`<th>${data.valueName ?? 'Usage'}</th>` : null}<th>${data.costName ?? 'Cost'}</th>${rate ? html`<th>${s.rate.unit}</th>` : null}
      ${meter.size ? html`<th>Import</th><th>Export</th><th>Net</th>` : null}</tr></thead>
    <tbody>${years.map(y => {
      const r = by.get(y), m = meter.get(y);
      const part = r?.months != null && r.months < 12 ? `${r.months} mo` : r && r.months == null
        ? (COUNTED[s.average?.per] ? `${r.count} ${COUNTED[s.average.per][r.count === 1 ? 0 : 1]}` : `${r.count}×`) : null;
      return html`<tr key=${y}><th scope="row">${y}${part ? html` <span class="dc-part">${part}</span>` : null}</th>
        ${unit ? html`<td>${r?.value != null ? whole(r.value, unit) : '–'}</td>` : null}<td>${r?.cost != null ? whole(r.cost, costUnit) : '–'}</td>
        ${rate ? html`<td>${rateText(r?.rate, s.rate.unit)}</td>` : null}
        ${meter.size ? html`<td>${m ? whole(m.import, 'kWh') : '–'}</td><td>${m ? whole(m.export, 'kWh') : '–'}</td><td>${m ? whole(m.net, 'kWh') : '–'}</td>` : null}</tr>`;
    })}</tbody></table></div>`;
}

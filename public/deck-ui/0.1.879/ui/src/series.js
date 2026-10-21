// A measure over time (contract/media.md *Time series*), no DOM: the ranges a chart offers, Habitat's entity history as a series, gaps,
// panels by unit, the time axis in the house's zone, the words a summary says. view/chart.js `TimeSeries` draws it.
import {formatQuantity} from './quantity.js';
import {DateTimeFormatter, dateText, timeText} from './format.js';
import {dateStrInTz, shiftDateStr, zonedWallTimeToUtc} from './zoned.js';

const HOUR = 3600000, DAY = 24 * HOUR;
/** The ranges a chart offers: how far back from now, the chip's label, the words, how many points to ask Habitat for. */
export const RANGES = Object.freeze({
  '24h': {ms: DAY, label: '24 h', words: '24 hours', points: 144},
  '7d': {ms: 7 * DAY, label: '7 d', words: '7 days', points: 168},
  '30d': {ms: 30 * DAY, label: '30 d', words: '30 days', points: 180},
  '1y': {ms: 365 * DAY, label: '1 y', words: 'year', points: 365},
});
export const RANGE_NAMES = Object.keys(RANGES);

/** [since, until] in ms of a range ending `now`. */
export function rangeBounds(range, now = Date.now()) {
  const until = +new Date(now);
  return {since: until - (RANGES[range] ?? RANGES['7d']).ms, until};
}
/** Habitat's query for a range (habitat docs/contract/entity-history.md). */
export function seriesQuery(id, range, now = Date.now()) {
  const {since, until} = rangeBounds(range, now);
  return {id, since: new Date(since).toISOString(), until: new Date(until).toISOString(), points: (RANGES[range] ?? RANGES['7d']).points};
}
/** Habitat's answer as a series: its buckets' means, their low and high; a state entity (not numeric) is none. */
export function fromHabitat(answer, {id, name, unit} = {}) {
  if (answer?.kind !== 'numeric' || !Array.isArray(answer.points)) return null;
  return {id: id ?? answer.entity_id, name: name ?? answer.entity_id, unit: unit ?? answer.unit ?? '', step: Number(answer.step) || null,
    points: answer.points.map(p => ({time: p.time, value: num(p.mean), min: num(p.min), max: num(p.max)}))};
}
const num = v => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
const ms = t => typeof t === 'number' ? t : Date.parse(t);

const TEMPERATURE = new Set(['°F', '°C', 'K', 'F', 'C']);
/** A value in its unit: `64%`, `312 km`, `51 °F`, `1,470 W`. */
export function valueText(v, unit = '') {
  if (v == null || !Number.isFinite(v)) return '–';
  const abs = Math.abs(v), precision = abs >= 100 || Number.isInteger(v) ? 0 : abs >= 10 ? 0 : 1;
  return unit === '%' ? formatQuantity({value: v, format: 'percent', precision}) : formatQuantity({value: v, unit, precision});
}

/** A series' drawable points in [since, until], oldest first, split where a value is missing or the readings stop: more than 2.5
 *  steps apart (its `step`, else the usual spacing of its points). */
export function segmentsOf(s, since, until) {
  const pts = (s.points ?? []).map(p => ({t: ms(p.time), v: num(p.value), min: num(p.min), max: num(p.max)}))
    .filter(p => Number.isFinite(p.t) && p.t >= since && p.t <= until).sort((a, b) => a.t - b.t);
  let step = s.step ? s.step * 1000 : null;
  if (!step) {
    const gaps = pts.slice(1).map((p, i) => p.t - pts[i].t).filter(d => d > 0).sort((a, b) => a - b);
    step = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  }
  const out = [];
  let cur = [];
  for (const p of pts) {
    if (p.v == null) { if (cur.length) out.push(cur); cur = []; continue; }
    if (cur.length && step && p.t - cur.at(-1).t > 2.5 * step) { out.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return {segments: out, step};
}

/** The series grouped into panels by unit (never two scales on one), in the order they come. */
export function panelsOf(series) {
  const by = new Map();
  for (const s of series ?? []) (by.get(s.unit ?? '') ?? by.set(s.unit ?? '', []).get(s.unit ?? '')).push(s);
  return [...by].map(([unit, list]) => ({unit, series: list}));
}
/** A panel's value domain: `%` 0–100 (wider if a reading is), a temperature its readings, anything else with zero. */
export function domainOf(unit, values) {
  const vs = values.filter(v => v != null && Number.isFinite(v));
  if (!vs.length) return unit === '%' ? [0, 100] : [0, 1];
  const lo = Math.min(...vs), hi = Math.max(...vs);
  if (unit === '%') return [Math.min(0, lo), Math.max(100, hi)];
  if (TEMPERATURE.has(unit)) { const pad = Math.max(1, (hi - lo) / 10); return [lo - pad, hi + pad]; }
  return [Math.min(0, lo), Math.max(0, hi, lo === hi ? hi + 1 : hi)];
}

const zoneOf = timeZone => timeZone ?? DateTimeFormatter().resolvedOptions().timeZone;
const STEPS = [[1, 'hour'], [2, 'hour'], [3, 'hour'], [6, 'hour'], [12, 'hour'], [1, 'day'], [2, 'day'], [7, 'day'], [14, 'day'], [1, 'month'], [2, 'month'], [3, 'month']];
const SIZE = {hour: HOUR, day: DAY, month: 30 * DAY};
/** The time axis's marks over [since, until] `plotW` wide, at local hours, days or months in `timeZone`, at least `gap` px apart:
 *  [{t, label, strong}] (`strong`: a day's or a year's start, said in full). */
export function timeTicks(since, until, plotW, {timeZone, gap = 56} = {}) {
  const tz = zoneOf(timeZone), span = Math.max(1, until - since);
  const [k, unit] = STEPS.find(([n, u]) => n * SIZE[u] / span * plotW >= gap) ?? STEPS.at(-1);
  const out = [], first = shiftDateStr(dateStrInTz(tz, new Date(since)), -1), last = dateStrInTz(tz, new Date(until));
  const now = new Date(until);
  if (unit === 'hour') {
    for (let d = first; d <= last; d = shiftDateStr(d, 1)) for (let hr = 0; hr < 24; hr += k) {
      const t = +zonedWallTimeToUtc(tz, d, `${String(hr).padStart(2, '0')}:00`);
      if (t >= since && t <= until) out.push({t, label: hr === 0 ? dateText(d, {now}) : timeText(t, {timeZone: tz, compact: true}), strong: hr === 0});
    }
  } else if (unit === 'day') {
    for (let d = first; d <= last; d = shiftDateStr(d, 1)) {
      const n = Math.round(Date.parse(`${d}T00:00:00Z`) / DAY);
      // weeks on Mondays (1970-01-05 was one); other steps every k-th day counted from then
      if ((n - 4) % k) continue;
      const t = +zonedWallTimeToUtc(tz, d, '00:00');
      if (t >= since && t <= until) out.push({t, label: dateText(d, {now}), strong: false});
    }
  } else {
    for (let d = `${first.slice(0, 7)}-01`; d <= last; d = nextMonth(d)) {
      const m = +d.slice(5, 7);
      if ((m - 1) % k) continue;
      const t = +zonedWallTimeToUtc(tz, d, '00:00');
      if (t >= since && t <= until) out.push({t, label: m === 1 ? d.slice(0, 4) : dateText(d.slice(0, 7), {now: d.slice(0, 4)}), strong: m === 1});
    }
  }
  return out;
}
const nextMonth = d => { const y = +d.slice(0, 4), m = +d.slice(5, 7); return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`; };

/** A moment as the readout says it, as near as the range needs: `Thu 3:40 PM` (a day or a week), `Oct 12, 3 PM`, `Oct 12` (a year). */
export function momentText(t, range, {timeZone, now} = {}) {
  const tz = zoneOf(timeZone);
  if (range === '1y') return dateText(new Date(t), {now, timeZone: tz});
  if (range === '30d') return `${dateText(new Date(t), {now, timeZone: tz})}, ${timeText(t, {timeZone: tz, compact: true})}`;
  return `${dateText(new Date(t), {now, timeZone: tz, weekday: true}).split(',')[0]} ${timeText(t, {timeZone: tz})}`;
}

/** What a series says in words: its latest reading and its low–high over the range: `Charge 64% now · 41–88% over 7 days`. */
export function seriesSummary(series, {range = '7d', now = Date.now()} = {}) {
  const {since, until} = rangeBounds(range, now), words = (RANGES[range] ?? RANGES['7d']).words;
  return (series ?? []).map(s => {
    const pts = segmentsOf(s, since, until).segments.flat();
    if (!pts.length) return `${s.name}: no readings over the last ${words}`;
    const lows = pts.map(p => p.min ?? p.v), highs = pts.map(p => p.max ?? p.v);
    const lo = Math.min(...lows), hi = Math.max(...highs), last = pts.at(-1).v;
    const span = lo === hi ? valueText(lo, s.unit) : s.unit === '%' ? `${valueText(lo, '')}–${valueText(hi, '%')}` : `${valueText(lo, '')}–${valueText(hi, s.unit)}`;
    return `${s.name} ${valueText(last, s.unit)} ${until - pts.at(-1).t <= 2 * HOUR ? 'now' : 'last'} · ${span} over the ${range === '1y' ? 'last year' : `last ${words}`}`;
  }).join('. ');
}

/** Each series' reading nearest `t` within its step (else null), for the readout. */
export function readingsAt(series, t, since, until) {
  return (series ?? []).map(s => {
    const {segments, step} = segmentsOf(s, since, until);
    let best = null;
    for (const p of segments.flat()) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return best && (!step || Math.abs(best.t - t) <= step * 1.5) ? best : null;
  });
}

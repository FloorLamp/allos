import { parseDay } from "./date";
// Numeric time-axis helpers (issue #402). recharts treats a string `dataKey` as a
// CATEGORY axis — x-position is the array INDEX, not the date — so a sparse,
// irregular series (one point per lab draw / per reading day) renders evenly
// spaced: a 4-year gap looks the same width as one month, and the monotone
// interpolation implies a smooth short-term trend that never happened. Mapping
// each ISO date to an epoch lets the axis be `type="number" scale="time"`, making
// x proportional to elapsed time. Pure (no DB / no React) so it's client-safe and
// unit-tested.
//
// The daily charts keep their CATEGORY axis, and since #2258 that premise is
// repaired rather than merely asserted: they used to be described as "near-dense
// by deliberate choice", which was true of the data and false of the series — a
// day with no reading was not on the axis at all, so a multi-day outage
// compressed away. lib/day-fill.ts densifies those series to the calendar before
// the chart sees them, so every category IS a day and the index is proportional
// to elapsed time again. A genuinely sparse series (a biomarker's lab draws) is
// declared exempt from that fill and belongs on THIS numeric axis instead — see
// docs/internals/charts.md § Gaps.

const MS_PER_DAY = 86_400_000;

// Epoch ms for a YYYY-MM-DD at UTC midnight, or NaN when unparseable. UTC-anchored
// so it never drifts with the runner's timezone (the dates are calendar days).
export function dateToEpoch(iso: string): number {
  const t = parseDay(iso);
  return Number.isNaN(t) ? NaN : t;
}

// The YYYY-MM-DD (UTC) an epoch falls on — the inverse of dateToEpoch, for turning
// an axis tick / tooltip x back into a date label.
export function epochToISO(epoch: number): string {
  return new Date(epoch).toISOString().slice(0, 10);
}

// The [min, max] epoch domain that covers every finite date. A single point (or an
// all-same-date series) opens a ±1 day window so the lone mark isn't a zero-width
// domain recharts can't map. Returns null for an empty/all-unparseable series so
// the caller can fall back to a category axis.
export function timeAxisDomain(dates: string[]): [number, number] | null {
  const es = dates.map(dateToEpoch).filter((e) => Number.isFinite(e));
  if (es.length === 0) return null;
  let min = Math.min(...es);
  let max = Math.max(...es);
  if (min === max) {
    min -= MS_PER_DAY;
    max += MS_PER_DAY;
  }
  return [min, max];
}

// Whether the domain crosses a calendar-year boundary (UTC), so ticks should carry
// the year. Uses the endpoints' actual calendar years — NOT a 365-day span — so
// Dec-2020 → Jan-2021 (35 days, two years) correctly opts into year labels while a
// full-January span does not.
export function spansYearBoundary(domain: [number, number] | null): boolean {
  if (!domain) return false;
  return (
    new Date(domain[0]).getUTCFullYear() !==
    new Date(domain[1]).getUTCFullYear()
  );
}

// Evenly-spaced epoch ticks across the domain (position ∝ time), inclusive of both
// endpoints. `count` is clamped to [2, maxTicks]; a degenerate/zero-width domain
// returns just its endpoint. These are honest time-proportional gridlines — a long
// gap between two clustered points shows as a wide empty span, which is the point.
export function timeAxisTicks(
  domain: [number, number] | null,
  maxTicks = 6
): number[] {
  if (!domain) return [];
  const [min, max] = domain;
  if (max <= min) return [min];
  const n = Math.max(2, Math.min(maxTicks, 12));
  // NEVER MORE TICKS THAN THE LABELS CAN TELL APART (#3497 item 1).
  //
  // Six evenly-spaced positions across a TWO-DAY domain are six honest times and
  // three distinct days, so the axis printed "07-09 · 07-09 · 07-09 · 07-10 ·
  // 07-10 · 07-11". Repeating a label does not add a gridline a reader can use; it
  // reads as the chart being broken, which on the surface where it was found it
  // was.
  //
  // The dedupe belongs HERE rather than at a call site because the label vocabulary
  // is this module's (`formatTimeTick`) and all three time-axis charts share it —
  // fixing one host would leave the other two able to draw the same axis. The
  // positions that survive are unchanged: this drops duplicates, it does not
  // re-space anything, so the ticks stay time-proportional (which is the whole
  // point of a numeric time axis) and the endpoints are still the first and last
  // labels their days can carry.
  const withYear = spansYearBoundary(domain);
  const seen = new Set<string>();
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const at = Math.round(min + ((max - min) * i) / (n - 1));
    const label = formatTimeTick(at, withYear);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(at);
  }
  return out;
}

// A compact axis-tick label for an epoch. Within one calendar year → "MM-DD"
// (matching the historical `v.slice(5)`); across years → "YYYY-MM", surfacing the
// year that adjacent points would otherwise hide (issue #402's MM-DD aggravation).
export function formatTimeTick(epoch: number, withYear: boolean): string {
  const d = new Date(epoch);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return withYear ? `${y}-${mo}` : `${mo}-${day}`;
}

// ── THE SAME POLICY, ON A CATEGORY AXIS (#4924) ─────────────────────────────
//
// The daily cards keep a CATEGORY x — every category is a calendar day since
// #2258 — and they handed recharts no tick policy at all, so the step came from
// its greedy end-anchored `preserveEnd` fit: 4 days on the wide cards, 3 on the
// narrow one, on the same page, from the same window. A reader comparing two
// cards is reading two different rulers.
//
// So the rule above extends down here rather than a second one being invented:
// at most `CHART_DATE_AXIS_TICKS` positions across the domain, spaced by TIME
// and never repeating a label. The one thing that changes on a category axis is
// that a tick must land on a category the axis actually has, so the step is a
// whole number of DAYS off a small calendar ladder — a week, a fortnight, a
// month, a quarter — which is also what makes the MM-DD labels fall into a
// rhythm instead of at 17.8-day intervals.
//
// ANCHORED AT THE LAST DAY, walking backwards. Two reasons, both load-bearing:
// the window's last day carries a tick even when nothing was logged on it (the
// #2258 guarantee that a trailing outage is visible, pinned by
// e2e/trends-day-gaps.spec.ts), and the end is where recharts' own fit anchored,
// so the last label's clearance from the svg edge (#4866) is exactly what it was.

/** At most this many labelled positions on a date axis. */
export const CHART_DATE_AXIS_TICKS = 7;

// A day, a two-day pair, a week, a fortnight, a four-week month, a quarter, a
// half-year, a year. Steps a reader can name; nothing lands on 17 days.
const CALENDAR_TICK_STEPS_DAYS = [1, 2, 7, 14, 28, 91, 182, 364];

/**
 * The calendar step a span takes its ticks at: the smallest one that fits inside
 * `maxTicks`. A span past the ladder's end falls back to an even division, which
 * is the numeric axis' own answer.
 */
export function calendarTickStepDays(
  spanDays: number,
  maxTicks = CHART_DATE_AXIS_TICKS
): number {
  const span = Math.max(0, Math.floor(spanDays));
  const most = Math.max(2, maxTicks);
  for (const step of CALENDAR_TICK_STEPS_DAYS) {
    if (Math.floor(span / step) + 1 <= most) return step;
  }
  return Math.ceil(span / (most - 1));
}

/**
 * The explicit tick set for a CATEGORY axis of ISO dates, in axis order.
 *
 * Each position is snapped to the nearest category that exists — a densified
 * daily series has every day, an aggregated one has bucket starts — so the ticks
 * stay time-proportional without asking recharts to place a label on a value the
 * axis does not hold. Fewer categories than ticks means every category is a tick,
 * which is the honest answer for a five-day window.
 */
export function categoryDateTicks(
  dates: readonly string[],
  maxTicks = CHART_DATE_AXIS_TICKS
): string[] {
  const epochs = dates.map(dateToEpoch);
  const dated = dates.filter((_, i) => Number.isFinite(epochs[i]));
  if (dated.length <= 2) return [...dated];
  const first = dateToEpoch(dated[0]);
  const last = dateToEpoch(dated[dated.length - 1]);
  const step = calendarTickStepDays((last - first) / MS_PER_DAY, maxTicks);
  const nearest = (target: number) =>
    dated.reduce((best, d) =>
      Math.abs(dateToEpoch(d) - target) < Math.abs(dateToEpoch(best) - target)
        ? d
        : best
    );
  const picked = new Set<string>();
  for (let at = last; at >= first; at -= step * MS_PER_DAY) {
    picked.add(nearest(at));
  }
  return dated.filter((d) => picked.has(d));
}

// ── THE VALUE AXIS (#4924) ──────────────────────────────────────────────────
//
// The numbers down the SIDE were recharts' defaults too, and its default fit
// divides the data range rather than snapping to a step a person would choose:
// the Sleep card printed 4.75 / 5.7 / 6.65 / 7.6 / 8.55 hours and the Heart Rate
// card 55 / 66 / 77 / 88 / 99 bpm. Nobody reads a chart in ninths.
//
// `snap125` is recharts' opt-in step algorithm — 1 / 2 / 2.5 / 5 at each order of
// magnitude — and SIX ticks is what makes it land tightly: at five, the same
// sleep domain snaps out to 4 / 6 / 8 / 10 / 12 and a third of the plot is spent
// on hours nobody slept. The two travel together, which is why they are one pair
// of constants and not two independent knobs. lib/__tests__/chart-tick-policy.test.ts
// runs them over the three domains the screenshot actually had.
//
// They live HERE, beside the date-axis policy, so a chart's two axes are one
// decision in one module; `chartAxisProps` spreads them onto whichever axis is
// numeric (recharts ignores both on a category axis).

/** recharts' nice-number step algorithm: 1 / 2 / 2.5 / 5 per order of magnitude. */
export const CHART_VALUE_AXIS_NICE_TICKS = "snap125" as const;
/** How many ticks a value axis asks for. */
export const CHART_VALUE_AXIS_TICKS = 6;

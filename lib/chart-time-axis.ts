// Numeric time-axis helpers (issue #402). recharts treats a string `dataKey` as a
// CATEGORY axis — x-position is the array INDEX, not the date — so a sparse,
// irregular series (one point per lab draw / per reading day) renders evenly
// spaced: a 4-year gap looks the same width as one month, and the monotone
// interpolation implies a smooth short-term trend that never happened. Mapping
// each ISO date to an epoch lets the axis be `type="number" scale="time"`, making
// x proportional to elapsed time. Pure (no DB / no React) so it's client-safe and
// unit-tested. The dense daily charts keep their category axis by DELIBERATE
// choice (near-dense data, negligible distortion) — see LineChartCardInner.

const MS_PER_DAY = 86_400_000;

// Epoch ms for a YYYY-MM-DD at UTC midnight, or NaN when unparseable. UTC-anchored
// so it never drifts with the runner's timezone (the dates are calendar days).
export function dateToEpoch(iso: string): number {
  const t = Date.parse(`${iso}T00:00:00Z`);
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
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(Math.round(min + ((max - min) * i) / (n - 1)));
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

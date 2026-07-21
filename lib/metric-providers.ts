// Cross-provider daily-metric reconciliation (pure — no DB), so it can be
// unit-tested in isolation. Some metrics are reported by more than one provider
// for the same day (e.g. active calories from Strava, Health Connect, AND Oura;
// sleep from Health Connect and Oura); summing across sources would
// double-count, so additive reads keep a single source per day. The per-profile
// primary-source choice (issue #14, lib/metric-source-priority) is prepended to
// the default preference below by the query layer.

import { sourceKey } from "./metric-source-priority";

// Default preference order when a day carries the same metric from several
// sources and the profile hasn't picked a primary one. A manual entry is the
// user's own correction, so it wins; Health Connect covers the whole day;
// Oura covers the night/workouts it saw; Strava only its recorded activities.
export const PROVIDER_PREFERENCE = [
  "manual",
  "health-connect",
  "oura",
  "withings",
  "strava",
];

// Collapse per-(date, source) subtotals to one value per day by choosing a single
// provider — the first present in `preference`, else the largest single-source
// total (which for a lone source is just that source, and avoids double-counting
// two unknown providers).
export function pickOneProviderPerDay(
  rows: { date: string; source: string | null; value: number }[],
  preference: string[]
): { date: string; value: number }[] {
  const byDate = new Map<string, Map<string, number>>();
  for (const r of rows) {
    let m = byDate.get(r.date);
    if (!m) {
      m = new Map();
      byDate.set(r.date, m);
    }
    const src = sourceKey(r.source);
    m.set(src, (m.get(src) ?? 0) + r.value);
  }
  const out: { date: string; value: number }[] = [];
  for (const [date, m] of byDate) {
    const chosen = preference.find((p) => m.has(p));
    const value = chosen != null ? m.get(chosen)! : Math.max(...m.values());
    out.push({ date, value });
  }
  return out;
}

// Health Connect is one integration source but may contain several device/app
// origins. Filter arbitrary rows to one origin per (date, source), choosing the
// origin with the greatest coverage/value weight. Null-origin legacy rows form a
// normal candidate group. Ties break by origin key for deterministic reads.
export function pickRowsOneOriginPerSourceDay<T>(
  rows: T[],
  dateOf: (row: T) => string,
  sourceOf: (row: T) => string | null,
  originOf: (row: T) => string | null,
  weightOf: (row: T) => number = () => 1
): T[] {
  const keyOf = (row: T) => `${dateOf(row)}\0${sourceKey(sourceOf(row))}`;
  const originKey = (origin: string | null) => origin ?? "";
  const weights = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const key = keyOf(row);
    let byOrigin = weights.get(key);
    if (!byOrigin) {
      byOrigin = new Map();
      weights.set(key, byOrigin);
    }
    const origin = originKey(originOf(row));
    byOrigin.set(origin, (byOrigin.get(origin) ?? 0) + weightOf(row));
  }
  const chosen = new Map<string, string>();
  for (const [key, byOrigin] of weights) {
    const winner = [...byOrigin.entries()].sort(
      ([aOrigin, aWeight], [bOrigin, bWeight]) =>
        bWeight - aWeight || aOrigin.localeCompare(bOrigin)
    )[0]?.[0];
    if (winner != null) chosen.set(key, winner);
  }
  return rows.filter(
    (row) => chosen.get(keyOf(row)) === originKey(originOf(row))
  );
}

// Filter arbitrary per-source rows down to ONE source per day, generically: the
// first source present in `preference` wins; else the source with the largest
// summed `weightOf` (defaults to row count — "most coverage"); ties break
// lexicographically so the pick is deterministic. Row order is preserved.
// Used by the multi-row readers (sleep stages, HR minutes/daily summary, body
// metric series) that can't collapse to a single number per day up front.
export function pickRowsOneSourcePerDay<T>(
  rows: T[],
  preference: string[],
  dateOf: (row: T) => string,
  sourceOf: (row: T) => string | null,
  weightOf: (row: T) => number = () => 1
): T[] {
  // Total weight per (date, source).
  const byDate = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const date = dateOf(r);
    let m = byDate.get(date);
    if (!m) {
      m = new Map();
      byDate.set(date, m);
    }
    const src = sourceKey(sourceOf(r));
    m.set(src, (m.get(src) ?? 0) + weightOf(r));
  }
  // Chosen source per date.
  const chosenByDate = new Map<string, string>();
  for (const [date, m] of byDate) {
    const preferred = preference.find((p) => m.has(p));
    if (preferred != null) {
      chosenByDate.set(date, preferred);
      continue;
    }
    let best: string | null = null;
    let bestWeight = -Infinity;
    for (const [src, w] of m) {
      if (
        w > bestWeight ||
        (w === bestWeight && (best == null || src < best))
      ) {
        best = src;
        bestWeight = w;
      }
    }
    chosenByDate.set(date, best!);
  }
  return rows.filter(
    (r) => chosenByDate.get(dateOf(r)) === sourceKey(sourceOf(r))
  );
}

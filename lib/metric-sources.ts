// Cross-source daily-metric reconciliation (pure — no DB), so it can be
// unit-tested in isolation. Some metrics are reported by more than one source
// for the same day (e.g. active calories from Strava, Health Connect, AND Oura;
// sleep from Health Connect and Oura); summing across sources would
// double-count, so additive reads keep a single source per day. The per-profile
// primary-source choice (issue #14, lib/metric-source-priority) is prepended to
// the default preference below by the query layer.

import {
  asSourceResolution,
  sourceGroupKey,
  sourceKey,
  type SourceResolution,
} from "./metric-source-priority";

// What the resolvers accept: a plain preference list (the instance default order)
// or the profile's fully resolved selection — a selector order plus its MODE
// (#1642). A bare list is preference mode, i.e. exactly today's behavior.
export type SourceSelection = readonly string[] | SourceResolution;

// Default preference order when a day carries the same metric from several
// sources and the profile hasn't picked a primary one. A manual entry is the
// user's own correction, so it wins; Health Connect covers the whole day;
// Oura covers the night/workouts it saw; Strava only its recorded activities.
//
// `fitbit-takeout` sits directly BELOW health-connect, and its position is a real
// decision rather than an append. A Takeout archive and a Health Connect push can
// describe the SAME night from the SAME watch and still disagree — measured on a
// real pair: session windows offset by tens of minutes, and stage architecture
// differing 2–4× on deep/REM, in no consistent direction (Fitbit appears to
// re-score sleep server-side after the sync that fed Health Connect, so the two
// are snapshots of an evolving analysis). Neither is obviously "right".
//
// Ranking it below health-connect keeps the LIVE stream authoritative by default,
// so importing an archive never silently rewrites the days a user already had. The
// per-profile primary-source pick (#14) is how someone deliberately prefers the
// archive's re-scored record instead — that choice is prepended to this list by the
// query layer, so it wins without editing the default.
//
// Being listed at all is the load-bearing part: pickOneSourcePerDay falls back to
// "the largest single-source total" for a source absent from this list, which for
// sleep would systematically favour the archive purely because it reports longer.
export const SOURCE_PREFERENCE = [
  "manual",
  "health-connect",
  "fitbit-takeout",
  "oura",
  "withings",
  "strava",
];

// Collapse per-(date, source) subtotals to one value per day by choosing a single
// source — the first present in `selection`, else the largest single-source
// total (which for a lone source is just that source, and avoids double-counting
// two unknown sources).
//
// A CLASS selector (#1640) makes its members ONE candidate: their subtotals sum,
// because the class IS the source for that day (two reports covering the same
// additive day is not a shape any real ingest produces).
//
// In STRICT mode (#1642) the "largest single-source total" fallback is skipped
// entirely: a day no selector covers yields no point at all, so the series shows
// an honest gap instead of another source's number.
export function pickOneSourcePerDay(
  rows: { date: string; source: string | null; value: number }[],
  selection: SourceSelection
): { date: string; value: number }[] {
  const { order, strict } = asSourceResolution(selection);
  const byDate = new Map<string, Map<string, number>>();
  for (const r of rows) {
    let m = byDate.get(r.date);
    if (!m) {
      m = new Map();
      byDate.set(r.date, m);
    }
    const src = sourceGroupKey(r.source, order);
    m.set(src, (m.get(src) ?? 0) + r.value);
  }
  const out: { date: string; value: number }[] = [];
  for (const [date, m] of byDate) {
    const chosen = order.find((p) => m.has(p));
    if (chosen == null && strict) continue;
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

// THE election, shared by both row filters below: given each candidate source
// group's summed weight inside one bucket, which group owns the bucket? The first
// group present in `order` wins; else the largest weight, ties broken
// lexicographically so the pick is deterministic. STRICT (#1642) skips that
// fallback, so a bucket no selector covers elects nobody and keeps no rows.
//
// The two filters differ ONLY in what a bucket is — a calendar day, or one
// overlapping window cluster — which is the whole of #2552. Keeping the choice in
// one place is what stops the two grains from drifting into two different rules.
function electSourceGroup(
  weights: Map<string, number>,
  { order, strict }: SourceResolution
): string | null {
  const preferred = order.find((p) => weights.has(p));
  if (preferred != null) return preferred;
  if (strict) return null;
  let best: string | null = null;
  let bestWeight = -Infinity;
  for (const [src, w] of weights) {
    if (w > bestWeight || (w === bestWeight && (best == null || src < best))) {
      best = src;
      bestWeight = w;
    }
  }
  return best;
}

// Filter arbitrary per-source rows down to ONE source per day, generically: the
// first source present in `selection` wins; else the source with the largest
// summed `weightOf` (defaults to row count — "most coverage"); ties break
// lexicographically so the pick is deterministic. Row order is preserved.
// Used by the multi-row readers (sleep stages, HR minutes/daily summary, body
// metric series) that can't collapse to a single number per day up front.
//
// A CLASS selector (#1640) keeps EVERY member's rows for the days it wins — "the
// documents source" is the whole family, so two scans on one day both survive and
// the caller's fold averages them exactly as it would two same-day manual rows.
// In STRICT mode (#1642) an uncovered day keeps NO rows: the honest gap.
//
// THE DAY IS THE RIGHT BUCKET ONLY FOR A PER-DAY QUANTITY (#2552). It is right for
// a day's HR minutes or a day's weigh-in — one day, one number, and a second source
// reporting it is a competing account of the same thing. It is WRONG for a list of
// events that merely happen to share a date: see pickRowsOneSourcePerWindow.
export function pickRowsOneSourcePerDay<T>(
  rows: T[],
  selection: SourceSelection,
  dateOf: (row: T) => string,
  sourceOf: (row: T) => string | null,
  weightOf: (row: T) => number = () => 1
): T[] {
  const resolution = asSourceResolution(selection);
  const { order } = resolution;
  // Total weight per (date, source-group).
  const byDate = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const date = dateOf(r);
    let m = byDate.get(date);
    if (!m) {
      m = new Map();
      byDate.set(date, m);
    }
    const src = sourceGroupKey(sourceOf(r), order);
    m.set(src, (m.get(src) ?? 0) + weightOf(r));
  }
  // Chosen source per date. A date absent from this map keeps no rows.
  const chosenByDate = new Map<string, string>();
  for (const [date, m] of byDate) {
    const chosen = electSourceGroup(m, resolution);
    if (chosen != null) chosenByDate.set(date, chosen);
  }
  return rows.filter(
    (r) => chosenByDate.get(dateOf(r)) === sourceGroupKey(sourceOf(r), order)
  );
}

// Filter WINDOWED rows down to ONE source per overlapping window, generically —
// the same election as the per-day filter above, over a bucket that is a cluster of
// overlapping windows rather than a calendar day.
//
// WHY THE DAY WAS THE WRONG BUCKET (#2552). Two sources describing one night are a
// duplicate and only one may survive; two sources describing an overnight and a
// daytime nap are two EVENTS, and dropping either loses something that really
// happened. The day cannot tell those apart — it sees "two sources on 2026-07-15"
// in both cases — so a nap logged by hand on the same wake-day elected `manual`
// (first in SOURCE_PREFERENCE, "the user's own correction") and took the wearable's
// entire overnight session out of the read with it. The overlap can tell them
// apart, because a duplicate of an event covers the same clock time and a distinct
// event does not.
//
// Windows are clustered transitively: a row joins the cluster it overlaps, and a
// cluster spans the union of its members. Touching endpoints do NOT overlap (a
// session that begins exactly when another ends is a second event). A row whose
// window will not parse, or is inverted, belongs to no cluster and is KEPT — this
// filter de-duplicates, it does not validate, and its callers' SQL already refuses
// an inverted window.
export function pickRowsOneSourcePerWindow<T>(
  rows: T[],
  selection: SourceSelection,
  startOf: (row: T) => string,
  endOf: (row: T) => string,
  sourceOf: (row: T) => string | null,
  weightOf: (row: T) => number = () => 1
): T[] {
  const resolution = asSourceResolution(selection);
  const groupOf = (row: T) => sourceGroupKey(sourceOf(row), resolution.order);
  const keep = new Set<number>();
  const spans: { index: number; start: number; end: number }[] = [];
  rows.forEach((row, index) => {
    const start = Date.parse(startOf(row));
    const end = Date.parse(endOf(row));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      spans.push({ index, start, end });
    } else {
      keep.add(index);
    }
  });
  spans.sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);

  for (let i = 0; i < spans.length;) {
    let clusterEnd = spans[i].end;
    let j = i + 1;
    while (j < spans.length && spans[j].start < clusterEnd) {
      clusterEnd = Math.max(clusterEnd, spans[j].end);
      j++;
    }
    const weights = new Map<string, number>();
    for (let k = i; k < j; k++) {
      const group = groupOf(rows[spans[k].index]);
      weights.set(
        group,
        (weights.get(group) ?? 0) + weightOf(rows[spans[k].index])
      );
    }
    const chosen = electSourceGroup(weights, resolution);
    if (chosen != null) {
      for (let k = i; k < j; k++) {
        if (groupOf(rows[spans[k].index]) === chosen) keep.add(spans[k].index);
      }
    }
    i = j;
  }
  return rows.filter((_, index) => keep.has(index));
}

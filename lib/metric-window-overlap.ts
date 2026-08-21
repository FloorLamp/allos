import { shiftDateStr } from "./date";
import { isStaleMetricSnapshot } from "./metric-snapshot";

// THE OVERLAP-SUPERSEDE RULE for `metric_samples` interval rows (issue #3424).
//
// WHY IT EXISTS. The Health Connect exporter's `daily` setting sends one interval
// record per DEVICE-LOCAL day: window = local midnight → the push moment. #1101 made
// `upsertMetricSamples` idempotent on (profile, metric, source, origin, started_at)
// so a moving END overwrites itself. A TIMEZONE CHANGE moves the START instead: the
// exporter re-anchors "today" to the new zone's midnight, so the re-anchored record
// carries a brand-new natural key, never supersedes the old one, and
// `getMetricDailyTotals` SUMs both into one profile-local day. Measured on prod
// profile 1: 23330 steps for a day with 11721.
//
// THE RULE. Under ONE anchoring, same-(metric, origin) day buckets are pairwise
// disjoint. So an overlap is always the mixed-anchoring anomaly, and "the newer row
// wins over whatever it overlaps" converges an affected span to the exporter's
// current anchoring within one push. Ingest applies it against an incoming row
// (lib/integrations/normalize.ts); the 20260821-hc-overlap-supersede migration
// replays the SAME rule over stored history in `id` order.
//
// TWO ENCODINGS, ONE RULE, PINNED. Ingest narrows candidates in SQL and decides in
// JS through `windowsOverlap`; the migration plans entirely in JS through
// `planOverlapSupersede`. Both call this file's predicate, and
// lib/__db_tests__/hc-overlap-supersede.test.ts pins the SQL narrowing against it —
// the `planSyncEventPrune` discipline (a pure rule, pinned against its DB twin).
//
// IT FAILS TOWARD KEEPING ROWS. This path DELETES stored health data, so every
// uncertainty resolves to "no overlap": an instant this module cannot read as an
// unambiguous UTC instant, a window with no duration, a candidate outside the day
// radius. A false negative leaves a double count that the next push fixes; a false
// positive destroys a reading nobody can get back.

/**
 * One stored or incoming `metric_samples` window, in the columns this rule reads.
 * Structural, so the pure tier can exercise it without a live schema.
 */
export interface MetricWindow {
  id: number;
  /** Profile-local day the row is filed under (`YYYY-MM-DD`). */
  date: string;
  started_at: string;
  ended_at: string;
  /** The #133 user-edit lock. NULL on rows written before migration 115. */
  edited: number | null;
}

// HOW FAR EITHER SIDE OF AN INCOMING ROW'S `date` A SUPERSEDABLE ROW CAN SIT, IN
// PROFILE-LOCAL DAYS. The unit is days of the `date` column, not hours of the window.
//
// Derivation: a day bucket spans at most 24 h, and re-anchoring shifts its start by
// at most the spread of real UTC offsets (−12:00 … +14:00, so 26 h). Two buckets that
// overlap therefore start within ~26 h of each other, and `date` — computed from
// `started_at` under the profile zone — can differ by at most 1. The radius is 2 to
// leave one full day of slack for a stale `date` that a re-send has not yet rewritten.
//
// It is a BOUND ON THE SCAN, not part of the rule: a genuine overlap further out than
// this is simply not superseded (see "fails toward keeping rows" above). Ingest spends
// it on the (profile_id, metric, date) index instead of walking a metric's history.
export const SUPERSEDE_DAY_RADIUS = 2;

/** The inclusive `date` range a supersede candidate for `date` may sit in. */
export function supersedeDateRange(date: string): { from: string; to: string } {
  return {
    from: shiftDateStr(date, -SUPERSEDE_DAY_RADIUS),
    to: shiftDateStr(date, SUPERSEDE_DAY_RADIUS),
  };
}

// An instant this rule is willing to compare, in epoch ms — or null when it is not.
//
// An explicit UTC designator (`Z`) or a numeric offset is REQUIRED. `metric_samples`
// instant columns are documented `mixed` (docs/internals/time-columns.md): they hold
// vendor ISO for an imported sample AND a bare `${date}T00:00:00` — a profile-local
// day midnight, not an instant — for a reading whose author stated only a day. Those
// bare strings parse against the HOST's zone, which would make a delete decision
// depend on where the server runs, so they are refused outright.
function instantMs(value: string): number | null {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Do two half-open windows `[start, end)` overlap, as INSTANTS?
 *
 * A window with no duration (`end <= start`) is a POINT reading — HRV, skin
 * temperature, lean mass, height, BMR all store `started_at === ended_at` — and never
 * overlaps anything, in either role. That is the guard that keeps the interval rule
 * off the point rows: the textbook half-open test `aStart < bEnd && bStart < aEnd`
 * answers TRUE for a degenerate window sitting inside a real one, which would let a
 * daily bucket delete a point reading it merely contains.
 *
 * Comparison is on parsed instants, never on the strings: `2026-05-02T00:00:00.000Z`
 * and `2026-05-02T00:00:00Z` are the same moment and sort the wrong way lexically,
 * and an offset spelling (`2026-05-02T09:00:00+09:00`) does not sort at all.
 */
export function windowsOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string
): boolean {
  const as = instantMs(aStart);
  const ae = instantMs(aEnd);
  const bs = instantMs(bStart);
  const be = instantMs(bEnd);
  if (as === null || ae === null || bs === null || be === null) return false;
  if (ae <= as || be <= bs) return false; // point reading — not an interval
  return as < be && bs < ae;
}

/**
 * Order two window starts oldest-first, as INSTANTS where both are readable and
 * lexically otherwise — the `isStaleMetricSnapshot` discipline, for the same reason:
 * `started_at` holds more than one spelling and a delete order must not depend on
 * which one a vendor chose.
 */
export function compareWindowStarts(a: string, b: string): number {
  const am = instantMs(a);
  const bm = instantMs(b);
  if (am !== null && bm !== null) return am - bm;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Is this window one the rule can act on at all (a readable, non-empty interval)? */
export function isSupersedingInterval(start: string, end: string): boolean {
  return windowsOverlap(start, end, start, end);
}

/**
 * Plan what an INCOMING window does to the stored rows it overlaps.
 *
 * `stored` is the candidate set for one (profile, metric, source, origin) group,
 * already narrowed to the day radius and with the incoming row's own natural-key twin
 * excluded — that row is the upsert's business, not the supersede's.
 *
 * THE INCOMING ROW WINS, unconditionally, against everything it overlaps that the #133
 * lock does not protect. That is #3424's rule verbatim, and it is right because of what
 * a push IS: the exporter re-aggregates under the device's CURRENT zone, so every row
 * of one push carries the current anchoring and anything stored that it overlaps
 * carries an older one. The one case that breaks the assumption — a push that also
 * re-sends a record cut under the PREVIOUS anchoring — is settled before this function
 * ever sees it, by `staleBatchOverlaps` below.
 */
export function planSupersede(
  incoming: { started_at: string; ended_at: string },
  stored: readonly MetricWindow[]
): { supersede: MetricWindow[]; locked: MetricWindow[] } {
  const supersede: MetricWindow[] = [];
  const locked: MetricWindow[] = [];
  if (!isSupersedingInterval(incoming.started_at, incoming.ended_at)) {
    return { supersede, locked };
  }
  for (const row of stored) {
    if (
      !windowsOverlap(
        incoming.started_at,
        incoming.ended_at,
        row.started_at,
        row.ended_at
      )
    ) {
      continue;
    }
    // The #133 lock, spelled as the #608 sweep spells it: NULL is "not locked".
    if (row.edited) locked.push(row);
    else supersede.push(row);
  }
  return { supersede, locked };
}

/** The shape `staleBatchOverlaps` needs of an incoming row. */
export interface BatchWindow {
  metric: string;
  origin?: string | null;
  started_at: string;
  ended_at: string;
}

/**
 * WITHIN ONE PUSH, the rows cut under the PREVIOUS anchoring — the ones that must not
 * be written at all.
 *
 * A push normally carries one anchoring and its windows are pairwise disjoint. A push
 * taken across a timezone change does not: #3424's rolling ~48h window re-sends the
 * pre-switch record ALONGSIDE the re-anchored one that re-contains it, and storing
 * both is the double count itself. Two rows of the same (metric, origin) that overlap
 * INSIDE ONE BATCH are therefore always a mixed-anchoring pair.
 *
 * WHICH ONE IS CURRENT IS A FRESHNESS QUESTION, NOT AN ORDER ONE. Travelling west the
 * new zone's midnight is EARLIER than the old one's (Tokyo 15:00Z → Honolulu 10:00Z),
 * so the re-anchored bucket sorts FIRST and "the row later in the batch wins" keeps the
 * stale record — measured against #3424's repro, which read 3000 steps for 3500 walked
 * under exactly that rule. These buckets end at the moment they were last pushed, so
 * the window reaching FURTHEST FORWARD is the one the exporter is still filling. That
 * is `isStaleMetricSnapshot`, #1101's own freshness test, applied to a pair that does
 * not share a key — reused rather than re-invented, and it answers correctly from
 * either travel direction.
 *
 * This is deliberately NOT applied between an incoming row and a STORED one: a
 * completed re-anchored bucket for a past day legitimately ends EARLIER than the
 * old-anchoring "today so far" row it overlaps, and blocking it there would leave the
 * profile half-converged with a gap between the two anchorings.
 */
export function staleBatchOverlaps<T extends BatchWindow>(
  rows: readonly T[]
): Set<T> {
  const dropped = new Set<T>();
  const byGroup = new Map<string, T[]>();
  for (const row of rows) {
    if (!isSupersedingInterval(row.started_at, row.ended_at)) continue;
    const key = `${row.metric}\0${row.origin ?? ""}`;
    const bucket = byGroup.get(key);
    if (bucket) bucket.push(row);
    else byGroup.set(key, [row]);
  }
  for (const group of byGroup.values()) {
    // Freshest first, longest first on a tie, so the greedy keep below always retains
    // the window that reaches furthest forward.
    const ranked = [...group].sort((a, b) => {
      // `isStaleMetricSnapshot(x, y)` is "y ends before x". So a ranks first when b is
      // the staler of the two.
      if (isStaleMetricSnapshot(a.ended_at, b.ended_at)) return -1;
      if (isStaleMetricSnapshot(b.ended_at, a.ended_at)) return 1;
      return compareWindowStarts(a.started_at, b.started_at);
    });
    const kept: T[] = [];
    for (const row of ranked) {
      const clashes = kept.some((k) =>
        windowsOverlap(k.started_at, k.ended_at, row.started_at, row.ended_at)
      );
      if (clashes) dropped.add(row);
      else kept.push(row);
    }
  }
  return dropped;
}

/**
 * Replay the rule over ONE group's stored history and return the ids to delete.
 *
 * `rows` is every stored row of one (profile, metric, source, origin) group, walked in
 * ascending `id` — INGEST ORDER — so a later-ingested row deletes the earlier rows it
 * overlaps, exactly as #3424 prescribes and exactly as ingest would have done had the
 * rule existed when they arrived.
 *
 * `id` order is the right proxy for anchoring order here, structurally: the rows cut
 * under the old zone were inserted BEFORE the switch and the re-anchored ones after,
 * so the later id is always the newer anchoring. It is also the only ordering available
 * — a stored row carries no record of which push delivered it.
 *
 * One asymmetry with ingest, deliberate: an EDIT-LOCKED row is never deleted, but it
 * may still supersede earlier rows. The lock protects that row's value, not its
 * neighbours'.
 *
 * IDEMPOTENT. A second replay deletes nothing: every non-locked overlap was resolved in
 * pass 1, so the survivors of a group are pairwise disjoint except where an edit-locked
 * row is involved — and neither pass may delete one of those. A group with no overlaps
 * returns [], which is the no-op a healthy profile takes.
 */
export function planOverlapSupersede(rows: readonly MetricWindow[]): number[] {
  const ascending = [...rows].sort((a, b) => a.id - b.id);
  const kept: MetricWindow[] = [];
  const doomed: number[] = [];
  for (const row of ascending) {
    if (isSupersedingInterval(row.started_at, row.ended_at)) {
      const { from, to } = supersedeDateRange(row.date);
      const neighbours = kept.filter((k) => k.date >= from && k.date <= to);
      for (const victim of planSupersede(row, neighbours).supersede) {
        doomed.push(victim.id);
        kept.splice(kept.indexOf(victim), 1);
      }
    }
    kept.push(row);
  }
  return doomed.sort((a, b) => a - b);
}

/** The group a row's supersede neighbourhood is scoped to. NUL-joined, as elsewhere. */
export function overlapGroupKey(row: {
  profile_id: number;
  metric: string;
  origin: string | null;
}): string {
  return `${row.profile_id}\0${row.metric}\0${row.origin ?? ""}`;
}

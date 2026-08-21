import { shiftDateStr, utcInstant } from "./date";
import { isStaleMetricSnapshot } from "./metric-snapshot";
import { SUB_DAILY_WINDOW_MAX_MIN } from "./integrations/health-connect";

// THE OVERLAP-SUPERSEDE RULE for `metric_samples` interval rows (issue #3424).
//
// WHY IT EXISTS. The Health Connect exporter's `daily` setting sends one interval
// record per DEVICE-LOCAL day: window = local midnight to the push moment. #1101 made
// `upsertMetricSamples` idempotent on (profile, metric, source, origin, started_at)
// so a moving END overwrites itself. A TIMEZONE CHANGE moves the START instead: the
// exporter re-anchors "today" to the new zone's midnight, so the re-anchored record
// carries a brand-new natural key, never supersedes the old one, and
// `getMetricDailyTotals` SUMs both into one profile-local day. Measured on prod
// profile 1: 23330 steps for a day with 11721.
//
// THE RULE, AND THE THREE THINGS THAT BOUND IT. "The newer row wins over whatever it
// overlaps" converges an affected span to the exporter's current anchoring. #3424
// justified it with "under one anchoring, same-(metric, origin) day buckets are
// pairwise disjoint, so an overlap is always the mixed-anchoring anomaly". THAT
// PREMISE IS NOT TRUE OF EVERY ROW THE PARSER EMITS, and an adversarial review proved
// it by deleting real readings with it. So the rule states its own preconditions now
// rather than inheriting them:
//
//   1. ONLY THE DAY-BUCKET METRICS (`DAY_BUCKET_METRICS`). Nutrition emits one
//      interval row per nutrient per NutritionRecord on the record's REAL start and
//      end, so a snack logged inside a meal window is two legitimately nested
//      `nutrition_kcal` rows and the rule would delete the meal. `sleep_min` is one row
//      per session on the session's real window, and two overlapping sessions are two
//      readings rather than one anomaly. Neither tiles, so neither may be superseded.
//   2. ONLY AT DAY-BUCKET GRANULARITY (`isDayBucketWindow`). The metric list alone is
//      not enough: the same four metrics arrive as MINUTE buckets at a `1m`/`15m`
//      exporter setting, and two devices that set no `metadata.data_origin` both parse
//      to `origin = null` (`dataOrigin`), which lands their minute buckets in ONE
//      supersede group. Gating on the OBSERVED window rather than on the recommended
//      setting is what makes that unreachable: this repo already calls a window an hour
//      or narrower a fine-grained setting (`SUB_DAILY_WINDOW_MAX_MIN`), and the rule
//      declines to act on one.
//   3. ONLY WHEN THE PAYLOAD SAYS THE INCOMING ROW IS NEWER (`pushIsNewer`), below.
//
// FRESHNESS IS STATED BY THE PAYLOAD, NEVER BY ARRIVAL ORDER. The first cut decided
// "incoming wins" from position - which chunk a row landed in, which push arrived last
// - and that was refuted twice, in both directions:
//
//   * A push over INGEST_CHUNK_SIZE rows splits a mixed-anchoring pair across two
//     chunks. The batch-scoped pass never saw the pair, and the per-row rule resolved it
//     by arrival: the STALE bucket deleted the CURRENT one. Worse than the bug it fixes,
//     because a double count is at least repairable.
//   * A byte-identical REPLAY of a pre-switch payload - an exporter retry after a 5xx,
//     and the route has no idempotency key - deleted the converged row and re-inserted
//     the stale one. The old freshness guard could not see it, because it compared
//     against the incoming row's natural-key TWIN and the supersede had already deleted
//     that twin.
//
// So every Health Connect row carries `metric_samples.pushed_at`, the instant the
// EXPORTER stamped on the push that wrote it (`payload.timestamp`), and a row may only
// supersede a stored row whose stamp is STRICTLY OLDER. A replay carries the same stamp
// as the push it replays, so it is not newer and takes nothing. Two rows of ONE push
// carry the SAME stamp, so no chunk can ever delete another chunk's row - within a push
// `staleBatchOverlaps` over the WHOLE payload is the only thing allowed to decide, and
// it decides by freshness rather than by order.
//
// IT IS LOSSY AT THE TRAILING EDGE OF THE ROLLING WINDOW - accepted, not overlooked.
// "Incoming deletes what it overlaps" is exact in the interior of the window. At its
// trailing edge it is not: an incoming re-anchored bucket that starts AFTER the stored
// bucket it overlaps takes that bucket's leading hours, [stored.start, incoming.start),
// with it, and those hours come back only if the exporter also re-sends the PREVIOUS
// re-anchored bucket - which at the edge of a ~48h window it may not. Westward the
// sliver is the old zone's midnight to the new zone's midnight: near-zero steps, a few
// hours of BMR on total_kcal. EASTWARD IS THE BAD CASE - the first Tokyo bucket starts
// 15:00Z, so it takes the New York row holding that New York MORNING, which lives only
// in the previous day's Tokyo bucket. Inside the window that bucket arrives and the
// morning is recounted; at the trailing edge it does not.
//
// There is NO THIRD OPTION once the source has re-anchored: the alternative to dropping
// the sliver is double-counting it, which is the bug. So the loss is bounded, stated
// here, and made visible - every superseded row is counted into the sync event's
// `superseded` split so a person can see in Review that a delete happened. The ingest
// also processes each batch in ascending started_at order, so within one push every
// leading sliver that IS re-sent lands before the row it would otherwise be lost from.
//
// IT FAILS TOWARD KEEPING ROWS. This path DELETES stored health data, so every
// uncertainty resolves to "no supersede": an instant this module cannot read as an
// unambiguous UTC instant, a window with no duration, a window at sub-daily
// granularity, a metric that can nest, a push with no readable stamp, a candidate
// outside the day radius. A false negative leaves a double count the next push fixes;
// a false positive destroys a reading nobody can get back.

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
  /**
   * The exporter's stamp on the push that wrote this row. NULL on every row stored
   * before `20260821-hc-overlap-supersede`, and on every non-Health-Connect row.
   */
  pushed_at: string | null;
}

// THE METRICS WHOSE WINDOWS TILE BY CONSTRUCTION, and the only ones this rule may act
// on. Precisely `FINE_GRAINED_CHECK`'s list in lib/integrations/health-connect.ts -
// "summable interval metrics that Health Connect stores as DAILY totals" - and
// precisely the four metrics #3424's prod table caught double counting.
//
// WHY AN ALLOW-LIST. `nutrition_*` and `hydration_l` are `daily` in SOURCE_FIDELITY
// too, but at a `full` setting the parser emits one row per RECORD on the record's own
// window, and nothing enforces the recommended setting - `FINE_GRAINED_CHECK` says in
// its own comment that detection is informational. `sleep_min` is one row per session.
// `sleep_*_min` stages are sequential and each bucket is already its own metric, so
// they are safe; they stay out anyway, because a rule that deletes health data should
// reach exactly as far as its evidence and no further.
export const DAY_BUCKET_METRICS: ReadonlySet<string> = new Set([
  "steps",
  "distance_km",
  "active_kcal",
  "total_kcal",
]);

/** Is this a metric whose Health Connect windows tile, so an overlap is an anomaly? */
export function isDayBucketMetric(metric: string): boolean {
  return DAY_BUCKET_METRICS.has(metric);
}

// HOW FAR EITHER SIDE OF AN INCOMING ROW'S `date` A SUPERSEDABLE ROW CAN SIT, IN
// PROFILE-LOCAL DAYS. The unit is days of the `date` column, not hours of the window.
//
// Derivation: a day bucket spans at most 24 h, and re-anchoring shifts its start by
// at most the spread of real UTC offsets (-12:00 to +14:00, so 26 h). Two buckets that
// overlap therefore start within ~26 h of each other, and `date` - computed from
// `started_at` under the profile zone - can differ by at most 1. The radius is 2 to
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

// An instant this rule is willing to compare, in epoch ms - or null when it is not.
//
// An explicit UTC designator (`Z`) or a numeric offset is REQUIRED. `metric_samples`
// instant columns are documented `mixed` (docs/internals/time-columns.md): they hold
// vendor ISO for an imported sample AND a bare `${date}T00:00:00` - a profile-local
// day midnight, not an instant - for a reading whose author stated only a day. Those
// bare strings parse against the HOST's zone, which would make a delete decision
// depend on where the server runs, so they are refused outright.
export function instantMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Do two half-open windows `[start, end)` overlap, as INSTANTS?
 *
 * A window with no duration (`end <= start`) is a POINT reading - HRV, skin
 * temperature, lean mass, height, BMR all store `started_at === ended_at` - and never
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
  if (ae <= as || be <= bs) return false; // point reading - not an interval
  return as < be && bs < ae;
}

/**
 * Is this window one the exporter cut as a DAY BUCKET rather than a fine-grained one?
 *
 * The threshold is `SUB_DAILY_WINDOW_MAX_MIN`, the constant the at-ingest granularity
 * detector already uses for exactly this judgement: "a daily-stored additive metric
 * arriving in windows an hour or narrower is a fine-grained setting regardless of how
 * few rows the push carried". Reused rather than re-picked, so the two cannot drift and
 * the number keeps its one derivation.
 *
 * A genuine `daily` bucket pushed within the first hour of local midnight is itself an
 * hour or narrower, so this declines to act on it. That is the safe direction: the
 * double count survives until the next push and is collapsed then.
 */
export function isDayBucketWindow(start: string, end: string): boolean {
  const s = instantMs(start);
  const e = instantMs(end);
  if (s === null || e === null) return false;
  return e - s > SUB_DAILY_WINDOW_MAX_MIN * 60_000;
}

/**
 * Order two window starts oldest-first, as INSTANTS where both are readable and
 * lexically otherwise - the `isStaleMetricSnapshot` discipline, for the same reason:
 * `started_at` holds more than one spelling and a write order must not depend on which
 * one a vendor chose.
 */
export function compareWindowStarts(a: string, b: string): number {
  const am = instantMs(a);
  const bm = instantMs(b);
  if (am !== null && bm !== null) return am - bm;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Is this a window the rule may act on at all: a readable, non-degenerate interval of
 * a tiling metric, cut at day-bucket granularity?
 */
export function isSupersedingWindow(
  metric: string,
  start: string,
  end: string
): boolean {
  return (
    isDayBucketMetric(metric) &&
    windowsOverlap(start, end, start, end) &&
    isDayBucketWindow(start, end)
  );
}

/**
 * Is the push carrying an incoming row strictly newer than the push that wrote a row
 * stamped `storedPushedAt`?
 *
 * A NULL stored stamp is a row written before the column existed, which is every
 * already-corrupted row this fix exists for, so those may be superseded. An unreadable
 * or absent INCOMING stamp is refused outright: a push that cannot say when it happened
 * gets to delete nothing.
 */
export function pushIsNewer(
  incomingPushedAt: string | null | undefined,
  storedPushedAt: string | null | undefined
): boolean {
  const incoming = instantMs(incomingPushedAt);
  if (incoming === null) return false;
  const stored = instantMs(storedPushedAt);
  if (stored === null) return true;
  return incoming > stored;
}

/**
 * The stamp to record on every row of one push, and to compare a future push against.
 *
 * PRIMARY: what the exporter said (`ParsedPayload.pushedAt`, from `payload.timestamp`).
 *
 * FALLBACK: the LATEST end instant anywhere in the push. `timestamp` is documented in
 * the payload shape but nothing validates it, so requiring it would silently switch the
 * whole fix off for an exporter build that omits it — and nobody would find out. The
 * fallback is derived from the same payload and has the two properties that matter:
 * it is IDENTICAL for a byte-identical replay (so a retry is never newer than the push
 * it replays), and it advances with every real push, because these buckets end at the
 * moment they were last pushed. It is the same quantity `staleBatchOverlaps` already
 * trusts to say which anchoring the exporter is still filling, read at push scope
 * instead of at row scope.
 *
 * IT MUST BE COMPUTED OVER THE WHOLE PUSH, never per chunk: a per-chunk maximum grows
 * chunk by chunk, which would let a later chunk out-rank an earlier one and reopen
 * exactly the split-pair defect the stamp exists to close.
 *
 * Null when the push states nothing readable either way — and then nothing is
 * superseded at all.
 *
 * RETURNED CANONICAL (`utcInstant`), never in the spelling it arrived in. `pushed_at`
 * is a brand-new column and there is no reason for it to be born `mixed`: an exporter
 * `timestamp` may carry milliseconds and an `ended_at` may not, and a column that holds
 * both needs a note explaining itself forever. The cost is second resolution — two
 * pushes inside ONE second compare equal, so the later one supersedes nothing and the
 * double count waits for the push after it. That is the safe direction, and the
 * exporter pushes minutes apart.
 */
export function pushStampFor(
  stated: string | null | undefined,
  rows: readonly { ended_at: string }[]
): string | null {
  const statedMs = instantMs(stated);
  if (statedMs !== null) return utcInstant(new Date(statedMs));
  let bestMs = -Infinity;
  for (const row of rows) {
    const ms = instantMs(row.ended_at);
    if (ms !== null && ms > bestMs) bestMs = ms;
  }
  return bestMs === -Infinity ? null : utcInstant(new Date(bestMs));
}

/**
 * Plan what an INCOMING window does to the stored rows it overlaps.
 *
 * `stored` is the candidate set for one (profile, metric, source, origin) group,
 * already narrowed to the day radius and with the incoming row's own natural-key twin
 * excluded - that row is the upsert's business, not the supersede's.
 *
 * A stored row is superseded when ALL of these hold: the incoming window is a
 * day-bucket window of a tiling metric; the two overlap as instants; the STORED window
 * is itself a day-bucket window; the incoming PUSH is strictly newer than the one that
 * wrote the stored row; and the #133 lock does not protect it.
 *
 * `locked` is every overlapped row the edit lock held out, reported rather than dropped
 * so the caller can count them into the `edited` split.
 *
 * `blocked` is the other direction, and it is what makes a REPLAY inert rather than
 * merely harmless. A stored row that this incoming row overlaps but is NOT newer than
 * says the incoming row carries an anchoring the store has already moved past. Refusing
 * to delete it is only half the answer: writing the incoming row anyway re-creates the
 * double count (measured — a replayed pre-switch push put the day back to 6500 by
 * INSERTING under a key its own supersede had cleared). So a blocked row is not written
 * at all, and the caller counts it `unchanged`, exactly as it counts a row a fresher
 * sibling in the same push covers.
 */
export function planSupersede(
  incoming: {
    metric: string;
    started_at: string;
    ended_at: string;
    pushedAt?: string | null;
  },
  stored: readonly MetricWindow[]
): {
  supersede: MetricWindow[];
  locked: MetricWindow[];
  blocked: MetricWindow[];
} {
  const supersede: MetricWindow[] = [];
  const locked: MetricWindow[] = [];
  const blocked: MetricWindow[] = [];
  if (
    !isSupersedingWindow(
      incoming.metric,
      incoming.started_at,
      incoming.ended_at
    )
  ) {
    return { supersede, locked, blocked };
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
    // A stored row cut at sub-daily granularity is not a bucket this rule may collapse,
    // whatever the incoming row looks like.
    if (!isDayBucketWindow(row.started_at, row.ended_at)) continue;
    // The payload's own account of which push is newer. A replay, or a second chunk of
    // the SAME push, is not newer — it takes nothing AND is not stored.
    if (!pushIsNewer(incoming.pushedAt, row.pushed_at)) {
      blocked.push(row);
      continue;
    }
    // The #133 lock, spelled as the #608 sweep spells it: NULL is "not locked".
    if (row.edited) locked.push(row);
    else supersede.push(row);
  }
  return { supersede, locked, blocked };
}

/** The shape `staleBatchOverlaps` needs of an incoming row. */
export interface BatchWindow {
  metric: string;
  origin?: string | null;
  started_at: string;
  ended_at: string;
}

/**
 * WITHIN ONE PUSH, the rows cut under the PREVIOUS anchoring - the ones that must not
 * be written at all.
 *
 * A push normally carries one anchoring and its windows are pairwise disjoint. A push
 * taken across a timezone change does not: #3424's rolling ~48h window re-sends the
 * pre-switch record ALONGSIDE the re-anchored one that re-contains it, and storing both
 * is the double count itself. Two rows of the same (metric, origin) that overlap INSIDE
 * ONE BATCH are therefore a mixed-anchoring pair - under the same preconditions as
 * everything else here, which is why `isSupersedingWindow` gates entry.
 *
 * IT MUST SEE THE WHOLE PAYLOAD. The first cut ran this per CHUNK and defended it with
 * an arithmetic claim about payload composition; a push over INGEST_CHUNK_SIZE rows
 * breaks the claim and splits a mixed-anchoring pair across two chunks, where the
 * per-row rule then resolved it by arrival order and deleted the CURRENT row.
 * `ingestHealthConnectPayload` computes this ONCE over `parsed.samples` and hands the
 * result to every chunk; `upsertMetricSamples` still computes it for the batch it is
 * given directly, which for every other caller IS the whole payload.
 *
 * WHICH ONE IS CURRENT IS A FRESHNESS QUESTION, NOT AN ORDER ONE. Travelling west the
 * new zone's midnight is EARLIER than the old one's (Tokyo 15:00Z to Honolulu 10:00Z),
 * so the re-anchored bucket sorts FIRST and "the row later in the batch wins" keeps the
 * stale record - measured against #3424's repro, which read 3000 steps for 3500 walked
 * under exactly that rule. These buckets end at the moment they were last pushed, so the
 * window reaching FURTHEST FORWARD is the one the exporter is still filling. That is
 * `isStaleMetricSnapshot`, #1101's own freshness test, applied to a pair that does not
 * share a key - reused rather than re-invented, and it answers correctly from either
 * travel direction.
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
    if (!isSupersedingWindow(row.metric, row.started_at, row.ended_at))
      continue;
    const key = `${row.metric} ${row.origin ?? ""}`;
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

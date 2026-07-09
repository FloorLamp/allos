// Import-review Phase 2 (issue #10): PURE duplicate/conflict detection + the pure
// halves of the merge machinery. No DB, no network — every function here takes
// already-loaded rows and returns plain data, so the whole file is exhaustively
// unit-testable (overlap math, proximity thresholds, signature stability, decision
// filtering, merge folding). The DB-touching read/decision layer that feeds these
// rows in and persists the outcome lives in lib/queries/integrations.ts; the
// user-facing actions live in app/(app)/data/review-actions.ts.
//
// THE PROBLEM. A Strava run and a manual (or Health Connect) "Morning run" logged
// for the same day are invisible to the existing external_id dedup — different
// source / external_id, so both persist and silently DOUBLE-COUNT in every rollup.
// Nothing compared two rows for near-equality, and nothing modeled a "these two
// are the same thing" relationship. This module supplies both.
//
// STABLE PAIR SIGNATURES (the crux of durability). A decision must survive the
// rolling 48h re-sync. When the user MERGES a pair we DELETE one row; if that was
// the integration row, the very next sync re-inserts it with a BRAND-NEW row id —
// so a decision keyed on row ids would silently un-resolve and the double-count
// returns. The fix: key each row's signature token on its STABLE natural identity
// (source + external_id for an integration/document row — preserved verbatim
// across re-syncs), falling back to the row id only for manual rows (which the
// sync never recreates). A sorted join of the two tokens is the pair signature,
// and it re-derives identically after a merge+re-sync, so the resolution sticks.

export type PairConfidence = "high" | "medium";

// The three terminal decisions a user can record on a detected pair. "merged" is a
// DESTRUCTIVE resolution (one row deleted, its gap-filling fields folded into the
// keeper) — which is exactly why these decisions get their own table rather than
// riding the binary snooze/dismiss findings bus (see lib/queries/integrations.ts).
export type PairDecision = "merged" | "kept-both" | "dismissed";

export const ACTIVITY_DOMAIN = "activity";
export const BODY_METRIC_DOMAIN = "body_metric";

// Proximity tolerance for the "medium" confidence fallback (times unavailable):
// duration AND distance must each match within 10%.
export const PROXIMITY_TOLERANCE = 0.1;

// ── Activity duplicate detection ──────────────────────────────────────────────

// The subset of an activities row the detector reads. Callers pass their fuller row
// (with title etc.) — the generic signatures below preserve those extra fields
// through to the UI, so nothing has to be re-joined. `edited` is intentionally READ
// but NOT used to gate detection: the user-edit lock (activities.edited) governs
// re-ingest CLOBBERING and MERGE behavior, never whether a pair is surfaced — a
// hand-edited integration row can still be a genuine duplicate of a manual one, and
// hiding it would leave the double-count in place.
export interface ActivityDupInput {
  id: number;
  date: string;
  type: string;
  source: string | null;
  external_id: string | null;
  duration_min: number | null;
  distance_km: number | null;
  start_time: string | null;
  end_time: string | null;
}

export interface ActivityDupPair<
  T extends ActivityDupInput = ActivityDupInput,
> {
  signature: string;
  confidence: PairConfidence;
  // Short human hint for the reason a pair was flagged.
  reason: string;
  // Deterministic order: the row whose signature token sorts first is `a`.
  a: T;
  b: T;
}

// A row's provenance bucket; NULL source (a manual entry) is its own bucket.
function provenance(source: string | null): string {
  return source ?? "manual";
}

// Two activities are a CROSS-SOURCE pair when their provenance differs. These are
// the classic import duplicate (a Strava run + a manual "Morning run" on one day):
// invisible to the external_id unique index (different source/external_id), so both
// persist and double-count. Two manual rows on one day are NOT flagged — a
// deliberate user choice (contrast body metrics, where duplicate manual rows ARE).
export function crossSource(
  a: Pick<ActivityDupInput, "source">,
  b: Pick<ActivityDupInput, "source">
): boolean {
  return provenance(a.source) !== provenance(b.source);
}

// Two activities are a SAME-SOURCE duplicate candidate (issue #64) when they share
// one NON-manual provenance but carry DIFFERENT external_ids. This models UPSTREAM
// double-feeding — e.g. Strava ingests one workout from both Garmin and Health
// Connect, so Allos sees two `strava` rows with distinct external_ids for the same
// session. Guards:
//   - same provenance only (crossSource pairs go through the other path);
//   - never MANUAL: two manual rows are a deliberate user act (same stance as the
//     cross-source rule), and manual rows have no external_id to tell apart anyway;
//   - both external_ids present AND different: a row is never paired with itself,
//     and a same-external_id re-sync (already deduped by the unique index) is not a
//     new duplicate.
export function sameSourceDuplicate(
  a: Pick<ActivityDupInput, "source" | "external_id">,
  b: Pick<ActivityDupInput, "source" | "external_id">
): boolean {
  const pa = provenance(a.source);
  if (pa !== provenance(b.source)) return false; // different source
  if (pa === "manual") return false; // two manual rows: excluded by design
  if (a.external_id == null || b.external_id == null) return false;
  return a.external_id !== b.external_id;
}

// The stable identity token for a row: its external_id when present (an
// integration/document row — this survives a merge+re-sync verbatim), else the row
// id (a manual row, which the sync never recreates). external_id already encodes
// the source (e.g. 'health-connect:<start>'), so it is globally unique on its own.
export function activityToken(
  r: Pick<ActivityDupInput, "id" | "external_id">
): string {
  return r.external_id ? `ext:${r.external_id}` : `id:${r.id}`;
}

// A stable, order-independent signature for a pair: the two tokens sorted and
// joined. Re-derives identically after a merge deletes one row and the next sync
// re-inserts it under the same external_id.
export function pairSignature(token1: string, token2: string): string {
  return [token1, token2].sort().join("|");
}

// Parse an activity clock field to minutes-of-day. Stored as "HH:MM" (see
// lib/activity-meta.minutesBetween and the integration normalizer), but tolerate an
// ISO timestamp by taking its time part. Returns null when unparseable.
export function parseMinutesOfDay(t: string | null): number | null {
  if (!t) return null;
  const timePart = t.includes("T") ? t.slice(t.indexOf("T") + 1) : t;
  const m = timePart.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export interface TimeWindow {
  start: number;
  end: number;
}

// The [start, end] minute window for an activity, or null when it has no usable
// start time. A missing/invalid end (or an end at/before start — a point record)
// collapses to a zero-width window at the start minute.
export function activityWindow(
  r: Pick<ActivityDupInput, "start_time" | "end_time">
): TimeWindow | null {
  const start = parseMinutesOfDay(r.start_time);
  if (start == null) return null;
  const end = parseMinutesOfDay(r.end_time);
  return { start, end: end != null && end >= start ? end : start };
}

// Closed-interval overlap (touching endpoints count — a point inside/at the edge of
// a window overlaps).
export function windowsOverlap(x: TimeWindow, y: TimeWindow): boolean {
  return x.start <= y.end && y.start <= x.end;
}

// Relative closeness within `tol` (fraction). Two zeros are equal; otherwise the
// absolute difference over the larger magnitude.
function withinTolerance(a: number, b: number, tol: number): boolean {
  const max = Math.max(Math.abs(a), Math.abs(b));
  if (max === 0) return true;
  return Math.abs(a - b) / max <= tol;
}

// The "medium" fallback when clock times aren't both available: every dimension
// both rows report (duration, distance) must be within PROXIMITY_TOLERANCE, and at
// least one dimension must actually be compared (two rows that share no comparable
// number are NOT a match).
export function proximityMatch(
  a: Pick<ActivityDupInput, "duration_min" | "distance_km">,
  b: Pick<ActivityDupInput, "duration_min" | "distance_km">
): boolean {
  let compared = 0;
  if (a.duration_min != null && b.duration_min != null) {
    if (!withinTolerance(a.duration_min, b.duration_min, PROXIMITY_TOLERANCE))
      return false;
    compared++;
  }
  if (a.distance_km != null && b.distance_km != null) {
    if (!withinTolerance(a.distance_km, b.distance_km, PROXIMITY_TOLERANCE))
      return false;
    compared++;
  }
  return compared > 0;
}

// Build a detected pair from two rows: the stable order-independent signature plus
// a deterministic a/b order (the row whose token sorts first is `a`). Pure.
function buildPair<T extends ActivityDupInput>(
  a: T,
  b: T,
  confidence: PairConfidence,
  reason: string
): ActivityDupPair<T> {
  const ta = activityToken(a);
  const tb = activityToken(b);
  const [first, second] = ta <= tb ? [a, b] : [b, a];
  return {
    signature: pairSignature(ta, tb),
    confidence,
    reason,
    a: first,
    b: second,
  };
}

// Classify one CROSS-SOURCE pair, or null when they are NOT a likely duplicate:
//   - both rows have clock windows → HIGH if they overlap, else NOT a duplicate
//     (two timed sessions at different times of day are genuinely distinct);
//   - otherwise fall back to duration/distance proximity → MEDIUM, else null.
function classifyCrossSourcePair<T extends ActivityDupInput>(
  a: T,
  b: T
): ActivityDupPair<T> | null {
  const wa = activityWindow(a);
  const wb = activityWindow(b);
  if (wa && wb) {
    if (!windowsOverlap(wa, wb)) return null;
    return buildPair(a, b, "high", "Overlapping start/end times");
  }
  if (proximityMatch(a, b))
    return buildPair(a, b, "medium", "Same day, similar duration/distance");
  return null;
}

// Classify one SAME-SOURCE pair (issue #64), or null when it is NOT a duplicate.
// HIGH confidence ONLY, and ONLY from overlapping clock windows: one person can't
// run two sessions from a single source at the same time, so overlap alone is
// strong evidence of upstream double-feeding. The duration/distance proximity
// fallback is DELIBERATELY NOT applied here — two similar same-day gym sessions from
// one source are usually legitimate, and matching them on closeness alone would
// flag real back-to-back workouts. So a same-source pair missing either window is
// left alone.
function classifySameSourcePair<T extends ActivityDupInput>(
  a: T,
  b: T
): ActivityDupPair<T> | null {
  const wa = activityWindow(a);
  const wb = activityWindow(b);
  if (!wa || !wb || !windowsOverlap(wa, wb)) return null;
  return buildPair(a, b, "high", "Overlapping times from one source");
}

// Find duplicate activity pairs within each (date, type) bucket. Two paths:
// CROSS-SOURCE pairs (high overlap OR medium proximity) and, since issue #64,
// SAME-SOURCE pairs (high overlap only). Generic over the row so callers keep their
// display fields (title, …). Ordered deterministically: HIGH confidence first, then
// by date desc, then signature.
export function findActivityDuplicates<T extends ActivityDupInput>(
  rows: T[]
): ActivityDupPair<T>[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const key = `${r.date} ${r.type}`;
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }
  const out: ActivityDupPair<T>[] = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const pair = crossSource(a, b)
          ? classifyCrossSourcePair(a, b)
          : sameSourceDuplicate(a, b)
            ? classifySameSourcePair(a, b)
            : null;
        if (pair) out.push(pair);
      }
    }
  }
  const rank: Record<PairConfidence, number> = { high: 0, medium: 1 };
  out.sort(
    (x, y) =>
      rank[x.confidence] - rank[y.confidence] ||
      y.a.date.localeCompare(x.a.date) ||
      x.signature.localeCompare(y.signature)
  );
  return out;
}

// ── Body-metric conflict detection ────────────────────────────────────────────

// The subset of a body_metrics row the detector reads (body_metrics has no
// external_id; its natural key is date + source). Callers pass their fuller row.
export interface BodyMetricConflictInput {
  id: number;
  date: string;
  weight_kg: number | null;
  body_fat_pct: number | null;
  resting_hr: number | null;
  source: string | null;
}

export interface BodyMetricConflictPair<
  T extends BodyMetricConflictInput = BodyMetricConflictInput,
> {
  signature: string;
  // Which measures both rows report (and would therefore double-count): a subset
  // of "weight" / "body fat" / "resting HR".
  measures: string[];
  reason: string;
  a: T;
  b: T;
}

// Stable identity token for a body_metrics row: source + date when sourced (an
// integration/document row re-created under the same date+source on re-sync), else
// the row id (a manual row the sync never recreates). Mirrors activityToken.
export function bodyMetricToken(
  r: Pick<BodyMetricConflictInput, "id" | "date" | "source">
): string {
  return r.source ? `bm:${r.source}@${r.date}` : `id:${r.id}`;
}

// The measures both rows carry a value for — a shared measure is a double-count
// risk. Order is stable (weight, body fat, resting HR).
export function sharedMeasures(
  a: BodyMetricConflictInput,
  b: BodyMetricConflictInput
): string[] {
  const measures: string[] = [];
  if (a.weight_kg != null && b.weight_kg != null) measures.push("weight");
  if (a.body_fat_pct != null && b.body_fat_pct != null)
    measures.push("body fat");
  if (a.resting_hr != null && b.resting_hr != null) measures.push("resting HR");
  return measures;
}

// Find conflicting body-metric pairs: same-date rows that both report at least one
// measure. UNLIKE activities this is NOT restricted to cross-source pairs — two
// manual weigh-ins on one day (or a manual row plus an integration row) both risk a
// double-count and are surfaced. Deterministic order: date desc, then signature.
export function findBodyMetricConflicts<T extends BodyMetricConflictInput>(
  rows: T[]
): BodyMetricConflictPair<T>[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const arr = groups.get(r.date);
    if (arr) arr.push(r);
    else groups.set(r.date, [r]);
  }
  const out: BodyMetricConflictPair<T>[] = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const measures = sharedMeasures(a, b);
        if (measures.length === 0) continue;
        const ta = bodyMetricToken(a);
        const tb = bodyMetricToken(b);
        const [first, second] = ta <= tb ? [a, b] : [b, a];
        out.push({
          signature: pairSignature(ta, tb),
          measures,
          reason: `Same-day ${measures.join(", ")} from two rows`,
          a: first,
          b: second,
        });
      }
    }
  }
  out.sort(
    (x, y) =>
      y.a.date.localeCompare(x.a.date) || x.signature.localeCompare(y.signature)
  );
  return out;
}

// ── Decision filtering (durability) ───────────────────────────────────────────

// Drop pairs already resolved by a recorded decision (merged / kept-both /
// dismissed). Keyed on the stable pair signature, so a decision recorded before a
// 48h re-sync still suppresses the SAME pair afterward. Generic over any object
// carrying a `signature`.
export function undecidedPairs<T extends { signature: string }>(
  pairs: T[],
  decided: ReadonlySet<string>
): T[] {
  return pairs.filter((p) => !decided.has(p.signature));
}

// ── Merge folding (pure halves of the merge action) ───────────────────────────

// Nullable activity columns folded from the DISCARDED row into the KEEPER when the
// keeper is missing them — so merging never loses a detail the other row had.
// Identity + provenance (id, date, type, title, source, external_id, created_at)
// are deliberately NOT here: they stay the keeper's.
export const ACTIVITY_FOLD_FIELDS = [
  "notes",
  "duration_min",
  "distance_km",
  "intensity",
  "start_time",
  "end_time",
  "components",
  "avg_hr",
  "max_hr",
  "elevation_m",
  "avg_speed_kmh",
  "max_speed_kmh",
  "relative_effort",
  "avg_power_w",
  "max_power_w",
  "weighted_avg_power_w",
  "avg_cadence",
  "avg_temp_c",
  "kilojoules",
  "workout_type",
] as const;

export type ActivityFoldField = (typeof ACTIVITY_FOLD_FIELDS)[number];

// The folded value per column: the keeper's own value wins, the discarded row only
// fills a gap (COALESCE(keep, drop)). Pure; the action applies the result via a
// scoped UPDATE.
export function foldActivityFields(
  keep: Record<string, unknown>,
  drop: Record<string, unknown>
): Record<ActivityFoldField, unknown> {
  const out = {} as Record<ActivityFoldField, unknown>;
  for (const f of ACTIVITY_FOLD_FIELDS) {
    out[f] = keep[f] ?? drop[f] ?? null;
  }
  return out;
}

// How many fold-fields a row actually populates — a "richness" score used to pick a
// default keeper. Accepts any row object and reads the fold columns dynamically.
export function activityRichness(row: object): number {
  const r = row as Record<string, unknown>;
  let n = 0;
  for (const f of ACTIVITY_FOLD_FIELDS) if (r[f] != null) n++;
  return n;
}

// The row id to keep BY DEFAULT when merging: prefer the integration-owned (sourced)
// row over a manual one; break ties by richness, then by lower id for stability.
// The UI seeds its "keep" selection with this but always lets the user override.
export function preferActivityKeeper(
  a: Pick<ActivityDupInput, "id" | "source">,
  b: Pick<ActivityDupInput, "id" | "source">
): number {
  const aSourced = a.source != null;
  const bSourced = b.source != null;
  if (aSourced !== bSourced) return aSourced ? a.id : b.id;
  const ra = activityRichness(a);
  const rb = activityRichness(b);
  if (ra !== rb) return ra > rb ? a.id : b.id;
  return a.id <= b.id ? a.id : b.id;
}

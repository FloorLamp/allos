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
  // The user-edit lock (activities.edited, #133). READ but NOT used to gate
  // DETECTION (see the note above); the AUTO-merge path (issue #1081) does consult it
  // to protect a hand-edited member. Optional so the detect-only callers that don't
  // load it still typecheck.
  edited?: number | null;
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

// Find duplicate activity pairs within each DATE bucket. Two paths: CROSS-SOURCE
// pairs (high overlap OR medium proximity) and, since issue #64, SAME-SOURCE pairs
// (high overlap only). Generic over the row so callers keep their display fields
// (title, …). Ordered deterministically: HIGH confidence first, then by date desc,
// then signature.
//
// The bucket is date-only, and the ACTIVITY TYPE gate now applies to the
// cross-source path ALONE. Grouping on (date, type) assumed the two records of one
// session agree about what that session was — which is false exactly where the
// same-source path is aimed. Health Connect can hold ONE bike ride twice, written by
// the same app seconds apart, typed OTHER_WORKOUT on one record and BIKING on the
// other; those classify to `sport` and `cardio`, land in different buckets, and are
// never compared — so the ride double-counts in every distance rollup with nothing
// surfaced in Review. (It was masked while the parser could not read numeric
// AndroidX exercise types: both records fell through to `sport`, so they shared a
// bucket by accident. Teaching the parser those constants made the pair honest and
// this blind spot visible.)
//
// Dropping the gate here is safe because classifySameSourcePair requires OVERLAPPING
// time windows — a run and a swim logged by one provider on one day don't overlap,
// so a genuinely distinct session is still never paired. The cross-source path keeps
// the type gate: it also matches on mere PROXIMITY (10% duration/distance), which
// without a type check would start pairing a 30-minute run with a 30-minute swim.
export function findActivityDuplicates<T extends ActivityDupInput>(
  rows: T[]
): ActivityDupPair<T>[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const arr = groups.get(r.date);
    if (arr) arr.push(r);
    else groups.set(r.date, [r]);
  }
  const out: ActivityDupPair<T>[] = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const pair = crossSource(a, b)
          ? a.type === b.type
            ? classifyCrossSourcePair(a, b)
            : null
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
  // Which measures the pair actually disagrees on (and would therefore
  // double-count): a subset of "weight" / "body fat" / "resting HR". For a
  // cross-source pair the exactly-equal shared measures are excluded (#1615) — an
  // equal reading from two sources is normal multi-source storage, not a conflict.
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

// The three measures a body_metrics row can carry, with the label the Review reason
// uses. ONE table so "which measures overlap" and "which measures disagree" can never
// drift apart or reorder (stable: weight, body fat, resting HR).
const BODY_MEASURES: {
  label: string;
  value: (r: BodyMetricConflictInput) => number | null;
}[] = [
  { label: "weight", value: (r) => r.weight_kg },
  { label: "body fat", value: (r) => r.body_fat_pct },
  { label: "resting HR", value: (r) => r.resting_hr },
];

// The measures both rows carry a value for — the overlap, regardless of whether the
// two values agree. Order is stable (weight, body fat, resting HR).
export function sharedMeasures(
  a: BodyMetricConflictInput,
  b: BodyMetricConflictInput
): string[] {
  return BODY_MEASURES.filter(
    (m) => m.value(a) != null && m.value(b) != null
  ).map((m) => m.label);
}

// The shared measures that actually DISAGREE — what Review should ask about (#1615).
//
// body_metrics deliberately keeps one row per (profile_id, date, source) so source
// comparison and per-metric source priority work (#14). Two sources reporting the
// SAME number for a day is therefore normal multi-source storage, not an unresolved
// conflict: there is nothing to decide, and the destructive merge would arbitrarily
// discard one source's provenance. So for a CROSS-PROVENANCE pair only the measures
// whose stored values differ are reportable; equality is exact in canonical storage
// units (55 === 55 auto-resolves, 55 !== 56 stays reviewable — no tolerance).
//
// SAME-PROVENANCE pairs keep the old behavior: two manual (source IS NULL) rows, or
// two rows from one source, are DUPLICATE RECORDS rather than intentional multi-source
// observations, so identical values are still worth surfacing. Pure → unit-testable.
export function conflictingMeasures(
  a: BodyMetricConflictInput,
  b: BodyMetricConflictInput
): string[] {
  const cross = crossSource(a, b);
  return BODY_MEASURES.filter((m) => {
    const av = m.value(a);
    const bv = m.value(b);
    if (av == null || bv == null) return false; // not shared → no double-count risk
    return cross ? av !== bv : true;
  }).map((m) => m.label);
}

// Find conflicting body-metric pairs: same-date rows that both report at least one
// DISAGREEING measure. UNLIKE activities this is NOT restricted to cross-source pairs
// — two manual weigh-ins on one day (or a manual row plus an integration row) both
// risk a double-count and are surfaced. A cross-source pair whose shared measures are
// all exactly equal is normal multi-source storage and never enters Review (#1615);
// when only some shared measures differ, the pair names only those.
// Deterministic order: date desc, then signature.
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
        const measures = conflictingMeasures(a, b);
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

// The signatures whose recorded decision should keep SUPPRESSING a re-detected pair
// (#507). A pair is only in the detector's input when BOTH its rows exist again — so a
// re-detected pair means the pair RE-FORMED. For 'kept-both'/'dismissed' the user ruled
// the pair fine as-is, so it stays suppressed. But a re-formed 'merged' pair means the
// resync UNDID the merge (the absorbed row came back) — the decision must NOT convert
// that regression into permanent silence, so 'merged' is EXCLUDED here and the pair
// resurfaces in Review. (The re-import tombstone normally prevents the resurrection
// upstream; this is the safety net for when it misses.) Pure → unit-testable.
export function suppressingSignatures(
  decisions: ReadonlyMap<string, PairDecision>
): Set<string> {
  const out = new Set<string>();
  for (const [signature, decision] of decisions) {
    if (decision !== "merged") out.add(signature);
  }
  return out;
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

// Measurement columns where a stored 0 cannot be a real workout value — it's a
// source's "sensor didn't record this" filler (issue #93) — so the fold and the
// richness score treat 0 the same as NULL. Deliberately NOT here: avg_temp_c
// (0 °C is a legitimate reading) and workout_type (0 is a meaningful value in
// Strava's enum).
export const ZERO_IS_MISSING_FIELDS: ReadonlySet<ActivityFoldField> = new Set([
  "duration_min",
  "distance_km",
  "elevation_m",
  "avg_hr",
  "max_hr",
  "avg_speed_kmh",
  "max_speed_kmh",
  "relative_effort",
  "avg_power_w",
  "max_power_w",
  "weighted_avg_power_w",
  "avg_cadence",
  "kilojoules",
] as ActivityFoldField[]);

// Whether a row actually carries data for a fold column: non-null, and for the
// measurement columns above, non-zero. Exported so the conflict detector
// (lib/import-review/conflicts.ts, issue #100) shares the SAME zero-as-missing
// semantics — never a fork.
export function hasFoldValue(f: ActivityFoldField, v: unknown): boolean {
  if (v == null) return false;
  return !(ZERO_IS_MISSING_FIELDS.has(f) && v === 0);
}

// The folded value per column: the keeper's own value wins, the discarded row only
// fills a gap. A "gap" is NULL — or a zero on the measurement columns, so a keeper
// showing "0 mi" inherits the other row's real distance (#93). When neither row
// has real data the keeper's stored value (0 or NULL) is preserved. Pure; the
// action applies the result via a scoped UPDATE.
export function foldActivityFields(
  keep: Record<string, unknown>,
  drop: Record<string, unknown>
): Record<ActivityFoldField, unknown> {
  const out = {} as Record<ActivityFoldField, unknown>;
  for (const f of ACTIVITY_FOLD_FIELDS) {
    out[f] = hasFoldValue(f, keep[f])
      ? keep[f]
      : hasFoldValue(f, drop[f])
        ? drop[f]
        : (keep[f] ?? drop[f] ?? null);
  }
  return out;
}

// How many fold-fields a row actually populates — a "richness" score used to pick a
// default keeper. Zero-filled measurement columns don't count (#93), so a source
// row padded with zeroes can't out-rich a manual row with real values and steer
// the default keeper into the lossy side of the fold. Accepts any row object and
// reads the fold columns dynamically.
export function activityRichness(row: object): number {
  const r = row as Record<string, unknown>;
  let n = 0;
  for (const f of ACTIVITY_FOLD_FIELDS) if (hasFoldValue(f, r[f])) n++;
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

// ── N-way clustering + generalized keeper (issue #1081) ───────────────────────

// A connected group of duplicate rows — the transitive closure of the pairwise
// detections within one (date, type) bucket. Four cross-source rows that pairwise
// match land in ONE cluster (instead of C(4,2)=6 pair cards); two genuinely distinct
// non-overlapping same-day sessions were never paired, so they stay TWO clusters.
export interface ActivityDupCluster<
  T extends ActivityDupInput = ActivityDupInput,
> {
  // Stable cluster signature: the sorted join of ALL members' activityTokens. It
  // re-derives identically after a merge+re-sync (the survivor keeps its token, a
  // re-inserted integration row keeps its external_id-derived token), so a re-formed
  // cluster is recognizable. For a 2-row cluster it equals the pair signature.
  signature: string;
  // Highest constituent pair confidence (high beats medium).
  confidence: PairConfidence;
  // Member rows, deduped, deterministic order (by activityToken).
  members: T[];
  // The constituent detected PAIR signatures — recorded as `merged` decisions so a
  // partially re-formed cluster still re-surfaces via the pairwise re-detection
  // (never a cluster-only key the pair detector can't see). Sorted for stability.
  pairSignatures: string[];
  // A short human hint (from the highest-confidence constituent pair).
  reason: string;
  // The bucket date (every member shares date + type).
  date: string;
}

// Group pairwise detections into connected components (union-find over shared row
// membership). Pure — the caller feeds it the same pairs findActivityDuplicates
// returns. Deterministic order: high confidence first, then date desc, then signature.
export function clusterActivityDuplicates<T extends ActivityDupInput>(
  pairs: ActivityDupPair<T>[]
): ActivityDupCluster<T>[] {
  const parent = new Map<number, number>();
  const rowById = new Map<number, T>();
  const ensure = (x: number): void => {
    if (!parent.has(x)) parent.set(x, x);
  };
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as number;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as number;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    ensure(a);
    ensure(b);
    parent.set(find(a), find(b));
  };
  for (const p of pairs) {
    rowById.set(p.a.id, p.a);
    rowById.set(p.b.id, p.b);
    union(p.a.id, p.b.id);
  }

  const membersByRoot = new Map<number, Map<number, T>>();
  for (const id of parent.keys()) {
    const root = find(id);
    let m = membersByRoot.get(root);
    if (!m) membersByRoot.set(root, (m = new Map()));
    m.set(id, rowById.get(id) as T);
  }
  const pairsByRoot = new Map<number, ActivityDupPair<T>[]>();
  for (const p of pairs) {
    const root = find(p.a.id);
    const arr = pairsByRoot.get(root);
    if (arr) arr.push(p);
    else pairsByRoot.set(root, [p]);
  }

  const clusters: ActivityDupCluster<T>[] = [];
  for (const [root, memberMap] of membersByRoot) {
    const members = [...memberMap.values()].sort((a, b) =>
      activityToken(a).localeCompare(activityToken(b))
    );
    const clusterPairs = pairsByRoot.get(root) ?? [];
    const confidence: PairConfidence = clusterPairs.some(
      (p) => p.confidence === "high"
    )
      ? "high"
      : "medium";
    const reason =
      (clusterPairs.find((p) => p.confidence === confidence) ?? clusterPairs[0])
        ?.reason ?? "";
    clusters.push({
      signature: members
        .map((m) => activityToken(m))
        .sort()
        .join("|"),
      confidence,
      members,
      pairSignatures: clusterPairs.map((p) => p.signature).sort(),
      reason,
      date: members[0].date,
    });
  }
  const rank: Record<PairConfidence, number> = { high: 0, medium: 1 };
  clusters.sort(
    (x, y) =>
      rank[x.confidence] - rank[y.confidence] ||
      y.date.localeCompare(x.date) ||
      x.signature.localeCompare(y.signature)
  );
  return clusters;
}

// The default keeper across N members — the pairwise preferActivityKeeper reduced to
// a single winner (sourced desc → richness desc → lowest id). Since that order is
// total (ids are unique), the reduce is order-independent. The manual UI (Review +
// Journal) seeds its keeper selection with this but always lets the user override.
export function preferActivityKeeperId<
  T extends Pick<ActivityDupInput, "id" | "source">,
>(members: T[]): number {
  return members.reduce((best, m) =>
    preferActivityKeeper(best, m) === best.id ? best : m
  ).id;
}

// Deterministic order to fold drops into the keeper: by activityToken, so the fold
// result is reproducible across a re-sync (raw ids aren't). Pure.
export function orderDropsForFold<T extends ActivityDupInput>(drops: T[]): T[] {
  return [...drops].sort((a, b) =>
    activityToken(a).localeCompare(activityToken(b))
  );
}

// ── High-confidence auto-merge decision (issue #1081) ─────────────────────────

// Whether a member is edit-locked (activities.edited, #133) — a deliberate user
// hand-edit the auto path must protect. Truthy `edited` only.
function isEditedMember(m: ActivityDupInput): boolean {
  return !!m.edited;
}

// Does the cluster carry a MATERIAL disagreement on a magnitude fold-field (distance
// or duration) — i.e. members that differ beyond PROXIMITY_TOLERANCE? The keeper rule
// decides WHICH row survives, not WHETHER the numbers agree; when they don't, an
// unattended auto-merge would silently drop real data, so we bail to manual Review.
function hasMaterialConflict(members: ActivityDupInput[]): boolean {
  for (const f of ["duration_min", "distance_km"] as const) {
    const vals = members
      .map((m) => m[f])
      .filter((v): v is number => typeof v === "number" && hasFoldValue(f, v));
    if (vals.length < 2) continue;
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    if (!withinTolerance(lo, hi, PROXIMITY_TOLERANCE)) return true;
  }
  return false;
}

// The auto-merge keeper across N members with the auto-specific hardenings over the
// human default (a person can't watch an unattended merge, and can't override):
//   - tiebreak on the STABLE activityToken (source+external_id), not the raw id, so
//     two runs / a concurrent tick agree;
//   - otherwise the same sourced-desc → richness-desc order as the manual default.
function autoMergeKeeperId<T extends ActivityDupInput>(members: T[]): number {
  return members.reduce((best, m) => {
    const bSourced = best.source != null;
    const mSourced = m.source != null;
    if (bSourced !== mSourced) return bSourced ? best : m;
    const rb = activityRichness(best);
    const rm = activityRichness(m);
    if (rb !== rm) return rb > rm ? best : m;
    return activityToken(best) <= activityToken(m) ? best : m;
  }).id;
}

// The keeper + drops for an AUTO-merge, or null when the cluster must wait for a
// human. Fires ONLY on the unambiguous case: a cross-source group whose clock windows
// genuinely overlap (one person can't run two timed sessions at once), with no
// material fold-field conflict, and no more than one edit-locked member. When exactly
// one member is edit-locked it is KEPT (explicit user intent wins the keeper slot);
// two or more edit-locked members is ambiguous → manual. Pure.
export interface ClusterAutoMerge {
  keepId: number;
  dropIds: number[];
}
export function autoMergeCluster<T extends ActivityDupInput>(
  members: T[]
): ClusterAutoMerge | null {
  if (members.length < 2) return null;
  // Cross-source group only — two provenances must be present.
  const provs = new Set(members.map((m) => provenance(m.source)));
  if (provs.size < 2) return null;
  // Every member has a clock window AND all windows mutually overlap.
  const windows = members.map((m) => activityWindow(m));
  if (windows.some((w) => w == null)) return null;
  for (let i = 0; i < windows.length; i++)
    for (let j = i + 1; j < windows.length; j++)
      if (!windowsOverlap(windows[i] as TimeWindow, windows[j] as TimeWindow))
        return null;
  // No silent data loss: bail on a material distance/duration disagreement.
  if (hasMaterialConflict(members)) return null;
  // Edit-lock protection.
  const edited = members.filter(isEditedMember);
  if (edited.length > 1) return null;
  const keepId =
    edited.length === 1 ? edited[0].id : autoMergeKeeperId(members);
  return {
    keepId,
    dropIds: members.filter((m) => m.id !== keepId).map((m) => m.id),
  };
}

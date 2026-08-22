import { db } from "@/lib/db";
import { sqlNow } from "@/lib/clock";
import type { ActivityType, ActivityComponent, MedicalFlag } from "@/lib/types";
import {
  normalizeResultStatus,
  supersedesReading,
} from "@/lib/lab-result-lifecycle";
import { insertObservationRevision } from "@/lib/queries/medical/revisions";
import {
  hasBodyMetric,
  mergeBodyMetricPartialAware,
  type BodyMetricValues,
} from "@/lib/body-metric-extract";
import { collapseBodyMetricsByDate } from "./body-metric-collapse";
import type { Kg, Km } from "@/lib/units";
import {
  emptyCounts,
  rowsEqual,
  isEditLocked,
  classifyUpsert,
  tallyUpsert,
} from "./sync-log";
import type { UpsertCounts, SyncRowSink } from "./sync-log";
import { loadImportTombstones } from "./tombstones";
import {
  bodyMetricTombstoneKey,
  metricSampleTombstoneKey,
} from "./tombstone-keys";
import { isStaleMetricSnapshot } from "@/lib/metric-snapshot";
import {
  compareWindowStarts,
  isSupersedingWindow,
  planSupersede,
  supersedeDateRange,
  windowsOverlap,
  type MetricWindow,
  type UnstampedEra,
} from "@/lib/metric-window-overlap";
import { readUnstampedEra } from "./unstamped-era";
import { HEALTH_CONNECT_ID } from "./health-connect";
import { streamKeysPlacedIn } from "@/lib/reading-placement";

// Source-agnostic record shapes. Every integration parses its own payload into
// these, then calls the shared upserts below — so a new source (Strava, Garmin)
// reuses all of the DB mapping and idempotency logic.

// Per-day body metrics. weight_kg may be undefined (e.g. a body-fat-only day).
//
// `weight_kg` is BRANDED (#2149): the column stores kilograms, so a parser must state
// the unit its source reported in by minting through `toKg` — `toKg(lbs, "lb")` for
// a source that reports pounds, `toKg(v, "kg")` for one that already reports the
// canonical unit. A raw `number` no longer compiles here, which is what stops a
// display-unit or wrong-unit payload from reaching `body_metrics.weight_kg`.
export interface NormBodyMetric {
  date: string; // YYYY-MM-DD (local)
  weight_kg?: Kg;
  body_fat_pct?: number;
  resting_hr?: number;
  // The absolute instant (ISO) this reading was taken. Only used to collapse multiple
  // same-date readings within a batch deterministically (#605) — the LATEST non-null
  // value wins per field. Sources that already emit one row per date (Health
  // Connect) omit it; Withings/Oura set it so their unsorted per-reading rows fold
  // in chronological order. Never persisted.
  measured_at?: string;
  // The day is only PARTIALLY covered by this batch's rolling window (#606): its
  // body-fat / resting-HR day-averages were computed from a partial tail of the day's
  // samples, so they must not overwrite a fuller value stored when the day was wholly
  // in the window. Set by the Health Connect parser for the oldest day in a push.
  // Never persisted.
  partial_day?: boolean;
}

export interface NormMetricSample {
  metric: string; // 'steps','distance_km','active_kcal','total_kcal','hrv_ms'
  date: string; // YYYY-MM-DD in the profile timezone at ingest (#94); started_at is the natural key
  started_at: string; // absolute ISO instant; point records set start == end
  ended_at: string;
  value: number;
  // Source-within-source provenance. Health Connect can carry records from
  // several origin apps (for example Fitbit and Garmin) under the single
  // `health-connect` integration source. Other integrations omit it.
  origin?: string | null;
  // Stable identity of the imported activity this sample describes. Unlike the
  // sample window, this survives user edits to the activity's date/clock fields.
  // Null/omitted for standalone metrics (steps, sleep, daily energy, etc.).
  activity_external_id?: string | null;
}

// A pre-aggregated 1-minute heart-rate bucket from the incoming batch.
export interface NormHrMinute {
  ts: string; // 'YYYY-MM-DDTHH:MM' profile-local at ingest, no zone stored (#94)
  bpm: number; // average of this batch's samples in the minute
  bpm_min: number;
  bpm_max: number;
  n: number; // sample count in this batch
}

export interface NormActivity {
  external_id: string; // dedup key, e.g. 'health-connect:<start ISO>'
  date: string; // YYYY-MM-DD (local)
  type: ActivityType;
  title: string;
  duration_min: number | null;
  // BRANDED (#2149), for the same reason as NormBodyMetric.weight_kg: sources report
  // distance in metres (Strava), miles, or kilometres, and `activities.distance_km`
  // stores kilometres. A parser states which by minting through `toKm`.
  distance_km: Km | null;
  start_time: string | null; // HH:MM
  end_time: string | null; // HH:MM
  // Richer per-activity metrics (Strava). All optional — a source that omits a
  // field leaves the column null. Power/cadence/kilojoules are cycling-only,
  // avg_temp_c is outdoor-only, workout_type is a label (see strava.ts).
  avg_hr?: number | null;
  max_hr?: number | null;
  elevation_m?: number | null;
  avg_speed_kmh?: number | null;
  max_speed_kmh?: number | null;
  relative_effort?: number | null;
  avg_power_w?: number | null;
  max_power_w?: number | null;
  weighted_avg_power_w?: number | null;
  avg_cadence?: number | null;
  avg_temp_c?: number | null;
  kilojoules?: number | null;
  workout_type?: string | null;
  // Session effort level on the app's manual-entry scale ('easy' | 'moderate' |
  // 'hard'), the one column an integration can fill in activities.intensity (Oura
  // reports it directly). NULL for sources that don't supply it (Strava, Health
  // Connect) — see mapOuraWorkout.
  intensity?: string | null;
  // Structured components (e.g. a single canonical-sport entry for a Strava ride)
  // persisted to the activities.components JSON column. Cardio/sport summaries group
  // by component name (see effortEntries/getCardioByActivity), so a Strava row with a
  // "Cycling" component groups under Cycling even though its title is the athlete's
  // freeform name. Omitted/null for sources (Health Connect) that don't set it.
  components?: ActivityComponent[] | null;
}

// A source-owned wellness-practice session. Unlike training activities, practices
// live in their own ledger and carry no exercise type, distance, sets, or components.
export interface NormPracticeLog {
  external_id: string;
  practice: string;
  date: string;
  time: string | null;
  duration_min: number | null;
}

export function upsertPracticeLogs(
  profileId: number,
  rows: NormPracticeLog[],
  source: string,
  sink?: SyncRowSink
): UpsertCounts {
  const compareCols = ["practice", "date", "time", "duration_min", "source"];
  const find = db.prepare(
    `SELECT id, edited, practice, date, time, duration_min, source
       FROM practice_logs WHERE profile_id = ? AND external_id = ?`
  );
  const insert = db.prepare(
    `INSERT INTO practice_logs
       (profile_id, practice, date, time, duration_min, source, external_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const update = db.prepare(
    `UPDATE practice_logs
        SET practice = ?, date = ?, time = ?, duration_min = ?, source = ?
      WHERE id = ? AND profile_id = ?`
  );
  // Fitbit meditations originally landed in activities. Migration 118 moves the
  // untouched rows, but deliberately leaves a user-edited/attached activity in
  // place. Preserve that cross-table occupancy on every later re-import so the same
  // source record cannot also appear as a practice.
  const findLegacyActivity = db.prepare(
    `SELECT edited FROM activities
      WHERE profile_id = ? AND external_id = ?`
  );
  const tombstoned = loadImportTombstones(profileId, "practice_logs");
  // A meditation deleted before migration 118 has its suppression recorded against
  // the old target table. The source identity did not change when its destination
  // did, so that deletion must continue to suppress the rerouted practice.
  const legacyActivityTombstones = loadImportTombstones(
    profileId,
    "activities"
  );
  const counts = emptyCounts();

  for (const row of rows) {
    const found = find.get(profileId, row.external_id) as
      | (Record<string, unknown> & { id: number; edited: number | null })
      | undefined;
    if (found && isEditLocked(found.edited)) {
      counts.edited++;
      continue;
    }
    if (found) {
      const post: Record<string, unknown> = {
        practice: row.practice,
        date: row.date,
        time: row.time,
        duration_min: row.duration_min,
        source,
      };
      const disposition = classifyUpsert(
        true,
        rowsEqual(compareCols, found, post)
      );
      if (disposition === "updated") {
        update.run(
          row.practice,
          row.date,
          row.time,
          row.duration_min,
          source,
          found.id,
          profileId
        );
        sink?.push({
          target_table: "practice_logs",
          target_id: found.id,
          disposition,
        });
      }
      tallyUpsert(counts, disposition);
    } else if (
      tombstoned.has(row.external_id) ||
      legacyActivityTombstones.has(row.external_id)
    ) {
      counts.suppressed++;
    } else {
      const legacyActivity = findLegacyActivity.get(
        profileId,
        row.external_id
      ) as { edited: number | null } | undefined;
      if (legacyActivity) {
        if (isEditLocked(legacyActivity.edited)) counts.edited++;
        else counts.suppressed++;
        continue;
      }
      const info = insert.run(
        profileId,
        row.practice,
        row.date,
        row.time,
        row.duration_min,
        source,
        row.external_id
      );
      const disposition = classifyUpsert(false, false);
      tallyUpsert(counts, disposition);
      sink?.push({
        target_table: "practice_logs",
        target_id: Number(info.lastInsertRowid),
        disposition: "inserted",
      });
    }
  }
  return counts;
}

// A GPS route for an activity → activity_routes (issue #569). Source-agnostic:
// carries the encoded polyline as delivered plus optional start/end coordinates,
// keyed to its parent activity by `external_id` (resolved to the activity's DB id
// at upsert time). Source-owned and never hand-edited, so no edit-lock applies.
export interface NormActivityRoute {
  external_id: string; // the parent activity's external_id (dedup key)
  polyline: string; // Google encoded polyline, as delivered
  start_lat: number | null;
  start_lng: number | null;
  end_lat: number | null;
  end_lng: number | null;
}

// The extra metric columns NormActivity carries beyond the base fields, in a
// fixed order shared by the INSERT/UPDATE statements below. Kept in one place so
// the column list, placeholders, and bound values can't drift apart.
const ACTIVITY_METRIC_COLS = [
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
  "intensity",
] as const;

function activityMetricValues(r: NormActivity): (number | string | null)[] {
  return ACTIVITY_METRIC_COLS.map((c) => r[c] ?? null);
}

// A clinical vital / lab reading → medical_records. canonical groups it with
// the same analyte from manual entry / documents; external_id dedups re-syncs.
export interface NormVital {
  external_id: string; // 'health-connect:<canonical>:<time>'
  date: string; // YYYY-MM-DD (local)
  // The instant the reading was taken, canonical UTC (`utcInstant` shape) —
  // destined for medical_records.occurred_at (#2154). The parsers were already
  // encoding this moment into `external_id`; now it is queryable data too.
  // `external_id` STAYS the dedupe key, unchanged — occurred_at is descriptive,
  // never identity. Absent/null for a source whose reading is a DAILY AGGREGATE
  // (Fitbit Takeout's daily SpO₂/respiratory files): a vendor day-summary has no
  // event instant, and NULL is the honest day-grain answer.
  occurred_at?: string | null;
  // #2479 part 2: `biomarker` is GONE from this union, not merely unused. It was the
  // legacy catch-all, and a source writing it (VO2 Max did, from Health Connect and
  // Withings) refilled the very bucket migration 185 empties. The narrowing is the
  // guard: a parser that reaches for it no longer compiles.
  category: "vitals" | "lab";
  name: string;
  canonical: string;
  value_num: number;
  unit: string;
  // The result's place in the lab lifecycle when the SOURCE states one (#1404) —
  // FHIR `Observation.status`: preliminary / final / corrected / amended. Optional:
  // a device/vitals feed states nothing, which stays NULL ("unstated"), never a
  // guessed 'final'. A source that re-issues a value as 'corrected' makes the
  // supersession explicit rather than leaving it to be inferred from the diff.
  result_status?: string | null;
}

export interface IngestCounts {
  bodyMetrics: number;
  samples: number;
  hrMinutes: number;
  activities: number;
  vitals: number;
}

// Upsert one imported body-metrics row per day, keyed by date + source. Only ever
// touches the row this source created — manually-entered rows (and rows from other
// sources) are never read or modified. Weight, body fat, and resting HR all live
// here now; a row may carry any subset (weight_kg is nullable). On update
// the incoming reading is folded into the stored row by mergeBodyMetric (pure,
// tested): a later sync window with only some of the three fills the gaps without
// blanking a value an earlier window stored, while a fresh non-null value (e.g. a
// corrected weight) still overwrites.
export function upsertBodyMetrics(
  profileId: number,
  rows: NormBodyMetric[],
  source: string,
  sink?: SyncRowSink
): UpsertCounts {
  // Pre-image on the (profile_id, date, source) natural key — now a DB UNIQUE index
  // (#133), which also lets the write below use ON CONFLICT DO UPDATE. `edited` is
  // the user-edit lock: a source-owned row the user has hand-edited (via the Review
  // resolver) is left alone on re-ingest so the rolling window never clobbers it.
  const find = db.prepare(
    "SELECT id, edited, weight_kg, body_fat_pct, resting_hr FROM body_metrics WHERE profile_id = ? AND date = ? AND source IS ? ORDER BY id LIMIT 1"
  );
  // Atomic upsert on the unique key: the bound values are the RESOLVED post-image
  // (incoming for a fresh row, mergeBodyMetric(mine, incoming) for an existing one),
  // so `excluded.*` already carries the merged triple and DO UPDATE writes it.
  const upsert = db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg, body_fat_pct, resting_hr, source)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, date, source) DO UPDATE SET
       weight_kg = excluded.weight_kg,
       body_fat_pct = excluded.body_fat_pct,
       resting_hr = excluded.resting_hr`
  );

  // Re-import tombstones for body_metrics: a source-owned row the user merged away or
  // deleted must NOT be re-inserted by the rolling window (#507/#508). Loaded once.
  const tombstoned = loadImportTombstones(profileId, "body_metrics");
  const counts = emptyCounts();
  // Collapse multiple same-date readings in this batch to one row per date FIRST
  // (#605), so the stored triple is independent of the order the source returned
  // its readings (Withings/Oura push one row per reading with no per-date collapse)
  // and a multi-weigh-in day no longer flip-flops on every re-scan.
  const collapsed = collapseBodyMetricsByDate(rows);
  for (const r of collapsed) {
    const incoming: BodyMetricValues = {
      weight_kg: r.weight_kg ?? null,
      body_fat_pct: r.body_fat_pct ?? null,
      resting_hr: r.resting_hr ?? null,
    };
    if (!hasBodyMetric(incoming)) continue; // nothing to store
    const mine = find.get(profileId, r.date, source) as
      (BodyMetricValues & { id: number; edited: number | null }) | undefined;
    // No live row AND a tombstone for this (date, source): the user removed it — skip
    // the re-insert and count it suppressed (a live row wins; the tombstone is stale).
    if (!mine && tombstoned.has(bodyMetricTombstoneKey(r.date, source))) {
      counts.suppressed++;
      continue;
    }
    // A hand-edited imported row is never overwritten; count it in its own `edited`
    // split (#659) — we deliberately persist nothing, but this is NOT an ordinary
    // no-op re-send, so it must be visible in Review rather than hidden in
    // `unchanged`. Mirrors the vitals + activities paths below.
    if (mine && isEditLocked(mine.edited)) {
      counts.edited++;
      continue;
    }
    // Resolved post-image: the merge fills gaps and lets a fresh non-null value
    // (a corrected weight) overwrite; a fresh row stores the incoming triple as-is.
    // On a partially-covered day (#606) the incoming body-fat/RHR "day average" was
    // computed from only a tail of the day's samples, so it must NOT overwrite a
    // fuller stored value — the partial-aware merge keeps the existing average there.
    const post = mine
      ? mergeBodyMetricPartialAware(mine, incoming, !!r.partial_day)
      : incoming;
    const equal =
      !!mine &&
      rowsEqual(
        BODY_METRIC_COMPARE_COLS,
        mine as unknown as Record<string, unknown>,
        post as unknown as Record<string, unknown>
      );
    const disposition = classifyUpsert(!!mine, equal);
    if (disposition === "unchanged") {
      // A window that only re-states already-stored values is a no-op → unchanged;
      // skip the redundant write.
      tallyUpsert(counts, disposition);
      continue;
    }
    const info = upsert.run(
      profileId,
      r.date,
      post.weight_kg,
      post.body_fat_pct,
      post.resting_hr,
      source
    );
    tallyUpsert(counts, disposition);
    // Per-row provenance (#1333): the affected row id is the pre-image row's id on an
    // update, else the freshly-inserted rowid. Only inserted/updated reach here.
    sink?.push({
      target_table: "body_metrics",
      target_id: mine ? mine.id : Number(info.lastInsertRowid),
      disposition,
    });
  }
  return counts;
}

const BODY_METRIC_COMPARE_COLS: string[] = [
  "weight_kg",
  "body_fat_pct",
  "resting_hr",
];

// Body-metric measures that live in body_metrics (body_fat_pct/resting_hr), NOT in
// metric_samples. A one-time fold moved body fat / resting HR out of metric_samples into
// body_metrics so every source of them shares one home; parsers route these to
// upsertBodyMetrics. This set is the guard (below) that keeps a future path from
// re-splitting them back into metric_samples, whose `metric` is free text.
//
// DERIVED FROM THE PLACEMENT POLICY (#2032), not hand-kept beside it. These are exactly
// the stream keys a registered reading identity places in `body_metrics`, so the guard
// and the write core cannot come to disagree about where a quantity belongs — which is
// the whole failure this sweep exists to catch, one layer up.
export const BODY_METRIC_SAMPLE_MEASURES: readonly string[] =
  streamKeysPlacedIn("body_metrics");

// THE SOURCE WHOSE INTERVAL ROWS SUPERSEDE WHAT THEY OVERLAP (#3424).
//
// Health Connect is the ONE source whose day-buckets re-anchor under the app's feet:
// the exporter follows the DEVICE zone, so a timezone change re-cuts "today" and the
// re-anchored record arrives with a start the natural key has never seen (see
// lib/metric-window-overlap.ts for the whole mechanism). Withings, Oura, Strava and
// the Fitbit takeout attribute each reading on their own clock and re-send the same
// key, and manual readings are the user's own rows — none of them may ever have a row
// deleted by this path, which is why the rule is gated on the source id rather than on
// a shape test that a future source could accidentally match.
const OVERLAP_SUPERSEDE_SOURCE = HEALTH_CONNECT_ID;

// Idempotent on (profile_id, metric, source, origin, started_at): a resent
// record from the SAME source overwrites itself, but two DIFFERENT sources
// (or two origins inside Health Connect) each keep their own row. `ended_at` is
// deliberately mutable: daily cumulative exporter snapshots keep a stable start
// while their end advances to the push moment (#1101).
//
// AND, FOR HEALTH CONNECT ONLY, the stored rows a push's windows overlap are DELETED
// before it is written (#3424). That is what the start-keyed idempotency of #1101 cannot
// do: a moving END overwrites its own key, a moving START mints a new one and leaves the
// old row summing into the same profile-local day. Edit-locked rows survive it,
// tombstoned rows stay dead, and point readings are untouched.
//
// THAT DELETE DOES NOT HAPPEN IN THIS FUNCTION. It is planned over the whole push before
// anything is written, and applied once, in the transaction of the push's LAST chunk —
// `planMetricSampleSupersede` and `applyMetricSampleSupersede` below, whose headers carry
// the argument for each half. All this function does for the rule is write `pushed_at`.
//
// Guard: body fat % and resting HR belong in body_metrics, not
// here — see BODY_METRIC_SAMPLE_MEASURES. A row whose metric is one of those is a
// programming error (a parser mis-routing a body metric into the samples path), so
// it is skipped and NOT counted rather than re-splitting the measure across two
// tables.
export interface MetricSampleUpsertOptions {
  /**
   * The exporter's stamp on this push (`ParsedPayload.pushedAt`). Stored on every row
   * written and required before any row may supersede another (#3424): without it the
   * rule falls back on arrival order, which an exporter retry defeats.
   */
  pushedAt?: string | null;
}

// ── THE OVERLAP-SUPERSEDE, IN THREE PASSES (#3424) ────────────────────────────────
//
// A  planMetricSampleSupersede   read-only, over the PRE-PUSH store, over the WHOLE push
// B  applyMetricSampleSupersede  the deletes, once, in the LAST chunk's transaction
// C  upsertMetricSamples         the upsert loop, with no supersede in it at all
//
// WHY IT IS SHAPED THIS WAY, since five adversarial rounds paid for the answer. The rule
// used to run per row inside the upsert loop: find the overlaps, delete them, upsert.
// That loop has TWO mutation paths — the per-row DELETE and the per-key ON CONFLICT —
// and one pre-image read, `found`, the natural-key twin #1101's moving-END merge needs.
// The DELETE can invalidate that read for a LATER row of the same push. Round 1 reached
// it through arrival order; round 5 reached it through the twin lookup, and measured the
// same push storing 11609 or 22609 depending only on where the chunk split fell (on
// `main`, all orders give 24109). They are one defect: a delete interleaved with reads
// it can change. Guarding either instance leaves the construction that produces them.
//
// The owner's ruling (#3424, option 2) is the split above, and its invariant is:
//
//     NOTHING IN PASS C CAN OBSERVE ANYTHING PASS B DID TO A ROW PASS C CARES ABOUT.
//
// which pass A buys with one WIDER EXCLUSION than the per-row version had. The old code
// excluded the incoming row's OWN natural-key twin from its candidates. The plan excludes
// every stored row whose `started_at` is the natural key of ANY row in this push: a row
// this push is about to upsert must never also be a victim, whichever row of the push
// would have collapsed it. Twins belong to the ON CONFLICT path — the #133 lock, the
// #1101 stale-retry guard, the value merge — and pass C reads them against a store whose
// only difference from the pre-push store is rows that are, by construction, no incoming
// row's twin. So every row's `found`, `staleRetry`, lock decision and disposition are
// what they would be with no supersede at all.
//
// THE CORRECTNESS ARGUMENT IS THEN ONE LINE:
//
//     final store = (pre-store − victims) ⊕ upserts
//
// where `victims` is a pure function of (pre-store, push) computed once before any write,
// and the upserts are #1101's per-key idempotent merges. Order- and chunk-independence
// hold BY CONSTRUCTION, not by an enumeration of channels — which is the point, because
// the enumeration is what was wrong twice. lib/__db_tests__/hc-overlap-push-property.test.ts
// is that line as a test: the same push, several orderings and chunk sizes including a
// 1-row chunk, against a NON-EMPTY store, must leave byte-identical rows every time.
//
// AND ONE MORE INVARIANT, ABOUT THE COMMITS RATHER THAN THE ORDER (#3424, the ruling of
// 2026-08-22). The line above is about the FINAL state; a chunked push also has states in
// between, and the first version of pass B — deletes in the FIRST chunk's transaction —
// got them wrong: chunk 2 failing left the day reading NOTHING where `main` still read
// the old rows. So:
//
//     at every commit point the store holds the OLD rows, or OLD + NEW, or NEW —
//     NEVER NEITHER. A day may read HIGH between commits; it must never read LOWER
//     than `main` would.
//
// Pass B therefore commits in the LAST chunk's transaction. `applyMetricSampleSupersede`
// carries the argument and the concurrency guard that goes with it.
//
// The ascending-`started_at` sort survives as deterministic write order and NOTHING MORE.
// It does no work here and must not be described as what makes the store correct.

// ── PASS C'S VETOES, AND WHY PASS A HAS TO SEE THEM (#3438) ───────────────────────
//
// `final store = (pre-store − victims) ⊕ upserts` assumes `⊕ upserts` IS TOTAL — that
// every row of the push lands. IT IS NOT. Pass C holds four UNILATERAL VETOES over what
// gets written, and a row a veto stops is not a replacement for anything:
//
//   body-metric  a measure that belongs in body_metrics, mis-routed here by a parser
//   tombstone    #508's re-import tombstone — the user deleted this exact reading
//   edit-lock    #133's lock — the stored twin is hand-corrected and wins
//   stale-retry  #1101's moving-END rule — the stored twin holds the newer snapshot
//
// Round 7 refuted the PR through the tombstone one. Pass A promoted a stored
// old-anchoring row to `victims` on the strength of an incoming re-anchored row that
// pass C then REFUSED to write; pass B deleted the stored row; the day went to ZERO,
// permanently, with `warnings: []` and `superseded: 1` telling the reader a row had been
// replaced. It is reachable from Data → Manage, which writes exactly that tombstone on
// the row's `started_at` (`app/(app)/data/manage-actions.ts`): delete the re-anchored one
// of two duplicated step rows and the next rolling-window push destroys the other. The
// store then reads LOWER than `main` — the one thing the ruling's invariant forbids
// outright.
//
// GUARDING THE TOMBSTONE ALONE WOULD BE THE MISTAKE THE THREE-PASS SPLIT WAS RULED IN TO
// STOP: a patch on the channel that was demonstrated, over a construction that keeps
// producing them. The other three vetoes are the same shape and want only a differently
// arranged store to fire. So the vetoes are stated ONCE, HERE, and BOTH passes ask this
// one function:
//
//   • pass C asks it instead of testing four conditions inline, and the accounting each
//     branch used to own now lives in `VETO_TALLY`;
//   • pass A asks it before it plans anything, and a vetoed row PLANS NO DELETE and
//     counts no in-push double count — a row that never lands replaces nothing and
//     doubles nothing. It still REPORTS, though, when the store holds its twin: no veto
//     writes, so that twin stays exactly as it is, and whatever it overlaps is a day
//     reading high. Pass A asks only whether a twin exists, never which veto fired.
//
// WHAT A FIFTH VETO COSTS, since that is the property this has to hold and not just the
// four instances. Adding one means adding a member to `MetricSampleVeto` — a compile
// error at `VETO_TALLY`, a `Record` over the union, until its accounting is stated — and
// adding its condition to `metricSampleVeto`, which is the ONLY place pass C may decline
// a row: the upsert loop has no other `continue`. Pass A then honours it with NO EDIT AT
// ALL, because pass A never asks why a row is vetoed, only whether it is. Moving an
// existing veto so it fires on an insert rather than an update costs nothing either, for
// the same reason.
//
// PASS A AND PASS C GET THE SAME ANSWER, WITHIN THIS PROCESS. Both read the twin on the
// ON CONFLICT natural key through `metricSampleVetoes` below, off one SQL literal; pass C
// runs BEFORE pass B in every chunk, so neither can observe a delete, and the push-key
// exclusion already keeps a victim from ever being a twin.
//
// THE ONE IN-PROCESS DIVERGENCE is a push carrying the same natural key twice: pass A
// reads the PRE-PUSH store for both rows, while pass C sees the first row's write when it
// reaches the second. It runs PASS C VETOES WHERE PASS A DID NOT — the direction round 7
// found, so it plans MORE victims, not fewer — and only ever as `stale-retry`. The other
// three cannot diverge this way: `body-metric` is a function of the metric alone;
// `tombstone` requires NO twin, and after the first row of a pair lands there is one;
// `edit-lock` reads `edited`, which the INSERT defaults to 0 and the ON CONFLICT never
// touches, so a lock present at pass C was present at pass A.
//
// AND THE VICTIMS IT PLANS ARE STILL SOUND, by the rows rather than by the count. Call
// the pair r1, r2 at one key, r2 the one pass C vetoes. `isStaleMetricSnapshot` fires
// because what stands under the key ends STRICTLY LATER than r2 does, and it stands under
// the same `started_at` — so its window strictly CONTAINS r2's. Everything r2's window
// overlapped, that window overlaps. `date` is derived from the start, which they share, so
// the candidate range is the same one. `isDayBucketWindow` has no upper bound, so a longer
// window still clears the gate. And the push carries one stamp, so `pushOutranks` answers
// the same. Every victim r2 planned is a victim the row that stands would plan too — and
// it is the SAME natural key, so pass B's `EXISTS` re-statement finds it (see
// `applyMetricSampleSupersede`).
export type MetricSampleVeto =
  "body-metric" | "tombstone" | "edit-lock" | "stale-retry";

/** The stored row under an incoming row's ON CONFLICT natural key — pass C's `found`. */
interface MetricSampleTwin {
  id: number;
  value: number;
  date: string;
  ended_at: string;
  edited: number;
  activity_external_id: string | null;
}

/**
 * What each veto does to the counts a person reads in Review.
 *
 * A `Record` over the union rather than a switch, so a fifth veto does not COMPILE until
 * it has said what Review shows for it.
 */
const VETO_TALLY: Record<MetricSampleVeto, (counts: UpsertCounts) => void> = {
  // NOT COUNTED, deliberately. A parser mis-routing a body metric into the samples path
  // is a programming error rather than a disposition; counting it would re-split the
  // measure across two tables in Review as well as in the store.
  "body-metric": () => {},
  tombstone: (counts) => {
    counts.suppressed++;
  },
  // Its OWN split (#659), like the body-metrics and vitals paths: a lock hold is not an
  // ordinary no-op re-send, so it stays visible in Review rather than hidden inside
  // `unchanged`.
  "edit-lock": (counts) => {
    counts.edited++;
  },
  "stale-retry": (counts) => {
    tallyUpsert(counts, classifyUpsert(true, true));
  },
};

interface MetricSampleVetoes {
  /** The stored row under this incoming row's natural key, or undefined. */
  twin(r: NormMetricSample): MetricSampleTwin | undefined;
  /** Why pass C will refuse to write this row, or null when it will write it. */
  veto(
    r: NormMetricSample,
    twin: MetricSampleTwin | undefined
  ): MetricSampleVeto | null;
}

/**
 * The veto set for one (profile, source), prepared once per pass.
 *
 * The tombstone set and the twin statement are read ONCE for the batch. Pass C pays for
 * them per push rather than per row, and pass A pays only on a push that carries a day
 * bucket at all, because it asks AFTER the granularity gate.
 */
function metricSampleVetoes(
  profileId: number,
  source: string
): MetricSampleVetoes {
  // The pre-image read on the ON CONFLICT natural key, as ONE literal both passes use:
  // they have to agree on which stored row is a row's twin, or the veto pass A computes
  // is not the veto pass C applies. `id` is carried so an update's provenance row (#1333)
  // names the existing row rather than relying on lastInsertRowid (unreliable for an
  // ON CONFLICT DO UPDATE).
  const find = db.prepare(
    "SELECT id, value, date, ended_at, edited, activity_external_id FROM metric_samples WHERE profile_id = ? AND metric = ? AND source = ? AND origin IS ? AND started_at = ?"
  );
  // Re-import tombstones for metric_samples (#508): a user-deleted sample must not be
  // re-inserted by the rolling window. Loaded once for the batch.
  const tombstoned = loadImportTombstones(profileId, "metric_samples");
  return {
    twin: (r) =>
      find.get(profileId, r.metric, source, r.origin ?? null, r.started_at) as
        MetricSampleTwin | undefined,
    veto: (r, twin) => {
      // These belong in body_metrics (via upsertBodyMetrics); never let them land in
      // metric_samples and re-split the measure across two tables.
      if (BODY_METRIC_SAMPLE_MEASURES.includes(r.metric)) return "body-metric";
      // No live row AND a tombstone for this natural key: the resurrecting insert is
      // refused, so this row lands nowhere at all.
      if (
        !twin &&
        tombstoned.has(
          metricSampleTombstoneKey(
            r.metric,
            source,
            r.origin ?? null,
            r.started_at
          )
        )
      )
        return "tombstone";
      // The #133 user-edit lock, which metric_samples gained in #1488 alongside the
      // detail-page readings table's per-row Edit. A hand-corrected sample survives every
      // later re-push of the rolling window — the same contract activities /
      // body_metrics / medical_records have had since #133.
      if (twin && isEditLocked(twin.edited)) return "edit-lock";
      // A delayed retry of an older cumulative snapshot must never roll a newer
      // day-so-far value backward — #1101's moving-END rule, for the natural-key twin and
      // NOTHING ELSE. The natural key intentionally omits `ended_at`, so freshness is an
      // explicit part of the runtime merge rule (#1101 review).
      //
      // IT IS NOT A GATE ON THE SUPERSEDE, and #3424 took it out of that job for good:
      // `isStaleMetricSnapshot` compares `ended_at`, the comparison
      // lib/metric-window-overlap.ts's header spends a page explaining cannot decide
      // which of two ANCHORINGS is current, and as a gate it was STRICT so a
      // byte-identical replay walked straight through it. What it decides here is
      // whether THIS ROW lands, which is the only thing pass A asks it.
      if (twin && isStaleMetricSnapshot(twin.ended_at, r.ended_at))
        return "stale-retry";
      return null;
    },
  };
}

/**
 * WHAT ONE PUSH DOES TO THE STORE IT ARRIVED AT — pass A, read-only.
 *
 * `victims` are the stored row ids the push collapses, unioned across every incoming row
 * and deduped, because two incoming buckets can overlap one stored row.
 *
 * `leftStanding` is the DISTINCT stored day buckets the push overlapped and did NOT
 * collapse, for any reason: no stamp on this push, a stamp the clock bound refused, a
 * stamp older than the stored row's (a phone whose clock went BACKWARDS stamps every push
 * in the past), a NULL stored stamp with no proof the row predates the column, a stored
 * bucket below the granularity gate, or the #133 edit lock. The reason does not matter to
 * the person reading their totals — a day still reads wrong and nothing else in the app
 * would mention it. It is also the channel a held lock is reported through, since `edited`
 * cannot carry it without inflating `received` past the payload the sender can count.
 *
 * DISTINCT STORED ROWS, not (incoming, stored) pairs: one stored row overlapped by two
 * incoming buckets of one push is one reading left double counting, and the pair count
 * said 2. The two sets are disjoint — a row this push collapses is not a row it left.
 *
 * `inPushDoubleCounts` IS THE SHAPE `leftStanding` STRUCTURALLY CANNOT HOLD, and it is
 * here because the ruling's item 3 produces exactly that shape. `leftStanding` is stored
 * row IDS, so it can only ever name rows that were in the table BEFORE this push. When a
 * push carries BOTH anchorings of one day and the store held NEITHER, both rows are
 * written — ruling item 3, and the right outcome — and the day double counts with no
 * stored row anywhere for the report to point at. Five shipped tests seeded one of the
 * two and so always had one; the store-holds-neither push reported nothing at all.
 *
 * So the in-push overlaps are counted separately and added to the same Review line: the
 * person reading a total that reads HIGH does not care which side of the push the second
 * reading came from. See `countInPushDoubleCounts`.
 */
/**
 * One stored row the plan collapses, CARRYING THE TWO FACTS IT WAS PLANNED AGAINST.
 *
 * Pass A reads a store; pass B deletes from a store read later, and three processes share
 * one DB file (`lib/db.ts`), so between them another push — or the user, through
 * Data → Manage — can commit writes. Everything pass B is told here it re-states in the
 * DELETE, so a victim is removed only while the evidence that licensed it still holds.
 *
 *   - `pushedAt` is the victim's `metric_samples.pushed_at` exactly as pass A read it:
 *     this row belongs to an OLDER push than the one now arriving. A row some other push
 *     has since re-stamped is a row that push has claimed as current.
 *   - `replacedBy` is the natural key of the incoming row whose landing licensed the
 *     delete: THE ROW THAT REPLACES THIS ONE. Pass A promoted the victim because that row
 *     was going to stand over the same span, and pass C holds four unilateral vetoes over
 *     whether it does (#3438). A veto that fires only because of what a concurrent writer
 *     committed after pass A read cannot be seen from inside the plan, so pass B asks the
 *     store instead.
 *
 * See `applyMetricSampleSupersede` for what each clause is and is not exact about.
 */
export interface SupersedeVictim {
  id: number;
  pushedAt: string | null;
  /** The ON CONFLICT natural key of the incoming row whose landing licenses this delete. */
  replacedBy: {
    metric: string;
    source: string;
    origin: string | null;
    startedAt: string;
  };
}

export interface MetricSampleSupersedePlan {
  victims: SupersedeVictim[];
  leftStanding: number[];
  inPushDoubleCounts: number;
}

/** The plan for a push this rule has nothing to say about — a source other than HC. */
function emptySupersedePlan(): MetricSampleSupersedePlan {
  return { victims: [], leftStanding: [], inPushDoubleCounts: 0 };
}

/**
 * The EXCESS day buckets a push carries against ITSELF — one per overlap beyond the
 * first, for each group of mutually overlapping incoming day buckets.
 *
 * "Overlaps a row of the same push that STARTS EARLIER" is the whole definition, and it
 * gives the count the Review line needs without a clustering pass: in a pair exactly one
 * row has the later start, so a push carrying both anchorings of one day counts 1 — the
 * same number the store-holds-one configuration reports for the same symptom, where the
 * stale row is a stored one. Three mutually overlapping buckets count 2.
 *
 * IT IS NOT SAYING WHICH ROW IS WRONG. Two rows of one push share a stamp, so nothing in
 * the payload ranks them (see lib/metric-window-overlap.ts) — and this counts rather than
 * chooses precisely because choosing is what two earlier versions did and what cost a
 * reading. Both rows are written either way; this only makes the day say so.
 *
 * IT IS HANDED ONE ROW PER NATURAL KEY, and the caller's dedupe is load-bearing rather
 * than tidiness. "Overlaps a row of the same push that starts earlier" is true of two
 * copies of ONE record — they share a `started_at`, so they overlap totally — and the ON
 * CONFLICT merges them into one stored row. Counting them would report a double count
 * over a store holding a single reading, scaling with the number of copies. See
 * `dayBuckets` in `planMetricSampleSupersede`.
 *
 * AND IT NEVER RE-COUNTS AN OVERLAP `leftStanding` ALREADY HOLDS. When a push re-sends a
 * row the store already has, the stored row and the incoming row are ONE reading updated
 * in place, not two — so a re-sent bucket overlapped by the same push's re-anchored one
 * is reported once, as the stored row `leftStanding` names. `reportedKeys` is the natural
 * keys of the stored rows that made it into `leftStanding`, and EITHER member of a pair
 * carrying one of them takes the pair out of this count. Either, not just one side: the
 * re-sent row starts LATER than the re-anchored one going west (Tokyo → Honolulu) and
 * EARLIER going east, so a rule that looked at one end reported the westward store-holds-
 * one push as "2 readings" for a day holding two rows, one excess — the same
 * pairs-not-rows error `leftStanding`'s own docstring was written to close.
 *
 * SCANNED ONLY BETWEEN DAY-BUCKET ROWS (`isSupersedingWindow`) — the same rows pass A
 * already looks up stored candidates for, so an 11.5k-row `1m` push has none of them and
 * pays nothing. The fine-grained-against-day-bucket shape is left unreported here for the
 * same reason it is left unreported against the store: it would mean comparing every
 * minute bucket against every other, and the cost is not worth a shape the exporter is
 * not observed to send.
 */
function countInPushDoubleCounts(
  rows: readonly DayBucketRow[],
  reportedKeys: ReadonlySet<string>
): number {
  const groups = new Map<string, DayBucketRow[]>();
  for (const r of rows) {
    const key = JSON.stringify([r.metric, r.origin]);
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }
  let excess = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Sorted here rather than trusting the caller: `planMetricSampleSupersede` is a pure
    // function of the rows it was handed, and the property test hands it permutations.
    const sorted = [...group].sort((a, b) =>
      compareWindowStarts(a.started_at, b.started_at)
    );
    const reported = (r: DayBucketRow) =>
      reportedKeys.has(JSON.stringify([r.metric, r.origin, r.started_at]));
    for (let i = 1; i < sorted.length; i++) {
      const later = sorted[i];
      if (reported(later)) continue;
      for (let j = 0; j < i; j++) {
        const earlier = sorted[j];
        if (reported(earlier)) continue;
        if (
          windowsOverlap(
            earlier.started_at,
            earlier.ended_at,
            later.started_at,
            later.ended_at
          )
        ) {
          excess++;
          break;
        }
      }
    }
  }
  return excess;
}

/** One incoming row that cleared `isSupersedingWindow`, kept for the in-push scan. */
interface DayBucketRow {
  metric: string;
  origin: string | null;
  started_at: string;
  ended_at: string;
}

/**
 * PASS A. Compute the whole push's effect on the stored rows, before anything is written.
 *
 * Called ONCE per push, over EVERY row of it, BEFORE `chunk()` — see the header above.
 * It writes nothing, so it may be run outside a transaction; what it returns is a pure
 * function of the store it read and the push it was given.
 */
export function planMetricSampleSupersede(
  profileId: number,
  rows: readonly NormMetricSample[],
  source: string,
  options: MetricSampleUpsertOptions = {}
): MetricSampleSupersedePlan {
  // Health Connect is the ONE source whose day buckets re-anchor under the app's feet.
  if (source !== OVERLAP_SUPERSEDE_SOURCE) return emptySupersedePlan();
  // The stamp of the push this plan belongs to, and the ONLY thing that licenses a
  // supersede. What the exporter stated and nothing else: freshness derived from the
  // rows themselves was measured LOSING a reading, because an `ended_at` is a property
  // of the reading and not of the push (see lib/metric-window-overlap.ts). A push with
  // no stamp deletes nothing, which leaves the double count this fix exists to remove —
  // visible, and collapsed by the next stamped push.
  //
  // A NULL STAMP DOES NOT SHORT-CIRCUIT THIS FUNCTION, and that is deliberate.
  // `pushOutranks` refuses a null incoming stamp outright, so `victims` comes back empty
  // either way — but the overlaps are still THERE, and they are still days reading high.
  // The Review line is written from what HAPPENED, never from why: a stampless push, a
  // stamp the clock bound refused, and a phone whose clock went backwards all leave the
  // same double count, and returning early here would silence exactly the case where the
  // person most needs telling.
  const pushedAt = options.pushedAt ?? null;

  // THE WIDER TWIN EXCLUSION — the part of the ruling that is easiest to under-implement,
  // and the whole reason pass C can trust its own pre-image read. Every natural key this
  // push will upsert, across the WHOLE push. A stored row under one of these keys is that
  // row's `found`, so it must not be a victim of any OTHER row of the same push. The old
  // per-row rule excluded only the incoming row's OWN twin, which is why a push carrying
  // two anchorings could delete the row it was itself re-sending — and which of the two
  // survived depended on where the chunk boundary fell.
  //
  // Exact string equality on `started_at`, because that is what the ON CONFLICT key uses:
  // the two must agree on which stored row is a twin, and `started_at` is a documented
  // `mixed`-shape column where two spellings of one instant are two different keys.
  //
  // IT REMOVES VICTIMHOOD, NOT THE REPORT. A stored row another row of this push is
  // re-sending, overlapped by a re-anchored bucket of the same push, is a real double
  // count — ruling item 3's "write both" case. It is not deleted, and it is exactly what
  // the Review line exists to say out loud, so it moves to `leftStanding` rather than
  // vanishing from both lists. The one row that belongs in NEITHER list is the incoming
  // row's OWN twin: that is the same reading being updated in place, not a second copy of
  // it, and the candidate SELECT below excludes it.
  //
  // BUILT OVER EVERY ROW, THE VETOED ONES INCLUDED (#3438). This set only ever REMOVES
  // victimhood, so an over-inclusive one can leave a day reading high and never low. And
  // for the two vetoes that require a stored twin — #133's lock and #1101's stale retry —
  // that twin is precisely the row that must not be deleted, since the incoming row is
  // declining to replace it.
  const pushKeys = new Set<string>();
  const keyOf = (metric: string, origin: string | null, startedAt: string) =>
    JSON.stringify([metric, origin, startedAt]);
  for (const r of rows)
    pushKeys.add(keyOf(r.metric, r.origin ?? null, r.started_at));

  // The stored rows an incoming interval may supersede: same profile / metric / source /
  // origin, inside the day radius, and NOT the incoming row's own natural-key twin (that
  // row is the ON CONFLICT's business — the lock, the stale-snapshot guard and the value
  // merge all belong to it, and it is one reading rather than two). The overlap test
  // itself is deliberately NOT in this SQL — `started_at` is a documented `mixed`-shape
  // column, so string comparison would answer a different question than instants do. SQL
  // narrows on the indexed (profile_id, metric, date) prefix;
  // lib/metric-window-overlap.ts decides.
  const findOverlaps = db.prepare(
    `SELECT id, date, started_at, ended_at, edited, pushed_at
       FROM metric_samples
      WHERE profile_id = ? AND metric = ? AND source = ? AND origin IS ?
        AND date >= ? AND date <= ?
        AND started_at <> ?
      ORDER BY id`
  );
  // WHEN `pushed_at` STARTED BEING WRITTEN, AND WHAT WAS ALREADY IN THE TABLE. The only
  // thing that licenses deleting a NULL-stamped row, read ONCE for the push because it is
  // a constant this push cannot move.
  const era: UnstampedEra | null = readUnstampedEra();
  // PASS C'S VETOES, ASKED HERE (#3438). A row pass C will refuse to write is not
  // replacing anything, so it must not plan a delete. See the header above.
  const vetoes = metricSampleVetoes(profileId, source);

  // Victim id → the whole decision pass B has to re-state: the stamp pass A read on that
  // row, and the natural key of the incoming row whose landing licenses the delete. A Map
  // rather than a Set because what pass A decided is only valid while both facts are still
  // true when the DELETE runs (see `applyMetricSampleSupersede`).
  //
  // TWO INCOMING BUCKETS CAN NAME THE SAME STORED ROW, and then only ONE of their keys is
  // kept — the last one planned. The stamp is the same value from either (both read it in
  // the same read-only pass); the licensing key is not, and keeping one is the direction
  // that fails safe: if the kept key is the one a veto stopped while the other landed,
  // pass B declines a delete it could have made and the day reads HIGH, which the
  // invariant permits. It cannot go the other way — a key that stands is a replacement
  // standing.
  const victims = new Map<number, SupersedeVictim>();
  const leftStanding = new Set<number>();
  // The incoming rows the in-push scan runs over: the ones that clear the granularity gate
  // below, that pass A saw no veto on, and that carry a natural key no earlier row of this
  // push already contributed. So the scan costs nothing on a push that carries no day
  // buckets at all.
  //
  // ONE ROW PER NATURAL KEY, AND THAT IS WHAT MAKES THE COUNT A COUNT OF READINGS. The
  // ON CONFLICT merges every row of a push sharing a key into ONE stored row, so two
  // copies of one record are one reading, not two — the same principle
  // `countInPushDoubleCounts` already applies to the stored side ("the stored row and the
  // incoming row are ONE reading updated in place"), applied to the incoming side, and the
  // same collapse `scripts/hc-origin-overlap-census.ts` makes on (metric, origin,
  // started_at) "so a re-sent moving-end snapshot is not reported as an overlap with
  // itself". Without it a push carrying one record twice reported "1 reading overlap" over
  // a store holding ONE row, and three copies reported 2: a false warning that scaled with
  // the number of copies. Measured, on a fresh store, through the real ingest.
  //
  // AND THE VETO GATE HERE IS NOT A CLAIM THAT EVERY ROW IN THIS LIST LANDS. Pass C can
  // veto a row pass A did not: two rows at one natural key are read against the pre-push
  // store by pass A and against each other by pass C, so the second can be stale-retry
  // vetoed. Measured — and it was counted anyway. The dedupe is what makes that harmless
  // rather than the veto gate: the pair collapses to the one entry that stands.
  const dayBuckets: DayBucketRow[] = [];
  // The natural keys already in `dayBuckets`, so a key appears at most once.
  const dayBucketKeys = new Set<string>();
  // The natural key of every stored row that lands in `leftStanding`, so the in-push scan
  // can tell a reading this push is UPDATING from a second reading it is adding. Keyed by
  // stored id, because a row one incoming bucket left standing can still be collapsed by
  // another, and the map is read only after that pruning.
  const standingKeyById = new Map<number, string>();
  for (const r of rows) {
    // ONLY DAY-BUCKET WINDOWS ARE LOOKED UP, and that is a cost bound as much as a safety
    // one. `planSupersede` would also report a FINE-GRAINED incoming row landing on a
    // stored day bucket, but asking it would mean one indexed range query per minute
    // bucket — ~11.5k queries over ~83M rows for a single `1m` push — so that shape is
    // not scanned for and not reported. It is the one residual in `left` this caller does
    // not deliver; the permanent one (a stored sub-daily bucket) is.
    if (!isSupersedingWindow(r.metric, r.started_at, r.ended_at)) continue;
    // AND WHAT PASS C WILL ACTUALLY LEAVE UNDER THIS NATURAL KEY (#3438). Asked AFTER the
    // granularity gate on purpose: the twin lookup then costs nothing on an 11.5k-row
    // `1m` push, which carries no day buckets at all.
    //
    // A VETOED ROW PLANS NO DELETE, because it is not replacing anything — that is the
    // whole refutation. What it may still do is REPORT. Two of the four vetoes require a
    // stored twin, and no veto writes anything, so that twin stays EXACTLY as it is: the
    // window standing under this key when the push is done is the TWIN'S, and the rows it
    // overlaps are real days reading high. A vetoed row with NO twin — the #508 tombstone,
    // a mis-routed body metric — puts nothing in the store under this key and has nothing
    // to say about it.
    //
    // WHICH LEAVES ONE DOUBLE COUNT NOBODY MENTIONS, and it is a gap rather than a bug:
    // two stored day buckets that overlap EACH OTHER, under a push whose only row is
    // vetoed with no twin. Nothing lands, so nothing here names them, and Review says
    // nothing. It is not a regression — `main` is silent on it too, and every path in this
    // file already reports a stored-side double count only as a by-product of an incoming
    // row landing on one of the pair. Closing it means a question no pass asks: do two
    // STORED rows overlap each other? That is a different scan with a different unit
    // (excess readings per cluster, not distinct rows the push touched), it would change
    // the Review line on every push rather than this one, and answering it only on the
    // vetoed-no-twin branch would make the count depend on whether a row happened to be
    // tombstoned — the same shape of defect this comment block exists to have removed. So
    // it is left, deliberately and in writing, rather than half-closed.
    //
    // This asks only WHETHER a twin exists, never WHICH veto fired, so a fifth veto is
    // handled here with no edit at all.
    const twin = vetoes.twin(r);
    const veto = vetoes.veto(r, twin);
    // The window that will stand under this natural key once the push is done.
    let standingWindow: { date: string; ended_at: string };
    if (veto === null) standingWindow = { date: r.date, ended_at: r.ended_at };
    else if (twin)
      standingWindow = { date: twin.date, ended_at: twin.ended_at };
    else continue;
    // The in-push double count is between rows that LAND, so a vetoed row is not one of
    // them: what stands under its key is a row the store already had, and any overlap
    // with it is `leftStanding`'s to name.
    if (veto === null) {
      const bucketKey = keyOf(r.metric, r.origin ?? null, r.started_at);
      if (!dayBucketKeys.has(bucketKey)) {
        dayBucketKeys.add(bucketKey);
        dayBuckets.push({
          metric: r.metric,
          origin: r.origin ?? null,
          started_at: r.started_at,
          ended_at: r.ended_at,
        });
      }
    }
    const { from, to } = supersedeDateRange(standingWindow.date);
    const candidates = findOverlaps.all(
      profileId,
      r.metric,
      source,
      r.origin ?? null,
      from,
      to,
      r.started_at
    ) as MetricWindow[];
    const plan = planSupersede(
      { ...r, ...standingWindow, pushedAt },
      candidates,
      era
    );
    for (const standing of plan.left) {
      leftStanding.add(standing.id);
      standingKeyById.set(
        standing.id,
        keyOf(r.metric, r.origin ?? null, standing.started_at)
      );
    }
    for (const victim of plan.supersede) {
      // TWO REASONS A COLLAPSE IS DECLINED AND STILL REPORTED. The wider push-key
      // exclusion: a row this push is about to upsert is never deleted, and the day it
      // leaves reading high is said out loud instead of being silently collapsed into
      // nothing. And the veto: the row that would have done the collapsing is not being
      // written, so there is nothing to replace the stored row with.
      const victimKey = keyOf(r.metric, r.origin ?? null, victim.started_at);
      if (veto !== null || pushKeys.has(victimKey)) {
        leftStanding.add(victim.id);
        standingKeyById.set(victim.id, victimKey);
      } else
        victims.set(victim.id, {
          id: victim.id,
          pushedAt: victim.pushed_at,
          // THE ROW THAT REPLACES IT, by the key pass B can look the replacement up
          // under. `r` is the incoming row that overlapped this victim and outranked it;
          // `source` is the same one pass C upserts under and the same one the twin
          // statement in `metricSampleVetoes` reads, so pass B asks the store the exact
          // question pass A asked it.
          replacedBy: {
            metric: r.metric,
            source,
            origin: r.origin ?? null,
            startedAt: r.started_at,
          },
        });
    }
  }
  // Disjoint, and THIS LINE IS WHAT MAKES THEM SO rather than a property of the loop.
  //
  // Most reasons a row lands in `left` rather than in `supersede` are facts about that
  // STORED row plus this push's one stamp — the granularity gate, the #133 lock,
  // `pushOutranks`, and the push-key exclusion, which asks only whether some row of this
  // push carries the stored row's key. Those cannot vary between the incoming buckets
  // that overlap it. THE VETO CAN (#3438): it is a fact about the INCOMING row, so one
  // stored row may be left standing by a vetoed bucket of this push and collapsed by a
  // bucket that lands. The collapse is the truth — a row that lands does replace it — so
  // the prune below is the arbiter, and it is stated here because an earlier version of
  // this comment claimed the case could not arise. Two rounds were lost to a claim of
  // that shape.
  for (const id of victims.keys()) leftStanding.delete(id);
  return {
    victims: [...victims.values()],
    leftStanding: [...leftStanding],
    // The double count this push carries against ITSELF, which no set of stored ids can
    // hold. Ruling item 3 says write both rows; this is the half that says so out loud.
    inPushDoubleCounts: countInPushDoubleCounts(
      dayBuckets,
      new Set([...leftStanding].map((id) => standingKeyById.get(id)!))
    ),
  };
}

/**
 * PASS B. Apply the plan's deletes, once, and say how many rows went.
 *
 * IT RUNS IN THE **LAST** CHUNK'S TRANSACTION, AFTER THAT CHUNK'S UPSERTS. An earlier
 * round of this PR put it in the FIRST chunk's, with the justification below — "a crash
 * between B and C must not leave a day reading LOW with nothing in flight to restore it".
 * That sentence is still the reason. The placement it was used to justify was wrong, and
 * the owner corrected it (#3424, the ruling of 2026-08-22): first-chunk placement gives
 * atomicity only when the push is ONE chunk. In a multi-chunk push the deletes commit
 * with chunk 1, and a failure in chunk 2 leaves the day reading NOTHING where `main`
 * would still read the old rows — measured at 8000 → nothing. The letter of the earlier
 * ruling produced exactly the outcome its own reason forbids.
 *
 * THE INVARIANT, which is the durable thing here and outlives any placement:
 *
 *     at every commit point the store holds the OLD rows, or OLD + NEW, or NEW —
 *     NEVER NEITHER. The mechanism may leave a day reading HIGH between commits;
 *     it must never read LOWER than `main` would.
 *
 * The placement follows from it: a victim is deleted only in a transaction that commits
 * with or after every row of the push that replaces it. One chunk — the same transaction
 * as the rows. Many chunks — chunks 1…n−1 commit upserts only and the store transiently
 * reads high (old + new, the visible double count), and the final chunk commits its
 * upserts and the WHOLE victim set together. A failure in chunk k leaves old + chunks<k:
 * a double count, never a hole. The exporter re-carries the unacked rows on its next push
 * (its failed deltas fold into the next one — measured on the 08-21 DNS failures), pass A
 * re-plans over that store, and that push collapses it.
 *
 * NOTHING THIS PROCESS WROTE CAN HAVE INVALIDATED THE PLAN, and it is not re-derived
 * here. Victims were computed excluding the natural-key twin of EVERY incoming row of the
 * push, so no upsert in chunks 1…n−1 — nor in the last chunk, which runs before this —
 * can touch a victim. The set of ids is exactly what pass A returned. That argument is
 * about THIS process and covers only what THIS process wrote; the two guards below are
 * what covers the other three.
 *
 * THE GUARDS ARE FOR ANOTHER PROCESS, NOT FOR THIS ONE. Three processes share one DB file
 * (`lib/db.ts`), so pass A's read and this DELETE can be separated by another push's
 * committed writes, or by the user's own — Data → Manage deletes a reading and writes a
 * #508 tombstone for it. The window widens with the number of chunks. Pass A's decision
 * rested on two facts about the store, so this DELETE re-states BOTH of them; a fact that
 * has stopped being true makes the statement match nothing, and the victim stays.
 *
 *   `pushed_at IS ?` — THE VICTIM'S PROVENANCE. The stamp pass A actually read on the
 *   row, so a row RE-STAMPED by a concurrent push is not deleted on evidence that has
 *   expired: some other push has since claimed it as current. `IS` rather than `=`
 *   because the stamp is NULL on every pre-column row and `= NULL` is never true — the
 *   NULL-stamped victims are the deploy-day rows this rule exists to collapse.
 *
 *   `EXISTS (…)` — THE REPLACEMENT. A victim is deleted because an incoming row was going
 *   to stand over the same span; pass C holds four unilateral vetoes over whether it does
 *   (#3438), and pass A honours every veto it can SEE. It cannot see one a concurrent
 *   writer creates after it read: the user deletes the re-anchored row through
 *   Data → Manage between the passes, the tombstone that delete writes vetoes the push's
 *   re-send of that same row, and the old-anchoring victim was deleted with nothing left
 *   to replace it — the day at ZERO, committed, where `main` still reads the old row.
 *   Round 7's outcome through a different door. So the DELETE re-states the natural key
 *   of the licensing row and asks the store, at DELETE time and inside this transaction,
 *   whether anything stands there.
 *
 * WHAT THE `EXISTS` IS AND IS NOT EXACT ABOUT, because "it fires exactly when a veto
 * fired" is NOT what it says and building on that would be wrong. It says: A ROW STANDS
 * UNDER THE REPLACEMENT'S NATURAL KEY. That is the invariant's own test, spelled in SQL —
 * "the store holds the OLD rows, or OLD + NEW, or NEW, never NEITHER" — and it separates
 * the two directions cleanly:
 *
 *   - The push's row landed: it IS that key, so EXISTS is true and the delete proceeds.
 *     Unchanged behaviour for every push nothing raced.
 *   - The tombstone and the body-metric veto put NOTHING under the key (the tombstone
 *     veto requires no twin, which is why the round-7 shape reaches zero at all). With no
 *     concurrent insert there is nothing to find, EXISTS is false, and the victim stays.
 *   - The #133 lock and the #1101 stale retry both REQUIRE a twin, so when one of them
 *     newly fires between the passes a row is standing under that key by definition, and
 *     the delete proceeds. That is not a hole: the day is left holding a reading — the
 *     locked one, or the newer snapshot — rather than nothing, which is the whole of what
 *     the invariant asks. Note this is why the guard is NOT a veto detector: it is
 *     deliberately true in exactly those two cases.
 *   - A row that landed in an EARLIER chunk and was deleted by someone else before this
 *     last chunk runs: EXISTS false, no delete, the day reads high. The safe direction.
 *
 * It re-states the same key columns as the twin statement in `metricSampleVetoes`, in the
 * same order, because the question has to be the same one: `profile_id, metric, source,
 * origin IS ?, started_at` is the ON CONFLICT natural key (`idx_metric_samples_natural`).
 *
 * THE DELETE RE-STATES `profile_id`, redundantly and on purpose: every id it is given
 * came out of the profile-scoped candidate SELECT in pass A. A barrier nothing observes
 * is a barrier a refactor deletes as noise — so the check that holds it is
 * lib/__tests__/profile-scoping.test.ts, the repo's own owned-table census, which reads
 * this LITERAL and fails when the clause is not there. That is also why the SQL is not
 * hoisted to a named constant: the census can only read a statement written inline, and
 * reports a prepared statement built from a variable as unverifiable.
 *
 * The deletes are sync-internal — they write no re-import tombstone, exactly like the
 * #608 timezone sweep's deletes, because the source is expected to keep sending the span
 * under its current anchoring.
 */
export function applyMetricSampleSupersede(
  profileId: number,
  victims: readonly SupersedeVictim[]
): number {
  if (victims.length === 0) return 0;
  const dropOverlap = db.prepare(
    "DELETE FROM metric_samples WHERE id = ? AND profile_id = ? AND pushed_at IS ? AND EXISTS (SELECT 1 FROM metric_samples AS replacement WHERE replacement.profile_id = ? AND replacement.metric = ? AND replacement.source = ? AND replacement.origin IS ? AND replacement.started_at = ?)"
  );
  let removed = 0;
  for (const victim of victims)
    removed += dropOverlap.run(
      victim.id,
      profileId,
      victim.pushedAt,
      profileId,
      victim.replacedBy.metric,
      victim.replacedBy.source,
      victim.replacedBy.origin,
      victim.replacedBy.startedAt
    ).changes;
  return removed;
}

export function upsertMetricSamples(
  profileId: number,
  rows: NormMetricSample[],
  source: string,
  sink?: SyncRowSink,
  options: MetricSampleUpsertOptions = {}
): UpsertCounts {
  // The pre-image on the natural key the ON CONFLICT below merges on, and the four
  // vetoes read against it — through the ONE function pass A also asks (#3438), so the
  // rows this loop refuses to write are the rows pass A refused to plan deletes for. A
  // re-send of the rolling window that lands the same value/date is counted unchanged
  // rather than a write (info.changes can't see that the values matched).
  const vetoes = metricSampleVetoes(profileId, source);
  const stmt = db.prepare(
    `INSERT INTO metric_samples
       (profile_id, source, origin, metric, date, started_at, ended_at, value,
        activity_external_id, pushed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO UPDATE SET
       value = excluded.value,
       date = excluded.date,
       ended_at = excluded.ended_at,
       activity_external_id = COALESCE(
         excluded.activity_external_id,
         metric_samples.activity_external_id
       ),
       -- The stamp of the push that last WROTE this row. COALESCE so a caller with no
       -- stamp (every non-Health-Connect source) cannot blank one that a stamped push
       -- already set, which would re-open the row to a replay.
       pushed_at = COALESCE(excluded.pushed_at, metric_samples.pushed_at)`
  );
  const counts = emptyCounts();

  // ── PASS C, AND ONLY PASS C (#3424) ───────────────────────────────────────────
  //
  // THERE IS NO SUPERSEDE IN THIS LOOP, and that is the change five adversarial rounds
  // bought. It used to find the overlaps and DELETE them per row, right here, next to the
  // `found` pre-image read that #1101's moving-END merge needs — so one row of a push
  // could invalidate what a LATER row of the same push observed. Reached through arrival
  // order (round 1) and through the natural-key twin lookup (round 5); one defect, two
  // doors. The comment that used to stand here argued that an equal stamp made a chunk
  // split harmless. That was right about the stamp channel and wrong to claim the
  // universal: rows of one push cannot be each other's VICTIMS, which says nothing about
  // what the twin lookup returns. The owner's ruling reverses it (#3424, option 2).
  //
  // The deletes are now planned over the whole push before anything is written
  // (`planMetricSampleSupersede`) and applied once (`applyMetricSampleSupersede`), with
  // every row this push will upsert excluded from being a victim. So the store this loop
  // reads differs from the pre-push store ONLY in rows that are no incoming row's twin,
  // and every `found`, `staleRetry`, lock decision and disposition below is what it would
  // be with no supersede at all. See the header above `planMetricSampleSupersede`.
  //
  // What is left of the rule in this function is one column: `pushed_at`, the stamp the
  // exporter stated on this push, written onto every row it stores so a LATER push can
  // rank itself against them. A caller with no stamp writes NULL and COALESCE keeps
  // whatever a stamped push already set, so a non-Health-Connect source cannot blank one.
  const pushedAt =
    source === OVERLAP_SUPERSEDE_SOURCE ? (options.pushedAt ?? null) : null;
  // ASCENDING started_at — DETERMINISTIC WRITE ORDER, and nothing more.
  //
  // #3424 asks for it under the trailing-edge heading, and it used to be load-bearing:
  // when a row of a push could supersede another row of the SAME push, which one arrived
  // first decided what survived. It cannot any more, and NOT because of the stamp — the
  // deletes do not happen here at all. It is kept because a stable write order makes
  // `metric_samples.id` follow the day, which is worth having for anyone reading the
  // table by hand, and because it costs one sort of a batch already in memory. It is NOT
  // what makes the store correct, and the test that pins it asserts insertion ORDER for
  // that reason.
  const ordered =
    source === OVERLAP_SUPERSEDE_SOURCE
      ? [...rows].sort((a, b) =>
          compareWindowStarts(a.started_at, b.started_at)
        )
      : rows;

  for (const r of ordered) {
    const found = vetoes.twin(r);
    // THE FOUR VETOES, AND THE ONLY PLACE THIS LOOP MAY DECLINE A ROW (#3438). They used
    // to stand here as four inline conditions, which is how pass A came to plan a delete
    // for a stored row on the strength of an incoming row this loop then refused to
    // write. Both passes now read them from `metricSampleVetoes`, so pass A cannot plan
    // against a push member that never lands — and a FIFTH veto is honoured by pass A
    // with no edit to pass A at all. The accounting lives in `VETO_TALLY`, a `Record`
    // over the union, so the new member does not compile until it says what Review shows.
    //
    // The reads behind them see a store pass B has not touched: pass B runs after this
    // loop in every chunk, and the plan excluded every one of this push's natural keys
    // from being a victim regardless. That is the invariant the three-pass shape exists
    // to give them.
    const veto = vetoes.veto(r, found);
    if (veto !== null) {
      VETO_TALLY[veto](counts);
      continue;
    }
    const info = stmt.run(
      profileId,
      source,
      r.origin ?? null,
      r.metric,
      r.date,
      r.started_at,
      r.ended_at,
      r.value,
      r.activity_external_id ?? null,
      pushedAt
    );
    const equal =
      !!found &&
      found.value === r.value &&
      found.date === r.date &&
      found.ended_at === r.ended_at &&
      (r.activity_external_id == null ||
        found.activity_external_id === r.activity_external_id);
    const disposition = classifyUpsert(!!found, equal);
    tallyUpsert(counts, disposition);
    // Per-row provenance (#1333) — only the value-changing dispositions. An update
    // names the pre-image row's id; an insert uses the fresh rowid.
    if (disposition !== "unchanged") {
      sink?.push({
        target_table: "metric_samples",
        target_id: found ? found.id : Number(info.lastInsertRowid),
        disposition,
      });
    }
  }
  return counts;
}

// Replace the minute bucket for each `ts` outright. Each exporter push recomputes
// every 1-minute aggregate from that batch's raw samples, so the incoming row is
// already the authoritative value for its minute — merging by count-weighted
// average would double `n` (and freeze the average) on every resend of the rolling
// 48h window. REPLACE-by-key keeps re-ingest idempotent. The key is
// (profile_id, ts, source) — migration 013, issue #14 — so a resend from the SAME
// source replaces its own bucket while two different sources reporting the same
// minute coexist instead of clobbering each other.
export function upsertHrMinutes(
  profileId: number,
  rows: NormHrMinute[],
  source: string
): UpsertCounts {
  // Pre-image on (profile_id, ts, source): the exporter recomputes each minute
  // bucket from that batch's raw samples and replaces the row outright, so a
  // resend of an identical minute (same bpm/min/max/n) is unchanged, not a write.
  const find = db.prepare(
    "SELECT bpm, bpm_min, bpm_max, n FROM hr_minutes WHERE profile_id = ? AND ts = ? AND source = ?"
  );
  const stmt = db.prepare(
    `INSERT INTO hr_minutes (profile_id, ts, bpm, bpm_min, bpm_max, n, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, ts, source) DO UPDATE SET
       bpm = excluded.bpm, bpm_min = excluded.bpm_min, bpm_max = excluded.bpm_max,
       n = excluded.n`
  );
  // No re-import tombstone consult here (#653): hr_minutes has no per-row delete path
  // (browse/export-only dataset; the only non-sync mutation is the timezone re-import
  // sweep, which must re-insert), so there is nothing for a sync to resurrect and the
  // table is intentionally absent from TOMBSTONE_TABLES.
  const counts = emptyCounts();
  for (const r of rows) {
    const found = find.get(profileId, r.ts, source) as
      | {
          bpm: number;
          bpm_min: number;
          bpm_max: number;
          n: number;
        }
      | undefined;
    stmt.run(profileId, r.ts, r.bpm, r.bpm_min, r.bpm_max, r.n, source);
    const equal =
      !!found &&
      found.bpm === r.bpm &&
      found.bpm_min === r.bpm_min &&
      found.bpm_max === r.bpm_max &&
      found.n === r.n;
    tallyUpsert(counts, classifyUpsert(!!found, equal));
  }
  return counts;
}

// Insert or update a vital/biomarker reading into medical_records, deduped on
// external_id. Only ever touches rows this source created (external_id is NULL for
// manual + document-extracted rows). Returns the affected row ids so the caller can
// run reconcileFlags() to set out-of-range flags. `value` mirrors value_num as text
// (the medical UI shows `value`).
//
// A re-issued result (#1404) does NOT silently replace what the user already read:
// when the incoming row supersedes the stored one — a changed value/unit/date, or an
// incoming status the source itself calls corrected/amended — the prior state is
// preserved as a medical_record_revisions child row FIRST, inside this same
// transaction, and only then is the reading updated in place. The reading keeps its
// id (every link, star, dismissal and provenance row points at it), and the value it
// used to hold is still there to show. An idempotent re-send of the rolling window
// is `unchanged` and writes nothing at all.
const VITAL_COMPARE_COLS: string[] = [
  "date",
  // The stated instant (#2154). In the compare set so a re-send of the rolling
  // window BACKFILLS a pre-#2154 row's occurred_at (stored NULL, incoming
  // instant → "updated", not "unchanged") — the one write path historical
  // device rows have; occurred_at alone never supersedes (no revision row).
  "occurred_at",
  "category",
  "name",
  "value",
  "value_num",
  "unit",
  "canonical_name",
  "result_status",
];

export function upsertVitals(
  profileId: number,
  rows: NormVital[],
  source: string,
  sink?: SyncRowSink
): { ids: number[]; counts: UpsertCounts } {
  const find = db.prepare(
    `SELECT id, edited, date, occurred_at, category, name, value, value_num, unit,
            canonical_name, reference_range, flag, result_status
       FROM medical_records WHERE profile_id = ? AND external_id = ?`
  );
  const insert = db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, occurred_at, category, name, value, value_num, unit, canonical_name, source, external_id, result_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const update = db.prepare(
    `UPDATE medical_records
       SET date = ?, occurred_at = ?, category = ?, name = ?, value = ?, value_num = ?,
           unit = ?, canonical_name = ?, result_status = ?
     WHERE id = ?`
  );
  // Re-import tombstones for medical_records vitals (#508), keyed by external_id.
  const tombstoned = loadImportTombstones(profileId, "medical_records");
  const ids: number[] = [];
  const counts = emptyCounts();
  for (const r of rows) {
    const valueStr = String(r.value_num);
    const found = find.get(profileId, r.external_id) as
      | (Record<string, unknown> & { id: number; edited: number | null })
      | undefined;
    // A hand-edited imported vital is never clobbered by re-ingest. Count it in the
    // `edited` split (#659) — we persist nothing — and, unlike the value-matched
    // unchanged case, do NOT push its id: the row is left entirely untouched, no flag
    // re-derivation.
    if (found && isEditLocked(found.edited)) {
      counts.edited++;
      continue;
    }
    // No live row AND a tombstone for this external_id: the user deleted this vital —
    // skip the resurrecting insert and count it suppressed.
    if (!found && tombstoned.has(r.external_id)) {
      counts.suppressed++;
      continue;
    }
    if (found) {
      // Resolved post-image (note the incoming `canonical` maps to the stored
      // `canonical_name` column). The `flag` column isn't compared: it's set out
      // of band by reconcileFlags, not by this write.
      const status = normalizeResultStatus(r.result_status);
      const post = {
        date: r.date,
        occurred_at: r.occurred_at ?? null,
        category: r.category,
        name: r.name,
        value: valueStr,
        value_num: r.value_num,
        unit: r.unit,
        canonical_name: r.canonical,
        result_status: status,
      };
      const disposition = classifyUpsert(
        true,
        rowsEqual(VITAL_COMPARE_COLS, found, post)
      );
      if (disposition === "updated") {
        // A re-ISSUED result — a changed value/unit/date, or an incoming status the
        // source itself calls corrected/amended — preserves what it replaces BEFORE
        // the overwrite (#1404), in this same transaction. A re-canonicalization or
        // a category re-classification changes how the reading is FILED, not what it
        // SAID, so it updates in place with no revision row (supersedesReading owns
        // that distinction — one computation).
        if (
          supersedesReading(
            {
              date: found.date as string | null,
              value: found.value as string | null,
              value_num: found.value_num as number | null,
              unit: found.unit as string | null,
              result_status: found.result_status as string | null,
            },
            { ...post, result_status: status }
          )
        ) {
          insertObservationRevision(
            found.id,
            {
              date: found.date as string | null,
              value: found.value as string | null,
              value_num: found.value_num as number | null,
              unit: found.unit as string | null,
              reference_range: found.reference_range as string | null,
              flag: found.flag as MedicalFlag | null,
              result_status: found.result_status as string | null,
            },
            status,
            source
          );
        }
        update.run(
          r.date,
          r.occurred_at ?? null,
          r.category,
          r.name,
          valueStr,
          r.value_num,
          r.unit,
          r.canonical,
          status,
          found.id
        );
      }
      tallyUpsert(counts, disposition);
      ids.push(found.id);
      // Per-row provenance (#1333) — record only a value-changing update, not a
      // no-op re-send (unchanged).
      if (disposition === "updated") {
        sink?.push({
          target_table: "medical_records",
          target_id: found.id,
          disposition,
        });
      }
    } else {
      const info = insert.run(
        profileId,
        r.date,
        // Bound, never defaulted (#2205): the source's stated instant or honest
        // NULL for a day-grain reading.
        r.occurred_at ?? null,
        r.category,
        r.name,
        valueStr,
        r.value_num,
        r.unit,
        r.canonical,
        source,
        r.external_id,
        normalizeResultStatus(r.result_status)
      );
      const newId = Number(info.lastInsertRowid);
      ids.push(newId);
      tallyUpsert(counts, classifyUpsert(false, false));
      sink?.push({
        target_table: "medical_records",
        target_id: newId,
        disposition: "inserted",
      });
    }
  }
  return { ids, counts };
}

// Insert or update an activity, deduped on external_id (synthesized from the
// session start). Preserves the activity's id (and its notes/components) on update.
// The base (non-metric) columns the activity upsert writes, compared alongside
// ACTIVITY_METRIC_COLS to decide unchanged-vs-updated on re-ingest.
const ACTIVITY_BASE_COLS = [
  "date",
  "type",
  "title",
  "duration_min",
  "distance_km",
  "start_time",
  "end_time",
  "source",
];

export function upsertActivities(
  profileId: number,
  rows: NormActivity[],
  source: string,
  sink?: SyncRowSink
): UpsertCounts {
  const metricCols = ACTIVITY_METRIC_COLS.join(", ");
  const metricSet = ACTIVITY_METRIC_COLS.map((c) => `${c} = ?`).join(", ");
  const metricPlaceholders = ACTIVITY_METRIC_COLS.map(() => "?").join(", ");
  // `components` is a JSON string column, compared alongside the base/metric cols so
  // a components change → updated and an identical re-sync (same serialized JSON) →
  // unchanged. Sources that omit components store/compare null on both sides.
  const compareCols = [
    ...ACTIVITY_BASE_COLS,
    ...ACTIVITY_METRIC_COLS,
    "components",
  ];
  const find = db.prepare(
    `SELECT id, edited, date, type, title, duration_min, distance_km,
            start_time, end_time, source, components, ${metricCols}
       FROM activities WHERE profile_id = ? AND external_id = ?`
  );
  // `created_at` is BOUND from the clock seam (#2287), not left to the column's
  // `datetime('now')` DEFAULT. For an IMPORTED row this stamp is the FIRST-SEEN
  // freshness anchor `computeWorkoutPresence` compares against a seam-derived now
  // (IMPORT_FRESHNESS_MIN), so the two have to come off one clock. Byte-identical to
  // SQLite's own value in production, where the seam is the real clock.
  const insert = db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, duration_min, distance_km, start_time, end_time, ${metricCols}, components, source, external_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${metricPlaceholders}, ?, ?, ?, ?)`
  );
  // NOTE (#342): equipment_id is deliberately absent from BOTH this UPDATE's column
  // set and the compareCols above, so a re-sync never clobbers a hand-set session
  // gear link — the picker is app-only, sources don't supply it. A user who links
  // gear on an imported row also flips `edited` (saveActivity), so the found.edited
  // guard below already short-circuits the whole write; this keeps it safe even if
  // that lock ever changed. Keep equipment_id out of the sync footprint.
  const update = db.prepare(
    `UPDATE activities
       SET date = ?, type = ?, title = ?, duration_min = ?, distance_km = ?,
           start_time = ?, end_time = ?, ${metricSet}, components = ?, source = ?
     WHERE id = ?`
  );
  // Re-import tombstones for activities (#507/#508), keyed by external_id. A row the
  // user merged away or deleted must not be re-inserted by the trailing re-scan.
  const tombstoned = loadImportTombstones(profileId, "activities");
  const counts = emptyCounts();
  for (const r of rows) {
    const metrics = activityMetricValues(r);
    // Serialize components to the JSON string actually stored, so the pre-image
    // compare below matches the column value byte-for-byte on an identical re-sync.
    const componentsJson =
      r.components && r.components.length ? JSON.stringify(r.components) : null;
    const found = find.get(profileId, r.external_id) as
      | (Record<string, unknown> & { id: number; edited: number | null })
      | undefined;
    // A source-owned row the user has hand-edited is left alone on re-ingest, so
    // the rolling 48h/re-scan window never clobbers those edits. Counts in the
    // `edited` split (#659) — we deliberately persist nothing, but this is a lock
    // the user should be able to see in Review, not a silent no-op. Routes through
    // the shared isEditLocked predicate like the body-metric/vital paths (#944).
    if (found && isEditLocked(found.edited)) {
      counts.edited++;
      continue;
    }
    if (found) {
      // Resolved post-image over the same columns the UPDATE writes (metric fields
      // reuse activityMetricValues so the compare and the write can't drift).
      const post: Record<string, unknown> = {
        date: r.date,
        type: r.type,
        title: r.title,
        duration_min: r.duration_min,
        distance_km: r.distance_km,
        start_time: r.start_time,
        end_time: r.end_time,
        source,
        components: componentsJson,
      };
      ACTIVITY_METRIC_COLS.forEach((c, i) => {
        post[c] = metrics[i];
      });
      const disposition = classifyUpsert(
        true,
        rowsEqual(compareCols, found, post)
      );
      if (disposition === "updated") {
        update.run(
          r.date,
          r.type,
          r.title,
          r.duration_min,
          r.distance_km,
          r.start_time,
          r.end_time,
          ...metrics,
          componentsJson,
          source,
          found.id
        );
      }
      tallyUpsert(counts, disposition);
      // Per-row provenance (#1333) — record only a value-changing update.
      if (disposition === "updated") {
        sink?.push({
          target_table: "activities",
          target_id: found.id,
          disposition,
        });
      }
    } else if (tombstoned.has(r.external_id)) {
      // No live row AND a tombstone for this external_id: the user merged/deleted it —
      // skip the resurrecting insert and count it suppressed.
      counts.suppressed++;
      continue;
    } else {
      const info = insert.run(
        profileId,
        r.date,
        r.type,
        r.title,
        r.duration_min,
        r.distance_km,
        r.start_time,
        r.end_time,
        ...metrics,
        componentsJson,
        source,
        r.external_id,
        sqlNow()
      );
      tallyUpsert(counts, classifyUpsert(false, false));
      sink?.push({
        target_table: "activities",
        target_id: Number(info.lastInsertRowid),
        disposition: "inserted",
      });
    }
  }
  return counts;
}

// Upsert activity GPS routes into the activity_routes child table (issue #569),
// keyed 1:1 on the parent activity by activity_id (UNIQUE). Each incoming route
// carries its parent's `external_id`; we resolve that to the activity's DB id with
// a PROFILE-SCOPED SELECT (so the write can never reach across profiles) and skip a
// route whose parent activity doesn't exist — e.g. one that was tombstoned/skipped
// by upsertActivities this same run. Routes are source-owned and never hand-edited,
// so there's no edit-lock/tombstone path here; the ON CONFLICT keeps re-syncs
// idempotent, and a SELECT-before-compare counts an unchanged polyline as unchanged
// rather than a write. Call it AFTER upsertActivities in the same writeTx.
export function upsertActivityRoutes(
  profileId: number,
  rows: NormActivityRoute[],
  source: string
): UpsertCounts {
  const findActivity = db.prepare(
    "SELECT id FROM activities WHERE profile_id = ? AND external_id = ?"
  );
  const findRoute = db.prepare(
    "SELECT polyline, start_lat, start_lng, end_lat, end_lng FROM activity_routes WHERE activity_id = ?"
  );
  const upsert = db.prepare(
    `INSERT INTO activity_routes
       (activity_id, polyline, start_lat, start_lng, end_lat, end_lng, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(activity_id) DO UPDATE SET
       polyline = excluded.polyline,
       start_lat = excluded.start_lat, start_lng = excluded.start_lng,
       end_lat = excluded.end_lat, end_lng = excluded.end_lng,
       source = excluded.source`
  );
  const counts = emptyCounts();
  for (const r of rows) {
    if (!r.polyline) continue;
    const act = findActivity.get(profileId, r.external_id) as
      { id: number } | undefined;
    if (!act) continue; // parent skipped/tombstoned this run — no orphan route
    const found = findRoute.get(act.id) as
      | {
          polyline: string;
          start_lat: number | null;
          start_lng: number | null;
          end_lat: number | null;
          end_lng: number | null;
        }
      | undefined;
    const equal =
      !!found &&
      found.polyline === r.polyline &&
      found.start_lat === r.start_lat &&
      found.start_lng === r.start_lng &&
      found.end_lat === r.end_lat &&
      found.end_lng === r.end_lng;
    const disposition = classifyUpsert(!!found, equal);
    if (disposition === "unchanged") {
      tallyUpsert(counts, disposition);
      continue;
    }
    upsert.run(
      act.id,
      r.polyline,
      r.start_lat,
      r.start_lng,
      r.end_lat,
      r.end_lng,
      source
    );
    tallyUpsert(counts, disposition);
  }
  return counts;
}

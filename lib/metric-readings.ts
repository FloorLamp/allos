import { db } from "@/lib/db";
import { isEditLocked } from "@/lib/integrations/sync-log";
import { getMoodReadings } from "@/lib/queries";
import {
  clearMoodRating,
  deleteMoodLog,
  updateMoodRating,
} from "@/lib/offline/writes";
import {
  MOOD_MAX,
  MOOD_MIN,
  moodRatingColumn,
  type MoodChartSeries,
} from "@/lib/mood";
import { readingIdentity } from "@/lib/reading-model";
import type { MetricRowTarget } from "@/lib/reading-placement";
import {
  deleteReadingAt,
  updateReadingAt,
  type ReadingDeleteOutcome,
  type ReadingWriteOutcome,
} from "@/lib/reading-writes";
import { HRV_METRIC, SKIN_TEMP_DELTA_METRIC } from "@/lib/vitals-input";
import type { BodyMetricSlug } from "@/lib/trends-body-metrics";
import type { BodyMetricColumn } from "@/lib/reading-identity-map";

export type { ReadingDeleteOutcome, ReadingWriteOutcome };

// The per-READING layer under a metric detail page (issue #1488, absorbing #1397).
//
// #1488's detail pages carry a readings TABLE below the chart — the chart's
// inspectable companion — and each row offers Edit / Delete through the standard ⋯
// overflow menu. That table is #1397's fix home: Trends' quick-adds were upsert-only,
// so a mis-typed manual HRV or sleep-hours value was a TRUE dead end (there was not
// even a production `DELETE FROM metric_samples`).
//
// This module is the auth-blind READ core plus the metric registry: `profileId` first,
// no `lib/auth` import (the Server Actions in app/(app)/trends/reading-actions.ts own
// the gate).
//
// THE WRITES MOVED (#2032, phase 2 of #1997). Correcting and deleting a reading is no
// longer a question about a metric slug — it is a question about the ROW, so it lives in
// `lib/reading-writes.ts` behind ONE contract keyed by `ReadingTarget`. What is left
// here is `metricReadingTarget()`, the slug → row adapter, and the two named wrappers
// the slug-speaking callers still use. The reason is concrete: this page folds in
// same-identity clinical observations (#1996), and while the write path resolved a store
// from the slug, every one of those rows had to be rendered read-only.
//
// THREE STORES, ONE SHAPE. A metric's readings live in whichever observation store
// its domain uses — `body_metrics` (weight / body fat / resting HR), `metric_samples`
// (the synced daily measures + HRV), `medical_records` (the vitals that store as lab
// rows), or the mood store. #860 deliberately left those tables UN-merged, and phase 3
// (the physical merge) is still a separate, later decision; what is shared is BEHAVIOR,
// via the substrate helpers the read path and the write core both call:
//
//   • the #133 EDIT LOCK — an edit stamps `edited = 1` so the next rolling-window
//     re-push skips the hand-corrected row instead of silently restoring the wrong
//     number (metric_samples got its column in migration 115 for exactly this);
//   • the #507/#508 RE-IMPORT TOMBSTONE — deleting a source-owned row records its
//     natural key so the next sync can't resurrect it.
//
// DERIVED SERIES HAVE NO READINGS. BMI is a date-paired computation over two other
// series, daily-average HR is an aggregate over hr_minutes, and sun/outdoor minutes
// is derived from activities against the solar day. None of them has a row a user
// could meaningfully edit, so their store is `null` and the detail page renders the
// chart alone — with the honest reason, never an empty table implying data is
// missing. Fixing a BMI means fixing the weight or height it came from.

// The `body_metrics` measure columns. DECLARED in lib/reading-identity-map.ts (#2086)
// and re-exported here, where every reader already looks: it is identity vocabulary —
// the stream keys the identity map registers — and the map must stay import-light, so
// the declaration cannot live in this module, which opens the database.
export type { BodyMetricColumn };

export type MetricReadingStore =
  | { table: "body_metrics"; column: BodyMetricColumn }
  | { table: "metric_samples"; metric: string }
  | { table: "medical_records"; canonical: string }
  // The mood check-in store. Named "mood" and NOT by its table, deliberately: mood is
  // store-private (#992) — only its own migration / read layer / write core may name
  // the table, and this module reaches it through those (pinned by
  // lib/__tests__/mood-guardrails.test.ts, a substring guard).
  //
  // `series` says WHICH of the check-in's three 1–5 ratings the metric is (#1408) —
  // one row, three readings, the same one-row-many-measures shape `body_metrics`
  // already has (see `deleteReadingAt` for how each is removed without taking the
  // others). The value crossing this boundary is in STORED semantics; `calm`'s
  // display relabel belongs to the page, beside weight's unit conversion.
  | { table: "mood"; series: MoodChartSeries };

export type MetricReadingTable = MetricReadingStore["table"];

/**
 * Which store holds a metric's individual readings, or `null` for a DERIVED series
 * whose points are computed rather than recorded (see the header).
 *
 * The keys are the ONE metric registry (`BodyMetricSlug`), so a new detail-page kind
 * declares its store here or is explicitly derived — it can't quietly render a table
 * of the wrong table's rows.
 */
export const METRIC_READING_STORE: Record<
  BodyMetricSlug,
  MetricReadingStore | null
> = {
  // Vitals that store as lab-shaped rows, keyed by canonical name (#482).
  systolic: { table: "medical_records", canonical: "Blood Pressure Systolic" },
  diastolic: {
    table: "medical_records",
    canonical: "Blood Pressure Diastolic",
  },
  spo2: { table: "medical_records", canonical: "Oxygen Saturation" },
  "respiratory-rate": {
    table: "medical_records",
    canonical: "Respiratory Rate",
  },
  temperature: { table: "medical_records", canonical: "Body Temperature" },
  // The body-composition triple.
  weight: { table: "body_metrics", column: "weight_kg" },
  "body-fat": { table: "body_metrics", column: "body_fat_pct" },
  "resting-hr": { table: "body_metrics", column: "resting_hr" },
  // Device / manual samples.
  hrv: { table: "metric_samples", metric: HRV_METRIC },
  // Import-only (#1562) — the tracker owns the baseline, so there is no quick-add.
  // It still has REAL rows, which is exactly why it needs a store: a bad import is
  // otherwise unreachable, and delete-with-tombstone is what the table is for.
  "skin-temp": { table: "metric_samples", metric: SKIN_TEMP_DELTA_METRIC },
  height: { table: "metric_samples", metric: "height_cm" },
  "head-circ": { table: "metric_samples", metric: "head_circumference_cm" },
  steps: { table: "metric_samples", metric: "steps" },
  "active-calories": { table: "metric_samples", metric: "active_kcal" },
  "lean-mass": { table: "metric_samples", metric: "lean_mass_kg" },
  "bone-mass": { table: "metric_samples", metric: "bone_mass_kg" },
  bmr: { table: "metric_samples", metric: "bmr_kcal" },
  hydration: { table: "metric_samples", metric: "hydration_l" },
  calories: { table: "metric_samples", metric: "nutrition_kcal" },
  mood: { table: "mood", series: "valence" },
  energy: { table: "mood", series: "energy" },
  calm: { table: "mood", series: "calm" },
  // Derived — no per-row store (see the header).
  hr: null,
  bmi: null,
  sun: null,
};

// body_metrics is the one store whose COLUMN varies by metric, and interpolating that
// column into the SQL would make three statements the profile-scoping scanner can't
// read (it verifies `profile_id` in LITERAL prepare() text — the guard that keeps a
// cross-profile leak impossible by construction). So each column gets its own literal
// statement, switched here. Verbose on purpose: a scannable statement beats a clever
// one in the layer that decides whose rows you see.
function bodyMetricSelect(column: BodyMetricColumn) {
  switch (column) {
    case "weight_kg":
      return db.prepare(
        `SELECT id, date, weight_kg AS value, source, edited, notes FROM body_metrics
          WHERE profile_id = ? AND weight_kg IS NOT NULL
          ORDER BY date DESC, id DESC LIMIT ?`
      );
    case "body_fat_pct":
      return db.prepare(
        `SELECT id, date, body_fat_pct AS value, source, edited, notes FROM body_metrics
          WHERE profile_id = ? AND body_fat_pct IS NOT NULL
          ORDER BY date DESC, id DESC LIMIT ?`
      );
    case "resting_hr":
      return db.prepare(
        `SELECT id, date, resting_hr AS value, source, edited, notes FROM body_metrics
          WHERE profile_id = ? AND resting_hr IS NOT NULL
          ORDER BY date DESC, id DESC LIMIT ?`
      );
  }
}

/** One row of the detail page's readings table. `value` is in STORED units. */
export interface MetricReading {
  id: number;
  date: string;
  value: number;
  /** Provenance: 'manual', an integration id, 'document:<id>', or null (legacy). */
  source: string | null;
  /** The #133 lock — set once the user hand-corrects an imported row. */
  edited: boolean;
  /** Out-of-range flag, for the stores that carry one (vitals). */
  flag: string | null;
  /** Free text carried by the row, where its store has one. */
  notes: string | null;
}

// How many readings the table shows. A detail page is a reading surface, not an
// export: a synced metric can have thousands of samples, and the answer to "show me
// everything" is Data → Manage, which is built for it.
export const METRIC_READINGS_LIMIT = 200;

/**
 * A metric's individual readings, newest first. Profile-scoped; returns `[]` for a
 * derived metric (no store).
 */
export function getMetricReadings(
  profileId: number,
  slug: BodyMetricSlug,
  limit = METRIC_READINGS_LIMIT
): MetricReading[] {
  const store = METRIC_READING_STORE[slug];
  if (!store) return [];
  switch (store.table) {
    case "body_metrics": {
      const rows = bodyMetricSelect(store.column).all(profileId, limit) as {
        id: number;
        date: string;
        value: number;
        source: string | null;
        edited: number;
        notes: string | null;
      }[];
      return rows.map((r) => ({
        id: r.id,
        date: r.date,
        value: r.value,
        source: r.source,
        edited: isEditLocked(r.edited),
        flag: null,
        notes: r.notes,
      }));
    }
    case "metric_samples": {
      const rows = db
        .prepare(
          `SELECT id, date, value, source, edited
             FROM metric_samples
            WHERE profile_id = ? AND metric = ?
            ORDER BY date DESC, start_time DESC, id DESC
            LIMIT ?`
        )
        .all(profileId, store.metric, limit) as {
        id: number;
        date: string;
        value: number;
        source: string | null;
        edited: number;
      }[];
      return rows.map((r) => ({
        id: r.id,
        date: r.date,
        value: r.value,
        source: r.source,
        edited: isEditLocked(r.edited),
        flag: null,
        notes: null,
      }));
    }
    case "medical_records": {
      const rows = db
        .prepare(
          `SELECT id, date, value_num AS value, source, edited, flag, notes
             FROM medical_records
            WHERE profile_id = ? AND canonical_name = ? AND value_num IS NOT NULL
            ORDER BY date DESC, id DESC
            LIMIT ?`
        )
        .all(profileId, store.canonical, limit) as {
        id: number;
        date: string;
        value: number;
        source: string | null;
        edited: number;
        flag: string | null;
        notes: string | null;
      }[];
      return rows.map((r) => ({
        id: r.id,
        date: r.date,
        value: r.value,
        source: r.source,
        edited: isEditLocked(r.edited),
        flag: r.flag,
        notes: r.notes,
      }));
    }
    case "mood": {
      // Mood is STORE-PRIVATE (#992): this module never names its table — the read
      // and both writes go through the mood store's own read layer / write core.
      return getMoodReadings(
        profileId,
        limit,
        moodRatingColumn(store.series)
      ).map((r) => ({
        id: r.id,
        date: r.date,
        value: r.value,
        // A mood check-in is manual by construction — there is no mood importer.
        source: "manual",
        edited: false,
        flag: null,
        notes: r.notes,
      }));
    }
  }
}

/**
 * The physical row a metric's reading id names — the metric registry's answer to the
 * ONE editability contract (#2032).
 *
 * This is the slug ADAPTER, not a second routing table: it turns "the page I am on" into
 * "the row you are editing" once, so `lib/reading-writes.ts` can execute the write
 * without ever hearing about a metric slug. A surface holding real readings should
 * prefer `readingTarget(reading)` — the row already knows where it lives, which is what
 * makes a folded clinical observation editable on a stream metric's page.
 *
 * Null for a DERIVED metric: there is no row.
 */
export function metricReadingTarget(
  slug: BodyMetricSlug,
  id: number
): MetricRowTarget | null {
  const store = METRIC_READING_STORE[slug];
  if (!store) return null;
  switch (store.table) {
    case "body_metrics":
      return { store: "body_metrics", id, column: store.column };
    case "metric_samples":
      return { store: "metric_samples", id, metric: store.metric };
    case "medical_records":
      return {
        store: "medical_records",
        id,
        identity: readingIdentity(store.canonical),
      };
    case "mood":
      return { store: "mood", id, series: store.series };
  }
}

/**
 * Correct one row of a metric detail page's readings table, in STORED units.
 *
 * The SPLIT this module owns, and the only one left: a READING goes to the one write
 * core, which decides nothing about the surface it came from; a MOOD check-in rating goes
 * to the mood store's own write core, because a 1–5 self-rating is not a reading of a
 * quantity and mood is store-private (#992).
 */
export function updateMetricRow(
  profileId: number,
  target: MetricRowTarget,
  value: number
): ReadingWriteOutcome {
  if (target.store !== "mood") return updateReadingAt(profileId, target, value);
  // Every check-in rating is a whole 1–5 self-rating; the store's write core re-checks
  // the scale, so an off-scale correction is refused there too.
  const rating = Math.round(value);
  if (rating < MOOD_MIN || rating > MOOD_MAX)
    return { ok: false, error: "invalid" };
  return updateMoodRating(
    profileId,
    target.id,
    moodRatingColumn(target.series),
    rating
  )
    ? { ok: true }
    : { ok: false, error: "not-found" };
}

/** Delete one row of that table — the same split, with the same two destinations. */
export function deleteMetricRow(
  profileId: number,
  target: MetricRowTarget
): ReadingDeleteOutcome {
  if (target.store !== "mood") return deleteReadingAt(profileId, target);
  // No tombstone: there is no mood importer to resurrect a deleted check-in.
  //
  // The body_metrics rule one store over (#1408): a check-in ROW carries up to three
  // ratings plus a note and factors, so removing a mis-tapped energy must NOT take that
  // day's mood with it — the optional rating is nulled and the row stays. Valence is the
  // check-in itself (NOT NULL), so removing it removes the day, exactly as it always has.
  if (target.series === "valence") {
    return { ok: deleteMoodLog(profileId, target.id), undoId: null };
  }
  return {
    ok: clearMoodRating(
      profileId,
      target.id,
      target.series === "energy" ? "energy" : "anxiety"
    ),
    undoId: null,
  };
}

/**
 * Correct one reading addressed by metric SLUG — the adapter for the callers that still
 * speak in slugs (bulk correction, the quick-fix paths, the action tests). "This metric
 * is derived, there is no row" is a slug-level answer the target vocabulary cannot
 * express, which is why this wrapper survives rather than being inlined.
 */
export function updateMetricReading(
  profileId: number,
  slug: BodyMetricSlug,
  id: number,
  value: number
): ReadingWriteOutcome {
  const target = metricReadingTarget(slug, id);
  if (!target) return { ok: false, error: "derived" };
  return updateMetricRow(profileId, target, value);
}

/** Delete one reading addressed by metric slug — the same adapter over the contract. */
export function deleteMetricReading(
  profileId: number,
  slug: BodyMetricSlug,
  id: number
): ReadingDeleteOutcome {
  const target = metricReadingTarget(slug, id);
  if (!target) return { ok: false, undoId: null };
  return deleteMetricRow(profileId, target);
}

import { db, writeTx } from "@/lib/db";
import { isEditLocked } from "@/lib/integrations/sync-log";
import { writeImportTombstoneForRow } from "@/lib/integrations/tombstones";
import { captureDelete } from "@/lib/undo-delete-db";
import { getMoodReadings, reconcileFlags } from "@/lib/queries";
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
import { HRV_METRIC, SKIN_TEMP_DELTA_METRIC } from "@/lib/vitals-input";
import type { BodyMetricSlug } from "@/lib/trends-body-metrics";

// The per-READING layer under a metric detail page (issue #1488, absorbing #1397).
//
// #1488's detail pages carry a readings TABLE below the chart — the chart's
// inspectable companion — and each row offers Edit / Delete through the standard ⋯
// overflow menu. That table is #1397's fix home: Trends' quick-adds were upsert-only,
// so a mis-typed manual HRV or sleep-hours value was a TRUE dead end (there was not
// even a production `DELETE FROM metric_samples`).
//
// This module is the auth-blind write/read core: `profileId` first, no `lib/auth`
// import (the Server Actions in app/(app)/trends/reading-actions.ts own the gate).
//
// THREE STORES, ONE SHAPE. A metric's readings live in whichever observation store
// its domain uses — `body_metrics` (weight / body fat / resting HR), `metric_samples`
// (the synced daily measures + HRV), `medical_records` (the vitals that store as lab
// rows), or the mood store. #860 deliberately left those tables UN-merged; what is
// shared is BEHAVIOR, via the substrate helpers every path here calls:
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

export type BodyMetricColumn = "weight_kg" | "body_fat_pct" | "resting_hr";

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
  // already has (see the delete case for how each is removed without taking the
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

// The #133 lock is only meaningful on a SOURCE-OWNED row (the keyed upsert dedups on
// (date, source)); a manual row has no source to be re-pushed from, so its flag is
// left alone — the same CASE the medical record editor uses.
function bodyMetricUpdate(column: BodyMetricColumn) {
  switch (column) {
    case "weight_kg":
      return db.prepare(
        `UPDATE body_metrics
            SET weight_kg = ?, edited = CASE WHEN source IS NOT NULL THEN 1 ELSE edited END
          WHERE id = ? AND profile_id = ? AND weight_kg IS NOT NULL`
      );
    case "body_fat_pct":
      return db.prepare(
        `UPDATE body_metrics
            SET body_fat_pct = ?, edited = CASE WHEN source IS NOT NULL THEN 1 ELSE edited END
          WHERE id = ? AND profile_id = ? AND body_fat_pct IS NOT NULL`
      );
    case "resting_hr":
      return db.prepare(
        `UPDATE body_metrics
            SET resting_hr = ?, edited = CASE WHEN source IS NOT NULL THEN 1 ELSE edited END
          WHERE id = ? AND profile_id = ? AND resting_hr IS NOT NULL`
      );
  }
}

// Clear ONE measure off a shared row (see deleteMetricReading).
function bodyMetricClear(column: BodyMetricColumn) {
  switch (column) {
    case "weight_kg":
      return db.prepare(
        `UPDATE body_metrics SET weight_kg = NULL, edited = 1
          WHERE id = ? AND profile_id = ?`
      );
    case "body_fat_pct":
      return db.prepare(
        `UPDATE body_metrics SET body_fat_pct = NULL, edited = 1
          WHERE id = ? AND profile_id = ?`
      );
    case "resting_hr":
      return db.prepare(
        `UPDATE body_metrics SET resting_hr = NULL, edited = 1
          WHERE id = ? AND profile_id = ?`
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

export type ReadingWriteOutcome =
  { ok: true } | { ok: false; error: "not-found" | "derived" | "invalid" };

/**
 * Correct one reading's value, in STORED units. Sets the #133 `edited` lock so a
 * later re-push of an imported row can't silently restore the wrong number.
 *
 * Profile-scoped by the WHERE clause, so an id belonging to another profile is a
 * `not-found` no-op rather than a cross-profile write.
 */
export function updateMetricReading(
  profileId: number,
  slug: BodyMetricSlug,
  id: number,
  value: number
): ReadingWriteOutcome {
  const store = METRIC_READING_STORE[slug];
  if (!store) return { ok: false, error: "derived" };
  if (!Number.isFinite(value)) return { ok: false, error: "invalid" };

  return writeTx(() => {
    switch (store.table) {
      case "body_metrics": {
        const info = bodyMetricUpdate(store.column).run(value, id, profileId);
        return info.changes > 0
          ? ({ ok: true } as const)
          : ({ ok: false, error: "not-found" } as const);
      }
      case "metric_samples": {
        const info = db
          .prepare(
            `UPDATE metric_samples SET value = ?, edited = 1
              WHERE id = ? AND profile_id = ? AND metric = ?`
          )
          .run(value, id, profileId, store.metric);
        return info.changes > 0
          ? ({ ok: true } as const)
          : ({ ok: false, error: "not-found" } as const);
      }
      case "medical_records": {
        const info = db
          .prepare(
            `UPDATE medical_records
                SET value = ?, value_num = ?,
                    -- Same #133 lock the record editor applies: an imported vital
                    -- corrected here must survive the next rolling window.
                    edited = CASE WHEN external_id IS NOT NULL THEN 1 ELSE edited END
              WHERE id = ? AND profile_id = ? AND canonical_name = ?`
          )
          .run(String(value), value, id, profileId, store.canonical);
        if (info.changes === 0)
          return { ok: false, error: "not-found" } as const;
        // A vital's out-of-range flag is a FUNCTION of its value, so a corrected
        // value re-derives it through the SAME reconcileFlags the record editor
        // calls (#221) — otherwise an edited-down blood pressure keeps its old
        // "high". One computation, not a second flag engine here.
        reconcileFlags(profileId, [id]);
        return { ok: true } as const;
      }
      case "mood": {
        // Every check-in rating is a whole 1–5 self-rating; the store's write core
        // re-checks the scale, so an off-scale correction is refused there too.
        const rating = Math.round(value);
        if (rating < MOOD_MIN || rating > MOOD_MAX)
          return { ok: false, error: "invalid" } as const;
        return updateMoodRating(
          profileId,
          id,
          moodRatingColumn(store.series),
          rating
        )
          ? ({ ok: true } as const)
          : ({ ok: false, error: "not-found" } as const);
      }
    }
  });
}

export interface ReadingDeleteOutcome {
  ok: boolean;
  /** Present when the delete went through the undo holding store. */
  undoId: number | null;
}

/**
 * Delete one reading. Where an undoable capture already exists for the store's root
 * (body_metrics, medical_records) it goes through `captureDelete`, which writes the
 * re-import tombstone and makes the delete restorable from the toast. The two stores
 * with no undoable root delete directly, capturing their tombstone pre-image FIRST —
 * the #653 pattern from the Data → Manage bulk delete, without which the next
 * rolling-window sync would simply re-insert the row the user just removed.
 */
export function deleteMetricReading(
  profileId: number,
  slug: BodyMetricSlug,
  id: number
): ReadingDeleteOutcome {
  const store = METRIC_READING_STORE[slug];
  if (!store) return { ok: false, undoId: null };

  switch (store.table) {
    case "body_metrics": {
      // A body_metrics ROW carries up to three measures; deleting the row for a
      // body-fat correction would take that day's weight with it. Null the ONE
      // column instead, and only drop the row when nothing is left on it.
      return writeTx(() => {
        const row = db
          .prepare(
            `SELECT weight_kg, body_fat_pct, resting_hr FROM body_metrics
              WHERE id = ? AND profile_id = ?`
          )
          .get(id, profileId) as
          | {
              weight_kg: number | null;
              body_fat_pct: number | null;
              resting_hr: number | null;
            }
          | undefined;
        if (!row) return { ok: false, undoId: null };
        const others = (
          ["weight_kg", "body_fat_pct", "resting_hr"] as const
        ).filter((c) => c !== store.column && row[c] != null);
        if (others.length === 0) {
          // The row exists only for this measure — capture it whole so the toast's
          // undo restores it (and its tombstone is written/removed with it).
          const undoId = captureDelete("body-metric", profileId, id);
          return { ok: undoId != null, undoId };
        }
        const info = bodyMetricClear(store.column).run(id, profileId);
        return { ok: info.changes > 0, undoId: null };
      });
    }
    case "medical_records": {
      const undoId = captureDelete("biomarker-record", profileId, id);
      return { ok: undoId != null, undoId };
    }
    case "metric_samples": {
      return writeTx(() => {
        const row = db
          .prepare(
            `SELECT metric, source, origin, start_time FROM metric_samples
              WHERE id = ? AND profile_id = ? AND metric = ?`
          )
          .get(id, profileId, store.metric) as
          Record<string, unknown> | undefined;
        if (!row) return { ok: false, undoId: null };
        const info = db
          .prepare(`DELETE FROM metric_samples WHERE id = ? AND profile_id = ?`)
          .run(id, profileId);
        // The pre-image was read BEFORE the delete — the row is gone now, and the
        // tombstone is what stops the next sync from re-inserting it (#508/#653).
        writeImportTombstoneForRow(profileId, "metric_samples", row);
        return { ok: info.changes > 0, undoId: null };
      });
    }
    case "mood": {
      // No tombstone: there is no mood importer to resurrect a deleted check-in.
      //
      // The body_metrics rule one store down (#1408): a check-in ROW carries up to
      // three ratings plus a note and factors, so removing a mis-tapped energy must
      // NOT take that day's mood with it — the optional rating is nulled and the row
      // stays. Valence is the check-in itself (NOT NULL), so removing it removes the
      // day, exactly as it always has.
      if (store.series === "valence") {
        return { ok: deleteMoodLog(profileId, id), undoId: null };
      }
      return {
        ok: clearMoodRating(
          profileId,
          id,
          store.series === "energy" ? "energy" : "anxiety"
        ),
        undoId: null,
      };
    }
  }
}

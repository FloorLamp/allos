import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #2810 — the continuous-glucose TRACE store.
//
// WHY A TABLE OF ITS OWN, rather than the `metric_samples` metric the issue asked
// for. docs/internals/reading-model.md ("Where continuous glucose belongs") rules
// that the reading model covers dated readings ABOVE minute grain: a real CGM is
// 288 readings a day, which puts it on `hr_minutes`' side of that boundary, not
// `peak_flow_lmin`'s. So a trace point carries NO `Reading` identity, no
// provenance and no fold — routing ~100k rows a year through `dedupeReadings`'
// (identity, date, source, value) group would cost more than it answers, and a
// per-5-minute point is not what a judgement, a period average or a readings table
// is asking about.
//
// The DAILY DERIVATIONS the trace supports — mean glucose, time-in-range — are
// above that boundary and are what a `metric_samples` metric legitimately holds
// (lib/glucose-trace.ts derives them, lib/glucose-trace-db.ts writes them through
// the existing `upsertMetricSamples` core). This table holds only the raw stream.
//
// THE SHAPE, and each column's reason:
//   • `ts` is a CANONICAL UTC instant (lib/date.ts utcInstant), minute-truncated —
//     BORN on the #2205 convention, so no reader ever has to guess a
//     serialization the way hr_minutes' pre-164 profile-local wall clock forced.
//     The profile-LOCAL day is derived at read time (lib/local-day-window.ts), so
//     a timezone change re-reads history correctly instead of re-meaning it (#94).
//   • `mgdl` is the canonical unit for glucose in this app — the same unit the
//     curated vocabulary stores and the Health Connect ingest converts mmol/L into.
//     Display conversion is a boundary concern, not a storage one.
//   • `source` is in the PRIMARY KEY, which is migration 014's hr_minutes lesson
//     taken at birth rather than as a rebuild: two writers of the same quantity
//     (a vendor CGM integration and a Health Connect push describing the same
//     sensor) must coexist instead of clobbering each other's minutes, while a
//     re-push from the SAME source still replaces its own point (idempotent).
//
// NO `n` COLUMN, deliberately. `hr_minutes.n` exists because a minute BUCKET is a
// count-weighted average of raw samples and a merge has to weight them. A CGM
// point is not a bucket: it is one interstitial reading the sensor emitted at one
// instant, so there is nothing to weight and a count would be a fiction. The
// per-day POINT COUNT — the coverage figure that says whether a day's mean and
// time-in-range are worth reading — is a daily derivation and lives with the
// others in `metric_samples`.
//
// NO PER-ROW DELETE PATH, the hr_minutes posture: the export dataset is
// browse/export-only (`deletable: false`), so there is nothing for a sync to
// resurrect and the table is intentionally absent from TOMBSTONE_TABLES. The
// derived `metric_samples` rows DO go through the tombstone/edit-lock consult,
// because that table has both.
//
// CLEANUP CLASS (#203): the fastest-growing table in the app after hr_minutes —
// ~105k rows a year for a continuously worn sensor. Cleared by profile_id via
// OWNED_TABLES on profile deletion.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS glucose_trace (
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      ts TEXT NOT NULL,
      mgdl REAL NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (profile_id, ts, source)
    )
  `);
}

export const migration: Migration = {
  name: "20260819-glucose-trace",
  up,
};

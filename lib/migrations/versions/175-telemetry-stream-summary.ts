import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 175 — a place on each telemetry row for the summary the cycling
// overview reads instead of the streams themselves (#2292).
//
// `getCyclingOverviewData` used to JSON.parse every `activity_telemetry.streams_json`
// row for the profile on each load of Training → Analyze → Cycling, to derive two
// things: the power-curve bests and the per-zone seconds. Streams are the largest
// payload the schema carries, so the page's cost scaled with total ride history in
// BYTES PARSED. Those two values are pure functions of the telemetry row's own
// columns, so they are now computed once at ingest and stored here.
//
// PURE DDL, deliberately. There is no backfill in this file: the boot task
// reconcileCyclingStreamSummaries (lib/cycling-stream-summary-db.ts) fills a NULL
// summary and re-derives a stale one with the SAME pass, because the derivation
// rule (POWER_CURVE_DURATIONS, the rolling-mean logic) lives in lib/ and changes in
// releases with no schema change. A one-shot backfill here would cover only the
// rows present today and would leave the recurring case unhandled — so the boot
// reconcile is the backfill, and this migration stays a file nobody needs to reason
// about again.
//
// Guarded ADD COLUMN keeps a replay a pure no-op (house style). Determinism: reads
// only the DB.
function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  if (columnNames(db, "activity_telemetry").has("stream_summary_json")) return;
  db.exec(
    `ALTER TABLE activity_telemetry ADD COLUMN stream_summary_json TEXT;`
  );
}

export const migration: Migration = {
  id: 175,
  name: "175-telemetry-stream-summary",
  up,
};

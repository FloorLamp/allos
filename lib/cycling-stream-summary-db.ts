// The DB half of the #2292 precompute: keep every `activity_telemetry` row's
// `stream_summary_json` in step with the derivation that produced it.
//
// WHY A BOOT TASK AND NOT A DATA-MOVE MIGRATION. Precomputing a value at ingest
// has one silent, permanent failure mode: change the rule and every row already
// on disk keeps answering the previous question, with nothing red anywhere. The
// summary's signature (lib/cycling-stream-summary.ts) names the rule that made
// it, so a rule change is DETECTABLE — but only if something re-derives. A
// migration could not: POWER_CURVE_DURATIONS and the derivation logic live in
// lib/, and they change in releases with NO schema change at all. That is exactly
// the reasoning seedCanonicalBiomarkers and reconcileFlagsIfCanonicalChanged are
// boot tasks for, and it is the shape of the two bugs #2306 and PR #2309 fixed:
// stored state silently out of sync with the rule that produced it.
//
// Running here also makes migration 175 pure DDL — one ADD COLUMN, no data move,
// no lib imports inside a permanently frozen file — because this same pass IS the
// backfill: a NULL summary and a stale-signature summary are the same case to it.
// One mechanism covers the backfill, every future rule change, and any row a
// writer other than upsertCyclingTelemetry ever creates.
//
// CHEAP WHEN THERE IS NOTHING TO DO, following #2307's refinement of the pattern:
// the plan is computed with READS ONLY over the small summary column, and the
// write transaction is opened only when it is non-empty — so the notify tick's
// several-times-an-hour boot takes no write lock, and `streams_json` is never
// read on a boot with no drift to repair.
//
// PROFILE SCOPING. `activity_telemetry` is profile-owned, but this is global
// maintenance in the shape of reconcileFlagsIfCanonicalChanged: the summary of a
// ride's own streams is the same value whoever owns the ride, the pass rewrites
// only the row's own derived column, and it never reads across profiles. Its two
// statements carry allowlist entries in lib/__tests__/profile-scoping.test.ts.

import type Database from "better-sqlite3";
import {
  serializeCyclingStreamSummary,
  streamSummarySignature,
  summarizeCyclingStreams,
} from "./cycling-stream-summary";
import { runBootTx } from "./migrations/schema-utils";

// Schema introspection, the #684 posture: a boot task must be VERSION-AGNOSTIC,
// because it also runs against handles built to an earlier schema (the migration
// tests drive bootTasks on a partial DB). Cycling telemetry arrived in migration
// 159, so on anything older there is simply nothing to reconcile. Binds the name
// rather than interpolating it, so this reads no owned table.
function tableExists(db: Database.Database): boolean {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get("activity_telemetry") != null
  );
}

// READ-ONLY. The ids whose stored summary is missing or was made by a different
// rule. `IS NOT` is SQLite's null-safe comparison, so a NULL column (never
// summarised, or a row a raw INSERT created) matches without a second clause.
// Deliberately selects ONLY the id: `streams_json` is not read for a row that
// needs no work, which is the entire point.
function planStale(db: Database.Database): number[] {
  return (
    db
      .prepare(
        `SELECT id FROM activity_telemetry
          WHERE json_extract(stream_summary_json, '$.sig') IS NOT ?
          ORDER BY id`
      )
      .all(streamSummarySignature()) as { id: number }[]
  ).map((row) => row.id);
}

// Re-derive the stale summaries. Returns how many rows were rewritten (0 on the
// overwhelmingly common boot where nothing has drifted).
export function reconcileCyclingStreamSummaries(db: Database.Database): number {
  if (!tableExists(db)) return 0;
  if (planStale(db).length === 0) return 0;

  const read = db.prepare(
    `SELECT streams_json, power_zones_json FROM activity_telemetry WHERE id = ?`
  );
  const write = db.prepare(
    `UPDATE activity_telemetry SET stream_summary_json = ? WHERE id = ?`
  );
  let rewritten = 0;
  runBootTx(
    db.transaction(() => {
      // runBootTx re-runs the whole callback on a SQLITE_BUSY retry, so the count
      // is rebuilt from scratch rather than accumulating a lost attempt's rows.
      rewritten = 0;
      // Re-planned INSIDE the write lock so a sync that landed between the probe
      // and here is neither missed nor acted on with stale facts. Row-at-a-time:
      // the backfill pass may face a whole history of streams, and holding every
      // one of them in memory at once is the cost this change exists to avoid.
      for (const id of planStale(db)) {
        const row = read.get(id) as
          | { streams_json: string | null; power_zones_json: string | null }
          | undefined;
        if (!row) continue;
        // summarizeCyclingStreams is TOTAL: a NULL, empty or malformed streams
        // payload yields an empty but SIGNED summary. So every row reached here
        // ends in a terminal state and stops matching planStale — an
        // unsummarisable row is written once, not re-parsed on every boot.
        write.run(
          serializeCyclingStreamSummary(
            summarizeCyclingStreams(row.streams_json, row.power_zones_json)
          ),
          id
        );
        rewritten++;
      }
    })
  );
  return rewritten;
}

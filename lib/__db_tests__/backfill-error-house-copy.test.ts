// DB INTEGRATION TIER — #3198's one-time re-classification of what is ALREADY
// stored in `integration_backfill_jobs.error`.
//
// Every future write is house copy, but the observed leak — a SQLite constraint
// string that sat on the owner's settings card for a week — is a row on disk. The
// migration rewrites the machine strings and must leave the three authored ones
// alone, because a wrongly-rewritten row is invisible while a missed machine string
// is not.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@/lib/migrations/runner";
import { migrationsBefore } from "@/lib/migrations/versions";

const MIGRATION = "20260823-backfill-error-house-copy";

const OBSERVED_LEAK =
  "UNIQUE constraint failed: activity_segment_efforts.profile_id, " +
  "activity_segment_efforts.source, activity_segment_efforts.external_id";

const HOUSE = "Couldn't finish this backfill. It's a bug on our side.";

// (kind, stored error, what it must read afterwards)
const ROWS: [string, string | null, string | null][] = [
  ["ride-details", OBSERVED_LEAK, HOUSE],
  ["laps", "SQLITE_CONSTRAINT_UNIQUE: activity_laps", HOUSE],
  ["shape", "no such column: activity_telemetry.answer", HOUSE],
  // Authored, by the three writers that fill this column legitimately.
  [
    "authored-count",
    "12 sessions could not be completed. Retry the backfill.",
    "12 sessions could not be completed. Retry the backfill.",
  ],
  ["authored-runner", "not connected", "not connected"],
  ["none", null, null],
];

function seeded(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db, migrationsBefore(MIGRATION));
  db.prepare(
    "INSERT INTO profiles (id, name) VALUES (1, 'BACKFILL-COPY')"
  ).run();
  for (const [kind, error] of ROWS) {
    db.prepare(
      `INSERT INTO integration_backfill_jobs
         (profile_id, source_id, kind, label, item_noun, status, total_items,
          completed_items, failed_items, request_count, active_seconds,
          started_at, error, created_at, updated_at)
       VALUES (1, 'strava', ?, 'Session detail backfill', 'session', 'failed',
               208, 48, 1, 117, 10, '2026-08-12T09:00:00Z', ?,
               '2026-08-12T09:00:00Z', '2026-08-12T09:45:02Z')`
    ).run(kind, error);
  }
  return db;
}

describe(MIGRATION, () => {
  it("rewrites every machine string and leaves authored ones byte-identical", () => {
    const db = seeded();
    try {
      // Premise, asserted rather than assumed: the leak is on the row before.
      expect(
        (
          db
            .prepare(
              "SELECT error FROM integration_backfill_jobs WHERE kind = 'ride-details'"
            )
            .get() as { error: string }
        ).error
      ).toBe(OBSERVED_LEAK);

      runMigrations(db);

      const after = db
        .prepare(
          "SELECT kind, error FROM integration_backfill_jobs ORDER BY id"
        )
        .all() as { kind: string; error: string | null }[];
      expect(after.map((r) => [r.kind, r.error])).toEqual(
        ROWS.map(([kind, , expected]) => [kind, expected])
      );
      for (const { error } of after) {
        if (error)
          expect(error, error).not.toMatch(/constraint|SQLITE_|activity_/i);
      }
    } finally {
      db.close();
    }
  });
});

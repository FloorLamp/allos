// DB INTEGRATION TIER — migration 123's legacy duplicate reconciliation (#1623).
//
// Applies the schema through 122, seeds the race artifact with case/whitespace
// variants, then proves 123 keeps the oldest target, repairs every side reference,
// and enables the normalized partial unique index.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "@/lib/migrations/versions";
import { up as up123 } from "@/lib/migrations/versions/123-practice-target-unique";
import { practiceIdentity, practiceSignalKey } from "@/lib/practice";

function applyThrough(maxId: number): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.pragma("busy_timeout = 10000");
  for (const migration of MIGRATIONS) {
    if (migration.id > maxId) break;
    migration.up(db);
  }
  return db;
}

describe("migration 123 collapses practice-target identity duplicates", () => {
  it("keeps the oldest row and re-keys protocols, suppressions, and logs", () => {
    const db = applyThrough(122);
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('Practice dupes')").run()
        .lastInsertRowid
    );
    const otherProfileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('Other profile')").run()
        .lastInsertRowid
    );

    const keeper = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets
             (profile_id, scope_kind, scope_value, per_week)
           VALUES (?, 'practice', '  Sauna\t Ritual  ', 2)`
        )
        .run(profileId).lastInsertRowid
    );
    const loser = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets
             (profile_id, scope_kind, scope_value, per_week)
           VALUES (?, 'practice', 'sauna   ritual', 4)`
        )
        .run(profileId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO frequency_targets
         (profile_id, scope_kind, scope_value, per_week)
       VALUES (?, 'practice', 'SAUNA RITUAL', 3)`
    ).run(otherProfileId);

    const protocolId = Number(
      db
        .prepare(
          `INSERT INTO protocols
             (profile_id, name, start_date, outcome_keys,
              frequency_target_id, owns_frequency_target)
           VALUES (?, 'Sauna protocol', '2026-07-01', '[]', ?, 1)`
        )
        .run(profileId, loser).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO upcoming_dismissals (profile_id, signal_key, dismissed_at)
       VALUES (?, ?, '2026-07-10')`
    ).run(profileId, practiceSignalKey(loser));
    db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date, edited)
       VALUES (?, 'SAUNA   RITUAL', '2026-07-01', 0),
              (?, ' sauna ritual ', '2026-07-02', 0),
              (?, 'SAUNA RITUAL', '2026-07-03', 0)`
    ).run(profileId, profileId, otherProfileId);

    expect(() => up123(db)).not.toThrow();

    expect(
      db
        .prepare(
          `SELECT id, scope_value, scope_identity, per_week
             FROM frequency_targets
            WHERE profile_id = ? AND scope_kind = 'practice'`
        )
        .all(profileId)
    ).toEqual([
      {
        id: keeper,
        scope_value: "Sauna Ritual",
        scope_identity: "sauna ritual",
        per_week: 2,
      },
    ]);
    expect(
      db
        .prepare("SELECT frequency_target_id FROM protocols WHERE id = ?")
        .get(protocolId)
    ).toEqual({ frequency_target_id: keeper });
    expect(
      db
        .prepare(
          `SELECT signal_key FROM upcoming_dismissals
            WHERE profile_id = ?`
        )
        .all(profileId)
    ).toEqual([{ signal_key: practiceSignalKey(keeper) }]);
    expect(
      db
        .prepare(
          `SELECT practice, edited FROM practice_logs
            WHERE profile_id = ? ORDER BY id`
        )
        .all(profileId)
    ).toEqual([
      { practice: "Sauna Ritual", edited: 1 },
      { practice: "Sauna Ritual", edited: 1 },
    ]);

    expect(() =>
      db
        .prepare(
          `INSERT INTO frequency_targets
             (profile_id, scope_kind, scope_value, scope_identity, per_week)
           VALUES (?, 'practice', 'SAUNA RITUAL', ?, 5)`
        )
        .run(profileId, practiceIdentity(" SAUNA\tRITUAL "))
    ).toThrow(/UNIQUE/i);
    expect(() =>
      db
        .prepare(
          `INSERT INTO frequency_targets
             (profile_id, scope_kind, scope_value, per_week)
           VALUES (?, 'practice', 'Cold plunge', 3)`
        )
        .run(profileId)
    ).toThrow(/scope_identity is required/i);

    // The identity is profile-local, and replay remains a no-op.
    expect(
      db
        .prepare(
          `SELECT scope_identity FROM frequency_targets
            WHERE profile_id = ? AND scope_kind = 'practice'`
        )
        .get(otherProfileId)
    ).toEqual({ scope_identity: "sauna ritual" });
    expect(() => up123(db)).not.toThrow();

    db.close();
  });
});

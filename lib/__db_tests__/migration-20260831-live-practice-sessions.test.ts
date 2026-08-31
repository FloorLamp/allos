import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@/lib/migrations/runner";
import { migrationsBefore } from "@/lib/migrations/versions";
import { up } from "@/lib/migrations/versions/20260831-live-practice-sessions";

const MIGRATION = "20260831-live-practice-sessions";

describe(MIGRATION, () => {
  it("adds an explicit non-live default without rewriting existing sessions", () => {
    const db = new Database(":memory:");
    runMigrations(db, migrationsBefore(MIGRATION));
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('practice-live')").run()
        .lastInsertRowid
    );
    const id = Number(
      db
        .prepare(
          `INSERT INTO practice_logs (profile_id, practice, date, start_time)
           VALUES (?, 'Sauna', '2026-08-31', '08:15')`
        )
        .run(profileId).lastInsertRowid
    );

    up(db);
    up(db);

    expect(
      db.prepare("SELECT id, live FROM practice_logs WHERE id = ?").get(id)
    ).toEqual({ id, live: 0 });
    expect(
      db
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'idx_practice_logs_profile_live'"
        )
        .get()
    ).toEqual({ present: 1 });
    expect(() =>
      db.prepare("UPDATE practice_logs SET live = 2 WHERE id = ?").run(id)
    ).toThrow(/CHECK/i);
    db.close();
  });
});

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@/lib/migrations/runner";
import { migrationsBefore } from "@/lib/migrations/versions";
import { up } from "@/lib/migrations/versions/20260831-practice-derived-windows";

const MIGRATION = "20260831-practice-derived-windows";

describe(MIGRATION, () => {
  it("adds an explicit user-stated default and is replay-safe", () => {
    const db = new Database(":memory:");
    runMigrations(db, migrationsBefore(MIGRATION));
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('derived-window')").run()
        .lastInsertRowid
    );
    const id = Number(
      db
        .prepare(
          `INSERT INTO practice_logs
             (profile_id, practice, date, start_time, end_time, duration_min)
           VALUES (?, 'Sauna', '2026-08-31', '09:00', '09:30', 30)`
        )
        .run(profileId).lastInsertRowid
    );

    up(db);
    up(db);
    expect(
      db
        .prepare(
          "SELECT derived_window, correction_locked FROM practice_logs WHERE id = ?"
        )
        .get(id)
    ).toEqual({ derived_window: 0, correction_locked: 0 });
    expect(() =>
      db
        .prepare("UPDATE practice_logs SET derived_window = 2 WHERE id = ?")
        .run(id)
    ).toThrow(/CHECK/i);
    expect(() =>
      db
        .prepare("UPDATE practice_logs SET correction_locked = 2 WHERE id = ?")
        .run(id)
    ).toThrow(/CHECK/i);
    db.close();
  });
});

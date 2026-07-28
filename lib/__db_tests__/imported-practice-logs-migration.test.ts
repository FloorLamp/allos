import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/migrations/versions/118-imported-practice-logs";

describe("migration 118 — imported wellness practices", () => {
  it("moves only untouched, childless Fitbit meditation activities", () => {
    const mem = new Database(":memory:");
    mem.exec(`
      CREATE TABLE profiles (id INTEGER PRIMARY KEY);
      INSERT INTO profiles (id) VALUES (1);
      CREATE TABLE activities (
        id INTEGER PRIMARY KEY,
        profile_id INTEGER NOT NULL,
        source TEXT,
        external_id TEXT,
        edited INTEGER DEFAULT 0,
        title TEXT NOT NULL,
        date TEXT NOT NULL,
        start_time TEXT,
        duration_min INTEGER
      );
      CREATE TABLE exercise_sets (
        id INTEGER PRIMARY KEY,
        activity_id INTEGER NOT NULL
      );
      CREATE TABLE activity_routes (
        id INTEGER PRIMARY KEY,
        activity_id INTEGER NOT NULL
      );
      CREATE TABLE activity_videos (
        id INTEGER PRIMARY KEY,
        activity_id INTEGER NOT NULL
      );
      CREATE TABLE fitness_assessments (
        id INTEGER PRIMARY KEY,
        activity_id INTEGER REFERENCES activities(id) ON DELETE SET NULL
      );
      CREATE TABLE practice_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL,
        practice TEXT NOT NULL,
        date TEXT NOT NULL,
        time TEXT,
        duration_min INTEGER,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO activities
        (id, profile_id, source, external_id, edited, title, date, start_time, duration_min)
      VALUES
        (1, 1, 'fitbit-takeout', 'fitbit-takeout:1', 0, 'Meditating',
         '2026-06-13', '13:05', 30),
        (2, 1, 'fitbit-takeout', 'fitbit-takeout:2', 1, 'Meditating',
         '2026-06-14', '14:00', 20),
        (3, 1, 'strava', 'strava:3', 0, 'Meditation',
         '2026-06-15', '15:00', 10),
        (4, 1, 'fitbit-takeout', 'fitbit-takeout:4', 0, 'Meditation',
         '2026-06-16', '16:00', 25),
        (5, 1, 'fitbit-takeout', NULL, 0, 'Meditating',
         '2026-06-17', '17:00', 15);
      INSERT INTO exercise_sets (id, activity_id) VALUES (1, 4);
      INSERT INTO fitness_assessments (id, activity_id) VALUES (1, 1);
    `);

    // Match the production migration runner: FK actions are disabled while the
    // migration applies, so migration 118 itself must clear inbound links.
    mem.pragma("foreign_keys = OFF");
    up(mem);
    up(mem);
    mem.pragma("foreign_keys = ON");

    expect(
      mem
        .prepare(
          `SELECT practice, date, time, duration_min, source, external_id, edited
             FROM practice_logs`
        )
        .all()
    ).toEqual([
      {
        practice: "Meditation",
        date: "2026-06-13",
        time: "13:05",
        duration_min: 30,
        source: "fitbit-takeout",
        external_id: "fitbit-takeout:1",
        edited: 0,
      },
    ]);
    expect(mem.prepare(`SELECT id FROM activities ORDER BY id`).all()).toEqual([
      { id: 2 },
      { id: 3 },
      { id: 4 },
      { id: 5 },
    ]);
    expect(
      mem.prepare(`SELECT activity_id FROM fitness_assessments`).get()
    ).toEqual({ activity_id: null });
    expect(mem.pragma("foreign_key_check")).toEqual([]);

    mem.close();
  });
});

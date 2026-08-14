import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/migrations/versions/20260814-saved-clinical-result-namespace";

describe("20260814 saved clinical-result namespace", () => {
  it("carries saved order and digest suppressions through old/new collisions", () => {
    const mem = new Database(":memory:");
    mem.exec(`
      CREATE TABLE profiles (id INTEGER PRIMARY KEY);
      INSERT INTO profiles (id) VALUES (1), (2);
      CREATE TABLE saved_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        kind TEXT NOT NULL,
        key TEXT NOT NULL COLLATE NOCASE,
        position INTEGER,
        created_at TEXT NOT NULL,
        backed INTEGER NOT NULL DEFAULT 0,
        UNIQUE(profile_id, kind, key)
      );
      INSERT INTO saved_items
        (id, profile_id, kind, key, position, created_at, backed)
      VALUES
        (1, 1, 'biomarker', 'apob', 4, '2024-01-01 00:00:00', 0),
        (2, 1, 'clinical-result', 'ApoB', NULL, '2025-01-01 00:00:00', 1),
        (3, 1, 'biomarker', 'Ferritin', NULL, '2024-02-01 00:00:00', 1),
        (4, 1, 'trend-metric', 'weight', 0, '2024-03-01 00:00:00', 0),
        (5, 2, 'biomarker', 'ApoB', 1, '2024-04-01 00:00:00', 1);

      CREATE TABLE upcoming_dismissals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        signal_key TEXT NOT NULL,
        snooze_until TEXT,
        dismissed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX idx_upcoming_dismissals_key
        ON upcoming_dismissals(profile_id, signal_key);
      INSERT INTO upcoming_dismissals
        (profile_id, signal_key, dismissed_at)
      VALUES
        (1, 'digest:bio:ApoB:up', '2024-01-01'),
        (1, 'digest:result:ApoB:up', '2025-01-01'),
        (2, 'digest:bio:Ferritin:down', '2024-02-01');
    `);

    up(mem);

    expect(
      mem
        .prepare(
          `SELECT id, profile_id, kind, key, position, created_at, backed
             FROM saved_items ORDER BY profile_id, position IS NULL, position, key`
        )
        .all()
    ).toEqual([
      {
        id: 4,
        profile_id: 1,
        kind: "trend-metric",
        key: "weight",
        position: 0,
        created_at: "2024-03-01 00:00:00",
        backed: 0,
      },
      {
        id: 1,
        profile_id: 1,
        kind: "clinical-result",
        key: "ApoB",
        position: 4,
        created_at: "2024-01-01 00:00:00",
        backed: 1,
      },
      {
        id: 3,
        profile_id: 1,
        kind: "clinical-result",
        key: "Ferritin",
        position: null,
        created_at: "2024-02-01 00:00:00",
        backed: 1,
      },
      {
        id: 5,
        profile_id: 2,
        kind: "clinical-result",
        key: "ApoB",
        position: 1,
        created_at: "2024-04-01 00:00:00",
        backed: 1,
      },
    ]);
    expect(
      mem
        .prepare(
          `SELECT profile_id, signal_key, dismissed_at
             FROM upcoming_dismissals ORDER BY profile_id, signal_key`
        )
        .all()
    ).toEqual([
      {
        profile_id: 1,
        signal_key: "digest:result:ApoB:up",
        dismissed_at: "2025-01-01",
      },
      {
        profile_id: 2,
        signal_key: "digest:result:Ferritin:down",
        dismissed_at: "2024-02-01",
      },
    ]);
    expect(() =>
      mem
        .prepare(
          "INSERT INTO saved_items (profile_id, kind, key) VALUES (1, 'biomarker', 'LDL')"
        )
        .run()
    ).toThrow();
  });
});

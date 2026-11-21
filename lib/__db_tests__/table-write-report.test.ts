import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { tableWriteReport } from "../../scripts/table-write-report";

it("ranks recent surviving rows and distinguishes zero from unavailable counts", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE activities (id INTEGER PRIMARY KEY, date TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE exercise_sets (activity_id INTEGER REFERENCES activities(id));
      CREATE TABLE goals (created_at TEXT);
      CREATE TABLE allergies (created_at TEXT);
      CREATE TABLE settings (created_at TEXT);

      INSERT INTO activities VALUES
        (1, '2026-01-01', '2026-10-22 12:00:00', NULL),
        (2, '2026-01-01', '2026-01-01 00:00:00', '2026-11-01T14:00:00+02:00'),
        (3, '2026-01-01', '2026-11-01T12:00:00Z', '2026-11-21T12:00:00.000Z'),
        (4, '2026-11-20', '2026-10-22T11:59:59Z', NULL),
        (5, '2026-11-20', '2026-11-22T00:00:00Z', NULL);
      INSERT INTO exercise_sets VALUES (1);
      INSERT INTO allergies VALUES ('2026-11-02 00:00:00');
      INSERT INTO settings VALUES ('2026-11-02 00:00:00');
    `);

    const report = tableWriteReport(db, new Date("2026-11-21T12:00:00Z"));
    const { tables, ...window } = JSON.parse(JSON.stringify(report));
    expect(window).toEqual({
      metric: "recent_rows",
      since: "2026-10-22T12:00:00.000Z",
      until: "2026-11-21T12:00:00.000Z",
    });
    expect(tables.slice(0, 3)).toEqual([
      { table: "activities", recentRows: 3 },
      { table: "allergies", recentRows: 1 },
      { table: "goals", recentRows: 0 },
    ]);
    expect(tables.slice(3)).toContainEqual({
      table: "exercise_sets",
      recentRows: null,
    });
    expect(tables).not.toContainEqual(
      expect.objectContaining({ table: "settings" })
    );
  } finally {
    db.close();
  }
});

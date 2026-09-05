import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import {
  diffSharedRows,
  sharedDayRestorePoint,
  snapshotSharedRows,
} from "../../e2e/shared-profile-guard";
import { makeTmpDir } from "../__tests__/tmp-dir";

// THE ISOLATION MECHANISM, PROVED AGAINST REAL SQL (#5037).
//
// `sharedDayRestorePoint` is the one thing four specs now lean on, and the shape it
// has to survive is a REPLACE: the measurements form deletes the day's rows for a
// metric and writes its own, so a cleanup that only removed what the test added
// would leave the seed's night deleted and look like it had tidied up. The control
// is therefore the guard's OWN diff, run over the same snapshots the fixture runs it
// over — not a fresh query written to check the work.

const NOW = new Date("2026-09-05T13:00:00.000Z");
const TODAY = "2026-09-05";
const YESTERDAY = "2026-09-04";

describe("the shared-profile day restore point", () => {
  let dir: string;
  let dbPath: string;
  let db: Database.Database;

  const insertSample = (
    date: string,
    metric: string,
    startedAt: string,
    value: number
  ) =>
    db
      .prepare(
        `INSERT INTO metric_samples
           (profile_id, source, origin, metric, date, started_at, ended_at, value)
         VALUES (1, 'manual', NULL, ?, ?, ?, ?, ?)`
      )
      .run(metric, date, startedAt, startedAt, value);

  beforeEach(() => {
    dir = makeTmpDir("shared-day-restore");
    dbPath = path.join(dir, "fixture.db");
    db = new Database(dbPath);
    db.exec(`
      CREATE TABLE activities (
        id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL, date TEXT NOT NULL,
        type TEXT NOT NULL, title TEXT NOT NULL
      );
      CREATE TABLE metric_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL,
        source TEXT NOT NULL, origin TEXT, metric TEXT NOT NULL, date TEXT NOT NULL,
        started_at TEXT NOT NULL, ended_at TEXT NOT NULL, value REAL NOT NULL
      );
      CREATE TABLE mood_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL,
        date TEXT NOT NULL, valence INTEGER NOT NULL, energy INTEGER,
        anxiety INTEGER, factors TEXT, notes TEXT
      );
    `);
    // The seed's shape at the moment #5037 bit: a 5h night, its nap, a reading on
    // another metric for the same day, and one row on the day before.
    insertSample(TODAY, "sleep_min", `${YESTERDAY}T23:00:00`, 300);
    insertSample(TODAY, "sleep_min", `${TODAY}T13:00:00`, 45);
    insertSample(TODAY, "peak_flow_lmin", `${TODAY}T07:30:00`, 600);
    insertSample(YESTERDAY, "sleep_min", `${YESTERDAY}T00:00:00`, 290);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const drift = (before: ReturnType<typeof snapshotSharedRows>) =>
    diffSharedRows(before, snapshotSharedRows(NOW, dbPath));

  it.each([
    [
      "a REPLACE — the measurements form's sleep save, which is what leaked",
      () => {
        db.prepare(
          "DELETE FROM metric_samples WHERE profile_id = 1 AND metric = 'sleep_min' AND date = ?"
        ).run(TODAY);
        insertSample(TODAY, "sleep_min", `${TODAY}T00:00:00`, 450);
      },
    ],
    [
      "a plain INSERT — offline-queue's waist reading",
      () =>
        insertSample(
          TODAY,
          "waist_circumference_cm",
          `${TODAY}T00:00:00`,
          91.9
        ),
    ],
    [
      "a bare DELETE — measurements-form-layout clearing the seeded peak flows",
      () =>
        db
          .prepare(
            "DELETE FROM metric_samples WHERE profile_id = 1 AND metric = 'peak_flow_lmin' AND date = ?"
          )
          .run(TODAY),
    ],
    [
      "an in-place EDIT, which no id-keyed cleanup could address",
      () =>
        db
          .prepare(
            "UPDATE metric_samples SET value = 999 WHERE profile_id = 1 AND date = ? AND metric = 'sleep_min'"
          )
          .run(TODAY),
    ],
  ])("puts the day back after %s", (_name, write) => {
    const before = snapshotSharedRows(NOW, dbPath);
    const restore = sharedDayRestorePoint("metric_samples", TODAY, dbPath);
    write();
    // The control is the guard's own diff, and it must SEE the write first —
    // otherwise the restore below would be proving nothing.
    expect(
      drift(before).added.length + drift(before).missing.length
    ).toBeGreaterThan(0);
    restore();
    const after = drift(before);
    expect([after.added, after.missing]).toEqual([[], []]);
    // And the day BEFORE the restore point is untouched by it.
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM metric_samples WHERE profile_id = 1 AND date = ?"
        )
        .get(YESTERDAY)
    ).toEqual({ n: 1 });
  });

  it("restores a day that was EMPTY, rather than leaving the write behind", () => {
    const before = snapshotSharedRows(NOW, dbPath);
    const restore = sharedDayRestorePoint("mood_logs", TODAY, dbPath);
    db.prepare(
      "INSERT INTO mood_logs (profile_id, date, valence) VALUES (1, ?, 4)"
    ).run(TODAY);
    expect(drift(before).added).toHaveLength(1);
    restore();
    expect(drift(before).added).toEqual([]);
  });
});

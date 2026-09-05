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

  const insertRecord = (
    date: string,
    name: string,
    value: string,
    unit: string
  ) =>
    db
      .prepare(
        `INSERT INTO medical_records (profile_id, date, category, name, value, unit)
         VALUES (1, ?, 'vitals', ?, ?, ?)`
      )
      .run(date, name, value, unit);

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
      CREATE TABLE medical_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL,
        date TEXT NOT NULL, category TEXT NOT NULL, name TEXT NOT NULL,
        value TEXT, unit TEXT
      );
      -- The shape #5266 had to reason about: medical_records is the first
      -- watched table that PARENTS other rows, and three of its children cascade.
      CREATE TABLE instrument_responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        medical_record_id INTEGER NOT NULL
          REFERENCES medical_records(id) ON DELETE CASCADE,
        item_index INTEGER NOT NULL, answer INTEGER NOT NULL
      );
    `);
    // The seed's shape at the moment #5037 bit: a 5h night, its nap, a reading on
    // another metric for the same day, and one row on the day before.
    insertSample(TODAY, "sleep_min", `${YESTERDAY}T23:00:00`, 300);
    insertSample(TODAY, "sleep_min", `${TODAY}T13:00:00`, 45);
    insertSample(TODAY, "peak_flow_lmin", `${TODAY}T07:30:00`, 600);
    insertSample(YESTERDAY, "sleep_min", `${YESTERDAY}T00:00:00`, 290);
    // And the shape #5266 widened to: profile 1's ONE today-dated reading, which
    // the specs that drive the vitals form write alongside rather than replace.
    insertRecord(TODAY, "Body Temperature", "99.2", "degF");
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

  // THE TABLE #5266 ADDED, in both directions it is actually written. The vitals
  // form INSERTS alongside the seed's reading; `measurements-form-layout` DELETES
  // the day as a precondition it owns. One is repairable and one is not, and the
  // restore point has to answer for both.
  it.each([
    [
      "an INSERT beside the seed's reading — the vitals form's own shape",
      () => insertRecord(TODAY, "Respiratory Rate", "22", "breaths/min"),
    ],
    [
      "a DELETE of the seed's reading, which no repair could invent back",
      () =>
        db
          .prepare(
            "DELETE FROM medical_records WHERE profile_id = 1 AND date = ?"
          )
          .run(TODAY),
    ],
  ])("puts a medical_records day back after %s", (_name, write) => {
    const before = snapshotSharedRows(NOW, dbPath);
    const restore = sharedDayRestorePoint("medical_records", TODAY, dbPath);
    write();
    expect(
      drift(before).added.length + drift(before).missing.length
    ).toBeGreaterThan(0);
    restore();
    expect([drift(before).added, drift(before).missing]).toEqual([[], []]);
  });

  // THE ONE THING THE RESTORE POINT CANNOT DO, pinned rather than described. The
  // day is put back by DELETing it and re-INSERTing the held rows, so a row with a
  // cascading child loses that child and gets a new id — which is why a spec whose
  // reading carries an instrument score must delete its own row instead of
  // restoring the day. Profile 1's seeded today-dated reading has no children,
  // which is what makes the callers in e2e/ safe.
  it("takes a cascading child with the row it puts back (#5266)", () => {
    const parent = Number(
      insertRecord(TODAY, "PHQ-9", "12", "score").lastInsertRowid
    );
    db.prepare(
      `INSERT INTO instrument_responses (medical_record_id, item_index, answer)
       VALUES (?, 0, 3)`
    ).run(parent);
    // The forged state, read through the same query the assertion below reads —
    // otherwise a silently-failed insert would make this test pass for nothing.
    const answers = () =>
      db.prepare("SELECT COUNT(*) AS n FROM instrument_responses").get();
    expect(answers()).toEqual({ n: 1 });

    const restore = sharedDayRestorePoint("medical_records", TODAY, dbPath);
    restore();

    // The reading itself is back, byte for byte on the watched columns...
    expect(
      db
        .prepare(
          `SELECT name, value, unit FROM medical_records
            WHERE profile_id = 1 AND date = ? ORDER BY name`
        )
        .all(TODAY)
    ).toEqual([
      { name: "Body Temperature", value: "99.2", unit: "degF" },
      { name: "PHQ-9", value: "12", unit: "score" },
    ]);
    // ...and its answers are not.
    expect(answers()).toEqual({ n: 0 });
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

import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { runMigrations } from "@/lib/migrations/runner";
import { migrationsBefore } from "@/lib/migrations/versions";
import { up } from "@/lib/migrations/versions/20260907-dose-schedule-amount";

const MIGRATION = "20260907-dose-schedule-amount";

it("backfills full amount strings as assumed without changing existing logs", () => {
  const db = new Database(":memory:");
  runMigrations(db, migrationsBefore(MIGRATION));
  db.prepare("INSERT INTO profiles(id, name) VALUES (1, 'History')").run();
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, obligation)
         VALUES (1, 'Migration dose', 'supplement', 'should')`
      )
      .run().lastInsertRowid
  );
  const amount = " 1 cap (500 mg) ";
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing)
         VALUES (?, ?, 'Morning', 'any')`
      )
      .run(itemId, amount).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_dose_schedule_versions
       (dose_id, effective_from, time_of_day)
     VALUES (?, '2026-08-01', 'Morning')`
  ).run(doseId);
  db.prepare(
    `INSERT INTO intake_item_logs
       (dose_id, item_id, date, amount, status, recorded_at)
     VALUES (?, ?, '2026-08-02', 'existing 250 mg', 'taken', '2026-08-02T08:00:00Z')`
  ).run(doseId, itemId);
  const logBefore = db
    .prepare("SELECT amount, hex(amount) AS bytes FROM intake_item_logs")
    .get();

  up(db);

  expect(
    db
      .prepare(
        "SELECT amount, amount_captured FROM intake_dose_schedule_versions"
      )
      .get()
  ).toEqual({ amount, amount_captured: 0 });
  expect(
    db
      .prepare("SELECT amount, hex(amount) AS bytes FROM intake_item_logs")
      .get()
  ).toEqual(logBefore);

  const beforeReplay = db
    .prepare(
      "SELECT id, amount, amount_captured FROM intake_dose_schedule_versions"
    )
    .all();
  up(db);
  expect(
    db
      .prepare(
        "SELECT id, amount, amount_captured FROM intake_dose_schedule_versions"
      )
      .all()
  ).toEqual(beforeReplay);
  db.close();
});

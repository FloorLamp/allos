import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { runMigrations } from "@/lib/migrations/runner";
import { MIGRATIONS, migrationsBefore } from "@/lib/migrations/versions";

const MIGRATION = "20260908-retire-blank-intake-doses";

it("retires only blank dose placeholders and preserves their linked history", () => {
  const db = new Database(":memory:");
  try {
    runMigrations(db, migrationsBefore(MIGRATION));
    db.exec(`
      INSERT INTO profiles (id, name) VALUES (1, 'First'), (2, 'Second');
      INSERT INTO intake_items (id, profile_id, name, kind, obligation)
      VALUES (1, 1, 'First medicine', 'medication', 'must'),
             (2, 2, 'Second medicine', 'medication', 'must');
    `);

    const cases = [
      { time: null, amount: null, retired: 0, expected: 1 },
      { time: "", amount: "", retired: 0, expected: 1 },
      { time: "   ", amount: " ", retired: 0, expected: 1 },
      { time: "\t\n\r", amount: "\v\f", retired: 0, expected: 1 },
      { time: "\u00a0\u2003", amount: "\u2028\ufeff", retired: 0, expected: 1 },
      { time: null, amount: "\t ", retired: 0, expected: 1 },
      { time: "Morning", amount: null, retired: 0, expected: 0 },
      { time: " Anytime ", amount: "\t", retired: 0, expected: 0 },
      { time: null, amount: "500 mg", retired: 0, expected: 0 },
      { time: "\n", amount: "0", retired: 0, expected: 0 },
      { time: "\u200b", amount: null, retired: 0, expected: 0 },
      { time: null, amount: "\u200b", retired: 0, expected: 0 },
      { time: "Evening", amount: "1 tablet", retired: 0, expected: 0 },
      { time: null, amount: null, retired: 1, expected: 1 },
      { time: "Morning", amount: "250 mg", retired: 1, expected: 1 },
    ];
    const insertDose = db.prepare(`
      INSERT INTO intake_item_doses
        (id, item_id, time_of_day, amount, food_timing, retired)
      VALUES (?, ?, ?, ?, 'any', ?)
    `);
    cases.forEach((row, index) => {
      insertDose.run(
        index + 1,
        (index % 2) + 1,
        row.time,
        row.amount,
        row.retired
      );
    });
    db.exec(`
      INSERT INTO intake_item_logs
        (dose_id, item_id, date, amount, status, recorded_at)
      VALUES (1, 1, '2026-08-02', 'recorded 250 mg', 'taken', '2026-08-02T08:00:00Z');
      INSERT INTO intake_dose_schedule_versions
        (dose_id, effective_from, time_of_day, amount, amount_captured)
      VALUES (1, '2026-08-01', 'Morning', 'historical 250 mg', 1),
             (1, '2026-09-01', NULL, NULL, 1);
    `);
    const dosesBefore = db
      .prepare("SELECT * FROM intake_item_doses ORDER BY id")
      .all() as Record<string, unknown>[];
    const logsBefore = db.prepare("SELECT * FROM intake_item_logs").all();
    const versionsBefore = db
      .prepare("SELECT * FROM intake_dose_schedule_versions ORDER BY id")
      .all();

    runMigrations(db, MIGRATIONS);

    expect(
      db.prepare("SELECT * FROM intake_item_doses ORDER BY id").all()
    ).toEqual(
      dosesBefore.map((row, index) => ({
        ...row,
        retired: cases[index].expected,
      }))
    );
    expect(db.prepare("SELECT * FROM intake_item_logs").all()).toEqual(
      logsBefore
    );
    expect(
      db
        .prepare("SELECT * FROM intake_dose_schedule_versions ORDER BY id")
        .all()
    ).toEqual(versionsBefore);
  } finally {
    db.close();
  }
});

import type Database from "better-sqlite3";
import type { Migration } from "../runner";

function hasColumn(db: Database.Database, name: string): boolean {
  return (
    db.prepare("PRAGMA table_info(intake_dose_schedule_versions)").all() as {
      name: string;
    }[]
  ).some((column) => column.name === name);
}

export function up(db: Database.Database): void {
  if (!hasColumn(db, "amount")) {
    db.exec("ALTER TABLE intake_dose_schedule_versions ADD COLUMN amount TEXT");
    db.exec(`
      UPDATE intake_dose_schedule_versions
         SET amount = (
           SELECT d.amount
             FROM intake_item_doses d
            WHERE d.id = intake_dose_schedule_versions.dose_id
         )
    `);
  }
  if (!hasColumn(db, "amount_captured")) {
    db.exec(`
      ALTER TABLE intake_dose_schedule_versions
        ADD COLUMN amount_captured INTEGER NOT NULL DEFAULT 0
        CHECK (amount_captured IN (0, 1))
    `);
  }
}

export const migration: Migration = {
  name: "20260907-dose-schedule-amount",
  up,
};

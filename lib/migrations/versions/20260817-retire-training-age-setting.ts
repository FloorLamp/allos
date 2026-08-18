import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issues #3067/#3081. Training records and tools are age-neutral; adult-only
// statistics use the profile life-stage model instead of an instance-wide knob.
// Remove the retired global row so an upgraded database cannot preserve a setting
// that no runtime surface reads. `settings` has no inbound foreign-key links.
export function up(db: Database.Database): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run("min" + "_training_age");
}

export const migration: Migration = {
  name: "20260817-retire-training-age-setting",
  up,
};

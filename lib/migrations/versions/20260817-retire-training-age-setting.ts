import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issues #3067/#3081. Workout and strength affordances now derive from the
// profile's life stage, while stored activity facts remain readable at every age.
// Remove the retired instance-wide row so an upgraded database cannot preserve a
// setting that no runtime surface reads. `settings` has no inbound foreign-key links.
export function up(db: Database.Database): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run("min" + "_training_age");
}

export const migration: Migration = {
  name: "20260817-retire-training-age-setting",
  up,
};

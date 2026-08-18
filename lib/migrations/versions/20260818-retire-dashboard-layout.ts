import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Dashboard placement is derived from live facts now. Remove the retired
// per-profile preference so upgrades cannot retain state no runtime reads.
// `profile_settings` has no inbound foreign-key links.
export function up(db: Database.Database): void {
  db.prepare("DELETE FROM profile_settings WHERE key = ?").run(
    "dashboard" + "_layout"
  );
}

export const migration: Migration = {
  name: "20260818-retire-dashboard-layout",
  up,
};

import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Which stored rows each Health Connect record id wrote (FP-9634), so a push's
// `deleted` list can remove them. `target` names the store and `natural_key` is the
// JSON key inside it (lib/integrations/health-connect-deletions.ts).
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS health_connect_record_refs (
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      record_id TEXT NOT NULL,
      target TEXT NOT NULL,
      natural_key TEXT NOT NULL,
      PRIMARY KEY (profile_id, record_id, target, natural_key)
    )
  `);
}

export const migration: Migration = {
  name: "20261118-health-connect-record-refs",
  up,
};

import type Database from "better-sqlite3";
import type { Migration } from "../runner";

export function up(db: Database.Database): void {
  // /v1/accounts asks for the last successful run of each portal account.
  // Failed runs and other accounts must not turn each lookup into a ledger scan.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_events_portal_success
    ON integration_sync_events(profile_id, account_id, at)
    WHERE source_id = 'patient-portals' AND ok = 1`);
}

export const migration: Migration = {
  name: "20261016-portal-success-index",
  up,
};

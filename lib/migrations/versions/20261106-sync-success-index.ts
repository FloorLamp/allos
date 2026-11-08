import type Database from "better-sqlite3";
import type { Migration } from "../runner";

export function up(db: Database.Database): void {
  // Every metrics scrape reads each profile's last success per source. Without
  // `ok` in the index, that read visited every retained ledger row on the event loop.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_events_success
    ON integration_sync_events(profile_id, source_id, at)
    WHERE ok = 1`);
}

export const migration: Migration = {
  name: "20261106-sync-success-index",
  up,
};

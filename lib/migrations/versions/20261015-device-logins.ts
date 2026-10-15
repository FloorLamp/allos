import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// FloorLamp/allos#6076 — allos as a Deck backend. A device (Deck: a desktop, the phone,
// the `deck` CLI) calls `/v1` with the credential boarding issued it; allos holds no
// credential of its own and verifies with boarding (lib/device-credential.ts). What
// boarding answers is the DEVICE'S NAME and scopes, never who the person is, so which
// allos login a device acts as is allos's own decision: this table, set explicitly by
// the owner (scripts/device-links.ts), never matched by name. A device with no row
// here is refused (403), whatever its scopes.
//
// GLOBAL, not profile-owned: it links a device to a LOGIN (an authentication
// identity). Which profiles that login reaches stays `login_profiles` and the admin
// bypass, exactly as for a cookie session or an API token. The login's deletion
// takes its links (CASCADE, and explicitly in deleteLogin as for api_tokens).
//
// Replay safety: CREATE IF NOT EXISTS, so the test tier's non-gated replay is a no-op.

export function up(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS device_logins (
       device     TEXT PRIMARY KEY,
       login_id   INTEGER NOT NULL REFERENCES logins(id) ON DELETE CASCADE,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_device_logins_login ON device_logins(login_id)"
  );
}

export const migration: Migration = {
  name: "20261015-device-logins",
  up,
};

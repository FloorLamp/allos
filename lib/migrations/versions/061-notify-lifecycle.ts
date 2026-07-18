import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 061 (issue #942, #860 Track A — the delivery-health marker becomes a
// lifecycle ROW). The channel-aware notification delivery-health marker (#131/#192)
// used to live as three ad-hoc GLOBAL settings keys — `notify_last_error` (the human
// error string), `notify_last_error_at` (ISO timestamp), `notify_last_error_channel`
// (which channel failed) — mutated by the set/clear/freeze `decideMarker` machine
// (lib/notifications/delivery-status.ts). This moves it onto a first-class lifecycle
// row so that state machine reads/writes one durable row keyed by a stable marker key,
// the same way every other lifecycle stage is a row (care_plan_items for the follow-up
// chain). Behavior is byte-equivalent: getNotifyError() returns the identical shape,
// and set/clear/freeze map 1:1 onto upsert/delete/no-op of this row.
//
// GLOBAL, not profile-owned: one shared bot serves every profile, so a revoked token /
// broken send is an instance-level signal (exactly like the old global settings keys,
// and like backup_last_*). No `profile_id` column ⇒ NOT in lib/owned-tables.ts, not
// per-profile exported/deleted — same treatment as `settings`.
//
// Presence = an ACTIVE failure: a row exists (state='failing') only while a delivery is
// broken; a healthy dispatch DELETEs it (clear). getNotifyError() returns null when no
// failing row exists. `key` is a stable marker key ('delivery-health'); the single-row
// design leaves room for future global markers without a re-key (#203-safe — an
// integer-id table it is not, but the key namespace is stable).
//
// DATA MIGRATION (append-only, runs once by version in production; the non-gated
// migrate() wrapper replays it, so every step is idempotent): if a live failure is
// recorded in the old settings keys, copy it into a 'delivery-health' row, then delete
// the three legacy keys so getNotifyError() reads a single source of truth. On replay
// the legacy keys are already gone, so the copy is a no-op and the row is untouched.

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get(name) != null
  );
}

export function up(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS notify_lifecycle (
       key      TEXT PRIMARY KEY,
       state    TEXT NOT NULL,
       channel  TEXT,
       detail   TEXT,
       at       TEXT
     );`
  );

  // One-shot copy of any live delivery-health failure from the legacy settings keys.
  // Guarded on the settings table existing (it always does after baseline) and on a
  // non-empty legacy error, so the whole block is a no-op on replay / a clean DB.
  if (!tableExists(db, "settings")) return;
  const getKey = (k: string): string | null => {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(k) as
      | { value: string | null }
      | undefined;
    return row?.value ?? null;
  };
  const legacyError = getKey("notify_last_error");
  if (legacyError && legacyError.length > 0) {
    db.prepare(
      `INSERT INTO notify_lifecycle (key, state, channel, detail, at)
         VALUES ('delivery-health', 'failing', ?, ?, ?)
       ON CONFLICT(key) DO NOTHING`
    ).run(
      getKey("notify_last_error_channel") ?? "",
      legacyError,
      getKey("notify_last_error_at") ?? ""
    );
  }
  // Retire the legacy keys unconditionally — the row (if any) is now authoritative.
  db.prepare(
    "DELETE FROM settings WHERE key IN ('notify_last_error', 'notify_last_error_at', 'notify_last_error_channel')"
  ).run();
}

export const migration: Migration = {
  id: 61,
  name: "061-notify-lifecycle",
  up,
};

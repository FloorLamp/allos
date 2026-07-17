import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 052: split the single `blood_type` profile setting into its two halves,
// `blood_type_abo` and `blood_type_rh`.
//
// The halves genuinely arrive apart. A document may report only the ABO group (Rh
// not drawn, or not reported) and a later one completes it — and labs report "Rh
// Type" as its own row. Held as ONE composed string, a partial had nowhere to live:
// "O" is not a member of BLOOD_TYPES, so normalizeBloodType rejected it and an
// ABO-only import silently stored nothing. Split, each half is kept the moment it is
// known and the next import fills the other.
//
// Legacy values were always canonicalized to a full BLOOD_TYPES member ("O+", "AB-"),
// so the split is a total, lossless parse. It is done with a LOCAL regex rather than
// by importing the app's normalizers on purpose: a shipped migration must be frozen,
// and reaching into lib/ would let a later edit there silently change what this
// migration does on replay.
//
// Idempotent: rows are keyed (profile_id, key), the INSERTs ignore conflicts so an
// already-adopted half is never clobbered, and the legacy key is dropped only after
// its parts are written. A DB with no blood_type rows is a no-op.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  // Defensive: a schema without profile_settings has nothing to split.
  if (!columnNames(db, "profile_settings").has("key")) return;

  const rows = db
    .prepare(
      "SELECT profile_id, value FROM profile_settings WHERE key = 'blood_type'"
    )
    .all() as { profile_id: number; value: string }[];
  if (rows.length === 0) return;

  const insert = db.prepare(
    "INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)"
  );
  const drop = db.prepare(
    "DELETE FROM profile_settings WHERE profile_id = ? AND key = 'blood_type'"
  );
  for (const r of rows) {
    // "O+" / "AB-" → group + factor. Anything unparseable is left alone rather than
    // guessed at (its legacy row is kept so nothing is lost).
    const m = /^\s*(AB|A|B|O)\s*([+-])\s*$/i.exec(r.value ?? "");
    if (!m) continue;
    insert.run(r.profile_id, "blood_type_abo", m[1].toUpperCase());
    insert.run(r.profile_id, "blood_type_rh", m[2]);
    drop.run(r.profile_id);
  }
}

export const migration: Migration = {
  id: 52,
  name: "052-blood-type-parts",
  up,
};

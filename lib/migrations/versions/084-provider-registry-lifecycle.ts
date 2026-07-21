import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 083 (the provider-domain closeout sweep, issues #1056/#1057/#1058):
// four nullable/defaulted columns on the GLOBAL `providers` registry row. All are
// plain guarded ADD COLUMNs (SQLite adds a column with a constant default in place):
//
//   • specialty_code TEXT           — the NUCC taxonomy code, verbatim (#1056). The
//                                     code-first identity companion to the NPI.
//   • specialty      TEXT           — the human display string (curated NUCC label
//                                     or the document's own displayName) (#1056).
//   • archived       INTEGER NOT NULL DEFAULT 0 — instance-level lifecycle flag
//                                     (#1057): an archived provider drops out of the
//                                     default directory + picker suggestions but
//                                     keeps every FK'd record's link (history is
//                                     immutable). A re-import that resolves to it
//                                     un-archives it (handled in providers-db).
//   • contact_edited INTEGER NOT NULL DEFAULT 0 — the #133 edit-lock applied to the
//                                     registry (#1058): a manual phone/address edit
//                                     sets it, and the import upsert preserves the
//                                     edited contact fields while still refreshing
//                                     unedited ones. Import-vs-import stays
//                                     last-write-wins (#467); only manual edits lock.
//
// `providers` is GLOBAL (like logins/profiles) — these columns are NOT profile-owned
// and carry no profile_id, so nothing joins lib/owned-tables.ts. No FK, no CHECK
// rebuild — a `NOT NULL DEFAULT 0` INTEGER is a legal in-place ADD COLUMN. The
// guarded ADD keeps the non-version-gated migrate() replay a pure no-op.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name
    )
  );
}

export function up(db: Database.Database): void {
  const cols = columnNames(db, "providers");
  if (!cols.has("specialty_code"))
    db.exec(`ALTER TABLE providers ADD COLUMN specialty_code TEXT`);
  if (!cols.has("specialty"))
    db.exec(`ALTER TABLE providers ADD COLUMN specialty TEXT`);
  if (!cols.has("archived"))
    db.exec(
      `ALTER TABLE providers ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`
    );
  if (!cols.has("contact_edited"))
    db.exec(
      `ALTER TABLE providers ADD COLUMN contact_edited INTEGER NOT NULL DEFAULT 0`
    );
}

export const migration: Migration = {
  id: 84,
  name: "084-provider-registry-lifecycle",
  up,
};

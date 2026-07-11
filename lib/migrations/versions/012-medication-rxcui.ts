import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 012 (issue #144): a nullable `rxcui` on intake_items.
//
// Drug-interaction checking normalizes each supplement/medication NAME to an RxNorm
// concept (RxCUI) via NLM's approximateTerm API, and CACHES the confirmed code here
// so the interaction matcher can key on a stable code instead of only the free-text
// name. The mapping is user-confirmable on the item's edit form (RxNav returns
// approximate matches), so this stores what the user accepted — never a silent guess.
//
// OPTIONAL: existing rows stay NULL; an item with no rxcui simply falls back to
// name/synonym matching in lib/drug-interactions.ts, so no backfill is needed. This
// is also independently useful for coded FHIR export later (lib/fhir-export.ts notes
// medications currently ship without codes).
//
// Additive + replay-safe: the ADD COLUMN is guarded on PRAGMA table_info so the
// non-version-gated migrate() test wrapper (which replays every migration) doesn't
// hit "duplicate column name"; production applies it once behind the user_version
// gate. Determinism: reads only the DB.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "intake_items").has("rxcui")) {
    db.exec(`ALTER TABLE intake_items ADD COLUMN rxcui TEXT;`);
  }
}

export const migration: Migration = {
  id: 12,
  name: "012-medication-rxcui",
  up,
};

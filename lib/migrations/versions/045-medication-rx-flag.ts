import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 045 (issue #851 items 1–2): the Rx / OTC flag on intake_items.
//
// A medication is either prescription (Rx) or over-the-counter (OTC). Until now the
// UI hardcoded an "Rx" badge for every medication and always showed the prescriber /
// pharmacy / Rx-number fields — there was no model bit distinguishing an OTC ibuprofen
// from a prescribed statin. One nullable/defaulted column drives it, OFF (0 = OTC) for
// every existing row unless the backfill derives otherwise:
//
//   • rx INTEGER NOT NULL DEFAULT 0 — 1 = prescription, 0 = OTC. The badge renders "Rx"
//     or "OTC" from it; the prescriber/pharmacy/Rx-number/provider fields render only
//     when rx=1 (a small "this is a prescription" disclosure flips it for edge cases).
//     The combobox pick and the form both keep it in sync going forward.
//
// One-shot backfill (deterministic from existing columns, so it rides IN this migration
// per the runner's one-shot discipline — no settings flag): a medication with a
// prescriber or an Rx number recorded is derived Rx; everything else stays OTC (0). A
// prn-defaults/typical catalog hit is OTC — already the default, so nothing to do. The
// backfill runs ONLY when the column is freshly added (guarded below), so a later
// migrate() replay can't re-flip a row the user has since edited.
//
// Nullable/defaulted so every existing supplement/medication row reads exactly as
// before (rx=0). The ADD COLUMN is guarded on PRAGMA table_info so the non-version-
// gated migrate() test wrapper can replay up() without "duplicate column name";
// production applies once behind the user_version gate. Determinism: reads only the DB.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  const cols = columnNames(db, "intake_items");
  if (!cols.has("rx")) {
    db.exec(
      `ALTER TABLE intake_items ADD COLUMN rx INTEGER NOT NULL DEFAULT 0;`
    );
    // One-shot derivation (only on fresh add): a medication with a recorded prescriber
    // or Rx number is a prescription; else OTC (the DEFAULT 0 already covers it).
    db.exec(
      `UPDATE intake_items
          SET rx = 1
        WHERE kind = 'medication'
          AND (
            (prescriber IS NOT NULL AND TRIM(prescriber) <> '')
            OR (rx_number IS NOT NULL AND TRIM(rx_number) <> '')
          );`
    );
  }
}

export const migration: Migration = {
  id: 45,
  name: "045-medication-rx-flag",
  up,
};

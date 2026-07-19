import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 073 (issue #1018): one-shot conversion of ALREADY-STORED imported
// Body Temperature rows that skipped the canonical-°F write boundary. The
// CCDA/FHIR observation mappers used to store `value_num` + `unit` verbatim, so a
// MyChart "38.5 Cel" sat in the Body Temperature series unconverted — unchartable
// and never fever-flagged (and, before the read gate shipped with this fix,
// plotted at "38.5 °F" on the episode fever curve). New imports convert at the
// boundary (lib/vitals-input.ts normalizeImportedTemperature); this migration
// converges the rows written before that existed.
//
// What it does, per stored Body Temperature row with a non-null unit + value:
//   • recognized Celsius spelling (Cel/°C/C/[degC]/celsius…) → value converted to
//     °F (the exact celsiusToF factor, 0.1 rounding), unit → 'degF' — SKIPPED for
//     `edited` rows (#133): a hand-corrected row may already hold the value the
//     user wants, and re-converting it would double-convert;
//   • recognized Fahrenheit spelling other than 'degF' ([degF]/°F/F…) → unit
//     respelled 'degF' (no numeric change, safe for edited rows too);
//   • conversion is guarded by the ingest plausibility band (77–113 °F): a junk
//     value stays verbatim (and therefore out of the canonical series) instead of
//     entering it wearing a trusted unit;
//   • unrecognized units stay verbatim (never guess); external_id is NOT touched —
//     the import mappers key dedup identity on the AS-SHIPPED value, so a
//     re-import of the same document still matches the converted row.
//
// Flags are NOT derived here: FLAG_LOGIC_VERSION was bumped in the same change,
// so the boot-task reconcile (reconcileFlagsIfCanonicalChanged, which runs AFTER
// the migration runner in createDb) re-derives every stored flag once — covering
// these converted rows AND the mm[Hg]/UCUM-spelled rows the sameUnit fix made
// convertible at read time.
//
// Self-contained by design (the manifest freezes this file): the spelling table,
// the °C→°F formula (a physical constant), and the plausibility band are inlined
// rather than imported, so later refactors of lib/ can never change what this
// shipped migration did. REPLAY SAFETY (the non-version-gated migrate() wrapper):
// after the first run every converted row's unit is 'degF', which matches no
// rewrite rule below — a second run is a pure no-op. Deliberately profile-AGNOSTIC
// (allowlisted in lib/__tests__/profile-scoping.test.ts): a one-shot vocabulary-
// level data converge across all profiles, keyed by canonical name + unit
// spelling, never reading one profile's data into another's.

const CELSIUS = new Set(["c", "cel", "degc", "celsius"]);
const FAHRENHEIT = new Set(["f", "degf", "fahrenheit"]);

// Letters-only key, matching lib/vitals-input.ts recognizedTempUnit at the time
// this migration shipped ("[degF]" → "degf", "°C" → "c", "deg F" → "degf").
function unitKey(unit: string): string {
  return unit.toLowerCase().replace(/[^a-z]/g, "");
}

export function up(db: Database.Database): void {
  const present = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'medical_records'`
    )
    .get();
  if (!present) return; // partial handle — nothing to converge

  const rows = db
    .prepare(
      `SELECT id, value_num, unit, edited FROM medical_records
        WHERE canonical_name = 'Body Temperature'
          AND unit IS NOT NULL AND unit != 'degF'`
    )
    .all() as {
    id: number;
    value_num: number | null;
    unit: string;
    edited: number | null;
  }[];

  const update = db.prepare(
    `UPDATE medical_records SET value = ?, value_num = ?, unit = 'degF'
      WHERE id = ?`
  );
  const respell = db.prepare(
    `UPDATE medical_records SET unit = 'degF' WHERE id = ?`
  );

  const run = db.transaction(() => {
    for (const r of rows) {
      const key = unitKey(r.unit);
      if (FAHRENHEIT.has(key)) {
        // Same scale, different spelling — converge the unit, keep the value.
        respell.run(r.id);
        continue;
      }
      if (!CELSIUS.has(key)) continue; // unrecognized — stays verbatim
      if (r.edited) continue; // hand-corrected (#133) — never re-convert
      if (r.value_num == null || !Number.isFinite(r.value_num)) continue;
      const degF = Math.round((r.value_num * (9 / 5) + 32) * 10) / 10;
      if (degF < 77 || degF > 113) continue; // implausible — stays verbatim
      update.run(String(degF), degF, r.id);
    }
  });
  run.immediate();
}

export const migration: Migration = {
  id: 73,
  name: "073-imported-temperature-degf",
  up,
};

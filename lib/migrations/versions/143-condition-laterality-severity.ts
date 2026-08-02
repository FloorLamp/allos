import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 143 (issue #1403): laterality / severity / stage on the problem list.
//
// ── THE GAP ──────────────────────────────────────────────────────────────────
//
// `conditions` carried only name/code/status/onset_date/resolved_date/notes. There
// was no side, no grade and no stage — so "osteoarthritis, LEFT knee" vs the right
// one, "MODERATE eczema" vs severe, and a staged oncology diagnosis all collapsed
// into the name string or a free-text notes blob. Laterality existed ONLY on
// imaging_studies / dental procedures, severity only on symptom_logs and
// intake_item_side_effects — never on the problem list. CCD (Problem Severity
// observation 2.16.840.1.113883.10.20.22.4.8, targetSiteCode) and FHIR
// (Condition.severity / Condition.bodySite) both carry these on import, and both
// were being DROPPED on the floor.
//
// ── THE COLUMNS ──────────────────────────────────────────────────────────────
//
// `laterality` — 'left' | 'right' | 'bilateral', CHECK-pinned. The vocabulary is
//   genuinely closed (unlike a body SITE), and it is IDENTITY, not decoration
//   (#482/#531): a left-knee problem and a right-knee problem are two clinical
//   entities, so the display label and the problem-list dedupe key both read it.
//   The imaging enum's extra 'na' member is deliberately NOT carried here — a
//   condition that has no sidedness simply leaves this NULL.
// `severity` — 'mild' | 'moderate' | 'severe', CHECK-pinned. The same three grades
//   FHIR's severity value set and the CCD severity observation use.
// `stage` — free TEXT. Staging vocabularies are open-ended (AJCC "IIIA", CKD
//   "stage 3b", NYHA "II"), so pinning it would be a rebuild waiting to happen.
//
// All three are NULLABLE with no backfill: NULL means "not stated", which is not
// the same claim as any value. Existing rows stay valid by construction, and a
// CHECK added with the column only constrains rows written from here on.
//
// House rules (CLAUDE.md): a new column on an existing table gets a new migration,
// no rebuild — a CHECK on a BRAND-NEW column is inline-legal (only GROWING an
// existing CHECK enum needs a rebuild). `conditions` is already profile-owned and
// already in lib/owned-tables.ts. Self-contained (imports nothing from lib/); a
// replay is decided purely by the DB catalog.

export function up(db: Database.Database): void {
  const run = db.transaction(() => {
    const cols = db.prepare(`PRAGMA table_info(conditions)`).all() as {
      name: string;
    }[];
    if (cols.length === 0) return; // table absent (never after 001; belt)
    const has = (n: string) => cols.some((c) => c.name === n);
    if (!has("laterality")) {
      db.exec(
        `ALTER TABLE conditions ADD COLUMN laterality TEXT
           CHECK (laterality IN ('left','right','bilateral') OR laterality IS NULL)`
      );
    }
    if (!has("severity")) {
      db.exec(
        `ALTER TABLE conditions ADD COLUMN severity TEXT
           CHECK (severity IN ('mild','moderate','severe') OR severity IS NULL)`
      );
    }
    if (!has("stage")) {
      // Free text: AJCC / CKD / NYHA staging vocabularies are open-ended.
      db.exec(`ALTER TABLE conditions ADD COLUMN stage TEXT`);
    }
  });
  run.immediate();
}

export const migration: Migration = {
  id: 143,
  name: "143-condition-laterality-severity",
  up,
};

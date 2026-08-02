import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 144 (issue #1407): age/cause of death and a GENETIC discriminator on
// family history.
//
// ── THE GAP ──────────────────────────────────────────────────────────────────
//
// `family_history` carried `onset_age` and a bare `deceased` 0/1 flag. Two things
// the screening-cadence and risk logic actually key on were unstorable:
//
//   1. HOW and HOW YOUNG a relative died. "Father, MI at 52" is the canonical
//      cardiac-screening input, and neither half of it had a column — a death was
//      a boolean and its cause lived (if anywhere) in a notes blob.
//   2. WHETHER the relative is a genetic one. `relation` is free text with no
//      genetic axis, so an ADOPTED parent, a STEP parent and a HALF sibling all
//      read as full first-degree hereditary risk. Treating an adopted parent's
//      history as hereditary is not a rounding error — it is wrong.
//
// ── THE COLUMNS ──────────────────────────────────────────────────────────────
//
// `age_at_death INTEGER` — whole years. Distinct from `onset_age` (age at
//   diagnosis); FHIR FamilyMemberHistory.deceasedAge maps straight onto it.
// `cause_of_death TEXT` — free text / the condition term that contributed to
//   death (FHIR condition.contributedToDeath marks which condition that is).
// `relation_type TEXT` — the genetic discriminator, CHECK-pinned to
//   'genetic' | 'half' | 'adopted' | 'step'. NULL means UNSTATED, which is read as
//   genetic: every existing row and every import predates the column, family
//   history is hereditary by default (FHIR FamilyMemberHistory.relationship is a
//   genetic relationship unless it says otherwise), and only an EXPLICIT
//   adopted/step marking excludes a relative from the hereditary read. That keeps
//   the migration backfill-free while making the exclusion a stated fact rather
//   than an absence.
// `lineage TEXT` — 'maternal' | 'paternal', CHECK-pinned. Which side a
//   grandparent/aunt/uncle sits on; NULL where the concept does not apply (a
//   parent, a sibling) or was never stated.
//
// All four are NULLABLE with no backfill, so existing rows stay valid by
// construction and a CHECK added with the column only constrains rows written from
// here on.
//
// House rules (CLAUDE.md): new columns on an existing table get a new migration,
// no rebuild — a CHECK on a BRAND-NEW column is inline-legal (only GROWING an
// existing CHECK enum needs a rebuild). `family_history` is already profile-owned
// and already in lib/owned-tables.ts. Self-contained (imports nothing from lib/);
// a replay is decided purely by the DB catalog.

export function up(db: Database.Database): void {
  const run = db.transaction(() => {
    const cols = db.prepare(`PRAGMA table_info(family_history)`).all() as {
      name: string;
    }[];
    if (cols.length === 0) return; // table absent (never after 001; belt)
    const has = (n: string) => cols.some((c) => c.name === n);
    if (!has("age_at_death")) {
      db.exec(`ALTER TABLE family_history ADD COLUMN age_at_death INTEGER`);
    }
    if (!has("cause_of_death")) {
      db.exec(`ALTER TABLE family_history ADD COLUMN cause_of_death TEXT`);
    }
    if (!has("relation_type")) {
      db.exec(
        `ALTER TABLE family_history ADD COLUMN relation_type TEXT
           CHECK (relation_type IN ('genetic','half','adopted','step')
                  OR relation_type IS NULL)`
      );
    }
    if (!has("lineage")) {
      db.exec(
        `ALTER TABLE family_history ADD COLUMN lineage TEXT
           CHECK (lineage IN ('maternal','paternal') OR lineage IS NULL)`
      );
    }
  });
  run.immediate();
}

export const migration: Migration = {
  id: 144,
  name: "144-family-history-death-lineage",
  up,
};

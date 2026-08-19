import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #2948 — the `niggles` store: the self-expiring tier BELOW injury.
//
// WHY A TABLE OF ITS OWN, rather than a row in `injuries` or `symptom_logs`.
// `injuries` is the MANAGED constraint — regions, muscles, movement patterns, exercise
// identities, a three-state lifecycle, review dates, load factors — and prod says it is
// too heavy to reach for: the table is EMPTY while `activities.notes` carry "right knee
// weird" and "left hip no good". `symptom_logs` is illness-shaped (symptom name +
// severity, episode-linked) and has no body region and no laterality at all. Adding a
// fourth injury status, or a body-region column to symptom_logs, would put a managed
// entity's weight on a thing nobody manages. #2948 is explicit that `injuries` and
// `symptom_logs` are untouched.
//
// THE SHAPE, and each column's reason:
//   • `region` is a `MuscleRegion` — the lib/lifts REGION_SCOPES vocabulary the injury
//     layer already speaks (lib/injury-model.ts). THE #2948 INVARIANT: one region
//     vocabulary, no parallel body-part list. The colloquial word a person types reaches
//     it through lib/curated/niggle-lexicon.ts, which resolves every term to a
//     `MuscleId` (rolled up by `muscleRegion()`) or, for a joint the enum has no id for,
//     to a `MuscleRegion` directly.
//   • `laterality` is `InjuryLaterality` ('left' | 'right' | 'bilateral') or NULL. NULL
//     means the person did not say which side, and is never a guess.
//   • `body_term` is the surface word ("knee", "hip"), DISPLAY ONLY. Exactly the
//     `injuries.label` precedent: the structured fact is `region`, the human sentence is
//     the label. Nothing keys, filters or groups on it.
//   • `source_activity_id` / `source_exercise` are the optional provenance #2948 asked
//     for. The FK is ON DELETE SET NULL rather than CASCADE: deleting the session you
//     mentioned it in does not mean the knee stopped hurting. `source_exercise` holds a
//     CANONICAL `exerciseHistoryKey`, never a raw label (#626/#432), and is written by
//     callers that know one — the note chip does not, so it stores NULL.
//   • `reported_at` / `last_reported_at` are canonical UTC instants (#2205), BORN on the
//     convention. Declared in lib/time-columns.ts.
//
// NO STATUS COLUMN AND NO EXPIRY FLAG, deliberately. A niggle is live purely as a
// function of `last_reported_at` and now (lib/niggle-model.ts, NIGGLE_QUIET_DAYS), so
// nothing has to run to resolve one, no sweep can leave the table disagreeing with a
// reader, and "a niggle needs zero interaction to go away" is a property of the schema
// rather than of a job. Re-reporting advances `last_reported_at`; that is the whole
// machine.
//
// ── THE CENSUSES, ANSWERED (every one, including the noes) ───────────────────
//
//   • lib/owned-tables.ts — YES. `profile_id` is on the row, so the table is DIRECTLY
//     owned: the profile-delete sweep clears it, the profile-scoping test forces every
//     `.prepare` to name profile_id, and the export-completeness binding demands a
//     dataset (below).
//   • lib/time-columns.ts — YES, both instant columns, declared `event`/`instant`/
//     `canonical`. Regenerated into docs/internals/time-columns.md.
//   • lib/export.ts DATASETS — YES, a deletable `niggles` dataset. The row is the
//     person's own record of their own body and must leave with them (#465).
//   • lib/export.ts DELETE_POLICY — YES. A plain id + profile_id delete: nothing FKs
//     INTO `niggles`, no counter sits beside it, and liveness is recomputed on read, so
//     removing rows means exactly "these are no longer on record".
//   • lib/dataset-undo.ts DATASET_UNDO_KIND — NO ENTRY, and none is possible: `niggles`
//     is not the root table of any UNDO_KINDS kind, so the `satisfies` type neither
//     requires nor permits a mapping. A row is cheap to re-report (one tap on the same
//     note), which is why it was not made an undo root.
//   • DECLARED_CHILD_TABLES (lib/__db_tests__/profile-delete-fk-scan.test.ts) — NOT
//     APPLICABLE. That census is for tables that reach a profile only through an FK
//     path. `niggles` carries `profile_id` itself and is therefore an OWNED_TABLES
//     member, not a child. Its FK to `activities` points OUT of the table, not in.
//   • lib/stateful-writes.ts — YES. The one-live-niggle-per-(region, laterality)
//     invariant is a compare-and-set over existing state, so lib/niggle-store.ts is
//     registered as the sole write core.
//   • TOMBSTONE_TABLES (lib/integrations/tombstone-keys.ts) — NO. That registry exists so
//     a keyed integration UPSERT does not resurrect a row the person deleted. No
//     integration writes niggles: the only writer is a human tapping a confirm chip, and
//     a re-tap after a delete is the person saying it again, which is a new fact rather
//     than a resurrection.
//
// CLEANUP CLASS (#203): tiny and self-limiting — at most one live row per region+side,
// and expired rows are the historical record. Cleared by profile_id via OWNED_TABLES on
// profile deletion.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS niggles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      region TEXT NOT NULL,
      laterality TEXT,
      body_term TEXT,
      source_activity_id INTEGER REFERENCES activities(id) ON DELETE SET NULL,
      source_exercise TEXT,
      reported_at TEXT NOT NULL,
      last_reported_at TEXT NOT NULL
    )
  `);
  // The read every consumer makes: "this profile's niggles, most recently reported
  // first" — the live-set derivation filters on `last_reported_at` in the pure model.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_niggles_profile_last_reported
      ON niggles (profile_id, last_reported_at DESC)
  `);
}

export const migration: Migration = {
  name: "20260819-niggles",
  up,
};

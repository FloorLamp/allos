import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #2857 — `intake_item_purposes`, the structured "why" of an intake item.
//
// Medications got the indication link (#1052, `intake_items.indication_condition_id`).
// Supplements got nothing, so the reason lived in `notes` as prose no engine can read:
// "taken for eye health"; "Vitamin D, 25-Hydroxy is 29 ng/mL, flagged LOW". A stack
// could not say why an item was in it, could not be grouped by what it was for, and
// could not connect "started D3 for low 25-OH-D" to the retest machinery that already
// tracks that analyte.
//
// THREE REASON KINDS, one table, MANY rows per item (an omega-3 is heart AND joints):
//   goal      — a curated vocabulary key (lib/intake-purposes.ts GOAL_PURPOSES).
//               "Eye health" is a goal, not a diagnosed condition, and a condition link
//               alone cannot express it.
//   condition — a tracked condition by id. The #1052 shape WIDENED to supplements
//               rather than cloned: same `conditions` table, same by-id link, same
//               "the link is the user's statement" posture.
//   biomarker — a canonical biomarker NAME, direction-agnostic. Low 25-OH-D leading to
//               vitamin D3 is one shape; high LDL/ApoB leading to psyllium (#2754's
//               add-on-high route) is the other. Both are real reasons somebody starts
//               a supplement, so the row stores the analyte's identity and OPTIONALLY
//               the flag direction that motivated it — never assuming that
//               deficiency-repletion is the only story.
//
// IDS AND KEYS, NEVER DISPLAY NAMES (#203), so a purpose survives a rename. The
// biomarker half stores the CANONICAL NAME under `COLLATE NOCASE`, which is the
// identity `saved_items` already uses for `kind = 'biomarker'` and the retest
// dismissal keys already spell `biomarker:<name>` — one biomarker identity in this
// schema, not a second one invented here.
//
// A CHILD TABLE, NOT AN OWNED ONE. No `profile_id`: it is scoped and deleted THROUGH
// `item_id -> intake_items.profile_id`, exactly like intake_item_ingredients (#2856)
// and intake_item_doses. `item_id` CASCADES — a purpose cannot outlive the item whose
// purpose it is — and the profile-delete sweep reaches it through PRAGMA
// foreign_key_list (#2126) with no edit anywhere.
//
// `condition_id` DELIBERATELY CARRIES NO ON DELETE ACTION, matching
// `intake_items.indication_condition_id`. Its detach is explicit, in the ONE place the
// sibling clinical null-outs live (lib/undo-delete-db.ts, keyed on
// `spec.ownedTable === "conditions"`), so BOTH condition-delete paths inherit it. A
// cascade here would have removed rows silently from a capture that does not carry
// them, and undo would have restored the condition with the purposes gone and nothing
// saying so. Instead the purpose ROW is removed with its condition and, like every
// sibling null-out, is NOT restored on undo — the condition comes back, the item's
// "For:" link stays honestly cleared. Recorded in docs/internals/trash.md.
//
// NO TEMPORAL COLUMNS, deliberately — the intake_item_ingredients call, for the same
// reason. A purpose is an ATTRIBUTE of the item, not an event: the set is replaced
// wholesale on every save, so a per-row created_at would record when a save happened
// and never when anything about the person's health did. Nothing to declare in
// lib/time-columns.ts.
//
// NOTHING WRITES WITHOUT THE USER (#559/#1505/#798). Purpose is the person's own
// statement of intent. The composition feeder (lutein/zeaxanthin => the eyes goal)
// SUGGESTS a chip on the form; the save is the write. This migration back-fills
// nothing — there is no second source for an intent nobody has stated, and reading one
// out of `notes` prose would be exactly the guess this table exists to replace.
//
// Additive and replay-safe (CREATE TABLE / INDEX IF NOT EXISTS), so an `up()` that
// runs twice is a no-op. Determinism: schema only, no rows.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS intake_item_purposes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES intake_items(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('goal','condition','biomarker')),
      goal_key TEXT,
      condition_id INTEGER REFERENCES conditions(id),
      biomarker_key TEXT COLLATE NOCASE,
      direction TEXT CHECK (direction IS NULL OR direction IN ('low','high')),
      sort INTEGER NOT NULL DEFAULT 0,
      -- Exactly one target per row, and it must be the one its kind names. A row that
      -- carried two targets, or none, would be a purpose nothing could render.
      CHECK (
        (kind = 'goal'
           AND goal_key IS NOT NULL AND condition_id IS NULL
           AND biomarker_key IS NULL AND direction IS NULL)
        OR (kind = 'condition'
           AND goal_key IS NULL AND condition_id IS NOT NULL
           AND biomarker_key IS NULL AND direction IS NULL)
        OR (kind = 'biomarker'
           AND goal_key IS NULL AND condition_id IS NULL
           AND biomarker_key IS NOT NULL)
      )
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_intake_item_purposes_item
       ON intake_item_purposes(item_id, sort)`
  );
  // The reverse lookup the condition detach needs: "which purpose rows name this
  // condition" runs on every condition delete, and must not be a table scan.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_intake_item_purposes_condition
       ON intake_item_purposes(condition_id) WHERE condition_id IS NOT NULL`
  );
}

export const migration: Migration = {
  name: "20260823-intake-item-purposes",
  up,
};

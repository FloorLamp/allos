import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 063 (issue #714): menstrual cycle tracking — the cycle LOG.
//
// A `cycles` row holds ONLY the cycle's OWN data — the recorded period (start/end of
// bleeding) and its flow, plus a free-text note — mirroring the illness_episodes
// identity+annotations shape (#856 / migration 046). Everything ELSE about a cycle is
// DERIVED: the cycle PHASE (menstrual/follicular/luteal) and cycle-length / variability
// trends are computed from the logged period history (lib/cycle.ts), and per-day cycle
// SYMPTOMS are a vocabulary extension of symptom_logs (a `domain` tag, no second store) —
// phase membership derives by DATE, so a symptom during a period during a cold belongs to
// both the illness episode and the luteal phase, correct by construction (#860/#944:
// reuse a store, don't mint a table). Deliberately tracking, NOT forecasting: no
// next-period/ovulation prediction and no fertility-awareness (issue #714 exclusions).
//
//   • `cycles` is directly profile-OWNED — born `profile_id INTEGER NOT NULL REFERENCES
//     profiles(id)` so it joins OWNED_TABLES (lib/owned-tables.ts) and is cleared by
//     profile_id on profile deletion.
//   • `period_start` = inclusive first bleeding day (YYYY-MM-DD, NOT NULL).
//   • `period_end`   = INCLUSIVE last bleeding day (YYYY-MM-DD); NULL = period ongoing.
//     (A period is a short, concretely-bounded span the user thinks of inclusively —
//     "my period was the 3rd to the 7th" — so unlike illness_episodes' EXCLUSIVE end,
//     this end is inclusive; lib/cycle.ts encodes that convention.)
//   • `flow`         = 'light' | 'medium' | 'heavy' (nullable — flow is optional).
//   • `note`         = free-text, rendered through <NotesText>.
//   Nothing FKs into this table.
//
// CREATE ... IF NOT EXISTS + the index guard keep the non-version-gated migrate() replay
// a pure no-op. Determinism (spec): reads only the DB + its own constants.

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cycles (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id   INTEGER NOT NULL REFERENCES profiles(id),
      period_start TEXT NOT NULL,
      period_end   TEXT,
      flow         TEXT CHECK (flow IN ('light','medium','heavy')),
      note         TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cycles_profile
      ON cycles(profile_id, period_start);
  `);
}

export const migration: Migration = {
  id: 63,
  name: "063-cycles",
  up,
};

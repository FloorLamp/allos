import type Database from "better-sqlite3";
import type { Migration } from "../runner";
import { isDraftActivityRow } from "../../activity-draft";

// #3190 — release the Nth-workout recognitions a create-at-start husk consumed.
//
// `totalWorkouts` (lib/milestones-db.ts) counted every `activities` row, including a
// session someone opened and abandoned. The `milestones` table is BOTH the timeline
// entry and the once-only fired marker, so an inflated count did not merely send a
// wrong notification: it wrote `workouts:N` as fired, and the person's real Nth
// workout could then never be recognized. Wrong once, permanently. Excluding drafts
// from the count going forward fixes the next crossing and leaves that one stranded,
// which is why this data move ships with it.
//
// WHAT IS STRANDED, exactly: a `workouts:N` row on a profile whose ledger does not
// hold N workouts. Deleting it restores the marker to what the count says, so the
// crossing is recognized when it actually happens. The row carries no side-state —
// the Timeline derives its event ids from the row id at render time and the
// notification's dedupe marker IS the row — so a delete cannot orphan anything, and
// can only mean "not awarded yet" (the same argument migration 148 made when it
// retired the run-shaped families).
//
// CONSERVATIVE ON PURPOSE, in two ways:
//
//   1. The count here includes strength rows for every profile, while the live
//      reader drops them for a profile whose life stage makes strength training
//      irrelevant (lib/life-stage.ts). Reproducing that gate would mean resolving
//      each profile's age inside a frozen migration; using the LARGEST count a
//      profile could have instead means a key is deleted only when it is stranded
//      under any reading of the ledger. A profile that also fails the narrower gate
//      keeps a key it should not have — no recognition is lost, and no unearned one
//      is minted by this migration.
//
//   2. Abandoned drafts are swept after a day or so, so most profiles' counts here
//      already exclude the husk that fired the key. The rule reads the ledger as it
//      stands rather than reconstructing history, which is also why a profile that
//      earned N and later DELETED activities down below N has its key released: the
//      table would otherwise carry a claim the ledger no longer supports, and the
//      recognition fires again if they cross N again.
//
// The draft rule itself is the app's one definition, imported rather than restated
// (lib/activity-draft.ts) — the same constraint every reader in #3056/#3188/#3191
// works under.
export function up(db: Database.Database): void {
  const fired = db
    .prepare(
      `SELECT profile_id, key, threshold FROM milestones WHERE kind = 'workouts'`
    )
    .all() as { profile_id: number; key: string; threshold: number }[];
  if (fired.length === 0) return;

  const rows = db
    .prepare(
      `SELECT a.profile_id AS profile_id,
              a.start_time, a.end_time, a.duration_min, a.components, a.notes,
              a.distance_km, a.source,
              EXISTS (
                SELECT 1 FROM exercise_sets s WHERE s.activity_id = a.id
              ) AS has_sets
         FROM activities a`
    )
    .all() as {
    profile_id: number;
    start_time: string | null;
    end_time: string | null;
    duration_min: number | null;
    components: string | null;
    notes: string | null;
    distance_km: number | null;
    source: string | null;
    has_sets: number;
  }[];

  const logged = new Map<number, number>();
  for (const row of rows) {
    if (isDraftActivityRow(row, row.has_sets)) continue;
    logged.set(row.profile_id, (logged.get(row.profile_id) ?? 0) + 1);
  }

  const remove = db.prepare(
    "DELETE FROM milestones WHERE profile_id = ? AND key = ?"
  );
  for (const m of fired) {
    if (m.threshold > (logged.get(m.profile_id) ?? 0)) {
      remove.run(m.profile_id, m.key);
    }
  }
}

export const migration: Migration = {
  name: "20260819-unstrand-husk-milestones",
  up,
};

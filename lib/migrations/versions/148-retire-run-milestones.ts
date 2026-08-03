import type { Migration } from "../runner";

// #1939 — retire the RUN-shaped milestone families. The `streak:` recognitions
// (7/30/100/365 days of a rest-tolerant activity streak) and the `adherence:`
// recognitions (7/30 consecutive days on which every due dose was taken) both
// rewarded MAINTAINING A RUN, which is the cliff class this app does not do: the
// copy was congratulatory ("You've taken every due dose for 30 days running"), and
// the adherence one quietly recast a deliberate skip (#232) — a legitimate act the
// dose machinery handles without judgment — as breaking something. The engine stops
// minting them in lib/milestones.ts; this is the matching one-shot data move, so
// the feature and its history go together and the Timeline carries no badge the app
// no longer awards.
//
// Match on BOTH discriminators the table stores. `kind` is the column the engine
// wrote and the export renders; `key` is the unique identity ("streak:30"). They
// agree on every row the engine wrote, but a row hand-fixed or imported with one
// out of step must not survive on a technicality. The surviving families —
// `workouts:` (a count that gaps cannot break), `goal:` (a user-declared intent
// met), and `endurance-plan:` (a completed event, written by lib/endurance-plans)
// — are untouched.
//
// Nothing is keyed to a milestone row: the Timeline reads the table generically and
// derives its event ids from the row id at render time (there is no persisted
// saved/dismissed side-state for timeline events), the export dataset is a plain
// table dump, and the milestone notification's dedupe marker IS the row itself —
// so deleting a row cannot orphan anything, and can only mean "never awarded".
// Re-firing is impossible because the engine no longer detects these families.
export const migration: Migration = {
  id: 148,
  name: "retire-run-milestones",
  up: (db) => {
    db.prepare(
      `DELETE FROM milestones
        WHERE kind IN ('streak', 'adherence')
           OR key LIKE 'streak:%'
           OR key LIKE 'adherence:%'`
    ).run();
  },
};

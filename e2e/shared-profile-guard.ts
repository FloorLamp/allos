import Database from "better-sqlite3";
import fs from "node:fs";
import { workerDbPath } from "./worker-env";

// THE STANDING SHARED-FIXTURE GUARD (issue #3173).
//
// No spec may leave a LIVE WORKOUT DRAFT on the shared admin profile. #3163 is why:
// `offline-refused-capture.spec.ts` left a started, unended activity on profile 1,
// `getWorkoutPresence` read it as an ACTIVE workout, and the app-wide WorkoutDock
// then haunted every later spec on that worker. The only thing that ever noticed was
// `offline-set-log`'s closing `expect(workout-dock).toHaveCount(0)` — and only once a
// shard reshuffle happened to seat the two files together. Two innocent clusters
// (#3144, #3165) each got a red on a spec they had not touched and each had every
// reason to suspect their own diff first. #3169 fixed the one instance; this stops
// the next one.
//
// It hangs off an auto TEST-scoped fixture (e2e/fixtures.ts), not a global teardown,
// because the whole point is to name the test that CAUSED the leak rather than the
// unlucky neighbour that notices three specs later. A global teardown could only
// name the run.
//
// PROFILE 1 ONLY, deliberately. A spec that legitimately needs a live draft gives it
// a profile of its own and disposes of it — the fixture-ownership rule (#868, #3029,
// #3040, #3106) — and the seeded ones already do: the `Push day` draft the workout
// dock hydrates from lives on the dedicated PRESENCE_PROFILE, so it is exempt by
// construction rather than by an allowlist that would rot. Profile 1 is the one
// profile every spec shares, so it is the one where a leak becomes somebody else's
// failure.

/** The profile every "shared fixture" spec acts as — the bootstrap admin's. */
export const SHARED_PROFILE_ID = 1;

export interface StrandedDraft {
  id: number;
  title: string;
  date: string;
}

// The LIVE-DRAFT SIGNATURE, straight off `computeWorkoutPresence`'s own `active`
// classifier (lib/workout-presence.ts): a manual (source-less) row that started, has
// no end, and carries no positive duration. Those four columns are exactly what the
// presence loop tests — `source` skips imports, `isCompletedSessionRow` covers the
// other three — so this selects the shape that resurrects the dock and nothing else.
// A finished session, an untimed retroactive log and an import all fail it.
const LIVE_DRAFT_SQL = `SELECT id, title, date
     FROM activities
    WHERE profile_id = ?
      AND source IS NULL
      AND start_time IS NOT NULL
      AND end_time IS NULL
      AND (duration_min IS NULL OR duration_min <= 0)
    ORDER BY id`;

/**
 * READ the live drafts on `profileId` without touching them — the same four columns
 * `takeStrandedDrafts` repairs on, asked as a question instead of a repair.
 *
 * IT EXISTS FOR THE ASSERTION THAT CANNOT BE MADE IN THE DOM (#3441). A live session
 * that races its own create ends up with TWO rows, and the editor is looking at
 * exactly one of them: every on-screen assertion — the panel, the dock, the delete,
 * the toast — is GREEN about the row it holds while the other stands alone in the
 * log. So the witness has to count rows, and it has to count them WITHOUT the
 * repairing side effect, or the count would erase the evidence it just took.
 */
export function listLiveDrafts(
  dbPath: string = workerDbPath(),
  profileId: number = SHARED_PROFILE_ID
): StrandedDraft[] {
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    return db.prepare(LIVE_DRAFT_SQL).all(profileId) as StrandedDraft[];
  } finally {
    db.close();
  }
}

/**
 * Find every live draft stranded on `profileId` in `dbPath`, DELETE it, and return
 * what was found. Defaults to the shared profile, which is the standing guard's job.
 *
 * It repairs as well as reports on purpose. A detector that only reported would leave
 * the draft in place, so the next test on that worker fails too, and the one after
 * that — a cascade whose first red is the culprit and whose remaining reds are noise
 * burying it. Removing the row means exactly ONE test fails: the one that caused it.
 * (The delete rides the schema's own `ON DELETE CASCADE` from `exercise_sets` and the
 * other activity-owned tables, which is why `foreign_keys` is turned on for it.)
 *
 * `profileId` EXISTS SO THE SIGNATURE ABOVE STAYS SINGLE-SOURCED (#3290). A spec that
 * drives a live workout on a DEDICATED fixture profile is outside the standing guard
 * by design, so it has to prove its own cleanup — and the only honest way to do that
 * is to ask the same four columns `computeWorkoutPresence` asks. Re-spelling
 * `LIVE_DRAFT_SQL` at that call site would mean two definitions of "an active
 * workout" that drift apart the first time the presence classifier changes.
 */
export function takeStrandedDrafts(
  dbPath: string = workerDbPath(),
  profileId: number = SHARED_PROFILE_ID
): StrandedDraft[] {
  // A worker whose database was never created (a fixture that failed before the
  // template copy) has nothing to answer for.
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    const stranded = db
      .prepare(LIVE_DRAFT_SQL)
      .all(profileId) as StrandedDraft[];
    if (stranded.length > 0) {
      const drop = db.prepare(
        "DELETE FROM activities WHERE id = ? AND profile_id = ?"
      );
      for (const row of stranded) drop.run(row.id, profileId);
    }
    return stranded;
  } finally {
    db.close();
  }
}

/** The failure message a stranded draft earns, naming the rows it left behind. */
export function strandedDraftMessage(
  stranded: StrandedDraft[],
  profileId: number = SHARED_PROFILE_ID
): string {
  const rows = stranded
    .map((row) => `  • activity ${row.id} "${row.title}" (${row.date})`)
    .join("\n");
  const which =
    profileId === SHARED_PROFILE_ID
      ? `the SHARED profile ${SHARED_PROFILE_ID}`
      : `its own fixture profile ${profileId}`;
  return (
    `This test left ${stranded.length} live workout draft(s) on ` +
    `${which} (#3173):\n${rows}\n\n` +
    `A started-but-unended manual activity is what getWorkoutPresence reads as an ` +
    `ACTIVE workout, so the app-wide workout dock would haunt every later spec on ` +
    `this worker and fail one of them instead of this one (#3163).\n\n` +
    `Dispose of the draft in this test — from a \`finally\`, so an earlier failure ` +
    `cannot skip it — or give the fixture a profile of its own (#868). The rows above ` +
    `have been removed so the rest of this worker's run is unaffected.`
  );
}

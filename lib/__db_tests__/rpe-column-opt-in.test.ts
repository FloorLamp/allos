// DB TIER — #3335's opt-in seam and the one-shot back-fill that ships with it.
//
// The set grid's effort column used to be there for everyone. Making it opt-in is a
// migration of a SHIPPED behaviour, so the change has two halves that have to be
// asserted together:
//
//   - the seam itself: the profile_settings row IS the opt-in, and `getRpeTracking`
//     is the only producer of the value a surface needs to render the column;
//   - the back-fill: a profile that was already logging RPE keeps its column, so the
//     migration does not read as data loss.
//
// THE FIXTURE MUST BE ABLE TO SAY BOTH THINGS. A migration that opted EVERY profile
// in would satisfy "the RPE logger kept its column" on its own, so a profile with
// sets but no ratings is asserted to stay OUT in the same run — that pair is what
// makes the back-fill's rule observable rather than its outcome on one row.
//
// SYNTHETIC ONLY: fictional profiles, invented lifts. No PHI.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { getProfileSetting } from "@/lib/settings/kv";
import { getRpeTracking, setRpeTracking } from "@/lib/rpe-tracking";
import { up as backfillRpeOptIn } from "@/lib/migrations/versions/20260820-rpe-column-opt-in";

const DAY = "2026-05-11";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// One strength session with a single set, rated or not.
function logSet(profileId: number, rpe: number | null): void {
  const activityId = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min)
         VALUES (?, ?, 'strength', 'Session', 30)`
      )
      .run(profileId, DAY).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, rpe)
     VALUES (?, 'Barbell Bench Press', 1, 60, 5, ?)`
  ).run(activityId, rpe);
}

const rowValue = (profileId: number) =>
  getProfileSetting(profileId, "strength_rpe");

describe("the RPE opt-in row is the seam (#3335)", () => {
  it("has no scale to hand a profile that never opted in", () => {
    const fresh = makeProfile("NEVER ASKED");
    expect(getRpeTracking(fresh)).toBeNull();
  });

  it("hands out the scale once the row exists, and takes it back on opt-out", () => {
    const p = makeProfile("TOGGLES");
    const tracking = setRpeTracking(p, true);
    expect(tracking).not.toBeNull();
    // The value a surface renders over — the scale, not a boolean.
    expect(tracking!.min).toBe(5);
    expect(tracking!.max).toBe(10);
    expect(getRpeTracking(p)).not.toBeNull();

    expect(setRpeTracking(p, false)).toBeNull();
    expect(getRpeTracking(p)).toBeNull();
  });

  // Opting out DELETES rather than writing "off". Two spellings of "not tracking"
  // would be two states to keep in step, and the second one always drifts.
  it("stores presence, not a value — opting out removes the row", () => {
    const p = makeProfile("DELETES ON OPT-OUT");
    setRpeTracking(p, true);
    expect(rowValue(p)).toBe("on");
    setRpeTracking(p, false);
    expect(rowValue(p)).toBeUndefined();
  });
});

describe("20260820-rpe-column-opt-in — the back-fill", () => {
  let rated: number;
  let unrated: number;

  beforeAll(() => {
    // Was already logging RPE when the column went opt-in.
    rated = makeProfile("LOGS RPE");
    logSet(rated, 8.5);
    // Has strength sets, never rated one.
    unrated = makeProfile("NEVER RATED");
    logSet(unrated, null);
  });

  it("keeps the column for a profile that was already logging RPE", () => {
    expect(getRpeTracking(rated)).toBeNull(); // before
    backfillRpeOptIn(db);
    expect(getRpeTracking(rated)).not.toBeNull();
  });

  it("leaves a profile with sets but no ratings opted out", () => {
    backfillRpeOptIn(db);
    expect(getRpeTracking(unrated)).toBeNull();
  });

  // THE BACK-FILL IS A ONE-TIME MOVE, NOT A READ RULE. The tempting alternative —
  // "opted in if the row exists OR the profile has some RPE data" — is a SECOND way
  // to be opted in, i.e. a second producer, and the two drift. It also makes opting
  // OUT impossible for the very people the back-fill was for: their data would keep
  // re-opting them in. So the reader knows about rows and nothing else, and this is
  // the profile that proves it.
  //
  // (The MIGRATION is not replay-safe against a later opt-out, and does not need to
  // be: the runner applies it once by name, and the migrate() test wrapper replays
  // it only against databases where nobody has opted out yet. That is a fact about
  // the runner, so it is not asserted here as if it were a fact about this file.)
  it("reads rows, not ratings — data alone opts nobody in", () => {
    const rowless = makeProfile("RATED, NEVER BACK-FILLED");
    logSet(rowless, 9);
    expect(getRpeTracking(rowless)).toBeNull();
  });

  it("lets a back-filled profile opt back out like anyone else", () => {
    const p = makeProfile("BACK-FILLED THEN LEFT");
    logSet(p, 7);
    backfillRpeOptIn(db);
    expect(getRpeTracking(p)).not.toBeNull();
    expect(setRpeTracking(p, false)).toBeNull();
    expect(getRpeTracking(p)).toBeNull();
  });
});

// THE TICK ORDER THAT KEEPS A SAFETY SIGNAL REACHABLE (#5194, #5212 falsifying pass F4),
// and only that.
//
// `runPostWorkoutFinish` is the safety tier: the moment workout presence reads
// `finished` it delivers that session's due, unresolved `post_workout` doses, ungated by
// the waking window because it is timed to a real event. It rests on
// `FINISHED_WINDOW_MIN` — sixty minutes — and on the guarantee that an hourly tick
// observes every finish inside it.
//
// THAT GUARANTEE WAS WRITTEN WHEN NO WRITER COULD BACK-DATE AN END. Both other
// `finishWorkoutSession` callers stamp the tap's own instant. `finishDetectedWorkouts`
// stamps the minute the heart rate says the session ended, which is already the usual
// recovery old when it is written — so if the sweep runs AFTER the dispatch, the row is
// `idle` at the sweep instant and `60 + recovery` minutes old by the next tick. The
// dose delivery and the #924 recap were silenced for every session the feature finished,
// and the whole DB tier stayed green.
//
// WHY THIS IS A SOURCE SCAN AND NOT A BEHAVIOUR TEST. The property itself — that a
// detected finish is inside the window at the sweep's own instant — is asserted against
// the real database in lib/__db_tests__/detected-workout-end.test.ts. What no runtime
// test observes is the ORDER of two independent `try` blocks in one function, because
// either order leaves both of them running. The order is the mechanism, so the order is
// what is pinned, in the same spirit as lib/__tests__/draft-write-order.test.ts: a
// mechanism whose only evidence is its own comment has no evidence.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./sql-scan";

const TICK = fs.readFileSync(
  path.join(REPO, "lib/notifications/tick.ts"),
  "utf8"
);

describe("the detected-finish sweep runs before the finish dispatch", () => {
  it("calls finishDetectedWorkouts before runPostWorkoutFinish", () => {
    const sweep = TICK.indexOf("finishDetectedWorkouts(profileId)");
    const dispatch = TICK.indexOf("runPostWorkoutFinish(profileId");

    // Both call sites still exist — a rename that broke this scan would otherwise turn
    // it into a test that passes by finding nothing.
    expect(sweep, "finishDetectedWorkouts call site not found").toBeGreaterThan(
      -1
    );
    expect(
      dispatch,
      "runPostWorkoutFinish call site not found"
    ).toBeGreaterThan(-1);

    expect(
      sweep,
      "finishDetectedWorkouts must run BEFORE runPostWorkoutFinish — a back-dated end " +
        "is already outside FINISHED_WINDOW_MIN by the next tick, so a sweep after the " +
        "dispatch silences the post-workout dose delivery for every detected finish"
    ).toBeLessThan(dispatch);
  });
});

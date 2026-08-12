// DB INTEGRATION TIER — the record instant is stamped by the CLOCK SEAM, not by
// SQL's own clock (issue #2287).
//
// THE DEFECT THESE PIN. `lib/clock.ts` is the app's one notion of "now", and the e2e
// suite freezes it. `lib/e2e-freeze-instant.ts` then NUDGES that frozen instant
// forward across UTC midnight for a run starting inside its hazard window, so for
// those runs the seam leads real time by 30–60 minutes. Any value SQL stamps itself
// (`datetime('now')`, or a column DEFAULT that reads it) is on the real clock, and
// every comparison between the two answers by the size of that gap rather than by
// the data. Two consequences were reproduced end-to-end before this change:
//
//   • `activities.created_at` / `updated_at` are what `computeWorkoutPresence`
//     subtracts from the seam's now to decide whether a live draft has gone quiet.
//     Stamped by SQL, a draft saved SECONDS ago read as 58 minutes quiet — past
//     STALE_MIN (45) — and the dock rendered "Still working out? Finish or discard".
//   • the offline food replay judged a queued eating-time statement against a bare
//     `new Date()` while the statement itself had been resolved against the seam (the
//     e2e fixture puts the BROWSER on the frozen clock too), so the gate — `judgeEatenAt`
//     since #2296 — refused a seconds-old statement as 58 minutes in the FUTURE and
//     `food_log_events.time_source` landed NULL instead of 'stated'. Since #2296 that
//     refusal is also SPOKEN, so a spurious one now misinforms the user rather than
//     merely losing a minute: it blames a device clock the app itself had moved.
//
// The tests below reproduce that gap DIRECTLY — freeze the seam ahead of real time,
// exactly as the nudge does — rather than asserting an equality that would still hold
// if a writer went back to SQL's clock. A regression fails them at any hour.
//
// Every value is synthetic (fake profiles, a fictional draft title, berries).

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { now as clockNow } from "@/lib/clock";
import { utcSqlString } from "@/lib/date";
import { toKm } from "@/lib/units";
import { saveActivityCore } from "@/lib/activity-write";
import { logMobilityMoveCore } from "@/lib/mobility-log-write";
import { finishWorkoutSession } from "@/lib/workout-finish";
import { upsertActivities } from "@/lib/integrations/normalize";
import { getWorkoutPresence } from "@/lib/queries/presence";
import { applyIntent } from "@/lib/offline/writes";
import { buildIntent } from "@/lib/offline/queue";
import { STALE_MIN } from "@/lib/workout-presence";

// The gap the freeze nudge produces for a run starting at 23:32Z (nudged to
// midnight + 30). Deliberately larger than STALE_MIN so a stamp on the wrong clock
// cannot pass by luck.
const NUDGE_GAP_MIN = 58;

let priorNow: string | undefined;

beforeEach(() => {
  priorNow = process.env.ALLOS_TEST_NOW;
  // Freeze the seam AHEAD of real time, the way #1464's nudge does inside its hazard
  // window. Anchored on the real clock (not a fixed literal) so the divergence is a
  // real one at whatever hour the suite runs.
  process.env.ALLOS_TEST_NOW = new Date(
    Date.now() + NUDGE_GAP_MIN * 60_000
  ).toISOString();
});

afterEach(() => {
  if (priorNow === undefined) delete process.env.ALLOS_TEST_NOW;
  else process.env.ALLOS_TEST_NOW = priorNow;
});

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function stamps(activityId: number): {
  created_at: string;
  updated_at: string | null;
} {
  return db
    .prepare("SELECT created_at, updated_at FROM activities WHERE id = ?")
    .get(activityId) as { created_at: string; updated_at: string | null };
}

// The live-draft signature computeWorkoutPresence reads as `active`: a started,
// un-ended, duration-less manual session on today.
function liveDraftForm(profileId: number, id?: number): FormData {
  const fd = new FormData();
  if (id != null) fd.set("id", String(id));
  fd.set("type", "strength");
  fd.set("title", "Draft session");
  fd.set("date", today(profileId));
  fd.set("start_time", "09:00");
  return fd;
}

describe("activities record instants come off the clock seam (#2287)", () => {
  it("saveActivityCore stamps created_at from the seam, not the column DEFAULT", () => {
    const p = newProfile("seam-activity-create");
    const outcome = saveActivityCore(p, liveDraftForm(p), {
      weightUnit: "kg",
      distanceUnit: "km",
    });
    expect(outcome.ok).toBe(true);
    const id = outcome.ok ? outcome.id : 0;
    expect(stamps(id).created_at).toBe(utcSqlString(clockNow()));
  });

  it("an edit stamps updated_at from the seam", () => {
    const p = newProfile("seam-activity-edit");
    const created = saveActivityCore(p, liveDraftForm(p), {
      weightUnit: "kg",
      distanceUnit: "km",
    });
    const id = created.ok ? created.id : 0;
    saveActivityCore(p, liveDraftForm(p, id), {
      weightUnit: "kg",
      distanceUnit: "km",
    });
    expect(stamps(id).updated_at).toBe(utcSqlString(clockNow()));
  });

  it("finishWorkoutSession stamps updated_at from the seam", () => {
    const p = newProfile("seam-activity-finish");
    const created = saveActivityCore(p, liveDraftForm(p), {
      weightUnit: "kg",
      distanceUnit: "km",
    });
    const id = created.ok ? created.id : 0;
    // A finish refuses a content-less draft (#1205 §4), so give it one logged set.
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, 'Back Squat', 1, 60, 5)`
    ).run(id);
    expect(finishWorkoutSession(p, id).kind).toBe("finished");
    expect(stamps(id).updated_at).toBe(utcSqlString(clockNow()));
  });

  it("the mobility core stamps both created_at and updated_at from the seam", () => {
    const p = newProfile("seam-mobility");
    const date = today(p);
    expect(logMobilityMoveCore(p, "neck_cars", date).kind).toBe("logged");
    const row = db
      .prepare(
        "SELECT id FROM activities WHERE profile_id = ? AND date = ? AND type = 'recovery'"
      )
      .get(p, date) as { id: number };
    expect(stamps(row.id).created_at).toBe(utcSqlString(clockNow()));
    // A second move UPDATEs the same day's row.
    expect(logMobilityMoveCore(p, "cat_cow", date).kind).toBe("logged");
    expect(stamps(row.id).updated_at).toBe(utcSqlString(clockNow()));
  });

  it("an imported activity's first-seen created_at comes off the seam", () => {
    const p = newProfile("seam-import");
    upsertActivities(
      p,
      [
        {
          date: today(p),
          type: "cardio",
          title: "Imported walk",
          duration_min: 30,
          distance_km: toKm(2, "km"),
          start_time: "08:00",
          end_time: "08:30",
          external_id: "e2e-seam-1",
        },
      ],
      "e2e-provider"
    );
    const row = db
      .prepare(
        "SELECT id FROM activities WHERE profile_id = ? AND external_id = ?"
      )
      .get(p, "e2e-seam-1") as { id: number };
    expect(stamps(row.id).created_at).toBe(utcSqlString(clockNow()));
  });

  it("a seconds-old live draft is NOT stale while the seam leads real time", () => {
    // The reproduction itself: with the seam 58 minutes ahead of the real clock, a
    // draft written and read in the same breath used to answer `quietMin ≈ 58`,
    // past STALE_MIN (45), and raise the dock's "Still working out?" branch.
    const p = newProfile("seam-presence");
    const created = saveActivityCore(p, liveDraftForm(p), {
      weightUnit: "kg",
      distanceUnit: "km",
    });
    const id = created.ok ? created.id : 0;
    const presence = getWorkoutPresence(p);
    expect(NUDGE_GAP_MIN).toBeGreaterThan(STALE_MIN);
    expect(presence.state).toBe("active");
    expect(presence.activityId).toBe(id);
    expect(presence.stale).toBe(false);
  });
});

describe("offline food replay judges a statement on the seam's clock (#2287)", () => {
  it("keeps time_source 'stated' while the seam leads real time", () => {
    // A browser under the e2e freeze answers the SAME now the server does (the
    // fixture sets each context's system time to the frozen instant), so a "now"
    // statement captured offline carries the SEAM's instant. Judged against a bare
    // `new Date()` it read as 58 minutes in the future and was dropped.
    const p = newProfile("seam-food-replay");
    const date = today(p);
    const statedAt = clockNow().toISOString();
    const outcome = applyIntent(
      p,
      buildIntent(
        "food",
        date,
        {
          entry: "serving",
          groupKey: "berries",
          mealSlot: null,
          grams: null,
          eatenAt: statedAt,
        },
        p,
        clockNow()
      )
    );
    expect(outcome).toEqual({ status: "done" });
    const row = db
      .prepare(
        `SELECT occurred_at, time_source FROM food_log_events
          WHERE profile_id = ? AND group_key = 'berries' ORDER BY id DESC LIMIT 1`
      )
      .get(p) as { occurred_at: string | null; time_source: string | null };
    expect(row.time_source).toBe("stated");
    expect(row.occurred_at).not.toBeNull();
  });
});

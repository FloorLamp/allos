// DB INTEGRATION TIER — create-at-start (#2870 step 3). Starting a live session
// writes its row up front; these pins hold the three contracts that row carries:
//   • PRESENCE SEES IT — the inserted shape is the live-draft signature, so the
//     session is `active` to computeWorkoutPresence the moment start returns
//     (other devices' resume bars key off exactly this).
//   • THE PAGE CAN RENDER IT — the id resolves through getActivityDetailData,
//     because the id IS the canonical URL the start flow navigates to.
//   • THE DRAFT LIFECYCLE HOLDS (#1205 §4) — an untouched start refuses to
//     finish (empty-draft) and discards cleanly; one logged set flips it to
//     finishable.
//
// Every value is synthetic (a fake profile; no PHI).

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import {
  startWorkoutSession,
  finishWorkoutSession,
  discardWorkoutSession,
  discardWorkoutSessionIfEmpty,
} from "@/lib/workout-finish";
import { getWorkoutPresence } from "@/lib/queries/presence";
import { getActivityDetailData } from "@/lib/training-activity-detail";
import type { UnitPrefs } from "@/lib/settings";
import { seedProfile } from "./fixtures";

const UNITS: UnitPrefs = {
  weightUnit: "kg",
  distanceUnit: "km",
  temperatureUnit: "F",
};

let profileId: number;

beforeAll(() => {
  profileId = seedProfile("Start Subject").profileId;
});

describe("startWorkoutSession (#2870 step 3)", () => {
  it("creates the live-draft row and presence reads it as active", () => {
    const now = new Date();
    const res = startWorkoutSession(
      profileId,
      { type: "strength", title: "" },
      now
    );
    expect(res.id).toBeGreaterThan(0);

    const row = db
      .prepare("SELECT * FROM activities WHERE id = ? AND profile_id = ?")
      .get(res.id, profileId) as Record<string, unknown>;
    // The live-draft signature: started, unended, duration-less, source-less.
    expect(row.start_time).toBe(res.startTime);
    expect(row.end_time).toBeNull();
    expect(row.duration_min).toBeNull();
    expect(row.source).toBeNull();

    const presence = getWorkoutPresence(profileId, now);
    expect(presence.state).toBe("active");
    expect(presence.activityId).toBe(res.id);

    // The id is the canonical URL — the page's gather resolves it.
    const detail = getActivityDetailData(profileId, res.id, UNITS);
    expect(detail).not.toBeNull();
    expect(detail!.card.activity.id).toBe(res.id);

    // Clean up the active session so later tests see a quiet profile.
    expect(discardWorkoutSession(profileId, res.id).kind).toBe("discarded");
  });

  it("an untouched start is a draft: finish refuses it, discard removes it", () => {
    const res = startWorkoutSession(profileId, {
      type: "strength",
      title: "",
    });
    expect(finishWorkoutSession(profileId, res.id).kind).toBe("empty-draft");
    expect(discardWorkoutSession(profileId, res.id).kind).toBe("discarded");
    expect(
      db
        .prepare("SELECT COUNT(*) AS c FROM activities WHERE id = ?")
        .get(res.id) as { c: number }
    ).toEqual({ c: 0 });
  });

  it("the if-empty discard takes the husk and keeps anything with content", () => {
    // The close-path abandonment (#2870 step 3): an untouched start goes...
    const husk = startWorkoutSession(profileId, {
      type: "strength",
      title: "",
    });
    expect(discardWorkoutSessionIfEmpty(profileId, husk.id).kind).toBe(
      "discarded"
    );
    // …one set keeps the row…
    const kept = startWorkoutSession(profileId, {
      type: "strength",
      title: "",
    });
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, 'Back Squat', 1, 100, 5)`
    ).run(kept.id);
    expect(discardWorkoutSessionIfEmpty(profileId, kept.id).kind).toBe("kept");
    // …a note alone is also content ("zero sets/VALUES" is the draft bar)…
    const noted = startWorkoutSession(profileId, {
      type: "strength",
      title: "",
    });
    db.prepare("UPDATE activities SET notes = 'tweaked knee' WHERE id = ?").run(
      noted.id
    );
    expect(discardWorkoutSessionIfEmpty(profileId, noted.id).kind).toBe("kept");
    // …and a finished session is refused outright.
    expect(finishWorkoutSession(profileId, kept.id).kind).toBe("finished");
    expect(discardWorkoutSessionIfEmpty(profileId, kept.id).kind).toBe(
      "already-finished"
    );
    // Quiet the profile for neighbors.
    expect(discardWorkoutSession(profileId, noted.id).kind).toBe("discarded");
  });

  it("one logged set flips the start from draft to finishable", () => {
    const res = startWorkoutSession(profileId, {
      type: "strength",
      title: "Legs",
    });
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, 'Back Squat', 1, 100, 5)`
    ).run(res.id);
    expect(finishWorkoutSession(profileId, res.id).kind).toBe("finished");
    const row = db
      .prepare("SELECT end_time, duration_min FROM activities WHERE id = ?")
      .get(res.id) as { end_time: string | null; duration_min: number | null };
    expect(row.end_time).not.toBeNull();
  });
});

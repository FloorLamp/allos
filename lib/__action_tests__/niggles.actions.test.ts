// SERVER-ACTION TIER — the confirm chip's write path (issue #2948 part 2).
//
// The posture under test is #798 confirm-never-silent: nothing reaches `niggles` until
// this action runs, the action runs only from a tap, and what it writes is re-derived
// from the activity's OWN notes rather than trusted from the form. So the pins are: a
// confirmed candidate lands linked to its activity; a candidate the note does not
// actually produce is refused; a second confirm of the same chip re-reports instead of
// duplicating; and another profile's activity cannot be named as the source.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { confirmNiggle } from "@/app/(app)/training/niggle-actions";
import { getNiggles } from "@/lib/niggle-store";
import { fd, seedActor } from "./harness";

const revalidate = vi.mocked(revalidatePath);

function seedActivity(profileId: number, notes: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, notes)
         VALUES (?, '2026-08-01', 'strength', 'Leg day', ?)`
      )
      .run(profileId, notes).lastInsertRowid
  );
}

beforeEach(() => revalidate.mockClear());

describe("confirmNiggle (#2948)", () => {
  it("writes the confirmed candidate, linked to the activity, and revalidates", async () => {
    const { profile } = seedActor();
    const activityId = seedActivity(profile.id, "right knee weird");

    const out = await confirmNiggle(
      fd({ activity_id: activityId, region: "Legs", laterality: "right" })
    );
    expect(out).toMatchObject({ ok: true, kind: "created" });

    const rows = getNiggles(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      region: "Legs",
      laterality: "right",
      bodyTerm: "knee",
      sourceActivityId: activityId,
      // The note names a body part, not a lift — the exercise is left unknown rather
      // than guessed from whatever was logged that day.
      sourceExercise: null,
    });
    expect(revalidate.mock.calls.map((c) => c[0])).toContain("/training");
  });

  it("nothing is written until the tap — the note alone stores no niggle", () => {
    const { profile } = seedActor();
    seedActivity(profile.id, "left hip no good");
    expect(getNiggles(profile.id)).toEqual([]);
  });

  it("refuses a region the note never named", async () => {
    const { profile } = seedActor();
    const activityId = seedActivity(profile.id, "right knee weird");
    // A forged/stale post naming a different region: the action re-runs the detector
    // over the stored note and finds no such candidate.
    expect(
      await confirmNiggle(
        fd({ activity_id: activityId, region: "Chest", laterality: "right" })
      )
    ).toEqual({ ok: false, reason: "no-candidate" });
    expect(getNiggles(profile.id)).toEqual([]);
  });

  it("refuses a side the note never named", async () => {
    const { profile } = seedActor();
    const activityId = seedActivity(profile.id, "right knee weird");
    expect(
      await confirmNiggle(
        fd({ activity_id: activityId, region: "Legs", laterality: "left" })
      )
    ).toEqual({ ok: false, reason: "no-candidate" });
    expect(getNiggles(profile.id)).toEqual([]);
  });

  it("a second confirm of the same chip re-reports rather than duplicating", async () => {
    const { profile } = seedActor();
    const activityId = seedActivity(profile.id, "left hip no good");
    const form = () =>
      fd({ activity_id: activityId, region: "Glutes", laterality: "left" });

    expect(await confirmNiggle(form())).toMatchObject({ kind: "created" });
    expect(await confirmNiggle(form())).toMatchObject({ kind: "re-reported" });
    expect(getNiggles(profile.id)).toHaveLength(1);
  });

  it("refuses an activity that is not the gated profile's", async () => {
    const other = seedActor({ profileName: "Other Household" });
    const otherActivity = seedActivity(other.profile.id, "right knee weird");
    const { profile } = seedActor();

    expect(
      await confirmNiggle(
        fd({ activity_id: otherActivity, region: "Legs", laterality: "right" })
      )
    ).toEqual({ ok: false, reason: "not-owned" });
    expect(getNiggles(profile.id)).toEqual([]);
    expect(getNiggles(other.profile.id)).toEqual([]);
  });
});

// DB INTEGRATION TIER — situation-aware coaching (issue #837). Per the #221 "one
// computation" discipline, the hold decision must reach BOTH the dashboard coaching
// card (recommendCoaching) and the Telegram workout slot (recommendWorkout) from the
// SAME gathered input, so they can't drift. The pure boundaries are pinned in
// lib/__tests__/coaching-illness.test.ts; only a real seed proves the DB gather
// (gatherCoachingInput → getIllnessCoachingContext) reads the open/closed
// illness_episodes rows and that both surfaces agree end-to-end:
//   - open episode  → gap nags held on the card AND the workout slot goes quiet
//   - closed today  → ease-back rec on the card AND the slot still quiet (ramp)
//   - ramp elapsed  → normal coaching resumes on both
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { gatherCoachingInput } from "@/lib/queries";
import { recommendCoaching } from "@/lib/coaching";
import { recommendWorkout } from "@/lib/notifications/recommend";
import { createEpisodeRow } from "@/lib/illness-episode-store";

const GO_TRAIN = new Set(["strength", "cardio", "ontrack"]);

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// Seed a strength session (with sets) on `date` so the profile has recent training
// history — enough for the next-workout core to emit a "go train" habit rec on a day
// with no logged session yet.
function seedStrength(profileId: number, date: string): void {
  const id = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min)
         VALUES (?, ?, 'strength', 'Squat Day', 45)`
      )
      .run(profileId, date).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
     VALUES (?, 'Back Squat', 1, 100, 5)`
  ).run(id);
}

// A profile with training history but no session logged today → a go-train rec fires.
function trainedProfile(name: string): { p: number; td: string } {
  const p = newProfile(name);
  const td = today(p);
  seedStrength(p, shiftDateStr(td, -3));
  seedStrength(p, shiftDateStr(td, -5));
  return { p, td };
}

describe("situation-aware coaching gather (#837)", () => {
  it("baseline: a go-train rec fires and the workout slot is live", () => {
    const { p } = trainedProfile("Illness Baseline");
    const input = gatherCoachingInput(p, "kg", "km");
    expect(input.illness).toEqual({ openEpisode: false, lastClosed: null });
    expect(recommendCoaching(input).some((r) => GO_TRAIN.has(r.kind))).toBe(
      true
    );
    // The slot is not gated by illness (it may still be non-null with focus/rest).
    expect(recommendWorkout(p, input)).not.toBeNull();
  });

  it("open episode: card holds the nags AND the workout slot goes quiet", () => {
    const { p, td } = trainedProfile("Illness Open");
    // An open flagged-illness episode covering today.
    createEpisodeRow(p, "Illness", shiftDateStr(td, -2), null);

    const input = gatherCoachingInput(p, "kg", "km");
    expect(input.illness?.openEpisode).toBe(true);

    const recs = recommendCoaching(input);
    // No go-train nag; the held note is present with its #656 reason.
    expect(recs.some((r) => GO_TRAIN.has(r.kind))).toBe(false);
    const held = recs.find((r) => r.id === "illness-hold");
    expect(held?.reasons?.[0].code).toBe("coaching-held");

    // Same input → the Telegram slot is quiet by construction (they can't drift).
    expect(recommendWorkout(p, input)).toBeNull();
  });

  it("episode closed today: ease-back rec on the card, slot still quiet", () => {
    const { p, td } = trainedProfile("Illness Closed");
    // Closed episode whose exclusive end (first well day) is today → ease-back day 0.
    createEpisodeRow(p, "Illness", shiftDateStr(td, -4), td);

    const input = gatherCoachingInput(p, "kg", "km");
    expect(input.illness?.openEpisode).toBe(false);
    expect(input.illness?.lastClosed?.endDate).toBe(td);

    const recs = recommendCoaching(input);
    expect(recs.some((r) => r.id === "illness-ease-back")).toBe(true);
    expect(recs.some((r) => GO_TRAIN.has(r.kind))).toBe(false);
    // The workout slot stays quiet through the ease-back ramp.
    expect(recommendWorkout(p, input)).toBeNull();
  });

  it("ramp elapsed: normal coaching resumes on both surfaces", () => {
    const { p, td } = trainedProfile("Illness Recovered");
    // Closed 4 days ago (well beyond the 3-day ease-back ramp).
    createEpisodeRow(p, "Illness", shiftDateStr(td, -8), shiftDateStr(td, -4));

    const input = gatherCoachingInput(p, "kg", "km");
    expect(input.illness?.openEpisode).toBe(false);

    const recs = recommendCoaching(input);
    expect(recs.some((r) => GO_TRAIN.has(r.kind))).toBe(true);
    expect(recs.some((r) => r.kind === "illness")).toBe(false);
    expect(recommendWorkout(p, input)).not.toBeNull();
  });
});

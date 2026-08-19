// The LIVE-NIGGLE coaching tier (#3211 part 3 / #2948 part 3) — the third and weakest
// constraint tier, below the illness hold and the injury exclusion.
//
// Three invariants are the acceptance bar, and each has its own describe block below:
//
//   1. The tilt only ever WEAKENS a session — never strengthens, never excludes.
//   2. Illness holds and injury exclusions OUTRANK it.
//   3. It is never silent — a moved target always carries a line naming the niggle.
//
// The ORDERING is pinned explicitly rather than left to emerge: an illness hold plus a
// live niggle must produce the hold, and an injury exclusion plus a live niggle on the
// same region must produce the exclusion. A tier system whose ordering is untested is one
// that will silently reorder.

import { describe, expect, it } from "vitest";
import {
  recommendNextWorkout,
  type NextWorkoutInput,
} from "@/lib/workout-recommendation";
import {
  contextNotes,
  recommendCoaching,
  type CoachingInput,
  type StrengthRecent,
} from "@/lib/coaching";
import {
  regionInjuryConstraint,
  type InjuryConstraint,
} from "@/lib/injury-model";
import {
  NIGGLE_LOAD_FACTOR,
  niggleTemperLine,
  resolveTrainingTemper,
  type NiggleCoachingContext,
} from "@/lib/niggle-model";

const TODAY = "2026-07-10"; // a Friday
const TUESDAY = "2026-07-07"; // three days back — "from Tuesday"

function sRec(over: Partial<StrengthRecent> = {}): StrengthRecent {
  return {
    exercise: "Bench Press",
    bodyweight: false,
    lastSessionBest: {
      weightKg: 100,
      reps: 5,
      targetReps: 5,
      toFailure: false,
    },
    lastDate: "2026-07-01",
    ...over,
  };
}

// A right-knee niggle from Tuesday — the #2948 scenario, in the app's own region
// vocabulary (a knee is Legs).
const rightKnee: NiggleCoachingContext = {
  region: "Legs",
  label: "right knee",
  lastReportedDay: TUESDAY,
};

function input(over: Partial<NextWorkoutInput> = {}): NextWorkoutInput {
  return {
    today: TODAY,
    routine: [],
    strength: [sRec({ exercise: "Squat" }), sRec({ exercise: "Bench Press" })],
    cardio: [],
    ...over,
  };
}

function ci(over: Partial<CoachingInput> = {}): CoachingInput {
  return {
    today: TODAY,
    routine: [],
    strength: [sRec({ exercise: "Squat" }), sRec({ exercise: "Bench Press" })],
    cardio: [],
    trainingDates: ["2026-07-01"],
    sleep: null,
    restingHr: null,
    ...over,
  };
}

// The numeric target off a recommendation card ("62.5 kg × 5" → 62.5).
const targetKg = (s: string | undefined) =>
  Number((s ?? "").match(/[\d.]+/)?.[0] ?? "0");

describe("invariant 1 — the tilt only WEAKENS (#3211 part 3)", () => {
  it("keeps the region in the recommendation: same items, focus and ranking", () => {
    const base = recommendNextWorkout(input());
    const withNiggle = recommendNextWorkout(input({ niggles: [rightKnee] }));
    // The niggle changes WHAT THE TARGET IS, never WHAT IS RECOMMENDED. Squat is a Legs
    // lift and the niggle is on Legs, so this is the case an exclusion would have eaten.
    expect(withNiggle.items).toEqual(base.items);
    expect(withNiggle.focus).toEqual(base.focus);
    expect(withNiggle.exercises).toEqual(base.exercises);
    expect(withNiggle.primary).toEqual(base.primary);
    expect(withNiggle.exercises).toContain("Squat");
    // And it is not an exclusion by any other name.
    expect(withNiggle.excludedRegions).toEqual([]);
    expect(withNiggle.excludedExercises).toEqual([]);
    expect(withNiggle.substitutionSuggested).toBe(false);
  });

  it("lowers the suggested load for the niggle's region", () => {
    // Squat alone, so the card's lead lift is unambiguously the niggle's region.
    const legs = ci({ strength: [sRec({ exercise: "Squat" })] });
    const plain = recommendCoaching(legs)[0];
    const tempered = recommendCoaching({ ...legs, niggles: [rightKnee] })[0];
    expect(plain.title).toContain("Squat");
    expect(plain.target).toBeTruthy();
    expect(tempered.target).toBeTruthy();
    expect(targetKg(tempered.target)).toBeLessThan(targetKg(plain.target));
    // And the card SAYS why, in the niggle's own words rather than an injury's.
    expect(tempered.detail).toContain("right knee niggle");
    expect(tempered.detail).not.toMatch(/injur/i);
  });

  it("leaves a lift OUTSIDE the niggle's region untouched", () => {
    const chest = ci({ strength: [sRec({ exercise: "Bench Press" })] });
    const plain = recommendCoaching(chest)[0];
    const withNiggle = recommendCoaching({ ...chest, niggles: [rightKnee] })[0];
    expect(withNiggle.target).toBe(plain.target);
  });

  it("never RAISES a target a recovering injury had already pulled below it", () => {
    // A user-declared loadFactor tighter than the niggle's: the composed factor is the
    // injury's, not the niggle's. This is the mutation that would let the weakest tier
    // strengthen a session.
    const tight: InjuryConstraint = {
      ...regionInjuryConstraint({
        id: 1,
        label: "left knee",
        status: "recovering",
        regions: ["Legs"],
      }),
      loadFactor: 0.4,
    };
    const t = resolveTrainingTemper(
      { kind: "tempered", factor: tight.loadFactor! },
      recommendNextWorkout(input({ niggles: [rightKnee], injuries: [tight] }))
        .niggleTempers,
      "Squat"
    );
    expect(t.factor).toBe(0.4);
    // And the mirror: a LOOSER declared preference is pulled down to the niggle's.
    const loose = resolveTrainingTemper(
      { kind: "tempered", factor: 0.95 },
      recommendNextWorkout(input({ niggles: [rightKnee] })).niggleTempers,
      "Squat"
    );
    expect(loose.factor).toBe(NIGGLE_LOAD_FACTOR);
  });

  it("tempers less than a recovering injury does — it is the WEAKEST tier", () => {
    const injuryFactor = resolveTrainingTemper(
      { kind: "tempered", factor: 0.6 },
      [],
      "Squat"
    ).factor;
    expect(NIGGLE_LOAD_FACTOR).toBeGreaterThan(injuryFactor);
  });

  it("no niggles ⇒ byte-for-byte the prior result", () => {
    const nw = recommendNextWorkout(input());
    expect(nw.niggleTempers).toEqual([]);
    expect(contextNotes(nw)).toEqual([]);
  });
});

describe("invariant 2 / ORDERING — illness and injury outrank the niggle (#3211)", () => {
  it("an illness HOLD plus a live niggle produces the HOLD", () => {
    const recs = recommendCoaching(
      ci({ niggles: [rightKnee], illness: { openEpisode: true } })
    );
    // The held note is the whole answer: no train nudge, and therefore no tempered
    // target and no niggle line under it.
    expect(recs.map((r) => r.kind)).toEqual(["illness"]);
    expect(recs[0].target).toBeUndefined();
    expect(JSON.stringify(recs)).not.toContain("niggle");
  });

  it("an injury EXCLUSION plus a live niggle on the same region produces the EXCLUSION", () => {
    const nw = recommendNextWorkout(
      input({
        niggles: [rightKnee],
        injuries: [
          regionInjuryConstraint({
            id: 1,
            label: "left knee",
            status: "active",
            regions: ["Legs"],
          }),
        ],
      })
    );
    // Legs is off the table, so there is no eased-off target to offer for it — and the
    // card must not simultaneously say "avoiding Legs" and "easing off Legs".
    expect(nw.excludedRegions.map((d) => d.region)).toEqual(["Legs"]);
    expect(nw.niggleTempers).toEqual([]);
    expect(nw.exercises).not.toContain("Squat");
    expect(contextNotes(nw).join(" ")).not.toContain("niggle");
  });

  it("an exclusion on ANOTHER region leaves the niggle's own tier intact", () => {
    const nw = recommendNextWorkout(
      input({
        niggles: [rightKnee],
        injuries: [
          regionInjuryConstraint({
            id: 1,
            label: "right shoulder",
            status: "active",
            regions: ["Chest"],
          }),
        ],
      })
    );
    expect(nw.niggleTempers.map((t) => t.region)).toEqual(["Legs"]);
  });

  it("a recovering injury on the same region keeps the INJURY's copy on the target", () => {
    const t = resolveTrainingTemper(
      { kind: "tempered", factor: 0.6 },
      recommendNextWorkout(input({ niggles: [rightKnee] })).niggleTempers,
      "Squat"
    );
    expect(t.tier).toBe("injury");
    expect(t.rationale).toBeNull();
  });

  it("an EXCLUDED lift is not tempered at all", () => {
    const t = resolveTrainingTemper(
      { kind: "excluded", factor: 1 },
      recommendNextWorkout(input({ niggles: [rightKnee] })).niggleTempers,
      "Squat"
    );
    expect(t.tier).toBe("excluded");
    expect(t.recoveringRegion).toBe(false);
  });
});

describe("invariant 3 — never silent (#3211)", () => {
  it("discloses the region, the niggle and when it was reported", () => {
    const nw = recommendNextWorkout(input({ niggles: [rightKnee] }));
    expect(nw.niggleTempers).toEqual([
      {
        region: "Legs",
        label: "right knee",
        factor: NIGGLE_LOAD_FACTOR,
        lastReportedDay: TUESDAY,
        note: "Easing off Legs — right knee niggle from Tuesday",
      },
    ]);
  });

  it("carries the line onto the coaching card's notes", () => {
    const [top] = recommendCoaching(ci({ niggles: [rightKnee] }));
    expect(top.notes ?? []).toContain(
      "Easing off Legs — right knee niggle from Tuesday"
    );
  });

  it("says the reason on the next-set rationale too, without calling it an injury", () => {
    const t = resolveTrainingTemper(
      { kind: "clear", factor: 1 },
      recommendNextWorkout(input({ niggles: [rightKnee] })).niggleTempers,
      "Squat"
    );
    expect(t.rationale).toBe("Easing off — right knee niggle");
    expect(t.rationale).not.toMatch(/injur/i);
  });

  it("phrases the report day across the whole quiet spell", () => {
    const at = (day: string) =>
      niggleTemperLine({ ...rightKnee, lastReportedDay: day }, TODAY);
    expect(at(TODAY)).toContain("from today");
    expect(at("2026-07-07")).toContain("from Tuesday");
    // A weekday name is ambiguous past a week, so the phrase falls back to the
    // relative form the rest of the app uses.
    expect(at("2026-06-28")).toContain("from 2 weeks ago");
  });
});

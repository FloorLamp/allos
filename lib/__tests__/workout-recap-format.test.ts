import { describe, it, expect } from "vitest";
import {
  composeFinishNudge,
  recapNudgeLine,
  weeklyRemainingLine,
} from "../notifications/workout-recap-format";
import type { NotificationMessage } from "../notifications/types";
import type { Recap } from "../session-recap";

function recap(over: Partial<Recap> = {}): Recap {
  return {
    title: "Push day",
    durationMin: 47,
    intensity: "hard",
    exercises: [],
    totalWorkingSets: 14,
    totalVolumeKg: 2450,
    targetRollup: "all-hit",
    prExercises: ["Bench press"],
    avgRpe: 8,
    ...over,
  };
}

const doseMsg: NotificationMessage = {
  title: "🏋️ Post-workout — 1 dose",
  body: "• Creatine — 5 g",
  actions: [
    { label: "✅ Creatine", data: "take:1:2:3:2026-07-17", row: "dose:2" },
  ],
  kind: "dose",
};

describe("recapNudgeLine", () => {
  it("returns the recap line when enabled and there's work to recap", () => {
    expect(recapNudgeLine(recap(), true)).toBe(
      "Push day done · 47 min · 14 sets · Bench press PR · all targets hit"
    );
  });

  it("returns null when the toggle is off (kind disabled strips it)", () => {
    expect(recapNudgeLine(recap(), false)).toBeNull();
  });

  it("returns null for a finish with no strength working sets (pure cardio)", () => {
    expect(
      recapNudgeLine(recap({ totalWorkingSets: 0, prExercises: [] }), true)
    ).toBeNull();
  });

  it("returns null when there's no recap", () => {
    expect(recapNudgeLine(null, true)).toBeNull();
  });
});

describe("composeFinishNudge", () => {
  it("leads with the recap line, then the supplement section", () => {
    const line = recapNudgeLine(recap(), true);
    const msg = composeFinishNudge(line, doseMsg);
    expect(msg).not.toBeNull();
    expect(msg!.body.startsWith("Push day done ·")).toBe(true);
    expect(msg!.body).toContain("Creatine");
    // Dose section still leads the message content after the recap line.
    expect(msg!.body).toBe(`${line}\n\n${doseMsg.body}`);
    // Keeps the dose message's SAFETY-tier kind + actions.
    expect(msg!.kind).toBe("dose");
    expect(msg!.actions).toEqual(doseMsg.actions);
  });

  it("strips the recap line when the toggle is disabled — dose message unchanged", () => {
    const line = recapNudgeLine(recap(), false); // null
    const msg = composeFinishNudge(line, doseMsg);
    expect(msg).toEqual(doseMsg);
  });

  it("sends recap-only (no due doses) as a workout-recap message", () => {
    const line = recapNudgeLine(recap(), true);
    const msg = composeFinishNudge(line, null);
    expect(msg).not.toBeNull();
    expect(msg!.kind).toBe("workout-recap");
    expect(msg!.body).toBe(line);
    expect(msg!.actions).toBeUndefined();
  });

  it("both absent ⇒ no send", () => {
    expect(composeFinishNudge(null, null)).toBeNull();
  });
});

// A minimal FrequencyTargetProgress-shaped fixture for the workout-scoped recap line.
function target(
  scope_kind: string,
  scope_value: string,
  count: number,
  per_week: number
) {
  return {
    target: { scope_kind, scope_value },
    count,
    per_week,
    met: count >= per_week,
  };
}

describe("weeklyRemainingLine (#981 §3, #1122)", () => {
  it("leads with the in-progress workout target, pace-framed (count 1 / per_week 2)", () => {
    // The issue's example: a `region` (Legs) target the session just advanced.
    expect(weeklyRemainingLine([target("region", "Legs", 1, 2)])).toBe(
      "Legs — 1 of 2 this week, one more to go."
    );
  });

  it("pluralizes the tail when more than one session remains", () => {
    expect(weeklyRemainingLine([target("type", "cardio", 1, 3)])).toBe(
      "Cardio — 1 of 3 this week, 2 more to go."
    );
  });

  it("excludes food_group targets from a WORKOUT recap (#1122 defect 1)", () => {
    // A lifting session can't advance veg-servings; grading it here is the "0 of N" bug.
    // With only a food_group target present, the workout recap has nothing to say.
    expect(
      weeklyRemainingLine([target("food_group", "vegetables", 0, 5)])
    ).toBeNull();
  });

  it("excludes mobility_region targets too, and leads with the workout one", () => {
    // food_group + mobility_region are dropped; the in-progress `region` leads.
    expect(
      weeklyRemainingLine([
        target("food_group", "vegetables", 0, 5),
        target("mobility_region", "Legs", 0, 3),
        target("region", "Chest", 1, 2),
      ])
    ).toBe("Chest — 1 of 2 this week, one more to go.");
  });

  it("leads with the closest-to-done in-progress target", () => {
    // Lower body needs 1 more (2 of 3), Cardio needs 2 more (1 of 3) → lead with Lower.
    expect(
      weeklyRemainingLine([
        target("type", "cardio", 1, 3),
        target("group", "Lower", 2, 3),
      ])
    ).toBe("Lower body — 2 of 3 this week, one more to go.");
  });

  it("all workout targets met ⇒ a calm celebratory-neutral line", () => {
    expect(
      weeklyRemainingLine([
        target("region", "Legs", 2, 2),
        target("type", "cardio", 3, 3),
      ])
    ).toBe("All weekly targets met — nice work.");
  });

  it("no workout targets at all ⇒ omitted (null)", () => {
    expect(weeklyRemainingLine([])).toBeNull();
    expect(
      weeklyRemainingLine([target("mobility_region", "Legs", 0, 3)])
    ).toBeNull();
  });

  it("nothing advanced and nothing met ⇒ stays quiet (no misleading '0 of N')", () => {
    // Targets exist but this session didn't advance any (all count 0) — don't tally them.
    expect(
      weeklyRemainingLine([
        target("region", "Legs", 0, 2),
        target("type", "cardio", 0, 3),
      ])
    ).toBeNull();
  });
});

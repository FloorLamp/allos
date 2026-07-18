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

// A minimal RoutineTargetProgress-shaped fixture (only `met` matters to the line);
// the reminder derives its behind-set the same way — routine.filter(t => !t.met).
function target(met: boolean) {
  return { met };
}

describe("weeklyRemainingLine (#981 §3)", () => {
  it("behind ⇒ 'N of M this week — one more to go' (met of total)", () => {
    // 3 targets, 2 met → 1 remaining.
    expect(
      weeklyRemainingLine([target(true), target(true), target(false)])
    ).toBe("2 of 3 this week — one more to go.");
  });

  it("more than one remaining ⇒ pluralized tail", () => {
    expect(
      weeklyRemainingLine([target(true), target(false), target(false)])
    ).toBe("1 of 3 this week — 2 more to go.");
  });

  it("all met ⇒ a calm celebratory-neutral line", () => {
    expect(weeklyRemainingLine([target(true), target(true)])).toBe(
      "All weekly targets met — nice work."
    );
  });

  it("no targets ⇒ omitted (null)", () => {
    expect(weeklyRemainingLine([])).toBeNull();
  });

  // #221 pin: the line's "remaining" count is EXACTLY the reminder's behind-set for
  // the same rollup — the two read one computation and can't drift.
  it("remaining equals the reminder's behind-set for the same fixture", () => {
    for (const routine of [
      [target(true), target(false), target(false)],
      [target(true), target(true), target(true)],
      [target(false)],
      [] as { met: boolean }[],
    ]) {
      const behindCount = routine.filter((t) => !t.met).length; // the reminder's behind
      const line = weeklyRemainingLine(routine);
      if (routine.length === 0) {
        expect(line).toBeNull();
        continue;
      }
      if (behindCount === 0) {
        expect(line).toBe("All weekly targets met — nice work.");
        continue;
      }
      const met = routine.length - behindCount;
      const tail =
        behindCount === 1 ? "one more to go" : `${behindCount} more to go`;
      expect(line).toBe(`${met} of ${routine.length} this week — ${tail}.`);
    }
  });
});

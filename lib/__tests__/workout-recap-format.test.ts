import { describe, it, expect } from "vitest";
import {
  composeFinishNudge,
  recapNudgeLine,
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

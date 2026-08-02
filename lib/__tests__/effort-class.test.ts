// PURE TIER — session effort class and the workout-nudge deferral it drives (#1672).
//
// The reported failure: two weekly targets behind, a morning session credited one, and
// the evening reminder pushed the other with no mention of the morning session. It read
// as "the app didn't notice my workout" and prescribed a same-day double session with
// no urgency test.

import { describe, it, expect } from "vitest";
import {
  daysLeftPhrase,
  effortClass,
  isGenericSessionTitle,
  reachableWithoutToday,
  targetScopeEffortClass,
  workoutAcknowledgmentLine,
  workoutDeferralDecision,
  type BehindTargetPace,
} from "@/lib/effort-class";

const target = (over: Partial<BehindTargetPace> = {}): BehindTargetPace => ({
  scopeKind: "type",
  scopeValue: "strength",
  label: "Strength",
  count: 1,
  perWeek: 3,
  daysLeftInWindow: 4,
  ...over,
});

describe("effortClass (#1672)", () => {
  it("classes real sessions as TRAINING", () => {
    expect(effortClass("strength", "Push day")).toBe("training");
    expect(effortClass("cardio", "Morning run")).toBe("training");
    expect(effortClass("cardio", "Long ride")).toBe("training");
    expect(effortClass("cardio", "Swim")).toBe("training");
    expect(effortClass("sport", "Tennis")).toBe("training");
    // A loaded carry is training, not a walk.
    expect(effortClass("cardio", "Ruck 10 km")).toBe("training");
  });

  it("classes walks and mobility work as INCIDENTAL", () => {
    // A walk is stored as cardio, so classifying on type alone would let a dog walk
    // mark the day trained — the #921 line this must uphold.
    expect(effortClass("cardio", "Dog walk")).toBe("incidental");
    expect(effortClass("cardio", "Evening walk")).toBe("incidental");
    expect(effortClass("recovery", "Stretching")).toBe("incidental");
    expect(effortClass("recovery", "")).toBe("incidental");
    expect(effortClass("strength", "Mobility flow")).toBe("incidental");
  });

  it("classes target SCOPES the same way", () => {
    expect(targetScopeEffortClass("type", "strength")).toBe("training");
    expect(targetScopeEffortClass("type", "cardio")).toBe("training");
    expect(targetScopeEffortClass("type", "walk")).toBe("incidental");
    expect(targetScopeEffortClass("type", "recovery")).toBe("incidental");
  });
});

describe("pace feasibility (#1672)", () => {
  it("is reachable when the sessions still owed fit the days that remain", () => {
    // Tuesday, 1 of 3 with 4 days left: 2 owed ≤ 4 remaining.
    expect(reachableWithoutToday(target())).toBe(true);
    // Saturday, 1 of 3 with 1 day left: 2 owed > 1 remaining.
    expect(reachableWithoutToday(target({ daysLeftInWindow: 1 }))).toBe(false);
    // The exact boundary: 2 owed, exactly 2 days left ⇒ still reachable.
    expect(
      reachableWithoutToday(
        target({ count: 1, perWeek: 3, daysLeftInWindow: 2 })
      )
    ).toBe(true);
  });
});

describe("workoutDeferralDecision (#1672)", () => {
  it("an untrained day behaves exactly as before", () => {
    expect(
      workoutDeferralDecision({ trainedToday: null, behind: [target()] })
    ).toEqual({ kind: "fire", acknowledge: null });
  });

  it("morning strength + another LOOSE training target ⇒ HOLD (no send)", () => {
    expect(
      workoutDeferralDecision({
        trainedToday: "Push day",
        behind: [target({ scopeValue: "cardio", label: "Cardio" })],
      })
    ).toEqual({ kind: "hold" });
  });

  it("morning strength + a TIGHT training target ⇒ fire, naming the lift and the pace fact", () => {
    const tight = target({
      scopeValue: "cardio",
      label: "Cardio",
      count: 1,
      perWeek: 3,
      daysLeftInWindow: 1,
    });
    const d = workoutDeferralDecision({
      trainedToday: "Push day",
      behind: [tight],
    });
    expect(d).toEqual({
      kind: "fire",
      acknowledge: { session: "Push day", forcedBy: tight },
    });
    expect(
      workoutAcknowledgmentLine(d.kind === "fire" ? d.acknowledge : null)
    ).toBe("Nice push day today — Cardio is 1/3 with today and 1 day left.");
  });

  it("a DOG-WALK day leaves a behind lift target's nudge alone (#921, upheld)", () => {
    // The walk never marks the day trained, so the decision is the untrained one.
    expect(
      workoutDeferralDecision({
        trainedToday: null, // what effortClass yields for a walk-only day
        behind: [target()],
      })
    ).toEqual({ kind: "fire", acknowledge: null });
  });

  it("a morning lift does NOT defer a behind WALK habit — a walk isn't a second session", () => {
    const walk = target({
      scopeValue: "walk",
      label: "Walk",
      count: 2,
      perWeek: 5,
      daysLeftInWindow: 4, // loose: it would be deferred if it were training-class
    });
    const d = workoutDeferralDecision({
      trainedToday: "Push day",
      behind: [walk],
    });
    expect(d.kind).toBe("fire");
    // No pace justification needed — the two are compatible, so the line just
    // acknowledges the session.
    expect(d.kind === "fire" ? d.acknowledge?.forcedBy : undefined).toBeNull();
    expect(
      workoutAcknowledgmentLine(d.kind === "fire" ? d.acknowledge : null)
    ).toBe("Nice push day today.");
  });

  it("holds only when EVERY remaining training target is still reachable", () => {
    const loose = target({ scopeValue: "cardio", label: "Cardio" });
    const tight = target({
      scopeValue: "strength",
      label: "Strength",
      count: 0,
      perWeek: 3,
      daysLeftInWindow: 1,
    });
    expect(
      workoutDeferralDecision({ trainedToday: "Run", behind: [loose] })
    ).toEqual({ kind: "hold" });
    expect(
      workoutDeferralDecision({ trainedToday: "Run", behind: [loose, tight] })
        .kind
    ).toBe("fire");
  });

  // Nothing behind means no workout is being PUSHED — the message, if any, is a
  // rest-day or on-track reframe. Those are calm notes, not a prescription for a
  // second session, so deferral must leave them alone.
  it("nothing behind at all ⇒ fire unchanged (the rest / on-track reframes)", () => {
    expect(
      workoutDeferralDecision({ trainedToday: "Push day", behind: [] })
    ).toEqual({ kind: "fire", acknowledge: null });
  });

  it("says nothing when there is no acknowledgment to make", () => {
    expect(workoutAcknowledgmentLine(null)).toBeNull();
  });
});

// ---- #1822 item 1: the days-left phrase, and the edge it used to get wrong ----

describe("daysLeftPhrase (#1822 item 1)", () => {
  // The count is on-days AFTER today, so 0 means "today is the last chance" — the
  // opposite of what "with 0 days left" told the reader.
  it("is TODAY-INCLUSIVE at the 0 edge", () => {
    expect(daysLeftPhrase(0)).toBe("only today left");
    // A negative denominator (a stale window) can only mean the same thing.
    expect(daysLeftPhrase(-3)).toBe("only today left");
    expect(daysLeftPhrase(0)).not.toContain("0 days");
  });

  it("counts today plus the remaining days, singular at 1", () => {
    expect(daysLeftPhrase(1)).toBe("today and 1 day left");
    expect(daysLeftPhrase(2)).toBe("today and 2 days left");
    expect(daysLeftPhrase(5)).toBe("today and 5 days left");
  });

  it("is the ONE phrase both pace formatters state", () => {
    // The acknowledgment (#1672) and recoveryOverrideLine (#1673) used to answer the
    // same pace fact differently on the 0 edge. Both now render this string, so the
    // drift cannot come back through a second joiner.
    const ack = workoutAcknowledgmentLine({
      session: "Bench day",
      forcedBy: target({
        scopeValue: "chest",
        label: "Chest",
        count: 1,
        perWeek: 2,
        daysLeftInWindow: 0,
      }),
    });
    expect(ack).toBe(
      "Nice bench day today — Chest is 1/2 with only today left."
    );
    expect(ack).not.toContain("0 days");
  });
});

// ---- #1822 item 2: a generic title earns acknowledgment, not praise ----

describe("generic session titles (#1822 item 2)", () => {
  it("recognizes titles that say nothing about WHAT was trained", () => {
    expect(isGenericSessionTitle("Workout")).toBe(true);
    expect(isGenericSessionTitle("  training session ")).toBe(true);
    expect(isGenericSessionTitle("Gym")).toBe(true);
    expect(isGenericSessionTitle("")).toBe(true);
    expect(isGenericSessionTitle("   ")).toBe(true);
  });

  it("leaves a title that names something specific alone", () => {
    // Whole-string, never substring — otherwise "chest workout" loses its praise too.
    expect(isGenericSessionTitle("Chest workout")).toBe(false);
    expect(isGenericSessionTitle("Push day")).toBe(false);
    expect(isGenericSessionTitle("Long ride")).toBe(false);
  });

  it("degrades to a plain acknowledgment rather than 'Nice workout today'", () => {
    expect(
      workoutAcknowledgmentLine({ session: "Workout", forcedBy: null })
    ).toBe("Trained today.");
    expect(
      workoutAcknowledgmentLine({
        session: "Workout",
        forcedBy: target({
          scopeValue: "chest",
          label: "Chest",
          count: 1,
          perWeek: 2,
          daysLeftInWindow: 0,
        }),
      })
    ).toBe("Trained today — Chest is 1/2 with only today left.");
  });

  it("still LEADS WITH WHAT THEY DID — the #1672 tone goal, either opening", () => {
    for (const session of ["Workout", "Chest workout"]) {
      const line = workoutAcknowledgmentLine({
        session,
        forcedBy: target({ label: "Strength", count: 1, perWeek: 3 }),
      })!;
      // The session comes first; the shortfall never opens the message.
      expect(line.startsWith("Trained") || line.startsWith("Nice")).toBe(true);
      expect(line.indexOf("Strength")).toBeGreaterThan(0);
    }
  });

  it("keeps the praise when the title names the session", () => {
    expect(
      workoutAcknowledgmentLine({ session: "Chest workout", forcedBy: null })
    ).toBe("Nice chest workout today.");
  });
});

// The policy-constants module's ONE behavioural claim (#4243): a threshold stated in
// prose is BUILT from the constant, so re-tuning the number cannot leave the sentence
// behind. That is the check the owner's 2026-09-05 ruling kept in place of a lint
// guard, so it is pinned on the formatter and on each phrase that uses it.
//
// The literal phrasings themselves are already pinned where they render
// (lib/__tests__/deload-adjust.test.ts, lib/__tests__/plateau-advice.test.ts, the
// rule-findings capture). What these assertions add is the LINK: each is written as
// "the rendered phrase equals the phrase built from the constant", so changing one
// side alone fails.

import { describe, it, expect } from "vitest";
import {
  DELOAD_LOAD_FACTOR,
  SAFE_LOSS_FRACTION_PER_WEEK,
  policyPercent,
} from "../constants";
import { plateauBreakAdvice } from "../plateau-advice";
import { deloadAdjust } from "../coaching/strength";

describe("policyPercent", () => {
  it("renders a policy fraction the way a sentence says it", () => {
    expect(policyPercent(0.01)).toBe("1%");
    expect(policyPercent(0.1)).toBe("10%");
    expect(policyPercent(0.015)).toBe("1.5%");
    expect(policyPercent(0.005)).toBe("0.5%");
    expect(policyPercent(0)).toBe("0%");
    expect(policyPercent(1)).toBe("100%");
  });

  it("absorbs the float noise a fraction subtraction leaves behind", () => {
    // 1 − 0.9 is 0.09999999999999998; the sentence still says 10%.
    expect(policyPercent(1 - 0.9)).toBe("10%");
  });
});

describe("prose states the constant it is tuned by", () => {
  it("the deload advice's magnitude is DELOAD_LOAD_FACTOR's drop", () => {
    const drop = policyPercent(1 - DELOAD_LOAD_FACTOR);
    expect(drop).toBe("10%");
    expect(plateauBreakAdvice("Bench Press").deloadPhrase).toBe(
      `drop the load ~${drop} and rebuild`
    );
    const adjusted = deloadAdjust({
      exercise: "Bench Press",
      sets: 3,
      nextSet: {
        weightKg: 100,
        reps: 5,
        bodyweight: false,
        targetReps: 5,
        rationale: "unchanged",
      },
    });
    expect(adjusted.nextSet!.rationale).toBe(
      `Deload week — ~${drop} lighter to recover`
    );
  });

  it("the safe-loss caution's ~1%/week is SAFE_LOSS_FRACTION_PER_WEEK", () => {
    // lib/rule-findings/body-goals.ts builds the caution's phrase this way.
    expect(`~${policyPercent(SAFE_LOSS_FRACTION_PER_WEEK)}/week`).toBe(
      "~1%/week"
    );
  });
});

import { describe, it, expect } from "vitest";
import {
  cycleTrackingRelevant,
  DEFAULT_NAV_RELEVANCE,
  type CycleRelevanceInput,
} from "../nav-relevance";

// The full truth table for the Cycle nav gate (issue #1042):
//
//   hasCycleRows
//   OR (sex === "female"
//       AND (reproductiveStatus === "premenopausal"
//            OR (reproductiveStatus == null
//                AND lifeStage(age) ∈ {adolescent, adult})))
//
// Data always wins; explicit status beats age; unknown sex/age hides.

const input = (
  over: Partial<CycleRelevanceInput> = {}
): CycleRelevanceInput => ({
  hasCycleRows: false,
  sex: null,
  reproductiveStatus: null,
  age: null,
  ...over,
});

describe("cycleTrackingRelevant", () => {
  it("data always wins — logged cycles show the entry regardless of sex/status/age", () => {
    // The trans / unset-sex case: rows exist, sex is male or unset → still shown.
    expect(cycleTrackingRelevant(input({ hasCycleRows: true }))).toBe(true);
    expect(
      cycleTrackingRelevant(input({ hasCycleRows: true, sex: "male" }))
    ).toBe(true);
    // Even an explicit postmenopausal status can't hide real data.
    expect(
      cycleTrackingRelevant(
        input({
          hasCycleRows: true,
          sex: "female",
          reproductiveStatus: "postmenopausal",
          age: 70,
        })
      )
    ).toBe(true);
  });

  it("explicit premenopausal status shows, beating any age (the FSH-range precedence)", () => {
    expect(
      cycleTrackingRelevant(
        input({ sex: "female", reproductiveStatus: "premenopausal" })
      )
    ).toBe(true);
    // Status beats the age proxy in BOTH directions: an older-adult age (which the
    // fallback would hide) is overridden by the explicit status…
    expect(
      cycleTrackingRelevant(
        input({ sex: "female", reproductiveStatus: "premenopausal", age: 66 })
      )
    ).toBe(true);
  });

  it("explicit postmenopausal status hides (absent data), regardless of age", () => {
    expect(
      cycleTrackingRelevant(
        input({ sex: "female", reproductiveStatus: "postmenopausal" })
      )
    ).toBe(false);
    // …and an adult age (which the fallback would show) is overridden too.
    expect(
      cycleTrackingRelevant(
        input({ sex: "female", reproductiveStatus: "postmenopausal", age: 35 })
      )
    ).toBe(false);
  });

  it("status unset falls back to the #494 life stage: adolescent/adult show", () => {
    expect(cycleTrackingRelevant(input({ sex: "female", age: 13 }))).toBe(true); // adolescent
    expect(cycleTrackingRelevant(input({ sex: "female", age: 17 }))).toBe(true);
    expect(cycleTrackingRelevant(input({ sex: "female", age: 18 }))).toBe(true); // adult
    expect(cycleTrackingRelevant(input({ sex: "female", age: 64 }))).toBe(true);
  });

  it("status unset: child, infant, and older-adult stages hide", () => {
    expect(cycleTrackingRelevant(input({ sex: "female", age: 0 }))).toBe(false); // infant
    expect(cycleTrackingRelevant(input({ sex: "female", age: 8 }))).toBe(false); // child
    expect(cycleTrackingRelevant(input({ sex: "female", age: 12 }))).toBe(
      false
    );
    expect(cycleTrackingRelevant(input({ sex: "female", age: 65 }))).toBe(
      false
    ); // older-adult
  });

  it("unknown age hides when status is unset (no positive life-stage match)", () => {
    expect(cycleTrackingRelevant(input({ sex: "female", age: null }))).toBe(
      false
    );
  });

  it("unknown or male sex hides absent data", () => {
    expect(cycleTrackingRelevant(input({ sex: null, age: 30 }))).toBe(false);
    expect(cycleTrackingRelevant(input({ sex: "male", age: 30 }))).toBe(false);
    // Sex gate applies even with an explicit premenopausal status on file (the
    // formula requires sex === "female" outside the data-wins arm).
    expect(
      cycleTrackingRelevant(
        input({ sex: null, reproductiveStatus: "premenopausal" })
      )
    ).toBe(false);
  });
});

describe("DEFAULT_NAV_RELEVANCE", () => {
  it("is all-true so an un-threaded caller never over-hides", () => {
    expect(Object.values(DEFAULT_NAV_RELEVANCE).every(Boolean)).toBe(true);
  });
});

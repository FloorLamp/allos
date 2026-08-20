import { describe, expect, it } from "vitest";
import {
  canonicalRpe,
  stepRpe,
  fmtRpe,
  rpeSummaryText,
  mintRpeTracking,
} from "@/lib/rpe";

// The scale an OPTED-IN profile steps over (#3335). A test may mint one directly;
// production may not, and lib/__tests__/rpe-opt-in.test.ts holds that line.
const tracking = mintRpeTracking();

describe("canonicalRpe — write-boundary canonicalization (#743)", () => {
  it("passes an on-grid in-range value through unchanged", () => {
    expect(canonicalRpe(5)).toBe(5);
    expect(canonicalRpe(7.5)).toBe(7.5);
    expect(canonicalRpe(10)).toBe(10);
  });

  it("snaps an off-step in-range value to the nearest half point", () => {
    expect(canonicalRpe(8.2)).toBe(8); // 8.2 → 8.0
    expect(canonicalRpe(8.3)).toBe(8.5); // 8.3 → 8.5
    expect(canonicalRpe(9.74)).toBe(9.5);
    expect(canonicalRpe(9.76)).toBe(10);
  });

  it("rejects an out-of-scale value to null rather than clamping", () => {
    expect(canonicalRpe(4)).toBeNull(); // below the 5 floor
    expect(canonicalRpe(4.9)).toBeNull();
    expect(canonicalRpe(10.1)).toBeNull(); // above the 10 ceiling
    expect(canonicalRpe(11)).toBeNull();
  });

  it("treats null/undefined/non-finite as no RPE", () => {
    expect(canonicalRpe(null)).toBeNull();
    expect(canonicalRpe(undefined)).toBeNull();
    expect(canonicalRpe(NaN)).toBeNull();
    expect(canonicalRpe(Infinity)).toBeNull();
  });
});

describe("stepRpe — the set-row stepper (#743)", () => {
  it("seeds the default working rating when stepping up from blank", () => {
    expect(stepRpe(tracking, null, 1)).toBe(tracking.seed);
  });
  it("clears back to blank when stepping down off the floor", () => {
    expect(stepRpe(tracking, 5, -1)).toBeNull();
    expect(stepRpe(tracking, null, -1)).toBeNull();
  });
  it("steps by a half point and clamps at the ceiling", () => {
    expect(stepRpe(tracking, 7, 1)).toBe(7.5);
    expect(stepRpe(tracking, 8.5, -1)).toBe(8);
    expect(stepRpe(tracking, 10, 1)).toBe(10); // clamped
  });
  // The stepper reads its bounds off the TRACKING, not off module constants —
  // which is what makes "no tracking, no control" mean something rather than
  // being a null-check anyone could route around.
  it("steps over the tracked scale, floor and ceiling included", () => {
    expect(tracking.min).toBe(5);
    expect(tracking.max).toBe(10);
    expect(stepRpe(tracking, tracking.max, 1)).toBe(tracking.max);
    expect(stepRpe(tracking, tracking.min, -1)).toBeNull();
    expect(stepRpe(tracking, tracking.min, 1)).toBe(
      tracking.min + tracking.step
    );
  });
});

describe("fmtRpe", () => {
  it("drops a trailing .0 but keeps a half point", () => {
    expect(fmtRpe(7)).toBe("7");
    expect(fmtRpe(9.5)).toBe("9.5");
  });
});

describe("rpeSummaryText — history-row badge (#743)", () => {
  it("is null when no set carried an RPE", () => {
    expect(rpeSummaryText([{ rpe: null }, {}])).toBeNull();
    expect(rpeSummaryText([])).toBeNull();
  });
  it("shows the single value when uniform", () => {
    expect(rpeSummaryText([{ rpe: 8 }, { rpe: 8 }])).toBe("RPE 8");
  });
  it("shows the min–max span when it varied, skipping unrated sets", () => {
    expect(rpeSummaryText([{ rpe: 7 }, { rpe: null }, { rpe: 9.5 }])).toBe(
      "RPE 7–9.5"
    );
  });
});

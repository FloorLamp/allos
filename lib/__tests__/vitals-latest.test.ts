import { describe, it, expect } from "vitest";
import {
  VITAL_PRESENTATION_FLOORS,
  presentedDirection,
  vitalPresentationFreshness,
  vitalsLatestModel,
} from "@/lib/vitals-latest";
import { shiftDateStr } from "@/lib/date";
import type { LatestTrend } from "@/lib/latest-trend";

// The Latest-vitals card's presentation floor (#2303): the glance framing #1216 put on
// Recent labs, applied to the card that never inherited it, and resolved through the ONE
// freshness decision rather than a fourth hand-rolled `age > horizon`.
//
// All values here are SYNTHETIC.

const TODAY = "2026-08-08";
const ago = (n: number) => shiftDateStr(TODAY, -n);

function trend(date: string, value: number, prev?: number): LatestTrend {
  return {
    date,
    value,
    previousValue: prev ?? null,
    direction: prev == null ? null : value > prev ? "up" : "down",
  };
}

describe("vitalPresentationFreshness", () => {
  it("is current exactly AT the floor and due one day past it", () => {
    for (const quantity of ["blood-pressure", "resting-hr"] as const) {
      const floor = VITAL_PRESENTATION_FLOORS[quantity].days;
      expect(vitalPresentationFreshness(quantity, ago(floor), TODAY)).toBe(
        "current"
      );
      expect(vitalPresentationFreshness(quantity, ago(floor + 1), TODAY)).toBe(
        "due"
      );
    }
  });

  it("gives each quantity its OWN clock", () => {
    // Three weeks of silence on a daily wearable stream is a stopped stream; three
    // weeks is nothing for an episodic cuff reading.
    expect(vitalPresentationFreshness("resting-hr", ago(21), TODAY)).toBe(
      "due"
    );
    expect(vitalPresentationFreshness("blood-pressure", ago(21), TODAY)).toBe(
      "current"
    );
  });

  it("is not-applicable — never due — when no age is knowable", () => {
    expect(vitalPresentationFreshness("blood-pressure", null, TODAY)).toBe(
      "not-applicable"
    );
    expect(vitalPresentationFreshness("blood-pressure", ago(3), null)).toBe(
      "not-applicable"
    );
  });
});

describe("presentedDirection", () => {
  it("carries the arrow only on a current reading", () => {
    expect(presentedDirection("up", "current")).toBe("up");
    expect(presentedDirection("up", "due")).toBeNull();
    expect(presentedDirection("up", "not-applicable")).toBeNull();
  });
});

describe("vitalsLatestModel", () => {
  it("keeps a stale reading's VALUE and withdraws only its currency claim", () => {
    const model = vitalsLatestModel(
      trend(ago(1600), 122, 118),
      trend(ago(1600), 78, 76),
      null,
      TODAY
    )!;
    // The value is still there at full prominence — the fix is what the card claims,
    // never what it hides.
    expect(model.bp).toEqual({
      systolic: 122,
      diastolic: 78,
      date: ago(1600),
      freshness: "due",
      direction: null,
    });
  });

  it("ages the two rows INDEPENDENTLY", () => {
    // The reported shape: a blood pressure from years ago beside yesterday's resting HR,
    // rendered as one snapshot of "my vitals now".
    const model = vitalsLatestModel(
      trend(ago(1600), 122, 118),
      trend(ago(1600), 78, 76),
      trend(ago(1), 61, 59),
      TODAY
    )!;
    expect(model.bp?.freshness).toBe("due");
    expect(model.bp?.direction).toBeNull();
    expect(model.restingHr?.freshness).toBe("current");
    expect(model.restingHr?.direction).toBe("up");
  });

  it("needs both halves for a BP row, and dates it by the systolic reading", () => {
    expect(vitalsLatestModel(trend(ago(2), 118), null, null, TODAY)).toBeNull();
    const model = vitalsLatestModel(
      trend(ago(2), 118),
      trend(ago(2), 76),
      null,
      TODAY
    )!;
    expect(model.bp?.date).toBe(ago(2));
    expect(model.restingHr).toBeNull();
  });

  it("is null only when NEITHER quantity has a reading", () => {
    expect(vitalsLatestModel(null, null, null, TODAY)).toBeNull();
    expect(
      vitalsLatestModel(null, null, trend(ago(1), 61), TODAY)
    ).not.toBeNull();
  });
});

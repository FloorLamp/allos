import { describe, it, expect } from "vitest";
import {
  VITAL_PRESENTATION_FLOORS,
  presentedDirection,
  vitalDormant,
  vitalPresentationFreshness,
  vitalsLatestModel,
} from "@/lib/vitals-latest";
import { VITAL_DORMANCY_DAYS } from "@/lib/domain-dormancy";
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
    // The day before is enough for the freshness cases; the points test below uses
    // explicit non-adjacent dates so ordering cannot pass by coincidence (#3252).
    previousDate: prev == null ? null : shiftDateStr(date, -1),
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
  it("builds a one-point resting-HR sparkline from the current reading", () => {
    const current = trend("2026-08-07", 61);
    expect(
      vitalsLatestModel(null, null, current, TODAY)?.restingHr?.points
    ).toEqual([{ date: "2026-08-07", value: 61 }]);
  });

  it("orders exactly the previous and current readings in a two-point resting-HR sparkline", () => {
    const previous = {
      ...trend("2026-08-07", 61, 59),
      previousDate: "2026-08-03",
    };
    expect(
      vitalsLatestModel(null, null, previous, TODAY)?.restingHr?.points
    ).toEqual([
      { date: "2026-08-03", value: 59 },
      { date: "2026-08-07", value: 61 },
    ]);
  });

  it("keeps a stale reading's VALUE and withdraws only its currency claim", () => {
    // Ten months: past the 180-day blood-pressure floor, well inside the year at which
    // the row goes dormant. This is the whole span #2303 governs.
    const model = vitalsLatestModel(
      trend(ago(300), 122, 118),
      trend(ago(300), 78, 76),
      null,
      TODAY
    )!;
    // The value is still there at full prominence — the fix is what the card claims,
    // never what it hides.
    expect(model.bp).toEqual({
      systolic: 122,
      diastolic: 78,
      date: ago(300),
      freshness: "due",
      direction: null,
      dormant: false,
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
    // ...and they go DORMANT independently too: the years-old cuff reading has stopped
    // arriving, yesterday's stream has not. A per-family verdict would flatten these.
    expect(model.bp?.dormant).toBe(true);
    expect(model.restingHr?.dormant).toBe(false);
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

  it("marks a year-quiet row dormant and a merely-stale one not", () => {
    const stale = vitalsLatestModel(
      trend(ago(VITAL_DORMANCY_DAYS), 122),
      trend(ago(VITAL_DORMANCY_DAYS), 78),
      trend(ago(VITAL_DORMANCY_DAYS), 61),
      TODAY
    )!;
    expect(stale.bp?.dormant).toBe(false);
    expect(stale.restingHr?.dormant).toBe(false);
    // Both are long past their presentation floors here — dormancy is a SECOND verdict
    // over the same date, not a rename of this one.
    expect(stale.bp?.freshness).toBe("due");
    expect(stale.restingHr?.freshness).toBe("due");

    const quiet = vitalsLatestModel(
      trend(ago(VITAL_DORMANCY_DAYS + 1), 122),
      trend(ago(VITAL_DORMANCY_DAYS + 1), 78),
      trend(ago(VITAL_DORMANCY_DAYS + 1), 61),
      TODAY
    )!;
    expect(quiet.bp?.dormant).toBe(true);
    expect(quiet.restingHr?.dormant).toBe(true);
  });

  it("is null only when NEITHER quantity has a reading", () => {
    expect(vitalsLatestModel(null, null, null, TODAY)).toBeNull();
    expect(
      vitalsLatestModel(null, null, trend(ago(1), 61), TODAY)
    ).not.toBeNull();
  });
});

describe("vitalDormant", () => {
  it("is the boundary the registry declares — AT the interval is awake, one day past is dormant", () => {
    for (const quantity of ["blood-pressure", "resting-hr"] as const) {
      expect(vitalDormant(quantity, ago(VITAL_DORMANCY_DAYS), TODAY)).toBe(
        false
      );
      expect(vitalDormant(quantity, ago(VITAL_DORMANCY_DAYS + 1), TODAY)).toBe(
        true
      );
    }
  });

  it("never fires on a reading whose age is unknowable", () => {
    // `absent` is not `dormant`: with no readable date there is no gap to report, and
    // the row must not claim one.
    expect(vitalDormant("blood-pressure", null, TODAY)).toBe(false);
    expect(vitalDormant("blood-pressure", "not-a-date", TODAY)).toBe(false);
    expect(vitalDormant("blood-pressure", ago(1600), null)).toBe(false);
  });

  it("never fires on a future-dated reading", () => {
    expect(vitalDormant("blood-pressure", shiftDateStr(TODAY, 30), TODAY)).toBe(
      false
    );
  });
});

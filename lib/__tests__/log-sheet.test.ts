import { describe, expect, it } from "vitest";
import {
  defaultLogSegment,
  habitualLogSegment,
  logSheetSegments,
  openingLogSegment,
  LOG_HABIT_MIN_DAYS,
  LOG_HABIT_WINDOW_DAYS,
  LOG_SEGMENT_CENSUS,
  type SegmentLogDays,
} from "@/lib/log-sheet";
import { QUICK_LOG_IDS, quickLogMenu } from "@/lib/quick-log";

// The "Everything else" section is a VIEW over the quick-log registry, not a
// second membership list. These tests pin exactly that: nothing is added,
// nothing is dropped, and both existing gates still decide.

describe("LOG_SEGMENT_CENSUS", () => {
  it("assigns every quick-log id to a segment", () => {
    for (const id of QUICK_LOG_IDS) {
      expect(LOG_SEGMENT_CENSUS[id]).toBeTruthy();
    }
  });
});

describe("logSheetSegments", () => {
  it("carries exactly the entries quickLogMenu carries, once each", () => {
    for (const [restricted, cycle] of [
      [false, true],
      [false, false],
      [true, true],
      [true, false],
    ] as const) {
      const flat = quickLogMenu(restricted, cycle).map((i) => i.id);
      const grouped = logSheetSegments(restricted, cycle).flatMap((s) =>
        s.items.map((i) => i.id)
      );
      expect([...grouped].sort()).toEqual([...flat].sort());
      expect(new Set(grouped).size).toBe(grouped.length);
    }
  });

  it("drops a segment with no surviving entry rather than disabling it", () => {
    // Training is the whole of the `train` segment, and an age-restricted profile
    // has no training surface at all.
    expect(logSheetSegments(false, true).map((s) => s.id)).toContain("train");
    expect(logSheetSegments(true, true).map((s) => s.id)).not.toContain(
      "train"
    );
    for (const segment of logSheetSegments(true, false)) {
      expect(segment.items.length).toBeGreaterThan(0);
    }
  });

  it("keeps the Body segment when the cycle bit is off", () => {
    // The period entry is cycle-gated; measurements is not, so the segment
    // survives with one fewer row.
    const body = logSheetSegments(false, false).find((s) => s.id === "body");
    expect(body?.items.map((i) => i.id)).toEqual(["log-measurements"]);
  });

  it("orders the track Train · Food · Body · Care", () => {
    expect(logSheetSegments(false, true).map((s) => s.id)).toEqual([
      "train",
      "food",
      "body",
      "care",
    ]);
  });
});

describe("defaultLogSegment", () => {
  const all = logSheetSegments(false, true);

  it("opens on the segment holding the route's promoted log", () => {
    expect(defaultLogSegment(all, "/nutrition", null)).toBe("food");
    expect(defaultLogSegment(all, "/medications", null)).toBe("care");
    // /trends' default tab promotes measurements, which lives in Body.
    expect(defaultLogSegment(all, "/trends", null)).toBe("body");
  });

  it("falls back to Train, the activity fallback's segment, on an opinionless route", () => {
    expect(defaultLogSegment(all, "/settings", null)).toBe("train");
  });

  it("never names a segment that is not on the track", () => {
    const restricted = logSheetSegments(true, true);
    // The route promotes Log activity, whose segment was dropped for this
    // profile — so the answer must be a surviving segment, not `train`.
    const chosen = defaultLogSegment(restricted, "/settings", null);
    expect(restricted.map((s) => s.id)).toContain(chosen);
    expect(chosen).not.toBe("train");
  });
});

// ── The dashboard's most-logged default (#2709) ──────────────────────────────
//
// The owner's ruling accepted a cost — predictability — so these tests are mostly
// about how LITTLE the answer moves. The churn claim in the module header ("a lead
// of two or more logged days survives any single day") is asserted here rather
// than asserted in prose, which is the whole reason the decision is a pure
// function.

describe("habitualLogSegment", () => {
  const all = logSheetSegments(false, true);

  it("names the segment with the most logged days", () => {
    expect(
      habitualLogSegment(all, { train: 9, food: 40, body: 12, care: 30 })
    ).toBe("food");
  });

  it("stays silent below the evidence floor, however lopsided", () => {
    // Six food days out of ninety is not a habit, and a profile with no history
    // at all is the same answer — which is the ruling's required fallback.
    const thin = LOG_HABIT_MIN_DAYS - 1;
    expect(habitualLogSegment(all, { food: thin })).toBeNull();
    expect(habitualLogSegment(all, {})).toBeNull();
    expect(habitualLogSegment(all, { food: LOG_HABIT_MIN_DAYS })).toBe("food");
  });

  it("never names a segment this profile's track does not carry", () => {
    // A restricted profile has no Train segment. Activity days recorded before
    // the gate applied must not select a segment the sheet does not render.
    const restricted = logSheetSegments(true, true);
    const chosen = habitualLogSegment(restricted, { train: 80, care: 20 });
    expect(chosen).toBe("care");
  });

  it("breaks an exact tie by track order, deterministically", () => {
    const days = { train: 20, food: 20, body: 20, care: 20 };
    expect(habitualLogSegment(all, days)).toBe("train");
    expect(habitualLogSegment(all, days)).toBe("train");
  });

  it("holds a two-day lead against anything one calendar day can do", () => {
    // The churn bound. A day adds at most one logged day to a segment and drops
    // at most one off the far end of the window, so a leader two days clear
    // cannot be overtaken between two visits.
    const before: SegmentLogDays = { food: 30, care: 28 };
    const leader = habitualLogSegment(all, before);
    // Every reachable next-day state: care gains a day, food loses its oldest,
    // and both at once.
    for (const after of [
      { food: 30, care: 29 },
      { food: 29, care: 28 },
      { food: 29, care: 29 },
    ]) {
      expect(habitualLogSegment(all, after)).toBe(leader);
    }
  });

  it("reads a whole quarter, so one busy week cannot be most of the evidence", () => {
    expect(LOG_HABIT_WINDOW_DAYS).toBe(90);
    expect(LOG_HABIT_MIN_DAYS).toBeLessThan(LOG_HABIT_WINDOW_DAYS);
  });
});

describe("openingLogSegment", () => {
  const all = logSheetSegments(false, true);
  const heavyCare: SegmentLogDays = { train: 5, food: 10, body: 4, care: 60 };

  it("opens the dashboard on the profile's most-logged segment", () => {
    expect(
      openingLogSegment({ segments: all, pathname: "/", habitDays: heavyCare })
    ).toBe("care");
  });

  it("leaves every route that promotes its own domain alone", () => {
    // The ruling's scope in one assertion: Nutrition still opens on Food and
    // Medications on Care no matter what the history says.
    expect(
      openingLogSegment({
        segments: all,
        pathname: "/nutrition",
        habitDays: heavyCare,
      })
    ).toBe("food");
    expect(
      openingLogSegment({
        segments: all,
        pathname: "/trends",
        habitDays: heavyCare,
      })
    ).toBe("body");
    // …and a long-tail route keeps the historical activity fallback rather than
    // quietly inheriting the dashboard's rule.
    expect(
      openingLogSegment({
        segments: all,
        pathname: "/settings",
        habitDays: heavyCare,
      })
    ).toBe("train");
  });

  it("falls back to the route default when history is absent or thin", () => {
    expect(openingLogSegment({ segments: all, pathname: "/" })).toBe("train");
    expect(
      openingLogSegment({ segments: all, pathname: "/", habitDays: null })
    ).toBe("train");
    expect(
      openingLogSegment({
        segments: all,
        pathname: "/",
        habitDays: { food: LOG_HABIT_MIN_DAYS - 1 },
      })
    ).toBe("train");
  });

  it("only ever answers with a segment on the track", () => {
    const restricted = logSheetSegments(true, false);
    for (const pathname of ["/", "/nutrition", "/settings", "/trends"]) {
      const chosen = openingLogSegment({
        segments: restricted,
        pathname,
        habitDays: { train: 90, body: 30 },
      });
      expect(restricted.map((s) => s.id)).toContain(chosen);
    }
  });
});

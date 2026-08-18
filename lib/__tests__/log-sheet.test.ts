import { describe, expect, it } from "vitest";
import {
  defaultLogSegment,
  dueDoseChipLabel,
  habitualLogSegment,
  logSheetSegments,
  openingLogSegment,
  LOG_HABIT_MIN_DAYS,
  LOG_HABIT_WINDOW_DAYS,
  type SegmentLogDays,
} from "@/lib/log-sheet";
import { quickLogMenu } from "@/lib/quick-log";

// The "Everything else" section is a VIEW over the quick-log registry, not a
// second membership list. These tests pin exactly that: nothing is added,
// nothing is dropped, and the cycle-relevance gate still decides.

describe("dueDoseChipLabel", () => {
  it("names the due doses and compacts overflow", () => {
    expect(dueDoseChipLabel({ count: 1, names: ["Creatine"] })).toBe(
      "Due: Creatine"
    );
    expect(
      dueDoseChipLabel({
        count: 3,
        names: ["Creatine", "Vitamin D", "Magnesium"],
      })
    ).toBe("Due: Creatine, Vitamin D +1");
  });

  it("keeps the count label as the missing-title fallback", () => {
    expect(dueDoseChipLabel({ count: 0, names: [] })).toBeNull();
    expect(dueDoseChipLabel({ count: 2, names: ["", " "] })).toBe(
      "2 doses due"
    );
  });
});

describe("logSheetSegments", () => {
  it("carries exactly the entries quickLogMenu carries, once each", () => {
    for (const cycle of [true, false]) {
      const flat = quickLogMenu(cycle).map((i) => i.id);
      const grouped = logSheetSegments(cycle).flatMap((s) =>
        s.items.map((i) => i.id)
      );
      expect([...grouped].sort()).toEqual([...flat].sort());
      expect(new Set(grouped).size).toBe(grouped.length);
    }
  });

  it("keeps the Body segment when the cycle bit is off", () => {
    // The period entry is cycle-gated; measurements is not, so the segment
    // survives with one fewer row.
    const body = logSheetSegments(false).find((s) => s.id === "body");
    expect(body?.items.map((i) => i.id)).toEqual(["log-measurements"]);
  });

  it("orders the track Train · Food · Body · Care", () => {
    expect(logSheetSegments(true).map((s) => s.id)).toEqual([
      "train",
      "food",
      "body",
      "care",
    ]);
  });
});

describe("defaultLogSegment", () => {
  const all = logSheetSegments(true);

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
    const segments = logSheetSegments(false);
    const chosen = defaultLogSegment(segments, "/settings", null);
    expect(segments.map((s) => s.id)).toContain(chosen);
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
  const all = logSheetSegments(true);

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

  it("can select Train from age-neutral activity history", () => {
    const segments = logSheetSegments(true);
    expect(habitualLogSegment(segments, { train: 80, care: 20 })).toBe("train");
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
  const all = logSheetSegments(true);
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
    const restricted = logSheetSegments(false);
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

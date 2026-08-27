import { describe, it, expect } from "vitest";
import {
  summarizeStepsToday,
  STEPS_DELTA_COMPLETE_HOUR,
  STEPS_TRAILING_DAYS,
} from "@/lib/steps-today";
import { hourInTz, zonedWallTimeToUtc } from "@/lib/date";
import { trailingAverage } from "@/lib/trailing-average";

// Pure-tier: the Steps-today dashboard aggregation (#1221). No DB/clock — the gather
// hands the deduped one-source-per-day series here.
//
// The BASELINE is not this module's arithmetic (#1909): it is trailingAverage's
// data-bearing window with today excluded, and these tests state their expectations
// through that helper rather than re-deriving a mean — a second mean in the test is
// how a second mean in the source stays green. The helper's own option matrix and
// the cross-surface pin live in lib/__tests__/trailing-average.test.ts.

const TODAY = "2026-07-23";
// The hour every pre-#3258 case is evaluated at: late enough that the delta exists, so
// those cases keep testing the arithmetic they were written for rather than the new
// silence. The gate itself is pinned separately below.
const EVENING = STEPS_DELTA_COMPLETE_HOUR;

describe("summarizeStepsToday", () => {
  it("returns null for an empty series (the data-aware empty state)", () => {
    expect(summarizeStepsToday([], TODAY, EVENING)).toBeNull();
  });

  it("reports today's steps and the prior-7-day baseline with an up arrow", () => {
    const points = [
      { date: "2026-07-16", value: 6000 },
      { date: "2026-07-17", value: 7000 },
      { date: "2026-07-18", value: 8000 },
      { date: "2026-07-22", value: 5000 },
      { date: TODAY, value: 10000 },
    ];
    const s = summarizeStepsToday(points, TODAY, EVENING)!;
    expect(s.today).toBe(10000);
    // Average over the 4 prior data days: (6000+7000+8000+5000)/4 = 6500.
    expect(s.average7).toBe(6500);
    expect(s.direction).toBe("up");
    expect(s.deltaPct).toBe(Math.round(((10000 - 6500) / 6500) * 100));
  });

  it("caps the baseline to the most recent N data days before today", () => {
    // 9 prior days all before today; only the newest STEPS_TRAILING_DAYS count.
    const prior = Array.from({ length: 9 }, (_, i) => ({
      date: `2026-07-${String(10 + i).padStart(2, "0")}`,
      value: (i + 1) * 1000, // 1000..9000, oldest→newest
    }));
    const points = [...prior, { date: TODAY, value: 500 }];
    const s = summarizeStepsToday(points, TODAY, EVENING)!;
    // The 7 most-recent prior days are 3000..9000 → mean 6000, which is what the
    // shared data-bearing window selects — no second arithmetic here.
    const window = trailingAverage(points, TODAY, {
      days: STEPS_TRAILING_DAYS,
      basis: "data-bearing",
    });
    expect(window.from).toBe("2026-07-12");
    expect(window.to).toBe("2026-07-18");
    expect(s.average7).toBe(6000);
    expect(s.average7).toBe(Math.round(window.average!));
    expect(s.direction).toBe("down"); // 500 < 6000
  });

  it("handles history with no reading today (today null, average present)", () => {
    const s = summarizeStepsToday(
      [
        { date: "2026-07-21", value: 8000 },
        { date: "2026-07-22", value: 9000 },
      ],
      TODAY,
      EVENING
    )!;
    expect(s.today).toBeNull();
    expect(s.average7).toBe(8500);
    expect(s.direction).toBeNull();
    expect(s.deltaPct).toBeNull();
  });

  it("marks a flat day when today equals the trailing average", () => {
    const s = summarizeStepsToday(
      [
        { date: "2026-07-22", value: 7000 },
        { date: TODAY, value: 7000 },
      ],
      TODAY,
      EVENING
    )!;
    expect(s.direction).toBe("flat");
    expect(s.deltaPct).toBe(0);
  });
});

describe("the partial-day delta waits for a day it can compare (#3258)", () => {
  // Today's running total against SEVEN COMPLETE DAYS is a clock reading, not a
  // behaviour reading: it opens every morning at −100% and climbs until bedtime. The
  // owner's own two screenshots of ONE unchanged day read −73% at midday and −47% that
  // evening. So the delta is withheld until the day is materially complete, and the
  // neutral prior-7-day average carries the row until then.
  //
  // The hour is PROFILE-LOCAL, so each case freezes an instant with zonedWallTimeToUtc
  // on a pinned zone and reads it back through the SAME hourInTz the dashboard calls —
  // never a naive "YYYY-MM-DDTHH:MM" string, which parses host-UTC and would prove only
  // the zone this run's own clock happened to draw (#1417/#3878).
  const PRIOR = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-07-${String(16 + i).padStart(2, "0")}`,
    value: 8000,
  }));
  const POINTS = [...PRIOR, { date: TODAY, value: 2000 }];
  // 2,000 steps against an 8,000-step average: the −75% a morning would have printed.
  const MORNING_ARTIFACT = -75;

  // Both extremes of the UTC offset range, a half-hour zone, and a DST-observing one:
  // the verdict must depend on the profile's wall clock and on nothing else.
  const ZONES = [
    "Etc/GMT+10",
    "America/Los_Angeles",
    "UTC",
    "Asia/Kolkata",
    "Etc/GMT-13",
  ];

  it.each([
    ["10:00", null, null],
    ["20:00", MORNING_ARTIFACT, "down"],
  ] as const)(
    "at %s profile-local the delta is %s in every zone",
    (wall, deltaPct, direction) => {
      for (const zone of ZONES) {
        const frozen = zonedWallTimeToUtc(zone, TODAY, wall)!;
        const s = summarizeStepsToday(POINTS, TODAY, hourInTz(zone, frozen))!;
        const where = `${zone} @ ${wall}`;
        expect(s.deltaPct, where).toBe(deltaPct);
        expect(s.direction, where).toBe(direction);
        // Silence is over the DELTA only — the neutral lines the row shows at every
        // hour are untouched, so 10:00 loses a false number and no information.
        expect(s.today, where).toBe(2000);
        expect(s.average7, where).toBe(8000);
      }
    }
  );

  it("a caller with no clock gets no delta rather than a defaulted one", () => {
    const s = summarizeStepsToday(POINTS, TODAY, null)!;
    expect(s.deltaPct).toBeNull();
    expect(s.average7).toBe(8000);
  });
});

import { describe, expect, it } from "vitest";
import type { CardioPR, PR } from "@/lib/coaching";
import {
  FITNESS_SECTIONS,
  MAX_FITNESS_WEEKS,
  MIN_FITNESS_WEEKS,
  WINDOW_PR_LIMIT,
  fitnessWindow,
  fitnessWindowWeeks,
  prWeeks,
  selectWindowPRs,
  strengthMovers,
  weekStartsThrough,
  windowPrDays,
} from "@/lib/trends-fitness";

// #1492: Trends → Fitness became the WINDOWED analytics lens. These pin the pure
// decisions windowing needs — the window itself, how many week columns it is
// worth, and which records lead the compact "PRs this window" block. The PR
// DETECTION stays in lib/coaching (this module never re-detects), so what's
// asserted here is merging, ranking and the top-3 cut.

const TODAY = "2026-07-25";

function pr(over: Partial<PR> = {}): PR {
  return {
    exercise: "Back Squat",
    equipmentId: null,
    equipment: null,
    kind: "1rm",
    date: TODAY,
    e1rmKg: 150,
    weightKg: 130,
    reps: 5,
    bodyweight: false,
    ...over,
  };
}

function cpr(over: Partial<CardioPR> = {}): CardioPR {
  return {
    activity: "Running",
    kind: "distance",
    date: TODAY,
    distanceKm: 12,
    durationMin: 0,
    speedKmh: 0,
    ...over,
  };
}

describe("FITNESS_SECTIONS", () => {
  it("is the four PINNED sections, in render order", () => {
    expect(FITNESS_SECTIONS.map((s) => s.id)).toEqual([
      "volume",
      "zones",
      "strength",
      "sport",
    ]);
    expect(FITNESS_SECTIONS.map((s) => s.label)).toEqual([
      "Volume & cadence",
      "Zones & cardio",
      "Strength progression",
      "Sport",
    ]);
  });
});

describe("fitnessWindow", () => {
  it("resolves the hub's default 90D window to a closed [from, to] of 90 days", () => {
    const w = fitnessWindow({ from: "2026-04-27", to: TODAY }, TODAY);
    expect(w).toEqual({
      from: "2026-04-27",
      to: TODAY,
      days: 90,
      allTime: false,
    });
  });

  it("treats an empty range as all time, ending today", () => {
    expect(fitnessWindow({}, TODAY)).toEqual({
      from: null,
      to: TODAY,
      days: null,
      allTime: true,
    });
  });

  it("runs an open END to today, and leaves an open START open", () => {
    expect(fitnessWindow({ from: "2026-07-01" }, TODAY)).toMatchObject({
      from: "2026-07-01",
      to: TODAY,
      days: 25,
      allTime: false,
    });
    // `to` alone is a bounded END with no start — everything up to that day.
    expect(fitnessWindow({ to: "2026-06-30" }, TODAY)).toMatchObject({
      from: null,
      to: "2026-06-30",
      days: null,
      allTime: false,
    });
  });

  it("counts a single-day window as one day, not zero", () => {
    expect(fitnessWindow({ from: TODAY, to: TODAY }, TODAY).days).toBe(1);
  });
});

describe("fitnessWindowWeeks", () => {
  it("gives the 90D default ~13 week columns, not a year", () => {
    expect(fitnessWindowWeeks(90)).toBe(13);
  });

  it("caps all time at 12 months of columns", () => {
    expect(fitnessWindowWeeks(null)).toBe(MAX_FITNESS_WEEKS);
    // A window LONGER than the cap still caps (the heatmap never grows unbounded).
    expect(fitnessWindowWeeks(5 * 365)).toBe(MAX_FITNESS_WEEKS);
  });

  it("floors a very short window so the weekly charts still read", () => {
    expect(fitnessWindowWeeks(1)).toBe(MIN_FITNESS_WEEKS);
    expect(fitnessWindowWeeks(7)).toBe(MIN_FITNESS_WEEKS);
  });

  it("rounds a partial week UP so the window's edge day has a column", () => {
    expect(fitnessWindowWeeks(30)).toBe(5); // 4.28 weeks
    expect(fitnessWindowWeeks(35)).toBe(5);
    expect(fitnessWindowWeeks(36)).toBe(6);
  });
});

describe("windowPrDays", () => {
  it("is the window's length, so a PR engine's `withinDays` IS the window", () => {
    expect(
      windowPrDays(fitnessWindow({ from: "2026-04-27", to: TODAY }, TODAY))
    ).toBe(90);
  });

  it("reaches past any storable record for an all-time window", () => {
    expect(windowPrDays(fitnessWindow({}, TODAY))).toBeGreaterThan(100 * 300);
  });
});

describe("selectWindowPRs", () => {
  it("merges both disciplines newest-first and takes the top three", () => {
    const { items, total } = selectWindowPRs(
      [
        pr({ exercise: "Back Squat", date: "2026-07-10" }),
        pr({ exercise: "Deadlift", date: "2026-07-20" }),
      ],
      [
        cpr({ activity: "Running", date: "2026-07-24" }),
        cpr({ activity: "Cycling", date: "2026-07-01", kind: "duration" }),
      ]
    );
    expect(total).toBe(4);
    expect(items).toHaveLength(WINDOW_PR_LIMIT);
    expect(items.map((i) => [i.source, i.date])).toEqual([
      ["cardio", "2026-07-24"],
      ["strength", "2026-07-20"],
      ["strength", "2026-07-10"],
    ]);
  });

  it("reports the FULL count so the block can offer 'show all'", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      pr({ exercise: `Lift ${i}`, date: `2026-07-0${i + 1}` })
    );
    const { items, total } = selectWindowPRs(many, []);
    expect(items).toHaveLength(3);
    expect(total).toBe(9);
  });

  it("breaks a same-date tie deterministically (strength, then name, then kind)", () => {
    const a = selectWindowPRs(
      [
        pr({ exercise: "Overhead Press", kind: "weight" }),
        pr({ exercise: "Bench Press", kind: "1rm" }),
      ],
      [cpr({ activity: "Running" })],
      5
    );
    const b = selectWindowPRs(
      [
        pr({ exercise: "Bench Press", kind: "1rm" }),
        pr({ exercise: "Overhead Press", kind: "weight" }),
      ],
      [cpr({ activity: "Running" })],
      5
    );
    const names = (r: ReturnType<typeof selectWindowPRs>) =>
      r.items.map((i) =>
        i.source === "strength" ? i.pr.exercise : i.pr.activity
      );
    expect(names(a)).toEqual(["Bench Press", "Overhead Press", "Running"]);
    // Input order can't move a row a user just read.
    expect(names(b)).toEqual(names(a));
  });

  it("handles an empty window and a zero limit without throwing", () => {
    expect(selectWindowPRs([], [])).toEqual({ items: [], total: 0 });
    expect(selectWindowPRs([pr()], [], 0)).toMatchObject({
      items: [],
      total: 1,
    });
  });
});

describe("prWeeks", () => {
  it("counts records into their week and zero-fills the barren ones", () => {
    const weeks = ["2026-06-28", "2026-07-05", "2026-07-12", "2026-07-19"];
    const { items } = selectWindowPRs(
      [
        pr({ date: "2026-06-30" }),
        pr({ date: "2026-07-02", exercise: "Deadlift" }),
        pr({ date: "2026-07-20", exercise: "Bench Press" }),
      ],
      [],
      99
    );
    expect(prWeeks(items, weeks)).toEqual([
      { week: "2026-06-28", count: 2 },
      { week: "2026-07-05", count: 0 },
      { week: "2026-07-12", count: 0 },
      { week: "2026-07-19", count: 1 },
    ]);
  });

  it("drops a record that falls before the first charted week", () => {
    const { items } = selectWindowPRs([pr({ date: "2026-01-01" })], [], 99);
    expect(prWeeks(items, ["2026-07-19"])).toEqual([
      { week: "2026-07-19", count: 0 },
    ]);
  });

  it("counts a record on or after the LAST week's start (the open final bucket)", () => {
    const { items } = selectWindowPRs([pr({ date: "2026-07-25" })], [], 99);
    expect(prWeeks(items, ["2026-07-12", "2026-07-19"])).toEqual([
      { week: "2026-07-12", count: 0 },
      { week: "2026-07-19", count: 1 },
    ]);
  });
});

describe("weekStartsThrough", () => {
  it("enumerates week starts inclusive of the window's end", () => {
    expect(weekStartsThrough("2026-07-05", "2026-07-25")).toEqual([
      "2026-07-05",
      "2026-07-12",
      "2026-07-19",
    ]);
  });

  it("returns the single week when the window is inside one", () => {
    expect(weekStartsThrough("2026-07-19", "2026-07-21")).toEqual([
      "2026-07-19",
    ]);
  });

  it("returns nothing when the first week starts after the end", () => {
    expect(weekStartsThrough("2026-08-02", "2026-07-25")).toEqual([]);
  });
});

describe("strengthMovers", () => {
  const series = (exercise: string, values: number[]) => ({
    exercise,
    points: values.map((value, i) => ({
      date: `2026-07-0${i + 1}`,
      value,
    })),
  });

  it("ranks by the SIZE of the windowed move, up or down", () => {
    expect(
      strengthMovers([
        series("Back Squat", [100, 105]),
        series("Deadlift", [180, 160]),
        series("Bench Press", [80, 82]),
      ])
    ).toEqual([
      {
        exercise: "Deadlift",
        first: 180,
        last: 160,
        deltaKg: -20,
        points: 2,
      },
      { exercise: "Back Squat", first: 100, last: 105, deltaKg: 5, points: 2 },
      { exercise: "Bench Press", first: 80, last: 82, deltaKg: 2, points: 2 },
    ]);
  });

  it("ignores a lift with a single windowed session (a point is not a trend)", () => {
    expect(strengthMovers([series("Back Squat", [200])])).toEqual([]);
  });

  it("compares the window's FIRST and LAST points, not its best", () => {
    const m = strengthMovers([series("Back Squat", [100, 140, 110])]);
    expect(m[0]).toMatchObject({ first: 100, last: 110, deltaKg: 10 });
  });

  it("caps the list", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      series(`Lift ${i}`, [100, 100 + i])
    );
    expect(strengthMovers(many)).toHaveLength(5);
    expect(strengthMovers(many, 2)).toHaveLength(2);
  });
});

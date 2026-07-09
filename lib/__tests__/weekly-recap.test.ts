import { describe, expect, it } from "vitest";
import {
  recapWindow,
  inWindow,
  weightTrendKg,
  buildWeeklyRecap,
  renderRecapMessage,
  medianWeeklyWorkouts,
  type RecapInput,
} from "@/lib/weekly-recap";

const TODAY = "2026-07-09"; // a Thursday

// A fully-populated baseline input; individual tests override the fields they
// exercise.
function baseInput(over: Partial<RecapInput> = {}): RecapInput {
  return {
    today: TODAY,
    weightUnit: "kg",
    workouts: [],
    prevWorkouts: [],
    volumeKg: 0,
    prevVolumeKg: 0,
    prLabels: [],
    adherence: null,
    weights: [],
    streak: 0,
    strictStreak: 0,
    goalsCompleted: [],
    ...over,
  };
}

describe("recapWindow", () => {
  it("is a trailing seven days ending on today, with a prior seven-day window", () => {
    expect(recapWindow(TODAY)).toEqual({
      start: "2026-07-03",
      end: "2026-07-09",
      prevStart: "2026-06-26",
      prevEnd: "2026-07-02",
    });
  });

  it("windows are contiguous and non-overlapping", () => {
    const w = recapWindow(TODAY);
    // prevEnd is the day immediately before start.
    expect(w.prevEnd < w.start).toBe(true);
    expect(inWindow(w.prevEnd, w.start, w.end)).toBe(false);
    expect(inWindow(w.start, w.start, w.end)).toBe(true);
    expect(inWindow(w.end, w.start, w.end)).toBe(true);
  });
});

describe("weightTrendKg", () => {
  it("returns null for fewer than two readings", () => {
    expect(weightTrendKg([])).toBeNull();
    expect(weightTrendKg([{ date: "2026-07-03", weightKg: 74 }])).toBeNull();
  });

  it("is a robust net change (median endpoints) resistant to one outlier", () => {
    // Steady 74 → 73 descent with a single spurious 99 spike that a raw
    // first/last diff would ignore but a mean would not; median endpoints ignore it.
    const w = [
      { date: "2026-07-03", weightKg: 74 },
      { date: "2026-07-04", weightKg: 73.8 },
      { date: "2026-07-05", weightKg: 99 }, // outlier
      { date: "2026-07-06", weightKg: 73.4 },
      { date: "2026-07-07", weightKg: 73.2 },
      { date: "2026-07-08", weightKg: 73.0 },
    ];
    const trend = weightTrendKg(w)!;
    expect(trend).toBeLessThan(0); // net loss despite the spike
    expect(trend).toBeGreaterThan(-2); // and not wildly distorted
  });
});

describe("buildWeeklyRecap", () => {
  it("summarizes workouts with a type breakdown and prior-week comparison", () => {
    const recap = buildWeeklyRecap(
      baseInput({
        workouts: [
          { date: "2026-07-04", type: "strength" },
          { date: "2026-07-06", type: "strength" },
          { date: "2026-07-08", type: "cardio" },
        ],
        prevWorkouts: [{ date: "2026-06-30", type: "strength" }],
      })
    );
    const line = recap.lines.find((l) => l.key === "workouts")!;
    expect(line.value).toBe("3 (strength 2, cardio 1)");
    expect(line.delta).toBe("1 last week");
    expect(recap.headline).toContain("3 workouts");
    expect(recap.isEmpty).toBe(false);
  });

  it("reports a volume delta versus the previous window", () => {
    const recap = buildWeeklyRecap(
      baseInput({ volumeKg: 11000, prevVolumeKg: 10000 })
    );
    const line = recap.lines.find((l) => l.key === "volume")!;
    expect(line.value).toBe("11,000 kg");
    expect(line.delta).toBe("+10%");
  });

  it("omits the volume delta when there was no prior volume", () => {
    const recap = buildWeeklyRecap(baseInput({ volumeKg: 5000 }));
    const line = recap.lines.find((l) => l.key === "volume")!;
    expect(line.delta).toBeUndefined();
  });

  it("lists PRs, truncating past three with a +N more", () => {
    const recap = buildWeeklyRecap(
      baseInput({
        prLabels: ["Bench press", "Squat", "Deadlift", "Overhead press"],
      })
    );
    const line = recap.lines.find((l) => l.key === "prs")!;
    expect(line.value).toBe("4");
    expect(line.delta).toBe("Bench press, Squat, Deadlift +1 more");
    expect(recap.headline).toContain("4 PRs");
  });

  it("computes adherence percentage from taken/due", () => {
    const recap = buildWeeklyRecap(
      baseInput({ adherence: { taken: 12, due: 14 } })
    );
    const line = recap.lines.find((l) => l.key === "adherence")!;
    expect(line.value).toBe("86%");
    expect(line.delta).toBe("12/14 doses");
  });

  it("shows the latest weight and a robust net change with a direction arrow", () => {
    const recap = buildWeeklyRecap(
      baseInput({
        weights: [
          { date: "2026-07-03", weightKg: 74 },
          { date: "2026-07-06", weightKg: 73.5 },
          { date: "2026-07-08", weightKg: 73 },
        ],
      })
    );
    const line = recap.lines.find((l) => l.key === "weight")!;
    expect(line.value).toBe("73 kg");
    expect(line.delta).toContain("−"); // net loss over the window
    expect(line.delta).toContain("kg");
  });

  it("reports streak status with the strict consecutive count as context", () => {
    const recap = buildWeeklyRecap(baseInput({ streak: 12, strictStreak: 4 }));
    const line = recap.lines.find((l) => l.key === "streak")!;
    expect(line.value).toBe("12 active days");
    expect(line.delta).toBe("4-day consecutive");
  });

  it("marks a week with no workouts, adherence, or weight as empty", () => {
    const recap = buildWeeklyRecap(baseInput());
    expect(recap.isEmpty).toBe(true);
    expect(recap.lines).toEqual([]);
  });

  it("is not empty when only a weigh-in was logged", () => {
    const recap = buildWeeklyRecap(
      baseInput({ weights: [{ date: "2026-07-08", weightKg: 73 }] })
    );
    expect(recap.isEmpty).toBe(false);
  });
});

describe("renderRecapMessage", () => {
  it("returns null for an empty recap (nothing worth interrupting for)", () => {
    const recap = buildWeeklyRecap(baseInput());
    expect(renderRecapMessage(recap, "Ada")).toBeNull();
  });

  it("renders a titled, profile-named, bulleted message", () => {
    const recap = buildWeeklyRecap(
      baseInput({
        workouts: [{ date: "2026-07-08", type: "strength" }],
        adherence: { taken: 7, due: 7 },
      })
    );
    const msg = renderRecapMessage(recap, "Ada")!;
    expect(msg.title).toBe("📊 Weekly recap — Ada");
    expect(msg.body).toContain("2026-07-03 – 2026-07-09");
    expect(msg.body).toContain("• Workouts: 1");
    expect(msg.body).toContain("• Adherence: 100%");
  });
});

describe("medianWeeklyWorkouts", () => {
  it("returns null for an empty list and the median otherwise", () => {
    expect(medianWeeklyWorkouts([])).toBeNull();
    expect(medianWeeklyWorkouts([2, 4, 3])).toBe(3);
  });
});

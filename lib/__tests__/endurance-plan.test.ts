import { describe, it, expect } from "vitest";
import {
  computeEnduranceTrajectory,
  detectLongSessionKm,
  disciplineForActivityName,
  peakLongSessionKm,
  taperWeeksForDistance,
  buildEndurancePlanCard,
  enduranceArmFor,
  enduranceLongSessionKey,
  MAX_WEEKLY_RAMP,
  RECOVERY_CADENCE_WEEKS,
  LONG_SESSION_FRACTION,
  type EndurancePlan,
} from "../endurance-plan";

// A comfortably-feasible half-marathon plan: 20 weeks out, decent base.
const FEASIBLE = {
  today: "2026-01-05", // a Monday
  eventDate: "2026-05-25", // ~20 weeks later
  discipline: "run" as const,
  targetDistanceKm: 21.1,
  currentWeeklyVolumeKm: 25,
  weekStart: 1,
};

describe("computeEnduranceTrajectory — ramp cap (#839)", () => {
  it("never grows weekly volume by more than ~10% week-over-week during the build", () => {
    const t = computeEnduranceTrajectory(FEASIBLE);
    const build = t.weeks.filter((w) => w.phase === "build");
    // Consecutive build weeks (recovery weeks reset the compare) respect the cap.
    for (let i = 1; i < build.length; i++) {
      if (build[i].index !== build[i - 1].index + 1) continue; // a recovery week sat between
      expect(build[i].targetVolumeKm).toBeLessThanOrEqual(
        build[i - 1].targetVolumeKm * (1 + MAX_WEEKLY_RAMP) + 0.11
      );
    }
  });

  it("week 0 steps up from the CURRENT actual volume, not a canned week 1", () => {
    const t = computeEnduranceTrajectory(FEASIBLE);
    // First build week is ~current × 1.1 (never a fixed starting mileage).
    expect(t.weeks[0].targetVolumeKm).toBeCloseTo(25 * 1.1, 0);
  });
});

describe("computeEnduranceTrajectory — recovery cadence (#839)", () => {
  it("inserts a cutback recovery week every 3–4 weeks", () => {
    const t = computeEnduranceTrajectory(FEASIBLE);
    const recovery = t.weeks.filter((w) => w.isRecoveryWeek);
    expect(recovery.length).toBeGreaterThan(0);
    // Every recovery week is at index (RECOVERY_CADENCE_WEEKS·n − 1).
    for (const w of recovery) {
      expect((w.index + 1) % RECOVERY_CADENCE_WEEKS).toBe(0);
    }
    // A recovery week's volume is BELOW the preceding build week (a cutback).
    const idx = recovery[0].index;
    expect(t.weeks[idx].targetVolumeKm).toBeLessThan(
      t.weeks[idx - 1].targetVolumeKm
    );
  });
});

describe("computeEnduranceTrajectory — taper flip (#839)", () => {
  it("flips to a distance-scaled taper before the event, stepping volume down", () => {
    const t = computeEnduranceTrajectory(FEASIBLE);
    const taper = t.weeks.filter((w) => w.isTaper && w.phase === "taper");
    // A half marathon (16 ≤ d < 32) tapers for 2 weeks.
    expect(taper.length).toBe(taperWeeksForDistance(21.1));
    expect(taperWeeksForDistance(21.1)).toBe(2);
    // Taper volume descends and is below the projected peak.
    for (const w of taper)
      expect(w.targetVolumeKm).toBeLessThan(t.projectedPeakVolumeKm);
    // The last week is the event itself.
    expect(t.weeks.at(-1)?.phase).toBe("event");
  });

  it("scales the taper window: 1 week for a 10k, 3 for a marathon", () => {
    expect(taperWeeksForDistance(10)).toBe(1);
    expect(taperWeeksForDistance(42.2)).toBe(3);
  });
});

describe("computeEnduranceTrajectory — infeasible-date honesty (#839)", () => {
  it("marks an event too soon INFEASIBLE, still returns the SAFE trajectory, and says where it lands", () => {
    const t = computeEnduranceTrajectory({
      today: "2026-01-05",
      eventDate: "2026-03-02", // ~8 weeks
      discipline: "run",
      targetDistanceKm: 42.2, // marathon from 15 km/week in 8 weeks — impossible safely
      currentWeeklyVolumeKm: 15,
      weekStart: 1,
    });
    expect(t.feasible).toBe(false);
    // Never fabricates an unsafe ramp: the safe trajectory peaks well short of the
    // marathon-implied ~80 km/week.
    expect(t.projectedPeakVolumeKm).toBeLessThan(t.neededPeakVolumeKm);
    // Still honestly reports where it lands + suggests a later date / shorter distance.
    expect(t.message).toMatch(/short for/i);
    expect(t.message).toMatch(/later date|shorter distance/i);
    // And it still respects the 10% cap between consecutive build weeks.
    const build = t.weeks.filter((w) => w.phase === "build");
    for (let i = 1; i < build.length; i++) {
      if (build[i].index !== build[i - 1].index + 1) continue;
      expect(build[i].targetVolumeKm).toBeLessThanOrEqual(
        build[i - 1].targetVolumeKm * (1 + MAX_WEEKLY_RAMP) + 0.11
      );
    }
  });

  it("a generous timeline for the same goal IS feasible", () => {
    const t = computeEnduranceTrajectory({
      today: "2026-01-05",
      eventDate: "2026-12-07", // ~48 weeks
      discipline: "run",
      targetDistanceKm: 42.2,
      currentWeeklyVolumeKm: 30,
      weekStart: 1,
    });
    expect(t.feasible).toBe(true);
  });

  it("a zero-volume base is never feasible (nothing to ramp from)", () => {
    const t = computeEnduranceTrajectory({
      ...FEASIBLE,
      currentWeeklyVolumeKm: 0,
    });
    expect(t.feasible).toBe(false);
  });
});

describe("computeEnduranceTrajectory — recompute-from-actuals (#839)", () => {
  it("projects from the current actual volume, so a missed (lower) week yields lower targets", () => {
    const high = computeEnduranceTrajectory({
      ...FEASIBLE,
      currentWeeklyVolumeKm: 40,
    });
    const low = computeEnduranceTrajectory({
      ...FEASIBLE,
      currentWeeklyVolumeKm: 20,
    });
    // Same plan, lower current volume → this-week target is lower (no debt make-up).
    expect(low.weeks[0].targetVolumeKm).toBeLessThan(high.weeks[0].targetVolumeKm);
  });

  it("the long session stays a bounded fraction of the week's volume", () => {
    const t = computeEnduranceTrajectory(FEASIBLE);
    for (const w of t.weeks) {
      if (w.phase === "event") continue;
      expect(w.longSessionKm).toBeLessThanOrEqual(
        w.targetVolumeKm * LONG_SESSION_FRACTION + 0.11
      );
    }
    // And it grows toward the distance-appropriate peak (a half → up to race distance).
    expect(peakLongSessionKm("run", 21.1)).toBe(21.1);
    expect(peakLongSessionKm("run", 42.2)).toBe(32); // marathon long-run cap
  });
});

describe("detectLongSessionKm — Strava label else longest-of-week (#839)", () => {
  it("prefers a Strava 'long run'/'race' labeled session over the raw longest", () => {
    const km = detectLongSessionKm([
      { distanceKm: 14, workoutType: null }, // the raw longest
      { distanceKm: 12, workoutType: "long run" }, // but the labeled one wins
      { distanceKm: 5, workoutType: null },
    ]);
    expect(km).toBe(12);
  });

  it("falls back to the longest-distance session when nothing is labeled", () => {
    const km = detectLongSessionKm([
      { distanceKm: 8, workoutType: null },
      { distanceKm: 15, workoutType: null },
      { distanceKm: 6, workoutType: "workout" }, // not a long-run/race label
    ]);
    expect(km).toBe(15);
  });

  it("returns 0 for an empty week", () => {
    expect(detectLongSessionKm([])).toBe(0);
  });
});

describe("disciplineForActivityName (#839)", () => {
  it("maps names onto run/ride/swim and returns null for non-distance cardio", () => {
    expect(disciplineForActivityName("Running")).toBe("run");
    expect(disciplineForActivityName("Trail run")).toBe("run");
    expect(disciplineForActivityName("Cycling")).toBe("ride");
    expect(disciplineForActivityName("Bike ride")).toBe("ride");
    expect(disciplineForActivityName("Open water swim")).toBe("swim");
    // "ride" is a whole word — "stride" doesn't classify as a ride.
    expect(disciplineForActivityName("Stride drills")).not.toBe("ride");
    expect(disciplineForActivityName("HIIT")).toBeNull();
    expect(disciplineForActivityName("Elliptical")).toBeNull();
  });
});

describe("buildEndurancePlanCard + enduranceArmFor (#839)", () => {
  const plan: EndurancePlan = {
    id: 7,
    eventName: "City Half",
    discipline: "run",
    eventDate: "2026-05-25",
    targetDistanceKm: 21.1,
    targetTimeSec: null,
    status: "active",
    notes: null,
    completedOn: null,
  };

  it("marks the long session done when the actual longest meets this week's target", () => {
    const trajectory = computeEnduranceTrajectory(FEASIBLE);
    const target = trajectory.weeks[0].longSessionKm;
    const card = buildEndurancePlanCard({
      plan,
      trajectory,
      actualVolumeKm: 20,
      actualLongSessionKm: target, // exactly met
      sessionsThisWeek: 3,
    });
    expect(card.longSessionDone).toBe(true);
    // The arm note reads as calm progress and is keyed to the discipline.
    const arm = enduranceArmFor(card);
    expect(arm.discipline).toBe("run");
    expect(arm.longSessionDue).toBe(false);
    expect(arm.note).toMatch(/City Half/);
  });

  it("surfaces the long session as DUE when it isn't logged yet", () => {
    const trajectory = computeEnduranceTrajectory(FEASIBLE);
    const card = buildEndurancePlanCard({
      plan,
      trajectory,
      actualVolumeKm: 5,
      actualLongSessionKm: 3,
      sessionsThisWeek: 1,
    });
    expect(card.longSessionDone).toBe(false);
    expect(enduranceArmFor(card).longSessionDue).toBe(true);
    expect(card.remainingKm).toBeGreaterThan(0);
  });

  it("keys the long-session finding on the discipline", () => {
    expect(enduranceLongSessionKey("run")).toBe("endurance:long-session:run");
    expect(enduranceLongSessionKey("ride")).toBe("endurance:long-session:ride");
  });
});

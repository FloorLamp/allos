import { describe, it, expect } from "vitest";
import {
  patternSetCounts,
  detectPushPullImbalance,
  detectStaleExercises,
  isPlateau,
  detectPlateaus,
  trainingBalanceSignalKey,
  trainingBalanceLegacyKey,
  staleExerciseSignalKey,
  plateauSignalKey,
  TRAINING_OBS_PREFIX,
  MIN_PUSH_PULL_SETS,
  type ExerciseSetCount,
} from "../training-observations";
import type { DatedPoint } from "../robust-stats";

// Concrete catalog lifts with known movement patterns (see lib/lifts.ts):
//   Bench Press / Overhead Press → push;  Barbell Row / Pull Up → pull.
const push = (sets: number): ExerciseSetCount => ({
  exercise: "Bench Press",
  sets,
});
const pull = (sets: number): ExerciseSetCount => ({
  exercise: "Barbell Row",
  sets,
});

describe("patternSetCounts", () => {
  it("buckets exercises into push/pull by catalog pattern", () => {
    const c = patternSetCounts([
      { exercise: "Bench Press", sets: 5 },
      { exercise: "Overhead Press", sets: 3 },
      { exercise: "Barbell Row", sets: 4 },
      { exercise: "Pull Up", sets: 2 },
      { exercise: "Back Squat", sets: 9 }, // legs → neither push nor pull
    ]);
    expect(c).toEqual({ push: 8, pull: 6 });
  });
});

describe("detectPushPullImbalance", () => {
  it("flags a ≥2× skew once total volume clears the floor", () => {
    const f = detectPushPullImbalance([push(16), pull(6)]);
    expect(f?.kind).toBe("balance");
    // Episode anchor = the skewed direction ("push" here); #436.
    expect(f?.key).toBe(trainingBalanceSignalKey("push"));
    expect(f?.legacyKey).toBe(trainingBalanceLegacyKey());
    expect(f?.detail).toContain("more pushing than pulling");
  });

  it("fires at EXACTLY the 2× ratio boundary", () => {
    // push 12, pull 6 → hi(12) is not < 2×lo(12); total 18 ≥ floor.
    expect(detectPushPullImbalance([push(12), pull(6)])).not.toBeNull();
  });

  it("does NOT fire just under the 2× ratio", () => {
    // push 11, pull 6 → hi(11) < 12; total 17 ≥ floor but ratio too small.
    expect(detectPushPullImbalance([push(11), pull(6)])).toBeNull();
  });

  it("does NOT fire below the total-volume floor even when lopsided", () => {
    // push 8, pull 0 → total 8 < MIN_PUSH_PULL_SETS.
    expect(MIN_PUSH_PULL_SETS).toBe(12);
    expect(detectPushPullImbalance([push(8), pull(0)])).toBeNull();
  });

  it("flags an all-one-side split once the floor is met", () => {
    const f = detectPushPullImbalance([push(14), pull(0)]);
    expect(f).not.toBeNull();
    expect(f?.detail).toContain("14 pushing and 0 pulling");
  });
});

describe("detectStaleExercises", () => {
  const today = "2026-03-01";
  const daysAgo = (n: number) => {
    const d = new Date(Date.UTC(2026, 2, 1) - n * 86_400_000);
    return d.toISOString().slice(0, 10);
  };

  it("flags an established lift lapsed inside the stale band", () => {
    const out = detectStaleExercises(
      [{ exercise: "Deadlift", sessions: 5, lastDate: daysAgo(28) }],
      today
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("stale");
    // Episode anchor = the YYYY-MM of the last session (daysAgo(28) → 2026-02); #436.
    expect(out[0].key).toBe(staleExerciseSignalKey("Deadlift", "2026-02"));
  });

  it("ignores a lift with too few sessions", () => {
    expect(
      detectStaleExercises(
        [{ exercise: "Deadlift", sessions: 2, lastDate: daysAgo(28) }],
        today
      )
    ).toEqual([]);
  });

  it("respects the stale-band boundaries (21…56 days)", () => {
    const at = (n: number) =>
      detectStaleExercises(
        [{ exercise: "Squat", sessions: 4, lastDate: daysAgo(n) }],
        today
      ).length;
    expect(at(20)).toBe(0); // too recent
    expect(at(21)).toBe(1); // just stale
    expect(at(56)).toBe(1); // last stale day
    expect(at(57)).toBe(0); // dropped, not merely stale
  });
});

describe("isPlateau / detectPlateaus", () => {
  const today = "2026-03-01";
  const daysAgo = (n: number) => {
    const d = new Date(Date.UTC(2026, 2, 1) - n * 86_400_000);
    return d.toISOString().slice(0, 10);
  };

  // Six weekly points, e1RM pinned at ~100 (tiny noise) across 42 days → flat.
  const flat: DatedPoint[] = [42, 35, 28, 21, 14, 7, 0].map((n, i) => ({
    date: daysAgo(n),
    value: 100 + (i % 2 === 0 ? 0.2 : -0.2),
  }));

  // Clean linear progression 100 → 112 over the same span → not flat.
  const rising: DatedPoint[] = [42, 35, 28, 21, 14, 7, 0].map((n) => ({
    date: daysAgo(n),
    value: 100 + (42 - n) * (12 / 42),
  }));

  it("calls a flat 6-week series a plateau", () => {
    expect(isPlateau(flat)).toBe(true);
  });

  it("does NOT call a steadily-progressing series a plateau", () => {
    expect(isPlateau(rising)).toBe(false);
  });

  it("needs enough points", () => {
    expect(isPlateau(flat.slice(0, 3))).toBe(false);
  });

  it("needs enough time span (4 points crammed into a week is not a plateau)", () => {
    const crammed: DatedPoint[] = [6, 4, 2, 0].map((n) => ({
      date: daysAgo(n),
      value: 100,
    }));
    expect(isPlateau(crammed)).toBe(false);
  });

  it("detectPlateaus windows out old points and emits a finding", () => {
    const out = detectPlateaus(
      [{ exercise: "Bench Press", points: flat }],
      today
    );
    expect(out).toHaveLength(1);
    // Episode anchor = the e1RM level bucket (median ~100 kg → round(100/5) = "20"); #436.
    expect(out[0].key).toBe(plateauSignalKey("Bench Press", "20"));
    expect(out[0].detail).toContain("deload");
  });

  it("all observation keys share the training-obs namespace", () => {
    for (const k of [
      trainingBalanceSignalKey("push"),
      staleExerciseSignalKey("Deadlift", "2026-02"),
      plateauSignalKey("Bench Press", "20"),
    ]) {
      expect(k.startsWith(TRAINING_OBS_PREFIX)).toBe(true);
    }
  });
});

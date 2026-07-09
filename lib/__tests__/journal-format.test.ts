import { describe, expect, it } from "vitest";
import { summarizeExercise, type SetRow } from "@/lib/journal-format";

// Tests use the "kg" unit so weight_kg renders verbatim (no conversion noise).
const row = (over: Partial<SetRow> & { set_number: number }): SetRow => ({
  weight_kg: null,
  reps: null,
  ...over,
});

describe("summarizeExercise — rep-based", () => {
  it("collapses uniform sets into 'weight × reps × count'", () => {
    const sets = [
      row({ set_number: 1, weight_kg: 100, reps: 5 }),
      row({ set_number: 2, weight_kg: 100, reps: 5 }),
      row({ set_number: 3, weight_kg: 100, reps: 5 }),
    ];
    const s = summarizeExercise(sets, "kg");
    expect(s.text).toBe("100kg × 5 × 3");
    expect(s.totalKg).toBe(1500);
  });

  it("lists varying reps", () => {
    const sets = [
      row({ set_number: 1, weight_kg: 150, reps: 8 }),
      row({ set_number: 2, weight_kg: 150, reps: 8 }),
      row({ set_number: 3, weight_kg: 150, reps: 7 }),
    ];
    const s = summarizeExercise(sets, "kg");
    expect(s.text).toBe("150kg × 8, 8, 7");
    expect(s.totalKg).toBe(150 * 8 + 150 * 8 + 150 * 7);
  });

  it("groups consecutive sets by weight when the load changes", () => {
    const sets = [
      row({ set_number: 1, weight_kg: 100, reps: 6 }),
      row({ set_number: 2, weight_kg: 100, reps: 5 }),
      row({ set_number: 3, weight_kg: 95, reps: 8 }),
    ];
    expect(summarizeExercise(sets, "kg").text).toBe("100kg × 6, 5, 95kg × 8");
  });

  it("drops the weight prefix for bodyweight (null) sets", () => {
    const sets = [
      row({ set_number: 1, weight_kg: null, reps: 10 }),
      row({ set_number: 2, weight_kg: null, reps: 10 }),
    ];
    const s = summarizeExercise(sets, "kg");
    expect(s.text).toBe("10 × 2");
    expect(s.totalKg).toBe(0);
  });

  it("drops the weight prefix for zero-weight sets too", () => {
    const sets = [
      row({ set_number: 1, weight_kg: 0, reps: 12 }),
      row({ set_number: 2, weight_kg: 0, reps: 12 }),
    ];
    expect(summarizeExercise(sets, "kg").text).toBe("12 × 2");
  });

  it("sorts by set_number before summarizing", () => {
    const sets = [
      row({ set_number: 3, weight_kg: 95, reps: 8 }),
      row({ set_number: 1, weight_kg: 100, reps: 6 }),
      row({ set_number: 2, weight_kg: 100, reps: 5 }),
    ];
    expect(summarizeExercise(sets, "kg").text).toBe("100kg × 6, 5, 95kg × 8");
  });

  it("carries no status for a single set", () => {
    const s = summarizeExercise(
      [row({ set_number: 1, weight_kg: 100, reps: 5 })],
      "kg"
    );
    expect(s.status).toBeNull();
  });
});

describe("summarizeExercise — target-based status", () => {
  it("carries no status without declared targets, even for varying reps", () => {
    // 5/3/1-style ramp: reps vary by design; without intent there is no
    // judgment to make.
    const sets = [
      row({ set_number: 1, weight_kg: 100, reps: 5 }),
      row({ set_number: 2, weight_kg: 110, reps: 3 }),
      row({ set_number: 3, weight_kg: 120, reps: 1 }),
    ];
    expect(summarizeExercise(sets, "kg").status).toBeNull();
  });

  it("marks met when every targeted set reaches its target", () => {
    const sets = [
      row({ set_number: 1, weight_kg: 100, reps: 5, target_reps: 5 }),
      row({ set_number: 2, weight_kg: 100, reps: 6, target_reps: 5 }),
    ];
    expect(summarizeExercise(sets, "kg").status).toBe("met");
  });

  it("marks missed when any targeted set falls short (even a single set)", () => {
    const sets = [
      row({ set_number: 1, weight_kg: 100, reps: 5, target_reps: 5 }),
      row({ set_number: 2, weight_kg: 100, reps: 4, target_reps: 5 }),
    ];
    expect(summarizeExercise(sets, "kg").status).toBe("missed");
    // No ≥2-sets guard: a lone short set is judged too.
    expect(
      summarizeExercise(
        [row({ set_number: 1, weight_kg: 100, reps: 4, target_reps: 5 })],
        "kg"
      ).status
    ).toBe("missed");
  });

  it("ignores to-failure (AMRAP) sets — declining reps are the plan", () => {
    const sets = [
      row({ set_number: 1, weight_kg: 100, reps: 12, to_failure: 1 }),
      row({ set_number: 2, weight_kg: 100, reps: 9, to_failure: 1 }),
      row({ set_number: 3, weight_kg: 100, reps: 7, to_failure: 1 }),
    ];
    expect(summarizeExercise(sets, "kg").status).toBeNull();
  });

  it("a to-failure flag on a targeted set exempts that set from judgment", () => {
    // e.g. 5/3/1 "1+": last set is AMRAP; the earlier targeted sets still count.
    const sets = [
      row({ set_number: 1, weight_kg: 100, reps: 5, target_reps: 5 }),
      row({
        set_number: 2,
        weight_kg: 100,
        reps: 3,
        target_reps: 5,
        to_failure: 1,
      }),
    ];
    expect(summarizeExercise(sets, "kg").status).toBe("met");
  });

  it("treats a non-positive target as no target — it can't auto-pass", () => {
    expect(
      summarizeExercise(
        [row({ set_number: 1, weight_kg: 100, reps: 0, target_reps: 0 })],
        "kg"
      ).status
    ).toBeNull();
  });
});

describe("summarizeExercise — timed holds", () => {
  it("renders hold time as m:ss and carries no status or volume", () => {
    const sets = [
      row({ set_number: 1, duration_sec: 60 }),
      row({ set_number: 2, duration_sec: 60 }),
      row({ set_number: 3, duration_sec: 60 }),
    ];
    const s = summarizeExercise(sets, "kg");
    expect(s.text).toBe("1:00 × 3");
    expect(s.status).toBeNull();
    expect(s.totalKg).toBe(0);
  });

  it("lists varying hold times", () => {
    const sets = [
      row({ set_number: 1, duration_sec: 60 }),
      row({ set_number: 2, duration_sec: 45 }),
    ];
    expect(summarizeExercise(sets, "kg").text).toBe("1:00, 0:45");
  });
});

describe("summarizeExercise — per-side (asymmetric)", () => {
  it("summarizes each side independently, joined with ' · '", () => {
    const sets = [
      row({
        set_number: 1,
        weight_kg: 14,
        reps: 10,
        weight_kg_right: 12,
        reps_right: 8,
      }),
      row({
        set_number: 2,
        weight_kg: 14,
        reps: 10,
        weight_kg_right: 12,
        reps_right: 8,
      }),
    ];
    const s = summarizeExercise(sets, "kg");
    expect(s.text).toBe("L 14kg × 10 × 2 · R 12kg × 8 × 2");
    expect(s.status).toBeNull();
    // Volume sums both sides.
    expect(s.totalKg).toBe(14 * 10 * 2 + 12 * 8 * 2);
  });

  it("handles per-side timed holds", () => {
    const sets = [
      row({ set_number: 1, duration_sec: 45, duration_sec_right: 40 }),
      row({ set_number: 2, duration_sec: 45, duration_sec_right: 40 }),
    ];
    const s = summarizeExercise(sets, "kg");
    expect(s.text).toBe("L 0:45 × 2 · R 0:40 × 2");
    expect(s.totalKg).toBe(0);
  });
});

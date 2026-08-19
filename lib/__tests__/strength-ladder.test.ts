import { describe, expect, it } from "vitest";
import {
  strengthLadderPlacement,
  strengthLadderRows,
} from "@/lib/strength-ladder";

describe("strengthLadderPlacement", () => {
  it("places current and prior e1RM through the same standards computation", () => {
    const row = strengthLadderPlacement("Bench Press", 100, 70, "male", 80)!;
    expect(row.current.level).toBe("intermediate");
    expect(row.prior?.level).toBe("novice");
    expect(row.currentPercent).toBeGreaterThan(row.priorPercent!);
    expect(row.moved).toBe(true);
  });

  it("shares the standards model's missing-context gate", () => {
    expect(
      strengthLadderPlacement("Bench Press", 100, 70, null, 80)
    ).toBeNull();
    expect(strengthLadderPlacement("Curl", 40, 30, "male", 80)).toBeNull();
  });
});

// #3132 — the row builder's whole job is that both dots come from ONE lane, so the
// points it is handed are already free-weight-restricted. What it owns is which
// point becomes the prior, and how movement ranks the rows.
describe("strengthLadderRows", () => {
  const CUTOFF = "2026-05-21";

  it("takes the newest point at or before the cutoff as the prior", () => {
    const [row] = strengthLadderRows(
      [
        {
          exercise: "Bench Press",
          currentE1rmKg: 100,
          points: [
            { date: "2026-01-10", value: 60 },
            { date: CUTOFF, value: 70 },
            { date: "2026-08-01", value: 100 },
          ],
        },
      ],
      CUTOFF,
      "male",
      80
    );
    expect(row.placement.prior?.e1rmKg).toBe(70);
    expect(row.placement.moved).toBe(true);
  });

  it("renders one dot when the lane holds nothing before the cutoff", () => {
    const [row] = strengthLadderRows(
      [
        {
          exercise: "Bench Press",
          currentE1rmKg: 100,
          points: [{ date: "2026-08-01", value: 100 }],
        },
      ],
      CUTOFF,
      "male",
      80
    );
    expect(row.placement.prior).toBeNull();
    expect(row.placement.priorPercent).toBeNull();
    // No prior is not a PR claim — the ladder says nothing about movement.
    expect(row.placement.moved).toBe(false);
  });

  // Movement is what ranks the rows, so a lift whose prior came from the wrong lane
  // is not merely mislabelled — it loses its place. (The comparator's leading
  // `moved` term is redundant with the delta below it, since `moved` is exactly
  // "delta > 0"; both are kept as #3089 wrote them.)
  it("ranks by how far a lift moved, non-movers last, ties by name", () => {
    const points = (prior: number, cur: number) => [
      { date: "2026-01-10", value: prior },
      { date: "2026-08-01", value: cur },
    ];
    const rows = strengthLadderRows(
      [
        {
          exercise: "Overhead Press",
          currentE1rmKg: 60,
          points: points(60, 60),
        },
        {
          exercise: "Bench Press",
          currentE1rmKg: 100,
          points: points(70, 100),
        },
        {
          exercise: "Back Squat",
          currentE1rmKg: 140,
          points: points(135, 140),
        },
      ],
      CUTOFF,
      "male",
      80
    );
    expect(rows.map((r) => r.exercise)).toEqual([
      "Bench Press", // moved +30
      "Back Squat", // moved +5
      "Overhead Press", // did not move
    ]);
  });

  it("drops lifts the standards model declines and keeps the top few", () => {
    const rows = strengthLadderRows(
      [
        { exercise: "Curl", currentE1rmKg: 40, points: [] },
        { exercise: "Bench Press", currentE1rmKg: 100, points: [] },
        { exercise: "Back Squat", currentE1rmKg: 140, points: [] },
        { exercise: "Deadlift", currentE1rmKg: 180, points: [] },
        { exercise: "Overhead Press", currentE1rmKg: 60, points: [] },
      ],
      CUTOFF,
      "male",
      80
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.exercise)).not.toContain("Curl");
  });
});

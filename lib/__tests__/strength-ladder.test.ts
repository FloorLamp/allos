import { describe, expect, it } from "vitest";
import { strengthLadderPlacement } from "@/lib/strength-ladder";

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

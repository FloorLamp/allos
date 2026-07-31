import { describe, expect, it } from "vitest";
import { buildSupplementWeeklyAdherence } from "@/lib/supplement-weekly-adherence";

describe("buildSupplementWeeklyAdherence", () => {
  it("keeps unresolved doses today out of the headline percentage", () => {
    const result = buildSupplementWeeklyAdherence([
      {
        date: "2026-07-24",
        due: 4,
        taken: 3,
        skipped: 0,
        isToday: false,
      },
      {
        date: "2026-07-25",
        due: 4,
        taken: 1,
        skipped: 0,
        isToday: true,
      },
    ]);

    expect(result).toMatchObject({
      taken: 3,
      intended: 4,
      pct: 75,
      skipped: 0,
    });
    expect(result.days[1]).toMatchObject({
      intended: 4,
      pending: 3,
      state: "pending",
    });
  });

  it("excludes skips from intended doses and includes a resolved today", () => {
    const result = buildSupplementWeeklyAdherence([
      {
        date: "2026-07-24",
        due: 3,
        taken: 2,
        skipped: 1,
        isToday: false,
      },
      {
        date: "2026-07-25",
        due: 2,
        taken: 2,
        skipped: 0,
        isToday: true,
      },
    ]);

    expect(result).toMatchObject({
      taken: 4,
      intended: 4,
      pct: 100,
      skipped: 1,
    });
    expect(result.days.map((day) => day.state)).toEqual(["taken", "taken"]);
  });

  it("distinguishes missed, skipped, and not-due days", () => {
    const result = buildSupplementWeeklyAdherence([
      {
        date: "2026-07-23",
        due: 2,
        taken: 0,
        skipped: 0,
        isToday: false,
      },
      {
        date: "2026-07-24",
        due: 2,
        taken: 0,
        skipped: 2,
        isToday: false,
      },
      {
        date: "2026-07-25",
        due: 0,
        taken: 0,
        skipped: 0,
        isToday: true,
      },
    ]);

    expect(result.days.map((day) => day.state)).toEqual([
      "missed",
      "skipped",
      "na",
    ]);
    expect(result).toMatchObject({
      taken: 0,
      intended: 2,
      pct: 0,
      skipped: 2,
    });
  });
});

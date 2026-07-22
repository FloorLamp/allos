import { describe, expect, it } from "vitest";
import {
  bedtimeSupplementStatusLabel,
  summarizeBedtimeSupplements,
} from "../sleep-bedtime-supplements";

describe("bedtime supplement sleep context", () => {
  it("returns null when no bedtime supplement was due", () => {
    expect(summarizeBedtimeSupplements("2026-07-20", [])).toBeNull();
    expect(bedtimeSupplementStatusLabel(null)).toBe("—");
  });

  it("reports all due doses taken and groups split doses by supplement", () => {
    const summary = summarizeBedtimeSupplements("2026-07-20", [
      { itemId: 1, name: "Magnesium", status: "taken" },
      { itemId: 1, name: "Magnesium", status: "taken" },
      { itemId: 2, name: "Glycine", status: "taken" },
    ]);

    expect(summary).toEqual({
      sleepDate: "2026-07-20",
      due: 3,
      taken: 3,
      skipped: 0,
      state: "taken",
      items: [
        {
          name: "Magnesium",
          due: 2,
          taken: 2,
          skipped: 0,
          state: "taken",
        },
        {
          name: "Glycine",
          due: 1,
          taken: 1,
          skipped: 0,
          state: "taken",
        },
      ],
    });
    expect(bedtimeSupplementStatusLabel(summary)).toBe("All taken");
  });

  it("keeps partial, skipped, and missed nights distinct", () => {
    const partial = summarizeBedtimeSupplements("2026-07-20", [
      { itemId: 1, name: "Magnesium", status: "taken" },
      { itemId: 2, name: "Glycine", status: null },
    ]);
    const skipped = summarizeBedtimeSupplements("2026-07-20", [
      { itemId: 1, name: "Magnesium", status: "skipped" },
    ]);
    const missed = summarizeBedtimeSupplements("2026-07-20", [
      { itemId: 1, name: "Magnesium", status: null },
    ]);

    expect(partial?.state).toBe("partial");
    expect(bedtimeSupplementStatusLabel(partial)).toBe("1 of 2 taken");
    expect(skipped?.state).toBe("skipped");
    expect(bedtimeSupplementStatusLabel(skipped)).toBe("Skipped");
    expect(missed?.state).toBe("missed");
    expect(bedtimeSupplementStatusLabel(missed)).toBe("Not logged");
  });
});

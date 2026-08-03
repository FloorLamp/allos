import { describe, expect, it } from "vitest";
import {
  bedtimeDoseDisposition,
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

describe("which doses belong to a night", () => {
  const night = {
    sleepDate: "2026-07-20",
    logged: false,
    isBedtimeDose: true,
    isCurrentDose: true,
    adherenceSince: "2026-07-01",
  };

  // Issue #1972 regression pin. A dose logged for night N and edited on night
  // N+5 must still report that night. The edit moves the dose's adherence lower
  // bound (doseAdherenceSince keys off updated_at), and that bound used to be
  // applied before the log was consulted, erasing the logged night entirely.
  it("keeps a logged night when the dose was edited afterwards", () => {
    expect(
      bedtimeDoseDisposition({
        ...night,
        logged: true,
        adherenceSince: "2026-07-25",
      })
    ).toBe("logged");
  });

  it("keeps a logged night for a paused or retired bedtime dose", () => {
    expect(
      bedtimeDoseDisposition({ ...night, logged: true, isCurrentDose: false })
    ).toBe("logged");
  });

  it("ignores a dose whose current slot is not bedtime, logged or not", () => {
    expect(
      bedtimeDoseDisposition({ ...night, isBedtimeDose: false, logged: true })
    ).toBe("excluded");
    expect(bedtimeDoseDisposition({ ...night, isBedtimeDose: false })).toBe(
      "excluded"
    );
  });

  it("still judges an unlogged night by the dose lifetime and regimen", () => {
    expect(bedtimeDoseDisposition(night)).toBe("scheduled");
    expect(
      bedtimeDoseDisposition({ ...night, adherenceSince: "2026-07-21" })
    ).toBe("excluded");
    expect(bedtimeDoseDisposition({ ...night, adherenceSince: null })).toBe(
      "scheduled"
    );
    expect(bedtimeDoseDisposition({ ...night, isCurrentDose: false })).toBe(
      "excluded"
    );
  });
});

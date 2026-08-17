import { describe, expect, it, vi } from "vitest";

// The dose classifier's FAIL-SAFE direction (#2970 R6), which the shipped dataset
// cannot exercise on its own: every ionizing modality currently carries a non-zero
// typical dose, so the modality set is never consulted for one and emptying it changed
// nothing. The case that matters is the one the dataset does not have yet — a modality
// whose entry resolves to 0 mSv and that nobody remembered to list.
//
// The claim "No ionizing radiation." must come from a POSITIVE statement of physics
// (this modality is non-ionizing), never from the absence of a name in a list. A
// study we cannot classify must read as not estimated, which is honest, rather than
// as carrying no radiation, which is false reassurance on a medical surface.
//
// This spec stands alone because the mock replaces the dataset for the whole file;
// the rest of the module's tests run against the real one in radiation-dose.test.ts.
vi.mock("@/lib/datasets/radiation-dose", () => ({
  RADIATION_DOSE_ENTRIES: [
    {
      key: "unmapped-zero",
      modality: "other",
      regions: [],
      msv: 0,
      label: "Unmapped study",
    },
    {
      key: "xray-chest",
      modality: "x-ray",
      regions: ["chest"],
      msv: 0.1,
      label: "Chest X-ray",
    },
  ],
  RADIATION_DOSE_META: {
    version: 2,
    naturalBackgroundMsvPerYear: 3,
    naturalBackgroundSource: "test fixture",
  },
}));

const { doseContributions, doseExclusionNote } =
  await import("@/lib/radiation-dose");

describe("a 0-mSv entry on an unlisted modality (#2970 R6)", () => {
  it("reports it as not estimated, never as carrying no ionizing radiation", () => {
    const b = doseContributions(
      [
        {
          id: 1,
          modality: "other" as const,
          body_region: "Whole body",
          dose_msv: null,
          study_date: "2025-01-01",
        },
      ],
      "2026-08-15"
    );
    expect(b.contributions).toHaveLength(0);
    const excluded = b.exclusions[0];
    expect(excluded.reason).toBe("no-entry");
    expect(doseExclusionNote(excluded.reason)).not.toContain(
      "No ionizing radiation"
    );
  });
});

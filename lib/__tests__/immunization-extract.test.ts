import { describe, expect, it } from "vitest";
import type { ExtractedImmunization } from "../medical-extract";
import { immunizationsFromExtraction } from "../immunization-extract";

function item(partial: Partial<ExtractedImmunization>): ExtractedImmunization {
  return { vaccine: "", date: null, dose_label: null, notes: null, ...partial };
}

describe("immunizationsFromExtraction", () => {
  it("normalizes recognized brand names to catalog/combo codes", () => {
    const rows = immunizationsFromExtraction(
      [
        item({
          vaccine: "Boostrix",
          date: "2025-03-01",
          dose_label: "Booster",
        }),
        item({ vaccine: "Vaxelis", date: "2024-01-01" }),
      ],
      null
    );
    expect(rows.map((r) => r.vaccine)).toEqual(["vaxelis", "tdap"]);
    expect(rows.find((r) => r.vaccine === "tdap")?.dose_label).toBe("Booster");
  });

  it("slugs an unrecognized name instead of dropping the dose", () => {
    const rows = immunizationsFromExtraction(
      [item({ vaccine: "Experimental XYZ", date: "2025-01-01" })],
      null
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].vaccine).toBe("experimental_xyz");
  });

  it("falls back to the document date, and skips dateless doses", () => {
    const rows = immunizationsFromExtraction(
      [
        item({ vaccine: "MMR" }), // no date → use document date
        item({ vaccine: "Tdap", date: "bad-date" }), // invalid, no fallback... uses doc date
      ],
      "2025-06-15"
    );
    // Both get the document date; neither is dropped.
    expect(rows.every((r) => r.date === "2025-06-15")).toBe(true);
    expect(rows.map((r) => r.vaccine).sort()).toEqual(["mmr", "tdap"]);
  });

  it("drops a dose with no usable date at all", () => {
    const rows = immunizationsFromExtraction(
      [item({ vaccine: "MMR" })],
      null // no document date either
    );
    expect(rows).toHaveLength(0);
  });

  it("dedupes identical (vaccine, date) rows and ignores blanks", () => {
    const rows = immunizationsFromExtraction(
      [
        item({ vaccine: "MMR", date: "2025-01-01" }),
        item({ vaccine: "MMR", date: "2025-01-01" }),
        item({ vaccine: "  ", date: "2025-01-01" }),
      ],
      null
    );
    expect(rows).toHaveLength(1);
  });

  it("returns [] for a document with no immunizations array", () => {
    expect(immunizationsFromExtraction(undefined, "2025-01-01")).toEqual([]);
  });
});

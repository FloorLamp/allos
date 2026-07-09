import { describe, expect, it } from "vitest";
import { canonicalGroupKey, groupByCanonicalName } from "../biomarker-group";

const row = (canonical_name: string | null, date: string) => ({
  canonical_name,
  date,
});

describe("groupByCanonicalName", () => {
  it("splits rows into per-analyte groups preserving input order", () => {
    const rows = [
      row("LDL Cholesterol", "2024-01-01"),
      row("LDL Cholesterol", "2024-06-01"),
      row("eGFR", "2024-03-01"),
    ];
    const groups = groupByCanonicalName(rows);
    expect(groups.size).toBe(2);
    expect(
      groups.get(canonicalGroupKey("LDL Cholesterol"))?.map((r) => r.date)
    ).toEqual(["2024-01-01", "2024-06-01"]);
    expect(groups.get(canonicalGroupKey("eGFR"))?.map((r) => r.date)).toEqual([
      "2024-03-01",
    ]);
  });

  it("groups case-insensitively, matching the SQL NOCASE series lookup", () => {
    const rows = [row("LDL", "2024-01-01"), row("ldl", "2024-02-01")];
    const groups = groupByCanonicalName(rows);
    expect(groups.size).toBe(1);
    // A lookup by either casing of the used name finds the merged series.
    expect(groups.get(canonicalGroupKey("Ldl"))?.length).toBe(2);
  });

  it("skips rows without a canonical name", () => {
    const groups = groupByCanonicalName([
      row(null, "2024-01-01"),
      row("A1c", "2024-01-02"),
    ]);
    expect(groups.size).toBe(1);
    expect(groups.get(canonicalGroupKey("A1c"))?.length).toBe(1);
  });
});

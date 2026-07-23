import { describe, it, expect } from "vitest";
import {
  tableNameKey,
  filterDerivedForTable,
  prepareTableRecords,
  paginateRecords,
  BIOMARKER_PAGE_SIZE,
} from "../derived-table";
import type { MedicalRecord } from "../types";

// Minimal MedicalRecord builder — only the fields these helpers read matter.
function rec(p: Partial<MedicalRecord> & { id: number }): MedicalRecord {
  return {
    date: "2024-01-01",
    category: "lab",
    name: "X",
    value: "1",
    unit: null,
    reference_range: null,
    notes: null,
    created_at: "",
    document_id: null,
    panel: null,
    flag: null,
    value_num: 1,
    canonical_name: null,
    provider_id: null,
    ...p,
  };
}

const derived = (id: number, name: string, date: string, flag?: string) =>
  rec({
    id,
    name,
    canonical_name: name,
    date,
    derived: true,
    flag: (flag as MedicalRecord["flag"]) ?? null,
  });

describe("tableNameKey", () => {
  it("prefers the canonical name, else the raw name", () => {
    expect(
      tableNameKey({ name: "Chol", canonical_name: "Total Cholesterol" })
    ).toBe("Total Cholesterol");
    expect(tableNameKey({ name: "Weird", canonical_name: "  " })).toBe("Weird");
  });
});

describe("filterDerivedForTable", () => {
  const rows = [
    derived(-1, "Non-HDL Cholesterol", "2024-01-01", "non-optimal-high"),
    derived(-2, "eGFR", "2024-01-01", "high"),
  ];

  it("keeps lab-category derived rows when unfiltered", () => {
    expect(filterDerivedForTable(rows, {})).toHaveLength(2);
  });

  it("excludes when a non-lab category is selected", () => {
    expect(filterDerivedForTable(rows, { category: "vitals" })).toHaveLength(0);
  });

  it("excludes all derived rows when a panel filter is active (they carry none)", () => {
    expect(filterDerivedForTable(rows, { panel: "LabCorp" })).toHaveLength(0);
  });

  it("range=oor keeps only clinical-flagged rows", () => {
    const out = filterDerivedForTable(rows, { range: "oor" });
    expect(out.map((r) => r.name)).toEqual(["eGFR"]);
  });

  it("range=nonoptimal keeps non-optimal rows too", () => {
    const out = filterDerivedForTable(rows, { range: "nonoptimal" });
    expect(out.map((r) => r.name).sort()).toEqual([
      "Non-HDL Cholesterol",
      "eGFR",
    ]);
  });

  it("free-text q matches the name", () => {
    const out = filterDerivedForTable(rows, { q: "egfr" });
    expect(out.map((r) => r.name)).toEqual(["eGFR"]);
  });

  it("free-text q matches the CANONICAL name (the row heading), not just the raw name (#383)", () => {
    const canonicalRows = [
      rec({
        id: -3,
        name: "CHOLESTEROL, TOTAL",
        canonical_name: "Total Cholesterol",
        derived: true,
      }),
    ];
    // Searching by the visible heading finds the row even though the raw lab
    // string differs.
    expect(
      filterDerivedForTable(canonicalRows, { q: "total cholesterol" })
    ).toHaveLength(1);
    // The lab's original raw string still matches.
    expect(
      filterDerivedForTable(canonicalRows, { q: "cholesterol, total" })
    ).toHaveLength(1);
  });

  it("respects excludeCategories", () => {
    expect(
      filterDerivedForTable(rows, { excludeCategories: ["lab"] })
    ).toHaveLength(0);
  });
});

describe("paginateRecords (#114 bounded payload)", () => {
  const many = Array.from({ length: 125 }, (_, i) => rec({ id: i + 1 }));

  it("slices to one page and reports the total", () => {
    const p = paginateRecords(many, 1, 50);
    expect(p.rows).toHaveLength(50);
    expect(p.rows[0].id).toBe(1);
    expect(p.total).toBe(125);
    expect(p.pageCount).toBe(3);
    expect(p.page).toBe(1);
  });

  it("returns the requested middle page", () => {
    const p = paginateRecords(many, 2, 50);
    expect(p.rows[0].id).toBe(51);
    expect(p.rows).toHaveLength(50);
  });

  it("returns a short final page", () => {
    const p = paginateRecords(many, 3, 50);
    expect(p.rows).toHaveLength(25);
    expect(p.rows[0].id).toBe(101);
  });

  it("clamps an out-of-range page to the last page", () => {
    expect(paginateRecords(many, 99, 50).page).toBe(3);
    expect(paginateRecords(many, 99, 50).rows[0].id).toBe(101);
  });

  it("clamps garbage/NaN/zero to page 1", () => {
    expect(paginateRecords(many, NaN, 50).page).toBe(1);
    expect(paginateRecords(many, 0, 50).page).toBe(1);
    expect(paginateRecords(many, -4, 50).page).toBe(1);
  });

  it("an empty list reads as page 1 of 1", () => {
    const p = paginateRecords([], 1);
    expect(p).toMatchObject({ total: 0, page: 1, pageCount: 1, rows: [] });
  });

  it("defaults to BIOMARKER_PAGE_SIZE", () => {
    const p = paginateRecords(many, 1);
    expect(p.pageSize).toBe(BIOMARKER_PAGE_SIZE);
    expect(p.rows).toHaveLength(BIOMARKER_PAGE_SIZE);
  });
});

describe("prepareTableRecords", () => {
  it("marks is_latest per name over the combined set (newest date wins)", () => {
    const d = [
      derived(-1, "eGFR", "2024-01-01"),
      derived(-2, "eGFR", "2024-06-01"),
    ];
    const out = prepareTableRecords([], d, { sort: "date", dir: "desc" });
    const byDate = new Map(out.map((r) => [r.date, r.is_latest]));
    expect(byDate.get("2024-06-01")).toBe(1);
    expect(byDate.get("2024-01-01")).toBe(0);
  });

  it("prefers a stored (positive id) row as latest over a same-date derived row", () => {
    const stored = [
      rec({ id: 5, name: "eGFR", canonical_name: "eGFR", date: "2024-06-01" }),
    ];
    const d = [derived(-2, "eGFR", "2024-06-01")];
    const out = prepareTableRecords(stored, d, { current: true });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(5);
  });

  it("current=true keeps only the latest reading per name", () => {
    const d = [
      derived(-1, "eGFR", "2024-01-01"),
      derived(-2, "eGFR", "2024-06-01"),
      derived(-3, "Non-HDL Cholesterol", "2024-03-01"),
    ];
    const out = prepareTableRecords([], d, { current: true });
    expect(out.map((r) => [r.name, r.date]).sort()).toEqual([
      ["Non-HDL Cholesterol", "2024-03-01"],
      ["eGFR", "2024-06-01"],
    ]);
  });

  it("sorts by name ascending, folding stored + derived together", () => {
    const stored = [
      rec({
        id: 1,
        name: "Apolipoprotein B (ApoB)",
        canonical_name: "Apolipoprotein B (ApoB)",
        date: "2024-01-01",
      }),
    ];
    const d = [derived(-1, "eGFR", "2024-01-01")];
    const out = prepareTableRecords(stored, d, { sort: "name", dir: "asc" });
    expect(out.map((r) => tableNameKey(r))).toEqual([
      "Apolipoprotein B (ApoB)",
      "eGFR",
    ]);
  });
});

import { describe, it, expect } from "vitest";
import {
  tableNameKey,
  filterDerivedForTable,
  prepareTableRecords,
  prepareMultiViewTableRecords,
  multiViewGroupKey,
  paginateRecords,
  BIOMARKER_PAGE_SIZE,
  type WithProfile,
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

// ── Multi-view merged partitions (#1331) ──────────────────────────────────────
// The load-bearing property: is_latest / dedup / the `current` filter are computed
// PER (profile, family) — a family collapse must NEVER merge two people's readings
// into one series. These pure tests pin that independence + the stable subject sort.

// A profile-tagged stored reading (WithProfile) for the merge helper.
function tagged(
  profileId: number,
  p: Partial<MedicalRecord> & { id: number }
): WithProfile<MedicalRecord> {
  return { ...rec(p), profileId };
}

describe("multiViewGroupKey", () => {
  it("distinguishes two members' identically-named analytes", () => {
    const a = tagged(10, {
      id: 1,
      name: "Vitamin D",
      canonical_name: "Vitamin D",
    });
    const b = tagged(20, {
      id: 2,
      name: "Vitamin D",
      canonical_name: "Vitamin D",
    });
    expect(multiViewGroupKey(a)).not.toBe(multiViewGroupKey(b));
  });

  it("keeps one member's same-named readings in one group", () => {
    const a1 = tagged(10, {
      id: 1,
      name: "Ferritin",
      canonical_name: "Ferritin",
    });
    const a2 = tagged(10, {
      id: 2,
      name: "Ferritin",
      canonical_name: "Ferritin",
    });
    expect(multiViewGroupKey(a1)).toBe(multiViewGroupKey(a2));
  });
});

describe("prepareMultiViewTableRecords", () => {
  it("computes is_latest per (profile, family) — one member's newest never marks another's", () => {
    // Both members have a shared "Vitamin D" family. Member 10's newest is 2024-06;
    // member 20's newest is 2024-03. Each member's own newest is is_latest, and NO
    // cross-member row is flagged.
    const stored = [
      tagged(10, {
        id: 1,
        name: "Vitamin D",
        canonical_name: "Vitamin D",
        date: "2024-01-01",
      }),
      tagged(10, {
        id: 2,
        name: "Vitamin D",
        canonical_name: "Vitamin D",
        date: "2024-06-01",
      }),
      tagged(20, {
        id: 3,
        name: "Vitamin D",
        canonical_name: "Vitamin D",
        date: "2024-03-01",
      }),
    ];
    const out = prepareMultiViewTableRecords(stored, [], {});
    const latest = out.filter((r) => r.is_latest === 1);
    // Exactly one latest per member: member 10's June row (id 2), member 20's March row (id 3).
    expect(new Set(latest.map((r) => r.id))).toEqual(new Set([2, 3]));
    expect(latest.every((r) => r.profileId === 10 || r.profileId === 20)).toBe(
      true
    );
    // Both members' families survive — never collapsed into a single series.
    expect(out.length).toBe(3);
  });

  it("never collapses two members' same value/date/family into one row (no cross-member dedup)", () => {
    // Same family, same date, same value — WITHIN a member these would dedup, but
    // across members they are two distinct people's readings and BOTH must survive.
    const stored = [
      tagged(10, {
        id: 1,
        name: "Vitamin D",
        canonical_name: "Vitamin D",
        date: "2024-06-01",
        value: "42",
        value_num: 42,
      }),
      tagged(20, {
        id: 2,
        name: "Vitamin D",
        canonical_name: "Vitamin D",
        date: "2024-06-01",
        value: "42",
        value_num: 42,
      }),
    ];
    const out = prepareMultiViewTableRecords(stored, [], {});
    expect(out.length).toBe(2);
    expect(out.every((r) => r.is_latest === 1)).toBe(true);
  });

  it("`current` keeps the latest reading PER member", () => {
    const stored = [
      tagged(10, {
        id: 1,
        name: "Ferritin",
        canonical_name: "Ferritin",
        date: "2024-01-01",
      }),
      tagged(10, {
        id: 2,
        name: "Ferritin",
        canonical_name: "Ferritin",
        date: "2024-05-01",
      }),
      tagged(20, {
        id: 3,
        name: "Ferritin",
        canonical_name: "Ferritin",
        date: "2024-02-01",
      }),
    ];
    const out = prepareMultiViewTableRecords(stored, [], { current: true });
    expect(out.map((r) => r.id).sort()).toEqual([2, 3]);
  });

  it("isolates colliding derived ids across members", () => {
    // Derived rows carry per-profile NEGATIVE ids, so two members can each have a
    // derived reading with id -1. The (profile, family) partition must keep them apart.
    const derivedRows = [
      {
        ...derived(-1, "eGFR", "2024-04-01"),
        profileId: 10,
      } as WithProfile<MedicalRecord>,
      {
        ...derived(-1, "eGFR", "2024-04-01"),
        profileId: 20,
      } as WithProfile<MedicalRecord>,
    ];
    const out = prepareMultiViewTableRecords([], derivedRows, {});
    expect(out.length).toBe(2);
    // Each member's derived eGFR is its own current reading.
    expect(out.every((r) => r.is_latest === 1)).toBe(true);
    expect(new Set(out.map((r) => r.profileId))).toEqual(new Set([10, 20]));
  });

  it("orders deterministically with the subject dimension as a stable tie-break", () => {
    // Same name + date across members → the profileId tie-break makes the order stable.
    const stored = [
      tagged(20, {
        id: 5,
        name: "Glucose",
        canonical_name: "Glucose",
        date: "2024-06-01",
      }),
      tagged(10, {
        id: 6,
        name: "Glucose",
        canonical_name: "Glucose",
        date: "2024-06-01",
      }),
    ];
    const a = prepareMultiViewTableRecords(stored, [], {
      sort: "name",
      dir: "asc",
    });
    const b = prepareMultiViewTableRecords([...stored].reverse(), [], {
      sort: "name",
      dir: "asc",
    });
    expect(a.map((r) => r.profileId)).toEqual([10, 20]);
    expect(b.map((r) => r.profileId)).toEqual([10, 20]);
  });

  it("keeps each member's same-analyte readings CONTIGUOUS (subject woven into the sort key, not a final tie-break)", () => {
    // Regression: with profileId only a FINAL tie-break, date-desc slots member 20's
    // March reading BETWEEN member 10's June and January rows, splitting 10's group
    // into two headings. The subject dimension must sort ABOVE the date tie-break.
    const stored = [
      tagged(10, {
        id: 1,
        name: "Vitamin D",
        canonical_name: "Vitamin D",
        date: "2024-01-01",
      }),
      tagged(10, {
        id: 2,
        name: "Vitamin D",
        canonical_name: "Vitamin D",
        date: "2024-06-01",
      }),
      tagged(20, {
        id: 3,
        name: "Vitamin D",
        canonical_name: "Vitamin D",
        date: "2024-03-01",
      }),
    ];
    const out = prepareMultiViewTableRecords(stored, [], {
      sort: "name",
      dir: "asc",
    });
    // Group by (profile, name) the way the table does — each member appears in ONE
    // contiguous run, so the sequence of group keys has exactly two runs, not three.
    const keys = out.map((r) => multiViewGroupKey(r));
    const runs = keys.filter((k, i) => i === 0 || keys[i - 1] !== k).length;
    expect(runs).toBe(2);
  });

  it("a single-profile view yields the same rows a single-view merge would (additive)", () => {
    const stored = [
      tagged(10, {
        id: 1,
        name: "Vitamin D",
        canonical_name: "Vitamin D",
        date: "2024-01-01",
      }),
      tagged(10, {
        id: 2,
        name: "Vitamin D",
        canonical_name: "Vitamin D",
        date: "2024-06-01",
      }),
    ];
    const mv = prepareMultiViewTableRecords(stored, [], {
      sort: "name",
      dir: "asc",
    });
    const single = prepareTableRecords(
      stored.map((r) => ({ ...r })),
      [],
      { sort: "name", dir: "asc" }
    );
    expect(mv.map((r) => [r.id, r.is_latest])).toEqual(
      single.map((r) => [r.id, r.is_latest])
    );
  });
});

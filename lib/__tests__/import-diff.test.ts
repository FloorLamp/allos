import { describe, it, expect } from "vitest";
import {
  unscopeExternalId,
  recordRow,
  medicationRow,
  diffRows,
  computeImportDiff,
  snapshotFromPersistInput,
  emptySnapshot,
  type DiffRow,
} from "@/lib/import-diff";
import type { PersistInput, PersistRecord } from "@/lib/import-shape";

// Pure unit tests for the reprocess-diff logic. No DB — the
// DB reader (lib/queries/imports.getReprocessSnapshot) and the extraction adapter
// both reduce to the same neutral snapshot these functions diff.

function rec(over: Partial<PersistRecord> = {}): PersistRecord {
  return {
    category: "lab",
    name: "Glucose",
    canonical: "Glucose",
    value: "95",
    value_num: 95,
    unit: "mg/dL",
    date: "2020-05-01",
    reference_range: null,
    flag: null,
    panel: null,
    notes: null,
    source: null,
    external_id: null,
    loinc: null,
    provider: null,
    courses: null,
    ...over,
  };
}

function input(over: Partial<PersistInput> = {}): PersistInput {
  return {
    records: [],
    immunizations: [],
    allergies: [],
    conditions: [],
    encounters: [],
    procedures: [],
    familyHistory: [],
    carePlanItems: [],
    careGoals: [],
    bodyMetrics: [],
    heights: [],
    headCircs: [],
    demographics: null,
    meta: {
      docType: null,
      source: null,
      documentDate: null,
      patientName: null,
      raw: null,
      model: null,
      importReport: null,
    },
    canonicalNamesToRegister: [],
    providers: [],
    ...over,
  };
}

describe("unscopeExternalId", () => {
  it("strips the document-source prefix so the two sides line up", () => {
    expect(unscopeExternalId("document:12|obs:glucose")).toBe("obs:glucose");
  });
  it("leaves an unscoped id and null untouched", () => {
    expect(unscopeExternalId("obs:glucose")).toBe("obs:glucose");
    expect(unscopeExternalId(null)).toBeNull();
  });
  it("only strips the leading document:<n>| (not a later pipe)", () => {
    expect(unscopeExternalId("document:3|a|b")).toBe("a|b");
  });
});

describe("recordRow keying", () => {
  it("keys on external_id when present", () => {
    const r = recordRow({
      date: "2020-05-01",
      category: "lab",
      name: "Glucose",
      value: "95",
      value_num: 95,
      unit: "mg/dL",
      reference_range: null,
      panel: null,
      flag: null,
      canonical: "Glucose",
      notes: null,
      external_id: "obs:glucose",
    });
    expect(r.key).toBe("ext:obs:glucose");
  });
  it("falls back to a content identity when external_id is null (AI path)", () => {
    const r = recordRow({
      date: "2020-05-01",
      category: "lab",
      name: "Glucose",
      value: "95",
      value_num: 95,
      unit: "mg/dL",
      reference_range: null,
      panel: null,
      flag: null,
      canonical: "Glucose",
      notes: null,
      external_id: null,
    });
    expect(r.key).toBe("rec:2020-05-01|lab|glucose");
  });
});

describe("diffRows", () => {
  const row = (key: string, fields: string): DiffRow => ({
    key,
    label: key,
    fields,
    detail: null,
  });

  it("classifies added / removed / changed / unchanged", () => {
    const current = [row("a", "1"), row("b", "1"), row("c", "1")];
    const next = [row("a", "1"), row("b", "2"), row("d", "1")];
    const d = diffRows(current, next);
    expect(d.unchanged.map((r) => r.key)).toEqual(["a"]);
    expect(d.changed.map((c) => c.after.key)).toEqual(["b"]);
    expect(d.added.map((r) => r.key)).toEqual(["d"]);
    expect(d.removed.map((r) => r.key)).toEqual(["c"]);
  });

  it("handles duplicate keys as a multiset (a second reading is not collapsed)", () => {
    const current = [row("a", "1")];
    const next = [row("a", "1"), row("a", "1")];
    const d = diffRows(current, next);
    expect(d.unchanged).toHaveLength(1);
    expect(d.added).toHaveLength(1);
  });

  it("matches same-key rows order-insensitively (reordered duplicates are unchanged)", () => {
    // Two same-key rows (AI path, same content key) with values [5,6] re-extracted
    // as [6,5] must read as unchanged, not two spurious changes.
    const current = [row("a", "5"), row("a", "6")];
    const next = [row("a", "6"), row("a", "5")];
    const d = diffRows(current, next);
    expect(d.unchanged).toHaveLength(2);
    expect(d.changed).toHaveLength(0);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
  });

  it("still reports a genuine value change on a single same-key row", () => {
    const d = diffRows([row("a", "5")], [row("a", "9")]);
    expect(d.changed).toHaveLength(1);
    expect(d.unchanged).toHaveLength(0);
  });
});

describe("computeImportDiff", () => {
  it("is all-unchanged (no changes) when the fresh extraction equals persisted", () => {
    const persisted = input({
      records: [rec({ external_id: "obs:glucose" })],
    });
    const snap = snapshotFromPersistInput(persisted);
    const diff = computeImportDiff(snap, snap);
    expect(diff.hasChanges).toBe(false);
    expect(diff.totals.unchanged).toBe(1);
    expect(diff.totals.added + diff.totals.removed + diff.totals.changed).toBe(
      0
    );
  });

  it("flags a changed value on the same external_id as a CHANGE, not add+remove", () => {
    const current = snapshotFromPersistInput(
      input({ records: [rec({ external_id: "obs:glucose", value: "95" })] })
    );
    const next = snapshotFromPersistInput(
      input({
        records: [
          rec({ external_id: "obs:glucose", value: "110", value_num: 110 }),
        ],
      })
    );
    const diff = computeImportDiff(current, next);
    expect(diff.hasChanges).toBe(true);
    expect(diff.totals.changed).toBe(1);
    expect(diff.totals.added).toBe(0);
    expect(diff.totals.removed).toBe(0);
    const recEntity = diff.entities.find((e) => e.entity === "records")!;
    expect(recEntity.changed[0].before.label).toContain("95");
    expect(recEntity.changed[0].after.label).toContain("110");
  });

  it("reports added and removed rows across a reprocess", () => {
    const current = snapshotFromPersistInput(
      input({ records: [rec({ external_id: "obs:a", name: "A" })] })
    );
    const next = snapshotFromPersistInput(
      input({ records: [rec({ external_id: "obs:b", name: "B" })] })
    );
    const diff = computeImportDiff(current, next);
    expect(diff.totals.added).toBe(1);
    expect(diff.totals.removed).toBe(1);
  });

  it("omits entity sections with no rows on either side", () => {
    const diff = computeImportDiff(emptySnapshot(), emptySnapshot());
    expect(diff.entities).toEqual([]);
    expect(diff.hasChanges).toBe(false);
  });
});

describe("snapshotFromPersistInput medications", () => {
  it("derives one medication per cleaned drug name from prescription records", () => {
    const snap = snapshotFromPersistInput(
      input({
        records: [
          rec({ category: "prescription", name: "Lisinopril 10 mg" }),
          rec({ category: "prescription", name: "Lisinopril" }),
          rec({ category: "prescription", name: "Metformin 500 mg" }),
          rec({ category: "lab", name: "Glucose" }),
        ],
      })
    );
    // "Lisinopril 10 mg" and "Lisinopril" collapse to one; Metformin is separate.
    expect(snap.medications.map((m) => m.key).sort()).toEqual([
      "med:lisinopril",
      "med:metformin",
    ]);
  });
});

describe("medicationRow", () => {
  it("strips strength/form to a stable grouping key", () => {
    expect(medicationRow("Lisinopril 10 mg tablet").key).toBe("med:lisinopril");
  });
});

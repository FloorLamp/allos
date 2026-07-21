import { describe, it, expect } from "vitest";
import {
  recentLabDirectionlessStatus,
  recentLabHighlights,
} from "@/lib/recent-labs";
import type { MedicalRecord } from "@/lib/types";

// The dashboard's recent-labs highlight selection (issue #313): of the current
// lab/biomarker readings, out-of-range floats to the top, then newest-first, then
// take the first `limit`, flattened to display rows.

type LabInput = Parameters<typeof recentLabHighlights>[0][number];

function rec(over: Partial<MedicalRecord> = {}): LabInput {
  return {
    category: "lab",
    flag: "normal",
    date: "2026-01-01",
    canonical_name: null,
    name: "Glucose",
    value: "90",
    unit: "mg/dL",
    ...over,
  };
}

describe("recentLabHighlights", () => {
  it("keeps only lab and biomarker categories", () => {
    const rows = recentLabHighlights([
      rec({ category: "lab", name: "A" }),
      rec({ category: "biomarker", name: "B" }),
      rec({ category: "vitals", name: "C" }),
      rec({ category: "scan", name: "D" }),
      rec({ category: "prescription", name: "E" }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["A", "B"]);
  });

  it("floats out-of-range (non-normal, non-null) flags to the top", () => {
    const rows = recentLabHighlights([
      rec({ name: "Normal", flag: "normal", date: "2026-05-01" }),
      rec({ name: "High", flag: "high", date: "2026-01-01" }),
    ]);
    // High is older but flagged, so it leads.
    expect(rows.map((r) => r.name)).toEqual(["High", "Normal"]);
  });

  it("treats a null flag as not-flagged (ranks below a flagged row)", () => {
    const rows = recentLabHighlights([
      rec({ name: "Unflagged", flag: null, date: "2026-05-01" }),
      rec({ name: "Low", flag: "low", date: "2026-01-01" }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Low", "Unflagged"]);
  });

  it("breaks ties within the same flag class newest-first", () => {
    const rows = recentLabHighlights([
      rec({ name: "Older", flag: "normal", date: "2026-01-01" }),
      rec({ name: "Newer", flag: "normal", date: "2026-06-01" }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Newer", "Older"]);
  });

  it("limits to 6 by default and honors an explicit limit", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      rec({ name: `M${i}`, date: `2026-01-${String(i + 1).padStart(2, "0")}` })
    );
    expect(recentLabHighlights(many)).toHaveLength(6);
    expect(recentLabHighlights(many, 3)).toHaveLength(3);
  });

  it("uses a trimmed canonical_name over name, with a biomarker deep-link", () => {
    const [row] = recentLabHighlights([
      rec({ name: "raw name", canonical_name: "  LDL Cholesterol  " }),
    ]);
    expect(row.name).toBe("LDL Cholesterol");
    expect(row.href).toBe("/biomarkers/view?name=LDL%20Cholesterol");
  });

  it("links to the biomarkers index when there is no canonical name", () => {
    const [row] = recentLabHighlights([
      rec({ name: "Glucose", canonical_name: null }),
    ]);
    expect(row.name).toBe("Glucose");
    expect(row.href).toBe("/results/biomarkers");
  });

  it("does not mutate the input array order", () => {
    const input = [
      rec({ name: "A", flag: "normal", date: "2026-01-01" }),
      rec({ name: "B", flag: "high", date: "2026-02-01" }),
    ];
    recentLabHighlights(input);
    expect(input.map((r) => r.name)).toEqual(["A", "B"]);
  });
});

describe("recentLabDirectionlessStatus", () => {
  it("labels every valid status that cannot carry a directional caret", () => {
    expect(recentLabDirectionlessStatus("abnormal")).toEqual({
      label: "Abnormal",
      tone: "bad",
    });
    expect(recentLabDirectionlessStatus("non-optimal")).toEqual({
      label: "Non-optimal",
      tone: "warn",
    });
    expect(recentLabDirectionlessStatus("immune")).toEqual({
      label: "Immune",
      tone: "default",
    });
  });

  it("leaves directional and normal flags to MedicalValue", () => {
    expect(recentLabDirectionlessStatus("high")).toBeNull();
    expect(recentLabDirectionlessStatus("non-optimal-low")).toBeNull();
    expect(recentLabDirectionlessStatus("normal")).toBeNull();
    expect(recentLabDirectionlessStatus(null)).toBeNull();
  });
});

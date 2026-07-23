import { describe, it, expect } from "vitest";
import { recentLabHighlights, recentLabStatus } from "@/lib/recent-labs";
import { flagLabel, flagTone } from "@/lib/reference-range";
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
  it("keeps only lab category (#1076)", () => {
    const rows = recentLabHighlights([
      rec({ category: "lab", name: "A" }),
      // Vitals, screening instruments, derived bio-age, immutable facts, and the
      // emptied legacy `biomarker` bucket are NOT recent labs — each has its own home.
      rec({ category: "biomarker", name: "B" }),
      rec({ category: "vitals", name: "C" }),
      rec({ category: "scan", name: "D" }),
      rec({ category: "prescription", name: "E" }),
      rec({ category: "instrument", name: "F" }),
      rec({ category: "derived", name: "G" }),
      rec({ category: "reference", name: "H" }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["A"]);
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

  // #1216: the recency floor. Without a `todayStr` no age can be computed, so no
  // row is claimed stale; with one, a reading older than the year window is flagged
  // stale (still surfaced — an unresolved abnormal never expires — but labeled).
  it("flags no row stale when no todayStr is supplied", () => {
    const rows = recentLabHighlights([
      rec({ name: "Old", date: "2010-01-01" }),
    ]);
    expect(rows[0].stale).toBe(false);
  });

  it("marks a reading older than the year floor as stale", () => {
    const today = "2026-07-15";
    const rows = recentLabHighlights(
      [
        rec({ name: "Fresh", date: "2026-07-01" }),
        rec({ name: "Aged", date: "2024-01-01" }),
      ],
      6,
      today
    );
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.stale]));
    expect(byName["Fresh"]).toBe(false);
    expect(byName["Aged"]).toBe(true);
  });

  it("keeps a stale flagged marker in the list, labeled not hidden", () => {
    const today = "2026-07-15";
    const rows = recentLabHighlights(
      [rec({ name: "OldAbnormal", flag: "abnormal", date: "2022-01-01" })],
      6,
      today
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].stale).toBe(true);
  });
});

describe("recentLabStatus (the non-color channel, #1220)", () => {
  it("labels the directionless/qualitative statuses", () => {
    expect(recentLabStatus("abnormal")).toEqual({
      label: "Abnormal",
      tone: "bad",
    });
    expect(recentLabStatus("non-optimal")).toEqual({
      label: "Non-optimal",
      tone: "warn",
    });
    expect(recentLabStatus("immune")).toEqual({
      label: "Immune",
      tone: "default",
    });
  });

  it("labels directional flags too — the caret's severity must not be color-only", () => {
    expect(recentLabStatus("high")).toEqual({ label: "High", tone: "bad" });
    expect(recentLabStatus("low")).toEqual({ label: "Low", tone: "bad" });
    expect(recentLabStatus("non-optimal-high")).toEqual({
      label: "Above optimal",
      tone: "warn",
    });
    expect(recentLabStatus("non-optimal-low")).toEqual({
      label: "Below optimal",
      tone: "warn",
    });
  });

  it("agrees with the #306 flagLabel/flagTone chokepoint for every non-normal flag", () => {
    const flags = [
      "high",
      "low",
      "abnormal",
      "non-optimal",
      "non-optimal-high",
      "non-optimal-low",
      "immune",
    ] as const;
    for (const f of flags) {
      expect(recentLabStatus(f)).toEqual({
        label: flagLabel(f),
        tone: flagTone(f),
      });
    }
  });

  it("leaves normal/unflagged rows unlabeled (no judgment to announce)", () => {
    expect(recentLabStatus("normal")).toBeNull();
    expect(recentLabStatus(null)).toBeNull();
  });
});

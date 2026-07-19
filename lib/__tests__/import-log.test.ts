import { describe, it, expect } from "vitest";
import {
  documentLogStatus,
  jobLogStatus,
  statusBadge,
  documentFormatLabel,
  jobTitle,
  jobFormatLabel,
  isProvenanceMismatch,
  interleaveImportLog,
  producedTotal,
  formatRawExtraction,
  type DocumentProducedCounts,
} from "../import-log";
import { EMPTY_PRODUCED_COUNTS } from "./produced-counts-fixture";

describe("documentLogStatus", () => {
  it("maps pending/processing to processing", () => {
    expect(documentLogStatus("pending")).toBe("processing");
    expect(documentLogStatus("processing")).toBe("processing");
  });
  it("passes through done/failed/skipped", () => {
    expect(documentLogStatus("done")).toBe("done");
    expect(documentLogStatus("failed")).toBe("failed");
    expect(documentLogStatus("skipped")).toBe("skipped");
  });
  it("defaults unknown to processing", () => {
    expect(documentLogStatus("weird")).toBe("processing");
  });
});

describe("jobLogStatus", () => {
  it("maps ready to partial (awaiting review)", () => {
    expect(jobLogStatus("ready")).toBe("partial");
  });
  it("maps processing/committing to processing", () => {
    expect(jobLogStatus("processing")).toBe("processing");
    expect(jobLogStatus("committing")).toBe("processing");
  });
  it("passes through failed/skipped", () => {
    expect(jobLogStatus("failed")).toBe("failed");
    expect(jobLogStatus("skipped")).toBe("skipped");
  });
});

describe("statusBadge", () => {
  it("assigns a label and tone to every status", () => {
    expect(statusBadge("done")).toEqual({ label: "done", tone: "green" });
    expect(statusBadge("partial")).toEqual({ label: "partial", tone: "amber" });
    expect(statusBadge("processing").tone).toBe("amber");
    expect(statusBadge("failed").tone).toBe("rose");
    expect(statusBadge("skipped").tone).toBe("slate");
  });
});

describe("documentFormatLabel", () => {
  it("prefers doc_type", () => {
    expect(
      documentFormatLabel({
        doc_type: "lab",
        source: "Quest",
        filename: "a.pdf",
      })
    ).toBe("lab");
  });
  it("falls back to source, then extension, then generic", () => {
    expect(
      documentFormatLabel({
        doc_type: null,
        source: "Quest",
        filename: "a.pdf",
      })
    ).toBe("Quest");
    expect(
      documentFormatLabel({ doc_type: "", source: "  ", filename: "labs.pdf" })
    ).toBe("PDF");
    expect(
      documentFormatLabel({ doc_type: null, source: null, filename: "noext" })
    ).toBe("Document");
  });
});

describe("job labels", () => {
  it("titles and formats workouts/biomarkers", () => {
    expect(jobTitle("workouts")).toBe("Pasted workouts");
    expect(jobTitle("biomarkers")).toBe("Pasted labs");
    expect(jobFormatLabel("workouts")).toContain("Workouts");
    expect(jobFormatLabel("biomarkers")).toContain("Biomarkers");
  });
});

describe("isProvenanceMismatch", () => {
  it("does not flag when the document has no patient name", () => {
    expect(isProvenanceMismatch(null, ["Jane Doe"])).toBe(false);
    expect(isProvenanceMismatch("", ["Jane Doe"])).toBe(false);
  });
  it("does not flag when there is no known name to compare", () => {
    expect(isProvenanceMismatch("John Smith", [])).toBe(false);
    expect(isProvenanceMismatch("John Smith", [null, ""])).toBe(false);
  });
  it("does not flag a lenient match (middle initial / name order)", () => {
    expect(isProvenanceMismatch("John A. Smith", ["John Smith"])).toBe(false);
    expect(isProvenanceMismatch("Smith, John", ["John Smith"])).toBe(false);
  });
  it("flags a genuinely different patient", () => {
    expect(isProvenanceMismatch("Robert Jones", ["John Smith"])).toBe(true);
  });
  it("matches against any of several known names", () => {
    expect(isProvenanceMismatch("Jane Doe", ["John Smith", "Jane Doe"])).toBe(
      false
    );
  });
});

describe("interleaveImportLog", () => {
  it("sorts newest-first, documents before jobs on a tie, then id desc", () => {
    const out = interleaveImportLog([
      { kind: "job", id: 5, sortTime: "2026-01-01 10:00:00" },
      { kind: "document", id: 2, sortTime: "2026-01-02 09:00:00" },
      { kind: "document", id: 7, sortTime: "2026-01-01 10:00:00" },
      { kind: "job", id: 9, sortTime: "2026-01-01 10:00:00" },
    ]);
    expect(out.map((e) => `${e.kind}:${e.id}`)).toEqual([
      "document:2", // newest date
      "document:7", // tie: document before job
      "job:9", // tie among jobs: id desc
      "job:5",
    ]);
  });
});

describe("producedTotal", () => {
  it("is zero for an empty import", () => {
    expect(producedTotal(EMPTY_PRODUCED_COUNTS)).toBe(0);
  });
  it("sums every produced kind EXCEPT providers (which extracted_count also excludes)", () => {
    const counts: DocumentProducedCounts = {
      recordsByCategory: [
        { category: "lab", count: 12 },
        { category: "prescription", count: 2 },
      ],
      immunizations: 3,
      allergies: 1,
      conditions: 1,
      encounters: 1,
      procedures: 1,
      familyHistory: 1,
      carePlanItems: 1,
      careGoals: 1,
      genomicVariants: 1,
      imagingStudies: 1,
      opticalPrescriptions: 1,
      appointments: 1,
      medications: 2,
      bodyMetrics: 1,
      heightSamples: 1,
      headCircSamples: 1,
      providers: 4,
    };
    // 14 records + 3 imms + 11 clinical singles (incl. 1 appointment + 1 genomic
    // variant + 1 imaging study + 1 optical prescription) + 2 meds + 3 body samples.
    expect(producedTotal(counts)).toBe(14 + 3 + 11 + 2 + 3);
  });
});

describe("formatRawExtraction", () => {
  it("returns null for empty/absent raw", () => {
    expect(formatRawExtraction(null)).toBeNull();
    expect(formatRawExtraction("   ")).toBeNull();
  });
  it("pretty-prints JSON", () => {
    expect(formatRawExtraction('{"a":1}')).toBe('{\n  "a": 1\n}');
  });
  it("returns non-JSON text as-is", () => {
    expect(formatRawExtraction("just text")).toBe("just text");
  });
  it("truncates a huge blob", () => {
    const big = "x".repeat(60_000);
    const out = formatRawExtraction(big)!;
    expect(out.length).toBeLessThan(60_000);
    expect(out).toContain("truncated");
  });
});

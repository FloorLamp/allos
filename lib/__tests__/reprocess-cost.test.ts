import { describe, it, expect } from "vitest";
import {
  isDeterministicReprocess,
  computeReprocessCost,
  formatReprocessCost,
} from "@/lib/reprocess-cost";

// Deterministic-vs-AI classification is keyed on the persisted health-record source.
describe("isDeterministicReprocess", () => {
  it("treats the three health-record sources as deterministic (no AI)", () => {
    for (const source of ["ccda", "smart-health-card", "fhir"]) {
      expect(
        isDeterministicReprocess({ source, mime_type: "application/xml" })
      ).toBe(true);
    }
  });

  it("treats a scan/PDF (null or lab source) as an AI extraction", () => {
    expect(
      isDeterministicReprocess({ source: null, mime_type: "application/pdf" })
    ).toBe(false);
    expect(
      isDeterministicReprocess({ source: "Quest Labs", mime_type: "image/png" })
    ).toBe(false);
  });
});

describe("computeReprocessCost", () => {
  const doc = (
    source: string | null
  ): { source: string | null; mime_type: string | null } => ({
    source,
    mime_type: null,
  });

  it("splits a mixed set and reports the quota that remains after the run", () => {
    // 9 health records + 5 scans/PDFs, 2 units already used today (48 remaining).
    const docs = [
      ...Array.from({ length: 9 }, () => doc("ccda")),
      ...Array.from({ length: 5 }, () => doc(null)),
    ];
    const cost = computeReprocessCost(docs, 2, 50);
    expect(cost).toMatchObject({
      total: 14,
      deterministic: 9,
      ai: 5,
      quotaLimit: 50,
      quotaRemaining: 48,
      aiWithinQuota: 5,
      aiOverQuota: 0,
      quotaAfter: 43,
      noAi: false,
    });
    expect(formatReprocessCost(cost)).toBe(
      "14 documents: 9 health records (re-imported instantly, no AI) · 5 scans/PDFs (5 AI extractions — 43 of 50 daily remaining)"
    );
  });

  it("flags an all-deterministic set as noAi (skip-confirm fast path)", () => {
    const docs = [doc("ccda"), doc("fhir"), doc("smart-health-card")];
    const cost = computeReprocessCost(docs, 0, 50);
    expect(cost.ai).toBe(0);
    expect(cost.noAi).toBe(true);
    expect(formatReprocessCost(cost)).toBe(
      "3 documents: 3 health records (re-imported instantly, no AI)"
    );
  });

  it("handles an all-AI set with fresh quota", () => {
    const docs = [doc(null), doc(null), doc("Quest Labs")];
    const cost = computeReprocessCost(docs, 0, 50);
    expect(cost).toMatchObject({
      total: 3,
      deterministic: 0,
      ai: 3,
      aiWithinQuota: 3,
      aiOverQuota: 0,
      quotaAfter: 47,
      noAi: false,
    });
    expect(formatReprocessCost(cost)).toBe(
      "3 documents: 3 scans/PDFs (3 AI extractions — 47 of 50 daily remaining)"
    );
  });

  it("shows the partial dispatch + skipped split when the cap is hit mid-run", () => {
    // 4 AI docs but only 3 units of quota left → 3 dispatch, 1 skipped.
    const docs = Array.from({ length: 4 }, () => doc(null));
    const cost = computeReprocessCost(docs, 47, 50);
    expect(cost).toMatchObject({
      ai: 4,
      quotaRemaining: 3,
      aiWithinQuota: 3,
      aiOverQuota: 1,
      quotaAfter: 0,
    });
    expect(formatReprocessCost(cost)).toBe(
      "4 documents: 4 scans/PDFs (3 AI extractions now — 1 skipped, daily limit of 50 reached)"
    );
  });

  it("shows the all-skipped shape when the quota is already exhausted", () => {
    const docs = [doc(null), doc("ccda")];
    const cost = computeReprocessCost(docs, 50, 50);
    expect(cost).toMatchObject({
      deterministic: 1,
      ai: 1,
      quotaRemaining: 0,
      aiWithinQuota: 0,
      aiOverQuota: 1,
    });
    expect(formatReprocessCost(cost)).toBe(
      "2 documents: 1 health record (re-imported instantly, no AI) · 1 scan/PDF (daily AI limit of 50 reached — all 1 skipped)"
    );
  });

  it("reports an empty set", () => {
    const cost = computeReprocessCost([], 0, 50);
    expect(cost.total).toBe(0);
    expect(cost.noAi).toBe(true);
    expect(formatReprocessCost(cost)).toBe(
      "No uploaded documents to re-extract."
    );
  });
});

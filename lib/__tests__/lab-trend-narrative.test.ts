import { describe, it, expect } from "vitest";
import {
  buildLabTrendPrompt,
  composeLabTrendOffline,
  hasLabTrendSignal,
  LAB_TREND_SYSTEM,
  type LabTrendInput,
} from "../lab-trend-narrative";

// All values here are synthetic (fictional analytes/meds/conditions) — no PHI.
function input(over: Partial<LabTrendInput> = {}): LabTrendInput {
  return {
    today: "2026-07-09",
    findings: [
      {
        label: "LDL Cholesterol",
        detail: "trending toward high range",
        tone: "caution",
      },
    ],
    readings: [
      {
        name: "LDL Cholesterol",
        date: "2026-07-01",
        value: "145",
        unit: "mg/dL",
        reference: "<100",
        flag: "high",
      },
    ],
    medications: [
      { name: "Test Statin", startedOn: "2026-01-01", stoppedOn: "2026-05-01" },
    ],
    conditions: [
      { name: "Hyperlipidemia", status: "active", onsetDate: "2025-11-01" },
    ],
    ...over,
  };
}

describe("hasLabTrendSignal", () => {
  it("is true when there are findings or readings", () => {
    expect(hasLabTrendSignal(input())).toBe(true);
    expect(hasLabTrendSignal(input({ findings: [] }))).toBe(true); // still readings
  });

  it("is false with neither findings nor readings", () => {
    expect(hasLabTrendSignal(input({ findings: [], readings: [] }))).toBe(
      false
    );
  });
});

describe("buildLabTrendPrompt", () => {
  it("includes movements, timeline, conditions, and fenced readings", () => {
    const p = buildLabTrendPrompt(input());
    expect(p).toContain("as of 2026-07-09");
    expect(p).toContain("## Detected biomarker movements");
    expect(p).toContain("- LDL Cholesterol: trending toward high range");
    expect(p).toContain("## Medication timeline");
    expect(p).toContain("Test Statin (started 2026-01-01, stopped 2026-05-01)");
    expect(p).toContain("## Conditions");
    expect(p).toContain("Hyperlipidemia (active, since 2025-11-01)");
    // Readings are fenced as untrusted document data.
    expect(p).toContain("<<<BEGIN UNTRUSTED EXTRACTED DOCUMENT DATA>>>");
    expect(p).toContain(
      "- 2026-07-01 LDL Cholesterol: 145 mg/dL (ref <100) [high]"
    );
    expect(p).toContain("<<<END UNTRUSTED EXTRACTED DOCUMENT DATA>>>");
  });

  it("renders sensible placeholders when a section is empty", () => {
    const p = buildLabTrendPrompt(
      input({ medications: [], conditions: [], findings: [] })
    );
    expect(p).toContain("None flagged by the trend engine.");
    expect(p).toContain("No medications recorded.");
    expect(p).toContain("None recorded.");
  });

  it("marks an ongoing medication (no stop date) as ongoing", () => {
    const p = buildLabTrendPrompt(
      input({
        medications: [{ name: "Test Med", startedOn: "2026-02-01" }],
      })
    );
    expect(p).toContain("Test Med (started 2026-02-01, ongoing)");
  });
});

describe("composeLabTrendOffline", () => {
  it("summarizes the movements and points at a clinician", () => {
    const out = composeLabTrendOffline(input());
    expect(out).toContain("LDL Cholesterol (trending toward high range)");
    expect(out).toContain("medication timeline (Test Statin)");
  });

  it("falls back to readings when there are no engine findings", () => {
    const out = composeLabTrendOffline(input({ findings: [] }));
    expect(out).toContain("Recent notable readings:");
    expect(out).toContain("LDL Cholesterol 145 mg/dL (high)");
  });

  it("degrades to one line when there is nothing to interpret", () => {
    const out = composeLabTrendOffline(input({ findings: [], readings: [] }));
    expect(out).toContain("No notable lab trends to interpret");
    expect(out).not.toContain("undefined");
  });

  it("never claims causation the dates don't show (no key/no network)", () => {
    // The offline composer only lists facts; it must not fabricate a link.
    const out = composeLabTrendOffline(input());
    expect(out).not.toMatch(/because|caused by/i);
  });
});

describe("LAB_TREND_SYSTEM", () => {
  it("is diagnosis-averse and names no model", () => {
    expect(LAB_TREND_SYSTEM).toContain("clinician");
    expect(LAB_TREND_SYSTEM).toMatch(/not diagnosing|NOT diagnosing/);
    expect(LAB_TREND_SYSTEM).not.toMatch(/claude|gpt|sonnet|opus/i);
  });
});

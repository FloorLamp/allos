// PURE TIER (npm test) — the finding explainer (issue #878, Phase 1).
//
// Pins the payload-ONLY contract: the prompt and the offline fallback render ONLY the
// reason payload's fields, so a fact the payload doesn't carry cannot appear (test:
// payload-absent field cannot appear in output). Also the reason sanitizer (a
// client-echoed payload can't smuggle an unknown code) and the offline structured
// composition (the keyless floor).

import { describe, it, expect } from "vitest";
import {
  buildExplainPrompt,
  composeOfflineExplanation,
  sanitizeReasons,
  type ExplainInput,
} from "@/lib/explain-finding";
import type { Reason } from "@/lib/reasons";

const REASONS: Reason[] = [
  {
    code: "biomarker-flagged",
    text: "Below optimal",
  },
  {
    code: "risk-elevated",
    text: "Family history of early heart disease raises LDL concern",
    source: "ACC/AHA 2018 cholesterol guideline",
  },
];

const INPUT: ExplainInput = {
  title: "LDL Cholesterol",
  detail: "130 mg/dL — Below optimal",
  reasons: REASONS,
};

describe("buildExplainPrompt — payload only", () => {
  it("includes every reason's text and cited source", () => {
    const p = buildExplainPrompt(INPUT);
    expect(p).toContain("Below optimal");
    expect(p).toContain(
      "Family history of early heart disease raises LDL concern"
    );
    expect(p).toContain("ACC/AHA 2018 cholesterol guideline");
    expect(p).toContain("LDL Cholesterol");
  });

  it("cannot contain a fact absent from the payload", () => {
    const p = buildExplainPrompt(INPUT);
    // A threshold/diagnosis the payload never carried must not appear — the prompt is
    // assembled from the reasons alone, so there is nowhere for it to come from.
    expect(p).not.toContain("statin");
    expect(p).not.toContain("70 mg/dL");
    // Every non-boilerplate line traces to a payload field.
    expect(p).toContain("using only the reasons above");
  });
});

describe("composeOfflineExplanation — the structured floor", () => {
  it("renders each reason (and its source) verbatim from the payload", () => {
    const text = composeOfflineExplanation(INPUT);
    expect(text).toContain("LDL Cholesterol is flagged because:");
    expect(text).toContain("Below optimal");
    expect(text).toContain("Source: ACC/AHA 2018 cholesterol guideline");
  });

  it("falls back to the detail when there are no reasons", () => {
    const text = composeOfflineExplanation({
      title: "Fasting Glucose",
      detail: "High",
      reasons: [],
    });
    expect(text).toContain("Fasting Glucose");
    expect(text).toContain("High");
  });

  it("never invents a fact absent from the payload", () => {
    const text = composeOfflineExplanation(INPUT);
    expect(text).not.toContain("statin");
    expect(text).not.toContain("diabetes");
  });
});

describe("sanitizeReasons — closed-union guard", () => {
  it("drops an unknown reason code and an empty-text reason", () => {
    const cleaned = sanitizeReasons([
      { code: "biomarker-flagged", text: "Low" },
      { code: "totally-made-up", text: "should be dropped" },
      { code: "risk-elevated", text: "" },
      { code: "situation-active", text: "Due because Illness is active" },
    ]);
    expect(cleaned.map((r) => r.code)).toEqual([
      "biomarker-flagged",
      "situation-active",
    ]);
  });

  it("keeps a citation source when present, omits it otherwise", () => {
    const cleaned = sanitizeReasons([
      { code: "risk-elevated", text: "cited", source: "Some guideline" },
      { code: "biomarker-flagged", text: "no source", source: "  " },
    ]);
    expect(cleaned[0].source).toBe("Some guideline");
    expect(cleaned[1].source).toBeUndefined();
  });

  it("returns an empty list for non-array input", () => {
    expect(sanitizeReasons(null)).toEqual([]);
    expect(sanitizeReasons("nope")).toEqual([]);
  });
});

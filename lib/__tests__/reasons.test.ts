import { describe, it, expect } from "vitest";
import {
  riskReasonsFrom,
  plainRiskReasons,
  flaggedReason,
  situationReason,
  concatReasons,
  primaryReason,
  type Reason,
} from "../reasons";

describe("riskReasonsFrom", () => {
  it("maps sourced risk lines to risk-elevated reasons carrying the citation", () => {
    expect(
      riskReasonsFrom([
        {
          text: "Family history of heart disease",
          source: "ACC/AHA (informational)",
        },
      ])
    ).toEqual([
      {
        code: "risk-elevated",
        text: "Family history of heart disease",
        source: "ACC/AHA (informational)",
      },
    ]);
  });

  it("is empty for no sourced lines", () => {
    expect(riskReasonsFrom([])).toEqual([]);
  });
});

describe("plainRiskReasons", () => {
  it("maps plain strings to risk-elevated reasons with no source", () => {
    expect(plainRiskReasons(["Managing diabetes"])).toEqual([
      { code: "risk-elevated", text: "Managing diabetes" },
    ]);
  });
});

describe("flaggedReason", () => {
  it("carries the flag label as its text, with no source", () => {
    const r = flaggedReason("low");
    expect(r.code).toBe("biomarker-flagged");
    expect(r.text).toBe("Low");
    expect(r.source).toBeUndefined();
  });
});

describe("situationReason", () => {
  it("names the active situation", () => {
    expect(situationReason("Illness")).toEqual({
      code: "situation-active",
      text: "Due because Illness is active",
    });
  });
});

describe("concatReasons", () => {
  it("preserves order and returns undefined when empty", () => {
    expect(concatReasons([], [])).toBeUndefined();
    const a: Reason = { code: "risk-elevated", text: "A" };
    const b: Reason = { code: "biomarker-flagged", text: "B" };
    expect(concatReasons([a], [b])).toEqual([a, b]);
  });
});

describe("primaryReason", () => {
  it("returns the first reason, or null", () => {
    expect(primaryReason(null)).toBeNull();
    expect(primaryReason([])).toBeNull();
    const a: Reason = { code: "risk-elevated", text: "lead" };
    expect(primaryReason([a, { code: "biomarker-flagged", text: "x" }])).toBe(
      a
    );
  });
});

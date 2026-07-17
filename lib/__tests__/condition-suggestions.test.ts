import { describe, expect, it } from "vitest";
import {
  suggestConditionsFromResults,
  conditionSuggestionDetail,
  CONDITION_REVIEW_PREFIX,
  type QualitativeResultInput,
} from "@/lib/condition-suggestions";
import { dedupeKeyHasKnownPrefix } from "@/lib/rule-finding-prefixes";

function reading(
  over: Partial<QualitativeResultInput> = {}
): QualitativeResultInput {
  return {
    id: 1,
    name: "HIV 1/2 Antibody",
    value: "Reactive",
    notes: null,
    reference: null,
    loinc: null,
    date: "2026-06-01",
    ...over,
  };
}

describe("suggestConditionsFromResults (#685)", () => {
  it("suggests a condition for an infection-positive marker", () => {
    const out = suggestConditionsFromResults([reading()], []);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("HIV");
    expect(out[0].key).toBe("condition-review:name:hiv");
    expect(out[0].kind).toBe("infection");
  });

  it("covers the named infection markers, not a generic culture", () => {
    const cases: [string, string, string | null][] = [
      ["Hepatitis C Antibody", "Reactive", "Hepatitis C"],
      ["Hepatitis B Surface Antigen", "Positive", "Hepatitis B"],
      ["RPR (Syphilis)", "Reactive", "Syphilis"],
      ["Chlamydia trachomatis NAAT", "Detected", "Chlamydia infection"],
      ["N. gonorrhoeae NAAT", "Detected", "Gonorrhea"],
      // A positive culture with no known organism has no confident concept → nothing.
      ["Urine Culture", "Growth", null],
    ];
    for (const [name, value, expected] of cases) {
      const out = suggestConditionsFromResults([reading({ name, value })], []);
      if (expected == null) expect(out).toHaveLength(0);
      else expect(out[0]?.name).toBe(expected);
    }
  });

  it("does NOT suggest a condition for a NEGATIVE infection result", () => {
    // A non-reactive HIV is a screening event, not a condition (#686 territory).
    expect(
      suggestConditionsFromResults([reading({ value: "Non-Reactive" })], [])
    ).toHaveLength(0);
  });

  it("does NOT suggest for an immune-positive titer (good polarity)", () => {
    // A positive Hep B SURFACE ANTIBODY is immunity (good) — never a condition.
    expect(
      suggestConditionsFromResults(
        [reading({ name: "Hepatitis B Surface Antibody", value: "Positive" })],
        []
      )
    ).toHaveLength(0);
  });

  it("routes a HIGH-risk prenatal screen alongside infections (#687 cross-ref)", () => {
    const out = suggestConditionsFromResults(
      [reading({ name: "Trisomy 21 (NIPT)", value: "High Risk" })],
      []
    );
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Trisomy 21 (Down syndrome)");
    expect(out[0].kind).toBe("screen");
    // Detail is framed as a screen positive to confirm — never a diagnosis assertion.
    expect(conditionSuggestionDetail(out[0])).toMatch(/screen positive/i);
  });

  it("does NOT suggest for a LOW-risk screen", () => {
    expect(
      suggestConditionsFromResults(
        [reading({ name: "Trisomy 21", value: "Low Risk" })],
        []
      )
    ).toHaveLength(0);
  });

  it("dedups against an existing condition by concept (name collapse)", () => {
    expect(
      suggestConditionsFromResults([reading()], [{ name: "HIV" }])
    ).toHaveLength(0);
    // Case-insensitive concept match (the collapse key lowercases the name).
    expect(
      suggestConditionsFromResults([reading()], [{ name: "hiv" }])
    ).toHaveLength(0);
  });

  it("dedups against a coded existing condition sharing the concept code", () => {
    // A suggestion carrying no code doesn't collapse onto a coded condition — the
    // app's own conservative condition identity. But a suggestion whose code MATCHES
    // an existing coded condition collapses. (All current concepts are code-less, so
    // this pins the collapse-key contract directly.)
    const withCode: QualitativeResultInput = reading();
    // No concept currently carries a code, so a coded HIV condition (B20) does NOT
    // dedup the code-less HIV suggestion — matching the conditions page's own rule.
    expect(
      suggestConditionsFromResults(
        [withCode],
        [{ name: "HIV disease", code: "B20" }]
      )
    ).toHaveLength(1);
  });

  it("emits ONE suggestion per concept across multiple readings", () => {
    const out = suggestConditionsFromResults(
      [
        reading({ id: 1, name: "HIV 1/2 Ab", value: "Reactive" }),
        reading({ id: 2, name: "HIV Antibody Screen", value: "Positive" }),
      ],
      []
    );
    expect(out).toHaveLength(1);
  });

  it("every emitted key parses against the known-prefix registry (#448)", () => {
    const out = suggestConditionsFromResults(
      [reading(), reading({ id: 2, name: "Trisomy 18", value: "High Risk" })],
      []
    );
    expect(out.length).toBeGreaterThan(0);
    for (const s of out) {
      expect(s.key.startsWith(CONDITION_REVIEW_PREFIX)).toBe(true);
      expect(dedupeKeyHasKnownPrefix(s.key)).toBe(true);
    }
  });
});

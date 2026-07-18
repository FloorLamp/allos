// PURE TIER (npm test) — free-text symptom mapping parser (issue #877).
//
// The vocabulary-constrained parser over a CANNED model tool-output (the "fake
// client" fixture): the fever+cough+appetite sentence maps to 3 slugs + a temperature;
// an unmapped fragment yields the couldn't-map affordance; and NO out-of-vocabulary
// slug can survive the parse. No network — the model output is a fixture.

import { describe, it, expect } from "vitest";
import {
  buildSymptomVocabPrompt,
  mappingIsEmpty,
  parseSymptomMapping,
  type SymptomVocabulary,
} from "@/lib/symptom-text-map";

const VOCAB: SymptomVocabulary = {
  slugs: ["fever", "cough", "poor_appetite", "sore_throat", "headache"],
  labels: {
    fever: "Fever",
    cough: "Cough",
    poor_appetite: "Poor appetite",
    sore_throat: "Sore throat",
    headache: "Headache",
  },
  customNames: ["tummy ache"],
};

describe("parseSymptomMapping — the 2am sentence", () => {
  it("maps 'fever since lunch, croupy cough, wouldn't eat dinner' to 3 slugs + temp", () => {
    // What the Light tier returns for the canonical sentence.
    const modelOutput = {
      symptoms: [
        { slug: "fever", severity: null, note: "since lunch" },
        { slug: "cough", severity: null, note: "croupy" },
        { slug: "poor_appetite", severity: null, note: null },
      ],
      temperature: { value: 101.2, unit: "F" },
      unmapped: [],
      day: "today",
    };
    const m = parseSymptomMapping(modelOutput, VOCAB);
    expect(m.symptoms.map((s) => s.slug)).toEqual([
      "fever",
      "cough",
      "poor_appetite",
    ]);
    // Conservative severity: no explicit cue → default 1.
    expect(m.symptoms.every((s) => s.severity === 1)).toBe(true);
    expect(m.symptoms.find((s) => s.slug === "cough")?.note).toBe("croupy");
    expect(m.symptoms.every((s) => s.isCustom === false)).toBe(true);
    expect(m.temperature).toEqual({ value: 101.2, unit: "F" });
    expect(m.dayOffset).toBe(0);
    expect(mappingIsEmpty(m)).toBe(false);
  });

  it("raises severity only on an explicit cue", () => {
    const m = parseSymptomMapping(
      { symptoms: [{ slug: "headache", severity: 4 }] },
      VOCAB
    );
    expect(m.symptoms[0].severity).toBe(4);
  });

  it("clamps an out-of-range severity into 1..4", () => {
    const m = parseSymptomMapping(
      {
        symptoms: [
          { slug: "fever", severity: 9 },
          { slug: "cough", severity: 0 },
        ],
      },
      VOCAB
    );
    expect(m.symptoms.find((s) => s.slug === "fever")?.severity).toBe(4);
    expect(m.symptoms.find((s) => s.slug === "cough")?.severity).toBe(1);
  });
});

describe("parseSymptomMapping — vocabulary constraint", () => {
  it("drops an out-of-vocabulary slug (no invented clinical term can parse)", () => {
    const m = parseSymptomMapping(
      {
        symptoms: [
          { slug: "fever" },
          // A slug the model invented that is NOT in the vocabulary and has no
          // custom_name — it must not survive as a curated symptom.
          { slug: "acute_bronchiolitis" },
        ],
      },
      VOCAB
    );
    // "acute_bronchiolitis" isn't curated, so it becomes a proposed CUSTOM (isCustom),
    // never a curated slug — the curated set is closed.
    const curated = m.symptoms.filter((s) => !s.isCustom).map((s) => s.slug);
    expect(curated).toEqual(["fever"]);
    expect(
      m.symptoms.some((s) => s.slug === "acute_bronchiolitis" && !s.isCustom)
    ).toBe(false);
  });

  it("surfaces an unmapped fragment for the couldn't-map affordance", () => {
    const m = parseSymptomMapping(
      { symptoms: [{ slug: "cough" }], unmapped: ["croupy", ""] },
      VOCAB
    );
    expect(m.unmapped).toEqual(["croupy"]);
  });

  it("proposes a custom, reusing an existing custom name's spelling", () => {
    const m = parseSymptomMapping(
      {
        symptoms: [
          { slug: "custom", custom_name: "Tummy Ache" },
          { slug: "custom", custom_name: "dizziness" },
        ],
      },
      VOCAB
    );
    const tummy = m.symptoms.find((s) => s.slug === "tummy ache");
    // Reused existing custom → not flagged as brand-new.
    expect(tummy?.isCustom).toBe(false);
    const dizzy = m.symptoms.find((s) => s.slug === "dizziness");
    expect(dizzy?.isCustom).toBe(true);
  });

  it("ignores a malformed temperature", () => {
    const m = parseSymptomMapping(
      {
        symptoms: [{ slug: "fever" }],
        temperature: { value: "hot", unit: "F" },
      },
      VOCAB
    );
    expect(m.temperature).toBeUndefined();
  });
});

describe("buildSymptomVocabPrompt", () => {
  it("enumerates the slugs + labels and the profile's customs", () => {
    const p = buildSymptomVocabPrompt(VOCAB);
    expect(p).toContain("fever — Fever");
    expect(p).toContain("tummy ache");
  });
});

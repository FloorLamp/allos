import { describe, it, expect } from "vitest";
import canonicalSeed from "@/lib/canonical-biomarkers.json";
import { buildCanonicalIndex } from "@/lib/canonical-name";
import {
  PATIENT_STATE_QUALIFIERS,
  patientStateQualifiersIn,
  stateAwareCanonical,
  withoutPatientState,
} from "@/lib/patient-state-qualifiers";
import { normalizeResults } from "@/lib/medical-extract";
import { SYSTEM, TOOL } from "@/lib/medical-extract/prompt";

const vocab = (
  canonicalSeed as { biomarkers: { name: string }[] }
).biomarkers.map((b) => b.name);
const index = buildCanonicalIndex(vocab);

const guard = (snapped: string, printed: string, panel?: string | null) =>
  stateAwareCanonical(snapped, [printed, panel ?? null], index);

// One extracted row through the real normalizer against the real seeded vocabulary.
const row = (r: Record<string, unknown>) =>
  normalizeResults({ results: [{ category: "lab", ...r }] }, vocab)[0];

describe("patientStateQualifiersIn — what counts as a patient-state condition", () => {
  it("recognizes the conditions a report either prints or does not", () => {
    expect(patientStateQualifiersIn("Glucose, Fasting")[0].key).toBe("fasting");
    expect(patientStateQualifiersIn("Cortisol, Morning")[0].key).toBe(
      "time-of-day"
    );
    expect(patientStateQualifiersIn("Cortisol, AM")[0].key).toBe("time-of-day");
    expect(patientStateQualifiersIn("FBG")[0].key).toBe("fasting");
    expect(patientStateQualifiersIn("Glucose, Post-Prandial")[0].key).toBe(
      "prandial"
    );
    expect(patientStateQualifiersIn("Vancomycin, Trough")[0].key).toBe(
      "dose-timing"
    );
    expect(patientStateQualifiersIn("Aldosterone, Supine")[0].key).toBe(
      "posture"
    );
    expect(patientStateQualifiersIn("Lactate, Post-Exercise")[0].key).toBe(
      "exertion"
    );
  });

  it("does NOT fire on a qualifier that is intrinsic to the analyte's own identity", () => {
    // These are curated entries in their own right: the word is what the analyte IS,
    // not a condition layered onto another analyte. A detector loose enough to catch
    // them would demote "Resting Heart Rate" to "Heart Rate" and lose a real series.
    for (const name of [
      "Resting Heart Rate",
      "Peak Expiratory Flow",
      "LDL Peak Size",
      "Glucose, Gestational Screen (50 g)",
    ]) {
      expect(patientStateQualifiersIn(name)).toEqual([]);
    }
  });

  it("does NOT fire on a STRUCTURAL qualifier — specimen, collection protocol, laterality", () => {
    for (const name of [
      "Glucose, Urine",
      "Creatinine, Urine",
      "Urine Creatinine, Random", // random vs 24-hour is a collection protocol
      "Protein, Urine, 24-Hour",
      "Intraocular Pressure, Left Eye",
      "Hearing Threshold, Right Ear 4 kHz",
      "LDL Cholesterol, Direct", // method
    ]) {
      expect(patientStateQualifiersIn(name)).toEqual([]);
    }
  });

  it("no seeded canonical entry is flagged except the deliberately state-qualified ones", () => {
    // Three. #2371 coined the insulin twin of #2337's glucose pair so an index defined
    // on a fasting measurement had a name to REQUIRE; #2526's audit of the same shape
    // coined the cortisol one, where nothing but a two-word note ("Morning draw") said
    // the band belonged to the top of a diurnal rhythm. Each has the unqualified
    // sibling the guard below demotes onto.
    const flagged = vocab.filter((n) => patientStateQualifiersIn(n).length);
    expect(new Set(flagged)).toEqual(
      new Set(["Glucose, Fasting", "Insulin, Fasting", "Cortisol, Morning"])
    );
  });

  it("every flagged seeded entry demotes onto a name the vocabulary already has", () => {
    // The demotion target must be a real landing, not a coined fragment — so the
    // unqualified sibling has to exist. Holds as the curated dataset grows.
    for (const name of vocab.filter(
      (n) => patientStateQualifiersIn(n).length
    )) {
      const bare = withoutPatientState(name, patientStateQualifiersIn(name));
      expect(vocab).toContain(bare);
    }
  });
});

describe("stateAwareCanonical — an unprinted condition is dropped, a printed one is kept (#2338)", () => {
  it("drops a fasting qualifier the printed name never carried", () => {
    // The reported defect: two reports printed a bare "GLUCOSE" and the model filed
    // both as fasting, which selects the 99-vs-140 band and forks the series.
    expect(guard("Glucose, Fasting", "GLUCOSE")).toBe("Glucose");
  });

  it("drops it EVEN WHEN the panel makes the condition likely", () => {
    expect(guard("Glucose, Fasting", "GLUCOSE", "Diabetes Panel")).toBe(
      "Glucose"
    );
    expect(
      guard("Glucose, Fasting", "GLUCOSE", "Comprehensive Metabolic Panel")
    ).toBe("Glucose");
  });

  it("KEEPS it when the printed name states the condition", () => {
    expect(guard("Glucose, Fasting", "FBG (Glucose Fasting)")).toBe(
      "Glucose, Fasting"
    );
    expect(guard("Glucose, Fasting", "FASTING BLOOD SUGAR")).toBe(
      "Glucose, Fasting"
    );
    expect(guard("Glucose, Fasting", "FBG")).toBe("Glucose, Fasting");
  });

  it("KEEPS it when the panel heading states it verbatim", () => {
    // "Fasting Lipid Panel" is the document printing the condition, not implying it.
    expect(guard("Glucose, Fasting", "GLUCOSE", "Fasting Lipid Panel")).toBe(
      "Glucose, Fasting"
    );
  });

  it("leaves structural inference completely alone", () => {
    // The SAME reports that over-qualified serum glucose correctly read the urine
    // row's specimen off its section. That inference recovers what the layout says.
    expect(guard("Glucose, Urine", "GLUCOSE", "Urinalysis")).toBe(
      "Glucose, Urine"
    );
    expect(guard("Intraocular Pressure, Left Eye", "IOP", "Left Eye")).toBe(
      "Intraocular Pressure, Left Eye"
    );
    expect(guard("Creatinine, Urine", "CREATININE", "Urine Chemistry")).toBe(
      "Creatinine, Urine"
    );
  });

  it("drops a morning qualifier the printed name never carried (#2526)", () => {
    // The cortisol twin of the glucose case. A bare "CORTISOL" is a draw of unstated
    // timing, and the morning band would flag a normal evening value as low.
    expect(guard("Cortisol, Morning", "CORTISOL")).toBe("Cortisol");
    expect(guard("Cortisol, Morning", "CORTISOL", "Adrenal Panel")).toBe(
      "Cortisol"
    );
    // …and keeps it when the report prints the timing, in either spelling.
    expect(guard("Cortisol, Morning", "CORTISOL, AM")).toBe(
      "Cortisol, Morning"
    );
    expect(guard("Cortisol, Morning", "CORTISOL", "Morning Draw")).toBe(
      "Cortisol, Morning"
    );
  });

  it("demotes an unseeded analyte to its own unqualified name", () => {
    expect(guard("Insulin, Fasting", "INSULIN")).toBe("Insulin");
    expect(guard("Fasting C-Peptide", "C-PEPTIDE")).toBe("C-Peptide");
  });

  it("keeps the model's name when stripping would leave nothing to land on", () => {
    expect(guard("Fasting", "GLUCOSE")).toBe("Fasting");
    expect(guard("Glucose", "GLUCOSE")).toBe("Glucose");
  });
});

describe("normalizeResults applies the guard end-to-end", () => {
  it("a bare printed name lands unqualified even on a fasting-typical panel", () => {
    const r = row({
      name: "GLUCOSE",
      canonical_name: "Glucose, Fasting",
      panel: "Comprehensive Metabolic Panel",
      value: "92",
      value_num: 92,
      unit: "mg/dL",
    });
    expect(r.canonical_name).toBe("Glucose");
    // Nothing is lost: the printed name is retained verbatim.
    expect(r.name).toBe("GLUCOSE");
  });

  it("the model's own `fasting` answer does NOT rescue the qualifier", () => {
    // Deliberate: that field is the same judgment that over-qualified the name, so
    // accepting it as evidence would make the guard a no-op on exactly the documents
    // that motivated it. The attribute is still stored on its own column.
    const r = row({
      name: "GLUCOSE",
      canonical_name: "Glucose, Fasting",
      panel: "Chemistry",
      value: "92",
      value_num: 92,
      unit: "mg/dL",
      fasting: 1,
    });
    expect(r.canonical_name).toBe("Glucose");
    expect(r.fasting).toBe(1);
  });

  it("a document that PRINTS the condition still lands qualified", () => {
    const r = row({
      name: "FBG (Glucose Fasting)",
      canonical_name: "Glucose, Fasting",
      panel: "Diabetes Screen",
      value: "88",
      value_num: 88,
      unit: "mg/dL",
      fasting: 1,
    });
    expect(r.canonical_name).toBe("Glucose, Fasting");
  });

  it("specimen inference from the panel section is unchanged", () => {
    // Both rows print "GLUCOSE" on the same report — the serum one demotes, the
    // urinalysis one keeps the specimen the layout gave it.
    const rows = normalizeResults(
      {
        results: [
          {
            category: "lab",
            name: "GLUCOSE",
            canonical_name: "Glucose, Fasting",
            panel: "Chemistry",
            value: "92",
            value_num: 92,
            unit: "mg/dL",
          },
          {
            category: "lab",
            name: "GLUCOSE",
            canonical_name: "Glucose, Urine",
            panel: "Urinalysis",
            value: "NEGATIVE",
          },
        ],
      },
      vocab
    );
    expect(rows.map((r) => r.canonical_name)).toEqual([
      "Glucose",
      "Glucose, Urine",
    ]);
  });

  it("laterality inference from the layout is unchanged", () => {
    const r = row({
      category: "vitals",
      name: "IOP",
      canonical_name: "Intraocular Pressure, Left Eye",
      panel: "Left Eye",
      value: "15",
      value_num: 15,
      unit: "mmHg",
    });
    expect(r.canonical_name).toBe("Intraocular Pressure, Left Eye");
  });
});

describe("the extraction prompt states the rule", () => {
  it("the system prompt separates structural qualifiers from patient-state ones", () => {
    expect(SYSTEM).toMatch(
      /PATIENT-STATE condition the document does not print/
    );
    expect(SYSTEM).toContain("Glucose, Urine");
    expect(SYSTEM).toMatch(/NOT "Glucose, Fasting"/);
  });

  it("the canonical_name tool-schema field carries the rule too", () => {
    const props = TOOL.input_schema.properties as Record<string, any>;
    const description = props.results.items.properties.canonical_name
      .description as string;
    expect(description).toMatch(/patient-state/i);
    expect(description).toMatch(/fasting/i);
    expect(description).toMatch(/laterality/i);
  });

  it("every registered qualifier is named in the prompt's own words", () => {
    // The prompt rule and the code guard must cover the same conditions — a family
    // added to one and not the other is the drift this pins.
    expect(PATIENT_STATE_QUALIFIERS.map((q) => q.key)).toEqual([
      "fasting",
      "prandial",
      "dose-timing",
      "posture",
      "exertion",
      "time-of-day",
    ]);
    for (const phrase of [
      "fasting",
      "post-prandial",
      "pre-/post-dose",
      "supine/standing",
      "at-rest/post-exercise",
      "morning/evening draw",
    ]) {
      expect(SYSTEM).toContain(phrase);
    }
  });
});

import { describe, expect, it } from "vitest";
import { extractFromCcda } from "@/lib/cda";
import { healthRecordToPersistInput } from "@/lib/import-shape";
import {
  isAssessmentScaleTemplate,
  isImmunizationAttributeLabel,
  isNonAnalyteObservation,
} from "@/lib/non-analyte-observations";
import { carriesBiomarkerIdentity } from "@/lib/medical-categories";

// PURE TIER — issue #2318: the NAME-axis guard that says an observation is not a
// measurement, and the mapper refusals built on it.
//
// `functionalStatusExtractor` has always nulled the assessment LOINC before storing,
// because carrying the code forward would invite canonical biomarker-map additions
// that would be wrong. That guard only ever covered the CODE axis; identity in this
// app also runs on the NAME, so the same rows still coined canonical names, still
// became Coverage candidates and still drew bandless series. These are the pure
// predicates that close the other axis, plus the two end-to-end parse assertions the
// DB tier then proves against a real database.
//
// All fixtures are SYNTHETIC — invented patients, dates, lot numbers and identifiers.

function doc(...sections: string[]): string {
  return `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <effectiveTime value="20260608"/>
  <recordTarget><patientRole><patient>
    <name><given>Wren</given><family>Placeholder</family></name>
    <administrativeGenderCode code="F"/>
    <birthTime value="19900101"/>
  </patient></patientRole></recordTarget>
  <component><structuredBody>
    ${sections.map((s) => `<component>${s}</component>`).join("")}
  </structuredBody></component>
</ClinicalDocument>`;
}

// A Results section carrying, in order:
//   • a real analyte (Glucose, numeric + unit + range) — must stay a `lab`;
//   • a SCORED screening total (numeric) — a measurement, so also a `lab`;
//   • a questionnaire ITEM under the C-CDA Assessment Scale Supporting Observation
//     template, carrying a real survey LOINC and a free-text answer;
//   • a vaccine LOT NUMBER and EXPIRATION DATE filed as free-standing observations;
//   • a bare status word with no code at all;
//   • a genuinely unmapped ANALYTE, so the unmapped-code report is demonstrably live
//     when the assertion below says the assessment's code is absent from it.
const RESULTS = `
<section>
  <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Results</title>
  <entry><observation classCode="OBS" moodCode="EVN">
    <code code="2345-7" codeSystem="2.16.840.1.113883.6.1" displayName="Glucose"/>
    <effectiveTime value="20260601"/>
    <value xsi:type="PQ" value="95" unit="mg/dL"/>
    <referenceRange><observationRange><text>70-99</text></observationRange></referenceRange>
  </observation></entry>
  <entry><observation classCode="OBS" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.69"/>
    <code code="44261-6" codeSystem="2.16.840.1.113883.6.1" displayName="Mood screen total score"/>
    <effectiveTime value="20260601"/>
    <value xsi:type="PQ" value="7" unit="{score}"/>
  </observation></entry>
  <entry><observation classCode="OBS" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.86"/>
    <code code="44250-9" codeSystem="2.16.840.1.113883.6.1" displayName="Little interest or pleasure in doing things"/>
    <effectiveTime value="20260601"/>
    <value xsi:type="ST">Several days</value>
  </observation></entry>
  <entry><observation classCode="OBS" moodCode="EVN">
    <code code="LOT" codeSystem="1.2.3.4.5" displayName="Lot Number"/>
    <effectiveTime value="20260601"/>
    <value xsi:type="ST">FAKE-01</value>
  </observation></entry>
  <entry><observation classCode="OBS" moodCode="EVN">
    <code code="EXP" codeSystem="1.2.3.4.5" displayName="Expiration Date"/>
    <effectiveTime value="20260601"/>
    <value xsi:type="ST">2027-01-31</value>
  </observation></entry>
  <entry><observation classCode="OBS" moodCode="EVN">
    <effectiveTime value="20260601"/>
    <value xsi:type="ST">Completed</value>
  </observation></entry>
  <entry><observation classCode="OBS" moodCode="EVN">
    <code code="99999-9" codeSystem="2.16.840.1.113883.6.1" displayName="Fictional Analyte"/>
    <effectiveTime value="20260601"/>
    <value xsi:type="PQ" value="1.2" unit="U/L"/>
  </observation></entry>
</section>`;

// A Vitals section whose temperature carries its measurement SITE as a sibling
// observation — the shape that put a body-site word in the analyte catalog.
const VITALS_WITH_SITE = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.4.1"/>
  <code code="8716-3" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Vital Signs</title>
  <entry><organizer classCode="CLUSTER" moodCode="EVN">
    <component><observation classCode="OBS" moodCode="EVN">
      <code code="8310-5" codeSystem="2.16.840.1.113883.6.1" displayName="Body temperature"/>
      <effectiveTime value="20260601"/>
      <value xsi:type="PQ" value="98.4" unit="[degF]"/>
    </observation></component>
  </organizer></entry>
</section>`;

// The Functional Status section an EHR files a temperature's measurement site under.
const FUNCTIONAL_STATUS_SITE = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.14"/>
  <code code="47420-5" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Functional Status</title>
  <entry><observation classCode="OBS" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.67"/>
    <code code="54522-8" codeSystem="2.16.840.1.113883.6.1" displayName="Functional status"/>
    <effectiveTime value="20260601"/>
    <value xsi:type="CD" code="123851003" codeSystem="2.16.840.1.113883.6.96" displayName="Oral"/>
  </observation></entry>
</section>`;

describe("isNonAnalyteObservation — states no measurement AND claims no analyte", () => {
  const measurement = {
    loinc: "2345-7",
    valueNum: 95,
    unit: "mg/dL",
    referenceRange: "70-99",
  };

  it("keeps a genuinely measured reading out of the bucket", () => {
    expect(isNonAnalyteObservation(measurement)).toBe(false);
  });

  it("keeps a SCORED total out of the bucket even with no code (#2318 out-of-scope)", () => {
    // Recognising/summing an instrument is a separate decision; what matters here is
    // that a number never lands in the non-analyte bucket by accident.
    expect(
      isNonAnalyteObservation({
        loinc: null,
        valueNum: 7,
        unit: null,
        referenceRange: null,
      })
    ).toBe(false);
  });

  it("keeps a coded QUALITATIVE lab out of the bucket — the conservatism that matters", () => {
    // "Positive" / "Detected" / a blood type is textual, unitless and range-less, the
    // same shape as a qualifier. The LOINC is what distinguishes them, so a coded row
    // is left alone unless it declares an assessment-scale template.
    expect(
      isNonAnalyteObservation({
        loinc: "5196-1",
        valueNum: null,
        unit: null,
        referenceRange: null,
      })
    ).toBe(false);
  });

  it("catches an uncoded, unitless, band-less textual observation", () => {
    // The shape a qualifier ("Oral"), a status word ("Completed") and a printed
    // expiry date all share — the VALUE is irrelevant to the decision, which is the
    // point: no number, no unit, no band, no code.
    expect(
      isNonAnalyteObservation({
        loinc: null,
        valueNum: null,
        unit: null,
        referenceRange: null,
      })
    ).toBe(true);
  });

  it("catches a CODED questionnaire item through its assessment-scale template", () => {
    expect(
      isNonAnalyteObservation({
        loinc: "44250-9",
        valueNum: null,
        unit: null,
        referenceRange: null,
        assessmentScale: true,
      })
    ).toBe(true);
  });

  it("a stated unit or range is enough to make it a measurement", () => {
    expect(
      isNonAnalyteObservation({
        loinc: null,
        valueNum: null,
        unit: "mmol/L",
        referenceRange: null,
      })
    ).toBe(false);
    expect(
      isNonAnalyteObservation({
        loinc: null,
        valueNum: null,
        unit: null,
        referenceRange: "NEGATIVE",
      })
    ).toBe(false);
  });
});

describe("isAssessmentScaleTemplate", () => {
  it("recognizes the instrument and its supporting ITEM templates", () => {
    expect(isAssessmentScaleTemplate("2.16.840.1.113883.10.20.22.4.69")).toBe(
      true
    );
    expect(isAssessmentScaleTemplate(" 2.16.840.1.113883.10.20.22.4.86 ")).toBe(
      true
    );
  });

  it("ignores an unrelated template and a non-string", () => {
    expect(isAssessmentScaleTemplate("2.16.840.1.113883.10.20.22.4.2")).toBe(
      false
    );
    expect(isAssessmentScaleTemplate(undefined)).toBe(false);
    expect(isAssessmentScaleTemplate(42)).toBe(false);
  });
});

describe("isImmunizationAttributeLabel", () => {
  it("matches the printed lot/expiry labels, punctuation and case included", () => {
    for (const label of [
      "Lot Number",
      "lot number",
      "Lot #",
      "LOT NO.",
      "Vaccine Lot Number",
      "Expiration Date",
      "expiry",
      "Exp Date:",
    ]) {
      expect(isImmunizationAttributeLabel(label), label).toBe(true);
    }
  });

  it("never matches an analyte, however it is spelled", () => {
    for (const label of [
      "Glucose",
      "Lot Streptococcus",
      "Expiratory Flow Rate",
      "Blood Type",
      null,
      "",
    ]) {
      expect(isImmunizationAttributeLabel(label), String(label)).toBe(false);
    }
  });
});

describe("the CCD mapper's refusals and routing (#2318)", () => {
  const parsed = extractFromCcda(
    doc(RESULTS, VITALS_WITH_SITE, FUNCTIONAL_STATUS_SITE)
  );
  const byName = new Map(parsed.records.map((r) => [r.name, r]));

  it("emits NO record for a vaccine lot number or expiry", () => {
    expect(byName.has("Lot Number")).toBe(false);
    expect(byName.has("Expiration Date")).toBe(false);
    // …and the refusal is ITEMIZED, not silent: the drop report says why.
    const drops = (parsed.report?.drops ?? []).filter(
      (d) => d.label === "Lot Number" || d.label === "Expiration Date"
    );
    expect(drops.map((d) => d.reason)).toEqual(["non_analyte", "non_analyte"]);
  });

  it("routes the questionnaire item, the site qualifier and the status word to `assessment`", () => {
    expect(
      byName.get("Little interest or pleasure in doing things")?.category
    ).toBe("assessment");
    expect(byName.get("Functional status")?.category).toBe("assessment");
    expect(byName.get("Result")?.category).toBe("assessment");
  });

  it("leaves the real analyte and the scored total as measurements", () => {
    expect(byName.get("Glucose")?.category).toBe("lab");
    expect(byName.get("Glucose")?.value_num).toBe(95);
    expect(byName.get("Mood screen total score")?.category).toBe("lab");
    expect(byName.get("Mood screen total score")?.value_num).toBe(7);
    expect(byName.get("Body temperature")?.category).toBe("vitals");
  });

  it("an assessment carries no LOINC into the unmapped-code report", () => {
    const codes = (parsed.report?.unmappedLoincs ?? []).map((u) => u.loinc);
    // The report IS live in this document — a genuine unmapped ANALYTE is listed …
    expect(codes).toContain("99999-9");
    // … and the assessment's survey code is not. That suggestion — "add this to
    // LOINC_TO_CANONICAL" — is the very outcome the functionalStatusExtractor
    // comment set out to prevent, and the category is what prevents it here.
    expect(codes).not.toContain("44250-9");
    expect(codes).not.toContain("54522-8");
  });

  it("registers no canonical name for any of them", () => {
    const input = healthRecordToPersistInput(parsed, "doc.xml", "ccda");
    expect(input.canonicalNamesToRegister).toContain("Glucose");
    for (const name of [
      "Little interest or pleasure in doing things",
      "Functional status",
      "Result",
      "Lot Number",
      "Expiration Date",
    ]) {
      expect(input.canonicalNamesToRegister, name).not.toContain(name);
    }
  });

  it("every emitted `assessment` is declared identity-less", () => {
    for (const r of parsed.records) {
      if (r.category !== "assessment") continue;
      expect(carriesBiomarkerIdentity(r.category)).toBe(false);
    }
  });
});

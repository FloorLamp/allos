import { describe, expect, it } from "vitest";
import { extractFromCcda } from "../cda";
import {
  isVisitDiagnosesSection,
  narrativeDiagnosisNames,
} from "../cda/extractors";
import type { CdaSection } from "../cda/constants";

// Coverage for issue #263: Epic/MyChart Encounter Summary CCDs emit their top-level
// "Visit Diagnoses" as an Assessment Section (LOINC 51848-0, templateId
// 2.16.840.1.113883.10.20.22.2.8) that is NARRATIVE-ONLY — an HTML table of
// diagnosis names with ZERO structured entries — not the 29308-4 "Diagnosis"
// packaging #249 recognized. The section was flagged `consumed: false` (unrecognized)
// even though the diagnoses were captured off the encounter, and a document shipping
// ONLY the narrative section would drop the diagnoses entirely. All fixtures are
// SYNTHETIC — obviously-fictional patients/clinicians, invented dates and codes.

function doc(...sections: string[]): string {
  return `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <effectiveTime value="20260608"/>
  <recordTarget><patientRole><patient>
    <name><given>Robin</given><family>Sample</family></name>
    <administrativeGenderCode code="F"/>
    <birthTime value="19900101"/>
  </patient></patientRole></recordTarget>
  <component><structuredBody>
    ${sections.map((s) => `<component>${s}</component>`).join("")}
  </structuredBody></component>
</ClinicalDocument>`;
}

// A single Office Visit encounter carrying NO diagnoses of its own.
const ENCOUNTER = `
<section>
  <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Encounters</title>
  <entry><encounter classCode="ENC" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
    <id root="1.2.3" extension="ENC-1"/>
    <code code="99213" codeSystem="2.16.840.1.113883.6.12" displayName="Office Visit"/>
    <effectiveTime><low value="20260608"/></effectiveTime>
  </encounter></entry>
</section>`;

// A single encounter carrying a nested Fever diagnosis — the packaging the encounter
// deep-walk already consumes. Used to prove the narrative Assessment table doesn't
// double-list Fever.
const ENCOUNTER_WITH_NESTED_FEVER = `
<section>
  <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Encounters</title>
  <entry><encounter classCode="ENC" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
    <id root="1.2.3" extension="ENC-DX"/>
    <code code="99213" codeSystem="2.16.840.1.113883.6.12" displayName="Office Visit"/>
    <effectiveTime><low value="20260608"/></effectiveTime>
    <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
      <code code="386661006" codeSystem="2.16.840.1.113883.6.96"/>
      <value xsi:type="CD" code="386661006" codeSystem="2.16.840.1.113883.6.96" displayName="Fever"/>
    </observation></entryRelationship>
  </encounter></entry>
</section>`;

// The narrative-only Assessment section Epic emits as "Visit Diagnoses": LOINC
// 51848-0 + templateId 2.2.8, an HTML table of diagnosis names, ZERO <entry> elements.
const ASSESSMENT_NARRATIVE = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.8"/>
  <code code="51848-0" codeSystem="2.16.840.1.113883.6.1" displayName="Assessments"/>
  <title>Visit Diagnoses</title>
  <text>
    <table>
      <thead><tr><th>Diagnosis</th><th>ICD-10</th></tr></thead>
      <tbody>
        <tr><td>Acute pharyngitis</td><td>J02.9</td></tr>
        <tr><td><content ID="dx2">Fever</content></td><td>R50.9</td></tr>
      </tbody>
    </table>
  </text>
</section>`;

// A section titled "Visit Diagnoses" with an unrecognized deployment-specific code
// (not 29308-4, not 51848-0) — recognized only by the title heuristic.
const TITLE_ONLY_VISIT_DX = `
<section>
  <code code="99999-9" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Visit Diagnoses</title>
  <text>
    <table>
      <tbody>
        <tr><td>Acute pharyngitis</td></tr>
      </tbody>
    </table>
  </text>
</section>`;

// A genuine Assessment section that is prose narrative (a clinician's assessment
// paragraph), no diagnosis table — must NOT be mis-parsed into fabricated diagnoses.
const ASSESSMENT_PROSE = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.8"/>
  <code code="51848-0" codeSystem="2.16.840.1.113883.6.1" displayName="Assessments"/>
  <title>Assessment</title>
  <text>Patient is clinically improving and tolerating oral intake well.</text>
</section>`;

describe("narrative-only Assessment / Visit Diagnoses (#263)", () => {
  it("correlates narrative-table diagnoses onto the single same-document encounter", () => {
    const r = extractFromCcda(doc(ENCOUNTER, ASSESSMENT_NARRATIVE));
    expect(r.encounters).toHaveLength(1);
    expect(r.encounters![0].diagnoses).toEqual(["Acute pharyngitis", "Fever"]);
    // Correlated onto the encounter, not duplicated into the problem list.
    expect(r.conditions).toEqual([]);
  });

  it("does not double-list a diagnosis the encounter already carries nested", () => {
    const r = extractFromCcda(
      doc(ENCOUNTER_WITH_NESTED_FEVER, ASSESSMENT_NARRATIVE)
    );
    expect(r.encounters).toHaveLength(1);
    // Fever (nested) is not doubled; Acute pharyngitis (narrative-only) is added.
    expect(r.encounters![0].diagnoses).toEqual(["Fever", "Acute pharyngitis"]);
    expect(r.conditions).toEqual([]);
  });

  it("lands narrative diagnoses as problem-list conditions when there is NO encounter", () => {
    const r = extractFromCcda(doc(ASSESSMENT_NARRATIVE));
    expect(r.encounters).toEqual([]);
    expect(r.conditions!.map((c) => c.name)).toEqual([
      "Acute pharyngitis",
      "Fever",
    ]);
    // Visit-diagnosis provenance namespace — never conflated with an Active Problem.
    expect(
      r.conditions!.every((c) => c.external_id.startsWith("ccda:visit-dx:"))
    ).toBe(true);
  });

  it("recognizes a Visit-Diagnoses-titled section by the title heuristic alone", () => {
    const r = extractFromCcda(doc(ENCOUNTER, TITLE_ONLY_VISIT_DX));
    expect(r.encounters![0].diagnoses).toEqual(["Acute pharyngitis"]);
  });

  it("does not fabricate diagnoses from a prose (table-less) Assessment section", () => {
    const r = extractFromCcda(doc(ENCOUNTER, ASSESSMENT_PROSE));
    expect(r.encounters![0].diagnoses).toEqual([]);
    expect(r.conditions).toEqual([]);
  });
});

describe("import coverage (#263): Assessment section is consumed, not unrecognized", () => {
  it("marks the narrative Assessment section consumed", () => {
    const r = extractFromCcda(doc(ENCOUNTER, ASSESSMENT_NARRATIVE));
    const entry = r.report!.coverage.find((c) => c.title === "Visit Diagnoses");
    expect(entry, "coverage entry for the Assessment section").toBeTruthy();
    expect(entry!.consumed).toBe(true);
    const unrecognized = r.report!.drops.filter(
      (d) => d.reason === "unrecognized_section"
    );
    expect(unrecognized).toEqual([]);
  });

  it("marks the section consumed even with no correlatable encounter", () => {
    const r = extractFromCcda(doc(ASSESSMENT_NARRATIVE));
    const entry = r.report!.coverage.find((c) => c.title === "Visit Diagnoses");
    expect(entry!.consumed).toBe(true);
  });
});

describe("isVisitDiagnosesSection (pure)", () => {
  const section = (over: Partial<CdaSection>): CdaSection => ({
    code: null,
    templateIds: [],
    title: null,
    entries: [],
    raw: {},
    ...over,
  });

  it("matches the 29308-4 Diagnosis section", () => {
    expect(isVisitDiagnosesSection(section({ code: "29308-4" }))).toBe(true);
  });

  it("matches the Assessment section by LOINC and by templateId", () => {
    expect(isVisitDiagnosesSection(section({ code: "51848-0" }))).toBe(true);
    expect(
      isVisitDiagnosesSection(
        section({ templateIds: ["2.16.840.1.113883.10.20.22.2.8"] })
      )
    ).toBe(true);
  });

  it("matches a section titled 'Visit Diagnoses' with an unknown code", () => {
    expect(
      isVisitDiagnosesSection(
        section({ code: "99999-9", title: "Visit Diagnoses" })
      )
    ).toBe(true);
  });

  it("does not match an unrelated section", () => {
    expect(
      isVisitDiagnosesSection(section({ code: "30954-2", title: "Results" }))
    ).toBe(false);
  });
});

describe("narrativeDiagnosisNames (pure)", () => {
  // The node shapes below mirror what the shared XML parser produces for a
  // narrative <table> (table → tbody → tr[] → td[]).
  it("reads the first cell of each body row, skipping the header and placeholders", () => {
    const raw = {
      text: {
        table: {
          thead: { tr: { th: ["Diagnosis", "Date"] } },
          tbody: {
            tr: [
              { td: ["Acute pharyngitis", "Jun 8"] },
              {
                td: [{ content: { "#text": "Fever", "@_ID": "d2" } }, "Jun 8"],
              },
              { td: ["No known problems", "—"] },
            ],
          },
        },
      },
    };
    expect(narrativeDiagnosisNames(raw)).toEqual([
      "Acute pharyngitis",
      "Fever",
    ]);
  });

  it("handles rows directly under <table> (no <tbody>) and dedups", () => {
    const raw = {
      text: {
        table: {
          tr: [{ td: ["Cough"] }, { td: ["Cough"] }, { td: ["Headache"] }],
        },
      },
    };
    expect(narrativeDiagnosisNames(raw)).toEqual(["Cough", "Headache"]);
  });

  it("returns nothing for a table-less (prose) narrative", () => {
    expect(narrativeDiagnosisNames({ text: "Patient improving." })).toEqual([]);
    expect(narrativeDiagnosisNames({})).toEqual([]);
  });
});

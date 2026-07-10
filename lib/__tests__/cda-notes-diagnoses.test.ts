import { describe, expect, it } from "vitest";
import { extractFromCcda } from "../cda";

// Wrap section XML in a minimal ClinicalDocument (with an effectiveTime so a
// standalone note has a document date to fall back to). All fixtures are SYNTHETIC:
// obviously-fictional clinician/patient names, no real NPIs/phones.
function doc(...sections: string[]): string {
  return `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <effectiveTime value="20260608"/>
  <recordTarget><patientRole><patient>
    <name><given>Robin</given><family>Sample</family></name>
    <administrativeGenderCode code="M"/>
    <birthTime value="20200101"/>
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

// A single encounter that carries a nested diagnosis ("Fever") — the packaging the
// deep-walk already consumes. Used to prove no duplicate when a standalone Visit
// Diagnoses section ALSO lists Fever.
const ENCOUNTER_WITH_NESTED_DX = `
<section>
  <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Encounters</title>
  <entry><encounter classCode="ENC" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
    <id root="1.2.3" extension="ENC-DX"/>
    <code code="99213" codeSystem="2.16.840.1.113883.6.12" displayName="Office Visit"/>
    <effectiveTime><low value="20260608"/></effectiveTime>
    <entryRelationship typeCode="SUBJ"><act classCode="ACT" moodCode="EVN">
      <code code="29308-4" codeSystem="2.16.840.1.113883.6.1" displayName="Diagnosis"/>
      <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
        <code code="386661006" codeSystem="2.16.840.1.113883.6.96"/>
        <value xsi:type="CD" code="386661006" codeSystem="2.16.840.1.113883.6.96" displayName="Fever"/>
      </observation></entryRelationship>
    </act></entryRelationship>
  </encounter></entry>
</section>`;

// Two unrelated encounters — so document-level correlation can't attribute reliably.
const TWO_ENCOUNTERS = `
<section>
  <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Encounters</title>
  <entry><encounter classCode="ENC" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
    <id root="1.2.3" extension="ENC-A"/>
    <code code="99213" codeSystem="2.16.840.1.113883.6.12" displayName="Office Visit"/>
    <effectiveTime><low value="20260601"/></effectiveTime>
  </encounter></entry>
  <entry><encounter classCode="ENC" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
    <id root="1.2.3" extension="ENC-B"/>
    <code code="99204" codeSystem="2.16.840.1.113883.6.12" displayName="Consult"/>
    <effectiveTime><low value="20250101"/></effectiveTime>
  </encounter></entry>
</section>`;

// A top-level Standalone Visit Diagnoses section (LOINC 29308-4), one diagnosis
// wrapped in a Diagnosis act, carrying an ICD-10 translation + an onset date.
const VISIT_DX_PHARYNGITIS = `
<section>
  <code code="29308-4" codeSystem="2.16.840.1.113883.6.1" displayName="Diagnosis"/>
  <title>Visit Diagnoses</title>
  <entry><act classCode="ACT" moodCode="EVN">
    <code code="29308-4" codeSystem="2.16.840.1.113883.6.1" displayName="Diagnosis"/>
    <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
      <code code="363746003" codeSystem="2.16.840.1.113883.6.96"/>
      <effectiveTime value="20260608"/>
      <value xsi:type="CD" code="363746003" codeSystem="2.16.840.1.113883.6.96" displayName="Acute pharyngitis">
        <translation code="J02.9" codeSystem="2.16.840.1.113883.6.90" displayName="Acute pharyngitis, unspecified"/>
      </value>
    </observation></entryRelationship>
  </act></entry>
</section>`;

// A Visit Diagnoses section listing Fever + Cough as bare Problem Observations.
const VISIT_DX_FEVER_COUGH = `
<section>
  <code code="29308-4" codeSystem="2.16.840.1.113883.6.1" displayName="Diagnosis"/>
  <title>Visit Diagnoses</title>
  <entry><observation classCode="OBS" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
    <code code="386661006" codeSystem="2.16.840.1.113883.6.96"/>
    <value xsi:type="CD" code="386661006" codeSystem="2.16.840.1.113883.6.96" displayName="Fever"/>
  </observation></entry>
  <entry><observation classCode="OBS" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
    <code code="49727002" codeSystem="2.16.840.1.113883.6.96"/>
    <value xsi:type="CD" code="49727002" codeSystem="2.16.840.1.113883.6.96" displayName="Cough"/>
  </observation></entry>
</section>`;

// A top-level Progress Notes section (LOINC 11506-3), narrative-only.
const PROGRESS_NOTES = `
<section>
  <code code="11506-3" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Progress Notes</title>
  <text>Patient reports feeling much better. Throat pain resolving. Continue supportive care.</text>
</section>`;

// A per-clinician "Notes from <clinician>" section (consult note 11488-4) with a
// named author (used for attribution).
const CLINICIAN_NOTES = `
<section>
  <code code="11488-4" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Notes from Dr. Ada Lovelace</title>
  <author>
    <time value="20260608"/>
    <assignedAuthor>
      <assignedPerson><name><given>Ada</given><family>Lovelace</family></name></assignedPerson>
    </assignedAuthor>
  </author>
  <text>Consult note: recommend follow-up in one week.</text>
</section>`;

// A Notes section recognized only by its title heuristic (a deployment-specific
// code we don't catalogue), no named author.
const TITLE_ONLY_NOTES = `
<section>
  <code code="99999-9" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Telephone Encounter Notes</title>
  <text>Called patient with lab results; no action needed.</text>
</section>`;

describe("standalone Visit Diagnoses (29308-4)", () => {
  it("correlates onto the single same-document encounter's diagnoses", () => {
    const r = extractFromCcda(doc(ENCOUNTER, VISIT_DX_PHARYNGITIS));
    expect(r.encounters).toHaveLength(1);
    expect(r.encounters![0].diagnoses).toEqual(["Acute pharyngitis"]);
    // Correlated, not duplicated into the problem list.
    expect(r.conditions).toEqual([]);
  });

  it("does not double-list a diagnosis a CCD carries in BOTH packagings", () => {
    const r = extractFromCcda(
      doc(ENCOUNTER_WITH_NESTED_DX, VISIT_DX_FEVER_COUGH)
    );
    expect(r.encounters).toHaveLength(1);
    // Fever (nested) is not doubled; Cough (standalone-only) is added.
    expect(r.encounters![0].diagnoses).toEqual(["Fever", "Cough"]);
    expect(r.conditions).toEqual([]);
  });

  it("lands as a problem-list condition (with provenance) when there is NO encounter", () => {
    const r = extractFromCcda(doc(VISIT_DX_PHARYNGITIS));
    expect(r.encounters).toEqual([]);
    expect(r.conditions).toHaveLength(1);
    const c = r.conditions![0];
    expect(c.name).toBe("Acute pharyngitis");
    expect(c.code).toBe("J02.9"); // prefers the ICD-10 translation
    expect(c.code_system).toBe("ICD-10-CM");
    expect(c.onset_date).toBe("2026-06-08");
    // Visit-diagnosis provenance namespace — never conflated with an Active Problem.
    expect(c.external_id.startsWith("ccda:visit-dx:")).toBe(true);
  });

  it("lands as a condition when the diagnosis can't be attributed (several encounters)", () => {
    const r = extractFromCcda(doc(TWO_ENCOUNTERS, VISIT_DX_PHARYNGITIS));
    expect(r.encounters).toHaveLength(2);
    expect(r.encounters!.every((e) => e.diagnoses.length === 0)).toBe(true);
    expect(r.conditions!.map((c) => c.name)).toEqual(["Acute pharyngitis"]);
  });
});

describe("Progress Notes + per-clinician Notes", () => {
  it("attaches a Progress Note to the single same-document encounter", () => {
    const r = extractFromCcda(doc(ENCOUNTER, PROGRESS_NOTES));
    expect(r.encounters).toHaveLength(1);
    expect(r.encounters![0].notes).toBe(
      "Patient reports feeling much better. Throat pain resolving. Continue supportive care."
    );
  });

  it("attributes a per-clinician note to its author when attached to an encounter", () => {
    const r = extractFromCcda(doc(ENCOUNTER, CLINICIAN_NOTES));
    expect(r.encounters![0].notes).toBe(
      "Ada Lovelace: Consult note: recommend follow-up in one week."
    );
  });

  it("attaches multiple notes to the encounter, one per line", () => {
    const r = extractFromCcda(doc(ENCOUNTER, PROGRESS_NOTES, CLINICIAN_NOTES));
    expect(r.encounters![0].notes).toBe(
      "Patient reports feeling much better. Throat pain resolving. Continue supportive care.\n" +
        "Ada Lovelace: Consult note: recommend follow-up in one week."
    );
  });

  it("recognizes a Notes section by its title heuristic", () => {
    const r = extractFromCcda(doc(ENCOUNTER, TITLE_ONLY_NOTES));
    expect(r.encounters![0].notes).toBe(
      "Called patient with lab results; no action needed."
    );
  });

  it("stores an uncorrelatable note as a standalone dated note entry", () => {
    const r = extractFromCcda(doc(PROGRESS_NOTES));
    expect(r.encounters).toHaveLength(1);
    const e = r.encounters![0];
    expect(e.type).toBe("Progress Notes");
    expect(e.date).toBe("2026-06-08"); // falls back to the document date
    expect(e.notes).toBe(
      "Patient reports feeling much better. Throat pain resolving. Continue supportive care."
    );
    expect(e.diagnoses).toEqual([]);
  });
});

describe("import coverage (no longer dropped as unrecognized)", () => {
  it("reports the three sections as consumed, not unrecognized", () => {
    const r = extractFromCcda(
      doc(ENCOUNTER, VISIT_DX_PHARYNGITIS, PROGRESS_NOTES, CLINICIAN_NOTES)
    );
    const coverage = r.report!.coverage;
    for (const title of [
      "Visit Diagnoses",
      "Progress Notes",
      "Notes from Dr. Ada Lovelace",
    ]) {
      const entry = coverage.find((c) => c.title === title);
      expect(entry, `coverage entry for ${title}`).toBeTruthy();
      expect(entry!.consumed).toBe(true);
    }
    const unrecognized = r.report!.drops.filter(
      (d) => d.reason === "unrecognized_section"
    );
    expect(unrecognized).toEqual([]);
  });
});

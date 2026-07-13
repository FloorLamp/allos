import { describe, expect, it } from "vitest";
import { extractFromCcda } from "../cda";

// Coverage for the CCD sections issues #265/#266 found dropped whole:
// History of Past Illness / Resolved Problems (11348-0), Admitting Diagnoses
// (46241-6), Medications at Time of Discharge (10183-2), Administered
// Medications (29549-3), and Discharge Summaries (8648-8) / Discharge
// Instructions (8653-8). All fixtures are SYNTHETIC — obviously-fictional
// patients/clinicians, no real NPIs/phones/orgs, invented dates.

// Wrap section XML in a minimal ClinicalDocument (with an effectiveTime so
// undated snapshot entries and standalone notes have a document date).
function doc(...sections: string[]): string {
  return `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <effectiveTime value="20260603"/>
  <recordTarget><patientRole><patient>
    <name><given>Test</given><family>Patient</family></name>
  </patient></patientRole></recordTarget>
  <component><structuredBody>
    ${sections.map((s) => `<component>${s}</component>`).join("")}
  </structuredBody></component>
</ClinicalDocument>`;
}

// One Problem Concern Act in a Resolved Problems shape: concern statusCode
// `completed`, problem observation with an effectiveTime high (the resolution
// date), NO explicit clinical-status observation.
const RESOLVED_PROBLEMS = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.20"/>
  <code code="11348-0" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Resolved Problems</title>
  <entry><act classCode="ACT" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.3"/>
    <statusCode code="completed"/>
    <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
      <effectiveTime><low value="20180301"/><high value="20190215"/></effectiveTime>
      <value xsi:type="CD" code="233604007" codeSystem="2.16.840.1.113883.6.96" displayName="Pneumonia">
        <translation code="J18.9" codeSystem="2.16.840.1.113883.6.90" displayName="Pneumonia, unspecified organism"/>
      </value>
    </observation></entryRelationship>
  </act></entry>
</section>`;

// A past-illness entry whose CONCERN act still says "active" (the tracking
// status) and which carries no clinical-status observation and no resolution
// date — the section's semantics must still land it resolved.
const PAST_ILLNESS_ACTIVE_CONCERN = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.20"/>
  <code code="11348-0" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Resolved Problems</title>
  <entry><act classCode="ACT" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.3"/>
    <statusCode code="active"/>
    <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
      <effectiveTime><low value="20200710"/></effectiveTime>
      <value xsi:type="CD" code="444814009" codeSystem="2.16.840.1.113883.6.96" displayName="Viral sinusitis"/>
    </observation></entryRelationship>
  </act></entry>
</section>`;

// A past-illness entry with an EXPLICIT clinical-status observation ("Active")
// — the explicit status stays authoritative over the section default.
const PAST_ILLNESS_EXPLICIT_ACTIVE = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.20"/>
  <code code="11348-0" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Resolved Problems</title>
  <entry><act classCode="ACT" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.3"/>
    <statusCode code="completed"/>
    <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
      <effectiveTime><low value="20240105"/></effectiveTime>
      <value xsi:type="CD" code="195967001" codeSystem="2.16.840.1.113883.6.96" displayName="Asthma"/>
      <entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.6"/>
        <value xsi:type="CD" code="55561003" displayName="Active"/>
      </observation></entryRelationship>
    </observation></entryRelationship>
  </act></entry>
</section>`;

// A single inpatient encounter with no diagnoses/notes of its own.
const HOSPITAL_ENCOUNTER = `
<section>
  <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Encounters</title>
  <entry><encounter classCode="ENC" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
    <id root="1.2.3" extension="HOSP-1"/>
    <code code="99223" codeSystem="2.16.840.1.113883.6.12" displayName="Hospital Encounter">
      <translation code="IMP" codeSystem="2.16.840.1.113883.5.4"/>
    </code>
    <effectiveTime><low value="20260601"/><high value="20260603"/></effectiveTime>
  </encounter></entry>
</section>`;

// Admitting Diagnoses (46241-6 / 2.2.43): a Hospital Admission Diagnosis act
// wrapping a Problem Observation — the same deep-walk shape as Visit Diagnoses.
const ADMITTING_DIAGNOSES = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.43"/>
  <code code="46241-6" codeSystem="2.16.840.1.113883.6.1" displayName="Hospital admission diagnosis"/>
  <title>Admitting Diagnoses</title>
  <entry><act classCode="ACT" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.34"/>
    <code code="46241-6" codeSystem="2.16.840.1.113883.6.1"/>
    <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
      <effectiveTime><low value="20260601"/></effectiveTime>
      <value xsi:type="CD" code="233604007" codeSystem="2.16.840.1.113883.6.96" displayName="Pneumonia">
        <translation code="J18.9" codeSystem="2.16.840.1.113883.6.90" displayName="Pneumonia, unspecified organism"/>
      </value>
    </observation></entryRelationship>
  </act></entry>
</section>`;

// Medications at Time of Discharge (10183-2 / 2.2.11): a Medication Activity
// with an active status and a start date — the take-home regimen.
const DISCHARGE_MEDICATIONS = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.11"/>
  <code code="10183-2" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Medications at Time of Discharge</title>
  <entry><substanceAdministration classCode="SBADM" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.16"/>
    <statusCode code="active"/>
    <effectiveTime xsi:type="IVL_TS"><low value="20260603"/></effectiveTime>
    <doseQuantity value="500" unit="mg"/>
    <consumable><manufacturedProduct><manufacturedMaterial>
      <code code="308191" codeSystem="2.16.840.1.113883.6.88" displayName="Amoxicillin 500 MG Oral Capsule"/>
      <name>Amoxicillin 500 mg capsule</name>
    </manufacturedMaterial></manufacturedProduct></consumable>
  </substanceAdministration></entry>
</section>`;

// Administered Medications (29549-3 / 2.2.38): a Medication Activity for a med
// GIVEN during the stay — statusCode still "active", a point effectiveTime.
const ADMINISTERED_MEDICATIONS = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.38"/>
  <code code="29549-3" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Administered Medications</title>
  <entry><substanceAdministration classCode="SBADM" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.16"/>
    <statusCode code="active"/>
    <effectiveTime value="20260601"/>
    <doseQuantity value="4" unit="mg"/>
    <consumable><manufacturedProduct><manufacturedMaterial>
      <code code="312086" codeSystem="2.16.840.1.113883.6.88" displayName="Ondansetron 4 MG Oral Tablet"/>
      <name>Ondansetron 4 mg tablet</name>
    </manufacturedMaterial></manufacturedProduct></consumable>
  </substanceAdministration></entry>
</section>`;

// An administered med with NO effectiveTime at all — must anchor to the
// document date and still land as a CLOSED course.
const ADMINISTERED_UNDATED = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.38"/>
  <code code="29549-3" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Administered Medications</title>
  <entry><substanceAdministration classCode="SBADM" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.16"/>
    <statusCode code="active"/>
    <consumable><manufacturedProduct><manufacturedMaterial>
      <code code="1049221" codeSystem="2.16.840.1.113883.6.88" displayName="Acetaminophen 325 MG Oral Tablet"/>
      <name>Acetaminophen 325 mg tablet</name>
    </manufacturedMaterial></manufacturedProduct></consumable>
  </substanceAdministration></entry>
</section>`;

// Discharge Summaries (8648-8, IHE 1.3.6.1.4.1.19376.1.5.3.1.3.5): narrative
// note section with a named author (a Note Activity's text lives in the
// section narrative in the tested Epic shape).
const DISCHARGE_SUMMARY = `
<section>
  <templateId root="1.3.6.1.4.1.19376.1.5.3.1.3.5"/>
  <code code="8648-8" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Discharge Summaries</title>
  <author>
    <time value="20260603"/>
    <assignedAuthor>
      <assignedPerson><name><given>Ada</given><family>Lovelace</family></name></assignedPerson>
    </assignedAuthor>
  </author>
  <text>Admitted for community-acquired pneumonia; improved on IV antibiotics and discharged in stable condition.</text>
</section>`;

// Discharge Instructions (8653-8 / 2.2.41): narrative-only instruction section.
const DISCHARGE_INSTRUCTIONS = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.41"/>
  <code code="8653-8" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Discharge Instructions</title>
  <text>Complete the full antibiotic course. Return if fever recurs.</text>
</section>`;

describe("History of Past Illness / Resolved Problems (11348-0, #265)", () => {
  it("lands a resolved problem in the conditions store with its resolution date", () => {
    const r = extractFromCcda(doc(RESOLVED_PROBLEMS));
    expect(r.conditions).toHaveLength(1);
    const c = r.conditions![0];
    expect(c.name).toBe("Pneumonia");
    expect(c.code).toBe("J18.9");
    expect(c.code_system).toBe("ICD-10-CM");
    expect(c.status).toBe("resolved");
    expect(c.onset_date).toBe("2018-03-01");
    expect(c.resolved_date).toBe("2019-02-15");
  });

  it("defaults to resolved even when the concern act's tracking status is 'active'", () => {
    const r = extractFromCcda(doc(PAST_ILLNESS_ACTIVE_CONCERN));
    expect(r.conditions).toHaveLength(1);
    const c = r.conditions![0];
    expect(c.name).toBe("Viral sinusitis");
    expect(c.status).toBe("resolved");
    // No effectiveTime high → no resolution date to assert.
    expect(c.resolved_date).toBeNull();
  });

  it("respects an explicit clinical-status observation over the section default", () => {
    const r = extractFromCcda(doc(PAST_ILLNESS_EXPLICIT_ACTIVE));
    expect(r.conditions).toHaveLength(1);
    expect(r.conditions![0].status).toBe("active");
  });

  it("does not disturb the Active Problems default (regression)", () => {
    // The same concern shape under the PROBLEMS section (11450-4) still lands
    // active — the resolved default is scoped to the past-illness section. Use a
    // chronic-capable name so the #590 self-limited downgrade (which would legitimately
    // resolve the "Viral sinusitis" fixture) doesn't mask what this test checks.
    const activeProblems = PAST_ILLNESS_ACTIVE_CONCERN.replace(
      '<templateId root="2.16.840.1.113883.10.20.22.2.20"/>',
      '<templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>'
    )
      .replace('code="11348-0"', 'code="11450-4"')
      .replace(
        'displayName="Viral sinusitis"',
        'displayName="Essential hypertension"'
      );
    const r = extractFromCcda(doc(activeProblems));
    expect(r.conditions).toHaveLength(1);
    expect(r.conditions![0].status).toBe("active");
  });
});

describe("Admitting Diagnoses (46241-6, #266)", () => {
  it("correlates onto the single same-document encounter's diagnoses", () => {
    const r = extractFromCcda(doc(HOSPITAL_ENCOUNTER, ADMITTING_DIAGNOSES));
    expect(r.encounters).toHaveLength(1);
    expect(r.encounters![0].diagnoses).toEqual(["Pneumonia"]);
    expect(r.conditions).toEqual([]);
  });

  it("lands as a condition with visit-diagnosis provenance when there is no encounter", () => {
    const r = extractFromCcda(doc(ADMITTING_DIAGNOSES));
    expect(r.encounters).toEqual([]);
    expect(r.conditions).toHaveLength(1);
    const c = r.conditions![0];
    expect(c.name).toBe("Pneumonia");
    expect(c.code).toBe("J18.9");
    expect(c.external_id.startsWith("ccda:visit-dx:")).toBe(true);
  });
});

describe("Medications at Time of Discharge (10183-2, #266)", () => {
  it("imports the take-home med, trusting its own status (open course) with discharge provenance", () => {
    const r = extractFromCcda(doc(DISCHARGE_MEDICATIONS));
    const meds = r.records.filter((x) => x.category === "prescription");
    expect(meds).toHaveLength(1);
    const m = meds[0];
    expect(m.name).toBe("Amoxicillin 500 mg capsule");
    expect(m.date).toBe("2026-06-03");
    expect(m.courses).toHaveLength(1);
    const course = m.courses![0];
    // Active discharge med = the intended ongoing regimen → an OPEN course.
    expect(course.started_on).toBe("2026-06-03");
    expect(course.stopped_on).toBeNull();
    expect(course.notes).toBe("At hospital discharge");
  });
});

describe("Administered Medications (29549-3, #266)", () => {
  it("imports an inpatient administration as a CLOSED course (never a current med)", () => {
    const r = extractFromCcda(doc(ADMINISTERED_MEDICATIONS));
    const meds = r.records.filter((x) => x.category === "prescription");
    expect(meds).toHaveLength(1);
    const m = meds[0];
    expect(m.name).toBe("Ondansetron 4 mg tablet");
    expect(m.courses).toHaveLength(1);
    const course = m.courses![0];
    // statusCode "active" is capped: an administration already happened.
    expect(course.started_on).toBe("2026-06-01");
    expect(course.stopped_on).toBe("2026-06-01");
    expect(course.stop_reason).toBe("completed_course");
    expect(course.notes).toBe("Administered during encounter");
  });

  it("anchors an undated administration to the document date, still closed", () => {
    const r = extractFromCcda(doc(ADMINISTERED_UNDATED));
    const meds = r.records.filter((x) => x.category === "prescription");
    expect(meds).toHaveLength(1);
    const m = meds[0];
    expect(m.date).toBe("2026-06-03"); // the document date
    expect(m.courses).toHaveLength(1);
    expect(m.courses![0].started_on).toBe("2026-06-03");
    expect(m.courses![0].stopped_on).toBe("2026-06-03");
  });
});

describe("Discharge Summaries (8648-8) + Discharge Instructions (8653-8, #266)", () => {
  it("attaches both notes to the single same-document encounter, attributed", () => {
    const r = extractFromCcda(
      doc(HOSPITAL_ENCOUNTER, DISCHARGE_SUMMARY, DISCHARGE_INSTRUCTIONS)
    );
    expect(r.encounters).toHaveLength(1);
    expect(r.encounters![0].notes).toBe(
      "Ada Lovelace: Admitted for community-acquired pneumonia; improved on IV antibiotics and discharged in stable condition.\n" +
        "Complete the full antibiotic course. Return if fever recurs."
    );
  });

  it("stores them as standalone dated notes when there is no encounter", () => {
    const r = extractFromCcda(doc(DISCHARGE_SUMMARY, DISCHARGE_INSTRUCTIONS));
    expect(r.encounters).toHaveLength(2);
    const types = r.encounters!.map((e) => e.type).sort();
    expect(types).toEqual(["Discharge Instructions", "Discharge Summaries"]);
    const summary = r.encounters!.find(
      (e) => e.type === "Discharge Summaries"
    )!;
    expect(summary.provider?.name).toContain("Lovelace");
    expect(summary.date).toBe("2026-06-03");
  });
});

describe("import coverage (#265/#266 sections no longer unrecognized)", () => {
  it("reports every new section as consumed, with no unrecognized-section drops", () => {
    const r = extractFromCcda(
      doc(
        HOSPITAL_ENCOUNTER,
        RESOLVED_PROBLEMS,
        ADMITTING_DIAGNOSES,
        DISCHARGE_MEDICATIONS,
        ADMINISTERED_MEDICATIONS,
        DISCHARGE_SUMMARY,
        DISCHARGE_INSTRUCTIONS
      )
    );
    const coverage = r.report!.coverage;
    const expectKeys: Record<string, string> = {
      "Resolved Problems": "pastIllness",
      "Admitting Diagnoses": "admissionDiagnoses",
      "Medications at Time of Discharge": "dischargeMedications",
      "Administered Medications": "administeredMedications",
      "Discharge Summaries": "clinicalNotes",
      "Discharge Instructions": "clinicalNotes",
    };
    for (const [title, key] of Object.entries(expectKeys)) {
      const entry = coverage.find((c) => c.title === title);
      expect(entry, `coverage entry for ${title}`).toBeTruthy();
      expect(entry!.consumed, `${title} consumed`).toBe(true);
      expect(entry!.key, `${title} key`).toBe(key);
    }
    const unrecognized = r.report!.drops.filter(
      (d) => d.reason === "unrecognized_section"
    );
    expect(unrecognized).toEqual([]);
  });
});

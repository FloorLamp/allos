import { describe, expect, it } from "vitest";
import { extractFromCcda } from "../cda";

// Coverage for the entry-bearing CCD sections issue #268 found unrecognized:
// Ordered Prescriptions (66149-6, Epic 1.2.840.114350.1.72.2.10144), Patient
// Instructions (69730-0 / 2.2.45), Functional Status (47420-5 / 2.2.14), and
// Insurance / Payers (48768-6 / 2.2.18 — recognized but deliberately ignored).
// All fixtures are SYNTHETIC — obviously-fictional patients/clinicians, no real
// NPIs/phones/orgs, invented dates and identifiers.

// Wrap section XML in a minimal ClinicalDocument (with an effectiveTime so
// undated orders and standalone notes have a document date).
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

// A single ambulatory encounter with no notes of its own.
const OFFICE_ENCOUNTER = `
<section>
  <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Encounters</title>
  <entry><encounter classCode="ENC" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
    <id root="1.2.3" extension="VISIT-1"/>
    <code code="99213" codeSystem="2.16.840.1.113883.6.12" displayName="Office Visit">
      <translation code="AMB" codeSystem="2.16.840.1.113883.5.4"/>
    </code>
    <effectiveTime><low value="20260603"/></effectiveTime>
  </encounter></entry>
</section>`;

// Ordered Prescriptions (66149-6, Epic templateId): a Medication Activity for a
// prescription WRITTEN at the visit — statusCode "active", start-only period.
const ORDERED_PRESCRIPTIONS = `
<section>
  <templateId root="1.2.840.114350.1.72.2.10144"/>
  <code code="66149-6" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Ordered Prescriptions</title>
  <entry><substanceAdministration classCode="SBADM" moodCode="INT">
    <templateId root="2.16.840.1.113883.10.20.22.4.16"/>
    <statusCode code="active"/>
    <effectiveTime xsi:type="IVL_TS"><low value="20260603"/></effectiveTime>
    <doseQuantity value="20" unit="mg"/>
    <consumable><manufacturedProduct><manufacturedMaterial>
      <code code="617314" codeSystem="2.16.840.1.113883.6.88" displayName="Atorvastatin 20 MG Oral Tablet"/>
      <name>Atorvastatin 20 mg tablet</name>
    </manufacturedMaterial></manufacturedProduct></consumable>
  </substanceAdministration></entry>
</section>`;

// An order with an EXPLICIT therapy period (a 10-day course) — the bounds win.
const ORDERED_BOUNDED = `
<section>
  <templateId root="1.2.840.114350.1.72.2.10144"/>
  <code code="66149-6" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Ordered Prescriptions</title>
  <entry><substanceAdministration classCode="SBADM" moodCode="INT">
    <templateId root="2.16.840.1.113883.10.20.22.4.16"/>
    <statusCode code="active"/>
    <effectiveTime xsi:type="IVL_TS"><low value="20260603"/><high value="20260613"/></effectiveTime>
    <doseQuantity value="100" unit="mg"/>
    <consumable><manufacturedProduct><manufacturedMaterial>
      <code code="723" codeSystem="2.16.840.1.113883.6.88" displayName="Amoxicillin 100 MG"/>
      <name>Amoxicillin 100 mg</name>
    </manufacturedMaterial></manufacturedProduct></consumable>
  </substanceAdministration></entry>
</section>`;

// An UNDATED order in a section matched by LOINC alone (no Epic templateId) —
// must anchor to the document date and still land as a closed course.
const ORDERED_UNDATED = `
<section>
  <code code="66149-6" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Ordered Prescriptions</title>
  <entry><substanceAdministration classCode="SBADM" moodCode="INT">
    <templateId root="2.16.840.1.113883.10.20.22.4.16"/>
    <statusCode code="active"/>
    <consumable><manufacturedProduct><manufacturedMaterial>
      <code code="197517" codeSystem="2.16.840.1.113883.6.88" displayName="Clarithromycin 250 MG Oral Tablet"/>
      <name>Clarithromycin 250 mg tablet</name>
    </manufacturedMaterial></manufacturedProduct></consumable>
  </substanceAdministration></entry>
</section>`;

// Patient Instructions (69730-0 / 2.2.45): visit-instruction narrative (the
// Instruction entries' text lives in the section narrative in the Epic shape).
const PATIENT_INSTRUCTIONS = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.45"/>
  <code code="69730-0" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Patient Instructions</title>
  <text>Take medication with food. Schedule a lipid panel in 3 months.</text>
  <entry><act classCode="ACT" moodCode="INT">
    <templateId root="2.16.840.1.113883.10.20.22.4.20"/>
    <code code="311401005" codeSystem="2.16.840.1.113883.6.96" displayName="Patient education"/>
    <statusCode code="completed"/>
  </act></entry>
</section>`;

// Functional Status (47420-5 / 2.2.14): assessment observations — one bare
// observation with a coded (qualitative) value, one nested under an organizer,
// and one null-flavored row that must be itemized as a drop (not imported).
const FUNCTIONAL_STATUS = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.14"/>
  <code code="47420-5" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Functional Status</title>
  <entry><observation classCode="OBS" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.67"/>
    <code code="54522-8" codeSystem="2.16.840.1.113883.6.1" displayName="Ambulation"/>
    <effectiveTime value="20260601"/>
    <value xsi:type="CD" code="165245003" codeSystem="2.16.840.1.113883.6.96" displayName="Independent walking"/>
  </observation></entry>
  <entry><organizer classCode="CLUSTER" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.66"/>
    <component><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.67"/>
      <code code="83240-2" codeSystem="2.16.840.1.113883.6.1" displayName="Cognitive status"/>
      <effectiveTime value="20260601"/>
      <value xsi:type="CD" code="17326005" codeSystem="2.16.840.1.113883.6.96" displayName="Well in self"/>
    </observation></component>
  </organizer></entry>
  <entry><observation classCode="OBS" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.67"/>
    <code code="75275-8" codeSystem="2.16.840.1.113883.6.1" displayName="Hearing status"/>
    <effectiveTime value="20260601"/>
    <value xsi:type="CD" nullFlavor="NA"/>
  </observation></entry>
</section>`;

// A Functional Status assessment whose LOINC COLLIDES with a vital-sign code
// (8302-2 Body height): a contrived-but-plausible cross-section code reuse. The
// assessment must stay a `lab` record — never be reclassified to "vitals" by the
// #681 code-based routing (#694).
const FUNCTIONAL_STATUS_VITAL_COLLISION = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.14"/>
  <code code="47420-5" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Functional Status</title>
  <entry><observation classCode="OBS" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.67"/>
    <code code="8302-2" codeSystem="2.16.840.1.113883.6.1" displayName="Reach ability"/>
    <effectiveTime value="20260601"/>
    <value xsi:type="CD" code="165245003" codeSystem="2.16.840.1.113883.6.96" displayName="Full reach"/>
  </observation></entry>
</section>`;

// A Results section carrying administrative NON-ANALYTE rows (45374-6 Specimen
// Expiration Date, 72486-4 Approved By) and a DERIVED PERCENTILE (59576-9 BMI
// percentile) alongside a real analyte (2345-7 Glucose) — the mapper drops the
// first three; only Glucose imports. All values synthetic.
const RESULTS_WITH_NOISE = `
<section>
  <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Results</title>
  <entry><observation classCode="OBS" moodCode="EVN">
    <code code="2345-7" codeSystem="2.16.840.1.113883.6.1" displayName="Glucose"/>
    <effectiveTime value="20260601"/>
    <value xsi:type="PQ" value="95" unit="mg/dL"/>
  </observation></entry>
  <entry><observation classCode="OBS" moodCode="EVN">
    <code code="45374-6" codeSystem="2.16.840.1.113883.6.1" displayName="Specimen Expiration Date"/>
    <effectiveTime value="20260601"/>
    <value xsi:type="ST">2026-06-30</value>
  </observation></entry>
  <entry><observation classCode="OBS" moodCode="EVN">
    <code code="72486-4" codeSystem="2.16.840.1.113883.6.1" displayName="Approved By"/>
    <effectiveTime value="20260601"/>
    <value xsi:type="ST">A. Reviewer</value>
  </observation></entry>
  <entry><observation classCode="OBS" moodCode="EVN">
    <code code="59576-9" codeSystem="2.16.840.1.113883.6.1" displayName="BMI percentile"/>
    <effectiveTime value="20260601"/>
    <value xsi:type="PQ" value="62" unit="%"/>
  </observation></entry>
</section>`;

// Insurance / Payers (48768-6 / 2.2.18): a Coverage Activity — deliberately not
// imported. All identifiers synthetic.
const INSURANCE = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.18"/>
  <code code="48768-6" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Insurance</title>
  <entry><act classCode="ACT" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.60"/>
    <code code="48768-6" codeSystem="2.16.840.1.113883.6.1"/>
    <statusCode code="completed"/>
    <entryRelationship typeCode="COMP"><act classCode="ACT" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.61"/>
      <id root="9.8.7" extension="TEST-PLAN-0001"/>
      <code code="SELF" codeSystem="2.16.840.1.113883.5.111" displayName="Self"/>
    </act></entryRelationship>
  </act></entry>
</section>`;

describe("Ordered Prescriptions (66149-6, #268)", () => {
  it("imports the order as a prescription tagged 'Ordered at visit', never an open course", () => {
    const r = extractFromCcda(doc(ORDERED_PRESCRIPTIONS));
    const meds = r.records.filter((x) => x.category === "prescription");
    expect(meds).toHaveLength(1);
    const m = meds[0];
    expect(m.name).toBe("Atorvastatin 20 mg tablet");
    expect(m.value).toBe("20 mg");
    expect(m.date).toBe("2026-06-03");
    expect(m.courses).toHaveLength(1);
    const course = m.courses![0];
    // The section documents an order EVENT, not a current regimen: an "active"
    // status is capped so the order can never surface as a current medication.
    expect(course.started_on).toBe("2026-06-03");
    expect(course.stopped_on).toBe("2026-06-03");
    expect(course.stop_reason).toBe("completed_course");
    expect(course.notes).toBe("Ordered at visit");
  });

  it("keeps an explicit therapy period's bounds", () => {
    const r = extractFromCcda(doc(ORDERED_BOUNDED));
    const meds = r.records.filter((x) => x.category === "prescription");
    expect(meds).toHaveLength(1);
    const course = meds[0].courses![0];
    expect(course.started_on).toBe("2026-06-03");
    expect(course.stopped_on).toBe("2026-06-13");
    expect(course.notes).toBe("Ordered at visit");
  });

  it("anchors an undated order (LOINC-only section match) to the document date, still closed", () => {
    const r = extractFromCcda(doc(ORDERED_UNDATED));
    const meds = r.records.filter((x) => x.category === "prescription");
    expect(meds).toHaveLength(1);
    const m = meds[0];
    expect(m.name).toBe("Clarithromycin 250 mg tablet");
    expect(m.date).toBe("2026-06-03"); // the document date
    expect(m.courses).toHaveLength(1);
    expect(m.courses![0].started_on).toBe("2026-06-03");
    expect(m.courses![0].stopped_on).toBe("2026-06-03");
  });
});

describe("Patient Instructions (69730-0, #268)", () => {
  it("attaches the instruction narrative to the single same-document encounter", () => {
    const r = extractFromCcda(doc(OFFICE_ENCOUNTER, PATIENT_INSTRUCTIONS));
    expect(r.encounters).toHaveLength(1);
    expect(r.encounters![0].notes).toBe(
      "Take medication with food. Schedule a lipid panel in 3 months."
    );
  });

  it("stores the instructions as a standalone dated note when there is no encounter", () => {
    const r = extractFromCcda(doc(PATIENT_INSTRUCTIONS));
    expect(r.encounters).toHaveLength(1);
    const note = r.encounters![0];
    expect(note.type).toBe("Patient Instructions");
    expect(note.date).toBe("2026-06-03"); // the document date
    expect(note.notes).toBe(
      "Take medication with food. Schedule a lipid panel in 3 months."
    );
  });
});

describe("Functional Status (47420-5, #268)", () => {
  it("imports bare and organizer-nested assessment observations as qualitative records", () => {
    const r = extractFromCcda(doc(FUNCTIONAL_STATUS));
    const byName = new Map(r.records.map((x) => [x.name, x]));
    expect([...byName.keys()].sort()).toEqual([
      "Ambulation",
      "Cognitive status",
    ]);
    const amb = byName.get("Ambulation")!;
    expect(amb.category).toBe("lab");
    expect(amb.value).toBe("Independent walking");
    expect(amb.date).toBe("2026-06-01");
    expect(byName.get("Cognitive status")!.value).toBe("Well in self");
  });

  it("does not carry the assessment LOINC onto the stored record (no unmapped-lab noise)", () => {
    const r = extractFromCcda(doc(FUNCTIONAL_STATUS));
    for (const rec of r.records) {
      expect(rec.loinc, rec.name).toBeNull();
    }
    // The unmapped-lab-code report must not invite canonicalizing assessment
    // instruments as biomarkers.
    expect(r.report!.unmappedLoincs).toEqual([]);
  });

  it("itemizes a null-flavored assessment as a drop with the section chip", () => {
    const r = extractFromCcda(doc(FUNCTIONAL_STATUS));
    const drop = r.report!.drops.find((d) => d.label === "Hearing status");
    expect(drop).toBeTruthy();
    expect(drop!.kind).toBe("lab");
    expect(drop!.reason).toBe("null_flavor");
    expect(drop!.section).toBe("Functional Status");
  });

  // #694: an assessment reusing a VITAL_LOINCS code (8302-2 height) must NOT be
  // reclassified to "vitals" — the mapper's vitals-override is disabled for the
  // functional-status extractor, so the record stays a `lab` assessment (and its
  // loinc is still stripped, so the misclassification can't hide either).
  it("keeps a vital-LOINC-colliding assessment as a lab, never 'vitals' (#694)", () => {
    const r = extractFromCcda(doc(FUNCTIONAL_STATUS_VITAL_COLLISION));
    const rec = r.records.find((x) => x.name === "Reach ability");
    expect(rec, "assessment record present").toBeTruthy();
    expect(rec!.category).toBe("lab");
    expect(rec!.value).toBe("Full reach");
    expect(rec!.loinc).toBeNull();
    // And it never leaks into the vitals category.
    expect(r.records.some((x) => x.category === "vitals")).toBe(false);
  });
});

describe("Results noise drops (#681/#684/#722/#693 — precise reasons)", () => {
  it("drops non-analyte + derived-percentile rows, keeps the real analyte", () => {
    const r = extractFromCcda(doc(RESULTS_WITH_NOISE));
    const names = r.records.map((x) => x.name).sort();
    expect(names).toEqual(["Glucose"]);
    // The administrative + percentile codes never surface in the unmapped-code report.
    expect(r.report!.unmappedLoincs).toEqual([]);
  });

  it("classifies the administrative row as 'non_analyte', not 'other'", () => {
    const r = extractFromCcda(doc(RESULTS_WITH_NOISE));
    const specimen = r.report!.drops.find(
      (d) => d.label === "Specimen Expiration Date"
    );
    expect(specimen).toBeTruthy();
    expect(specimen!.reason).toBe("non_analyte");
    const approved = r.report!.drops.find((d) => d.label === "Approved By");
    expect(approved!.reason).toBe("non_analyte");
  });

  it("classifies the derived percentile as 'derived_percentile', not 'other'", () => {
    const r = extractFromCcda(doc(RESULTS_WITH_NOISE));
    const pct = r.report!.drops.find((d) => d.label === "BMI percentile");
    expect(pct).toBeTruthy();
    expect(pct!.reason).toBe("derived_percentile");
  });
});

describe("Insurance (48768-6, #268 — recognized but ignored)", () => {
  it("imports nothing from the section and reports no unrecognized-section gap", () => {
    const r = extractFromCcda(doc(INSURANCE));
    expect(r.records).toEqual([]);
    expect(r.conditions).toEqual([]);
    expect(r.encounters).toEqual([]);
    expect(
      r.report!.drops.filter((d) => d.reason === "unrecognized_section")
    ).toEqual([]);
    const entry = r.report!.coverage.find((c) => c.title === "Insurance");
    expect(entry).toBeTruthy();
    expect(entry!.key).toBe("insurance");
    expect(entry!.consumed).toBe(false);
    expect(entry!.ignored).toBe(true);
  });
});

describe("import coverage (#268 sections no longer unrecognized)", () => {
  it("reports the consumed sections with their keys and Insurance as ignored", () => {
    const r = extractFromCcda(
      doc(
        OFFICE_ENCOUNTER,
        ORDERED_PRESCRIPTIONS,
        PATIENT_INSTRUCTIONS,
        FUNCTIONAL_STATUS,
        INSURANCE
      )
    );
    const coverage = r.report!.coverage;
    const expectKeys: Record<string, string> = {
      "Ordered Prescriptions": "orderedPrescriptions",
      "Patient Instructions": "clinicalNotes",
      "Functional Status": "functionalStatus",
    };
    for (const [title, key] of Object.entries(expectKeys)) {
      const entry = coverage.find((c) => c.title === title);
      expect(entry, `coverage entry for ${title}`).toBeTruthy();
      expect(entry!.consumed, `${title} consumed`).toBe(true);
      expect(entry!.key, `${title} key`).toBe(key);
    }
    const insurance = coverage.find((c) => c.title === "Insurance")!;
    expect(insurance.consumed).toBe(false);
    expect(insurance.ignored).toBe(true);
    const unrecognized = r.report!.drops.filter(
      (d) => d.reason === "unrecognized_section"
    );
    expect(unrecognized).toEqual([]);
  });
});

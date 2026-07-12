import { describe, expect, it } from "vitest";
import { parseFhirBundle } from "@/lib/fhir";
import { extractFromCcda } from "@/lib/cda";
import { conditionExternalId, allergyExternalId } from "@/lib/clinical-parse";

// Fixture-based coverage for the FHIR resource types added on top of
// Patient/Observation/Immunization: Condition, AllergyIntolerance,
// MedicationRequest/Statement, Encounter, DiagnosticReport — plus reference
// resolution, status/negation handling, provider provenance, and the external_id
// consistency that lets a record present in both a CCD and a FHIR bundle dedup.

// An entry with an explicit fullUrl (so urn:uuid references resolve).
function bundleWithUrls(
  entries: { fullUrl?: string; resource: object }[]
): string {
  return JSON.stringify({
    resourceType: "Bundle",
    type: "collection",
    entry: entries,
  });
}

function bundle(resources: object[]): string {
  return bundleWithUrls(resources.map((resource) => ({ resource })));
}

describe("FHIR Condition → ImportedCondition", () => {
  it("maps code system, clinical status, onset, and resolution date", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "Condition",
          clinicalStatus: {
            coding: [
              {
                system:
                  "http://terminology.hl7.org/CodeSystem/condition-clinical",
                code: "resolved",
              },
            ],
          },
          code: {
            text: "Essential hypertension",
            coding: [
              { system: "http://snomed.info/sct", code: "59621000" },
              { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "I10" },
            ],
          },
          onsetDateTime: "2019-05-01",
          abatementDateTime: "2022-08-15",
        },
      ])
    );
    expect(r.conditions).toHaveLength(1);
    const c = r.conditions![0];
    expect(c).toMatchObject({
      name: "Essential hypertension",
      // ICD-10-CM preferred over SNOMED (mirrors the CDA pickCode preference).
      code: "I10",
      code_system: "ICD-10-CM",
      status: "resolved",
      onset_date: "2019-05-01",
      resolved_date: "2022-08-15",
    });
    // external_id uses the shared `ccda:condition:` builder → cross-format dedup.
    expect(c.external_id).toBe(
      conditionExternalId({
        name: c.name,
        code: "I10",
        onsetDate: "2019-05-01",
      })
    );
    expect(c.external_id).toBe("ccda:condition:i10:2019-05-01");
  });

  it("skips entered-in-error conditions and defaults status to active", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "Condition",
          verificationStatus: {
            coding: [
              {
                system:
                  "http://terminology.hl7.org/CodeSystem/condition-ver-status",
                code: "entered-in-error",
              },
            ],
          },
          code: { text: "Typo diagnosis" },
        },
        { resourceType: "Condition", code: { text: "Asthma" } },
      ])
    );
    expect(r.conditions!.map((c) => c.name)).toEqual(["Asthma"]);
    expect(r.conditions![0].status).toBe("active");
    expect(r.conditions![0].resolved_date).toBeNull();
  });
});

describe("FHIR AllergyIntolerance → ImportedAllergy", () => {
  it("maps substance, reaction, severity, status and a stable external_id", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "AllergyIntolerance",
          clinicalStatus: {
            coding: [
              {
                system:
                  "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
                code: "active",
              },
            ],
          },
          criticality: "high",
          code: {
            text: "Penicillin G",
            coding: [
              {
                system: "http://www.nlm.nih.gov/research/umls/rxnorm",
                code: "7980",
              },
            ],
          },
          onsetDateTime: "2015-03-10",
          reaction: [
            {
              manifestation: [{ text: "Hives" }],
              severity: "moderate",
            },
          ],
        },
      ])
    );
    expect(r.allergies).toHaveLength(1);
    const a = r.allergies![0];
    expect(a).toMatchObject({
      substance: "Penicillin G",
      substance_code: "7980",
      substance_code_system: "RxNorm",
      reaction: "Hives",
      // reaction[].severity wins over criticality.
      severity: "moderate",
      status: "active",
      onset_date: "2015-03-10",
    });
    expect(a.external_id).toBe(
      allergyExternalId({
        substance: "Penicillin G",
        substanceCode: "7980",
        onsetDate: "2015-03-10",
      })
    );
  });

  it("honors the no-known-allergy negation (coded and textual)", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "AllergyIntolerance",
          code: {
            coding: [{ system: "http://snomed.info/sct", code: "716186003" }],
            text: "No known allergy",
          },
        },
        {
          resourceType: "AllergyIntolerance",
          code: { text: "NKDA" },
        },
      ])
    );
    expect(r.allergies).toEqual([]);
  });

  it("falls back to criticality when no reaction severity is given", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "AllergyIntolerance",
          criticality: "low",
          code: { text: "Latex" },
        },
      ])
    );
    expect(r.allergies![0].severity).toBe("low");
    expect(r.allergies![0].reaction).toBeNull();
  });
});

describe("FHIR MedicationRequest / MedicationStatement → medication record", () => {
  it("maps an inline medicationCodeableConcept with dosage text", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "MedicationRequest",
          status: "active",
          authoredOn: "2023-01-04",
          medicationCodeableConcept: {
            text: "Lisinopril 10 MG Oral Tablet",
            coding: [
              {
                system: "http://www.nlm.nih.gov/research/umls/rxnorm",
                code: "314076",
              },
            ],
          },
          dosageInstruction: [{ text: "Take 1 tablet by mouth daily" }],
        },
      ])
    );
    expect(r.records).toHaveLength(1);
    const m = r.records[0];
    expect(m).toMatchObject({
      category: "prescription",
      name: "Lisinopril 10 MG Oral Tablet",
      value: "Take 1 tablet by mouth daily",
      date: "2023-01-04",
    });
    // Shared `ccda:rx:` medication key → dedups with the same drug from a CCD.
    expect(m.external_id).toBe("ccda:rx:314076:2023-01-04");
  });

  it("captures prescriber (requester), pharmacy (dispenseRequest.performer), and Rx number (identifier) — #417", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "MedicationRequest",
          status: "active",
          authoredOn: "2023-02-01",
          identifier: [{ system: "urn:rx", value: "RX-555017" }],
          medicationCodeableConcept: {
            text: "Metformin 500 MG Oral Tablet",
            coding: [
              {
                system: "http://www.nlm.nih.gov/research/umls/rxnorm",
                code: "860975",
              },
            ],
          },
          requester: { display: "Dr. Ada Prescriber" },
          dispenseRequest: { performer: { display: "Test Pharmacy #12" } },
          dosageInstruction: [{ text: "Take 1 tablet by mouth twice daily" }],
        },
      ])
    );
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({
      category: "prescription",
      name: "Metformin 500 MG Oral Tablet",
      prescriber: "Dr. Ada Prescriber",
      pharmacy: "Test Pharmacy #12",
      rxNumber: "RX-555017",
    });
  });

  it("resolves a contained medicationReference (MedicationStatement)", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "MedicationStatement",
          status: "active",
          effectiveDateTime: "2022-11-20",
          contained: [
            {
              resourceType: "Medication",
              id: "med1",
              code: {
                text: "Metformin 500 MG",
                coding: [
                  {
                    system: "http://www.nlm.nih.gov/research/umls/rxnorm",
                    code: "860975",
                  },
                ],
              },
            },
          ],
          medicationReference: { reference: "#med1" },
          dosage: [{ text: "500 mg twice daily" }],
        },
      ])
    );
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({
      name: "Metformin 500 MG",
      value: "500 mg twice daily",
      date: "2022-11-20",
      external_id: "ccda:rx:860975:2022-11-20",
    });
  });

  it("skips entered-in-error medications and undated ones", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "MedicationRequest",
          status: "entered-in-error",
          authoredOn: "2023-01-04",
          medicationCodeableConcept: { text: "Bad Rx" },
        },
        {
          resourceType: "MedicationRequest",
          status: "active",
          medicationCodeableConcept: { text: "No date Rx" },
        },
      ])
    );
    expect(r.records).toEqual([]);
  });
});

describe("FHIR Encounter → ImportedEncounter", () => {
  it("maps period, class, type, reason, diagnosis + provider/location refs", () => {
    const r = parseFhirBundle(
      bundleWithUrls([
        {
          fullUrl: "urn:uuid:prac-1",
          resource: {
            resourceType: "Practitioner",
            id: "prac-1",
            name: [{ given: ["Alan"], family: "Turing" }],
            identifier: [
              { system: "http://hl7.org/fhir/sid/us-npi", value: "1234567890" },
            ],
          },
        },
        {
          fullUrl: "urn:uuid:org-1",
          resource: {
            resourceType: "Location",
            id: "loc-1",
            name: "Bletchley Clinic",
          },
        },
        {
          fullUrl: "urn:uuid:cond-1",
          resource: {
            resourceType: "Condition",
            id: "cond-1",
            code: { text: "Acute bronchitis" },
          },
        },
        {
          fullUrl: "urn:uuid:enc-1",
          resource: {
            resourceType: "Encounter",
            id: "enc-1",
            status: "finished",
            class: {
              system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
              code: "AMB",
            },
            type: [{ text: "Office Visit" }],
            period: { start: "2024-02-14", end: "2024-02-14" },
            reasonCode: [{ text: "Cough" }],
            participant: [{ individual: { reference: "urn:uuid:prac-1" } }],
            location: [{ location: { reference: "urn:uuid:org-1" } }],
            diagnosis: [{ condition: { reference: "urn:uuid:cond-1" } }],
          },
        },
      ])
    );
    expect(r.encounters).toHaveLength(1);
    const e = r.encounters![0];
    expect(e).toMatchObject({
      date: "2024-02-14",
      end_date: "2024-02-14",
      type: "Office Visit",
      class_code: "AMB",
      reason: "Cough",
      diagnoses: ["Acute bronchitis"],
      external_id: "ccda:encounter:enc-1",
    });
    // Performer resolved to the Practitioner (with NPI); location to the facility.
    expect(e.provider).toMatchObject({
      name: "Alan Turing",
      type: "individual",
      npi: "1234567890",
    });
    expect(e.location).toMatchObject({
      name: "Bletchley Clinic",
      type: "organization",
    });
  });

  it("skips entered-in-error and dateless encounters", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "Encounter",
          status: "entered-in-error",
          period: { start: "2024-01-01" },
        },
        { resourceType: "Encounter", status: "finished" },
      ])
    );
    expect(r.encounters).toEqual([]);
  });
});

describe("FHIR Appointment → ImportedAppointment (#416)", () => {
  it("maps start (with time), status, description, service kind + practitioner/location participants", () => {
    const r = parseFhirBundle(
      bundleWithUrls([
        {
          fullUrl: "urn:uuid:prac-1",
          resource: {
            resourceType: "Practitioner",
            id: "prac-1",
            name: [{ given: ["Grace"], family: "Hopper" }],
          },
        },
        {
          fullUrl: "urn:uuid:appt-1",
          resource: {
            resourceType: "Appointment",
            id: "appt-1",
            status: "booked",
            description: "Dental cleaning",
            serviceType: [{ concept: { text: "Dental" } }],
            start: "2030-08-01T14:30:00Z",
            comment: "Bring insurance card",
            participant: [
              { actor: { reference: "urn:uuid:prac-1" }, status: "accepted" },
              {
                actor: {
                  reference: "Location/loc-9",
                  display: "Sample Dental Office",
                },
                status: "accepted",
              },
            ],
          },
        },
      ])
    );
    expect(r.appointments).toHaveLength(1);
    const a = r.appointments![0];
    expect(a).toMatchObject({
      scheduled_at: "2030-08-01T14:30",
      status: "scheduled",
      title: "Dental cleaning",
      location: "Sample Dental Office",
      notes: "Bring insurance card",
      kind: "dental",
      external_id: "fhir:appointment:appt-1",
    });
    expect(a.provider).toMatchObject({
      name: "Grace Hopper",
      type: "individual",
    });
  });

  it("maps fulfilled→completed and cancelled/noshow→cancelled", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "Appointment",
          id: "a1",
          status: "fulfilled",
          start: "2030-01-01",
        },
        {
          resourceType: "Appointment",
          id: "a2",
          status: "cancelled",
          start: "2030-01-02",
        },
        {
          resourceType: "Appointment",
          id: "a3",
          status: "noshow",
          start: "2030-01-03",
        },
      ])
    );
    const byId = Object.fromEntries(
      (r.appointments ?? []).map((a) => [a.external_id, a.status])
    );
    expect(byId["fhir:appointment:a1"]).toBe("completed");
    expect(byId["fhir:appointment:a2"]).toBe("cancelled");
    expect(byId["fhir:appointment:a3"]).toBe("cancelled");
  });

  it("drops entered-in-error and startless appointments", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "Appointment",
          status: "entered-in-error",
          start: "2030-01-01",
        },
        { resourceType: "Appointment", status: "booked" },
      ])
    );
    expect(r.appointments).toEqual([]);
  });
});

describe("FHIR provider provenance on Observation / Immunization", () => {
  it("attaches the resolved performing organization to an Observation record", () => {
    const r = parseFhirBundle(
      bundleWithUrls([
        {
          fullUrl: "urn:uuid:lab-1",
          resource: {
            resourceType: "Organization",
            id: "lab-1",
            name: "Quest Diagnostics",
          },
        },
        {
          fullUrl: "urn:uuid:obs-1",
          resource: {
            resourceType: "Observation",
            id: "obs-1",
            status: "final",
            code: {
              text: "Hemoglobin A1c",
              coding: [{ system: "http://loinc.org", code: "4548-4" }],
            },
            valueQuantity: { value: 5.6, unit: "%" },
            effectiveDateTime: "2024-03-01",
            performer: [{ reference: "urn:uuid:lab-1" }],
          },
        },
      ])
    );
    expect(r.records).toHaveLength(1);
    expect(r.records[0].provider).toMatchObject({
      name: "Quest Diagnostics",
      type: "organization",
    });
  });

  it("captures the Immunization performer via a bare resourceType/id reference", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "Organization",
          id: "clinic-9",
          name: "Community Health",
        },
        {
          resourceType: "Immunization",
          status: "completed",
          vaccineCode: {
            coding: [{ system: "http://hl7.org/fhir/sid/cvx", code: "08" }],
          },
          occurrenceDateTime: "2020-09-01",
          performer: [{ actor: { reference: "Organization/clinic-9" } }],
        },
      ])
    );
    expect(r.immunizations).toHaveLength(1);
    expect(r.immunizations[0].provider).toMatchObject({
      name: "Community Health",
      type: "organization",
    });
  });
});

describe("FHIR DiagnosticReport → contained lab Observations", () => {
  it("extracts contained Observations and dedups against top-level ones", () => {
    const topLevelObs = {
      resourceType: "Observation",
      id: "obs-top",
      status: "final",
      code: {
        text: "Glucose",
        coding: [{ system: "http://loinc.org", code: "2345-7" }],
      },
      valueQuantity: { value: 92, unit: "mg/dL" },
      effectiveDateTime: "2024-04-01",
    };
    const r = parseFhirBundle(
      bundle([
        topLevelObs,
        {
          resourceType: "DiagnosticReport",
          status: "final",
          code: { text: "CMP" },
          contained: [
            {
              resourceType: "Observation",
              id: "obs-contained",
              status: "final",
              code: {
                text: "Sodium",
                coding: [{ system: "http://loinc.org", code: "2951-2" }],
              },
              valueQuantity: { value: 140, unit: "mmol/L" },
              effectiveDateTime: "2024-04-01",
            },
          ],
          // References the already-top-level Glucose obs — collapses on external_id.
          result: [{ reference: "Observation/obs-top" }],
        },
      ])
    );
    // Glucose (top-level + referenced) dedups to one; Sodium (contained) added.
    expect(r.records.map((x) => x.name).sort()).toEqual(["Glucose", "Sodium"]);
  });
});

// Fix 1: component[] observations (blood pressure) + the valueless-Observation drop.
describe("FHIR Observation component[] + valueless guard", () => {
  it("expands a blood-pressure Observation (85354-9) into systolic + diastolic", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "Observation",
          status: "final",
          // The BP panel code carries NO top-level value — the numbers live in
          // component[], exactly as Epic/Apple "Export FHIR" ships blood pressure.
          code: {
            text: "Blood pressure",
            coding: [{ system: "http://loinc.org", code: "85354-9" }],
          },
          effectiveDateTime: "2024-05-01",
          component: [
            {
              code: {
                text: "Systolic",
                coding: [{ system: "http://loinc.org", code: "8480-6" }],
              },
              valueQuantity: { value: 122, unit: "mm[Hg]" },
            },
            {
              code: {
                text: "Diastolic",
                coding: [{ system: "http://loinc.org", code: "8462-4" }],
              },
              valueQuantity: { value: 78, unit: "mm[Hg]" },
            },
          ],
        },
      ])
    );
    // Two readings, canonicalized + routed to vitals via their component LOINCs.
    expect(r.records).toHaveLength(2);
    const byCanonical = new Map(r.records.map((x) => [x.canonical, x]));
    expect(byCanonical.get("Blood Pressure Systolic")).toMatchObject({
      category: "vitals",
      value_num: 122,
      loinc: "8480-6",
      date: "2024-05-01",
    });
    expect(byCanonical.get("Blood Pressure Diastolic")).toMatchObject({
      category: "vitals",
      value_num: 78,
      loinc: "8462-4",
    });
    // The parent BP row is NOT imported as a nameless "—".
    expect(r.records.every((x) => x.value_num != null)).toBe(true);
  });

  it("drops a valueless, component-less Observation as no_value", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "Observation",
          status: "final",
          code: {
            text: "Empty Result",
            coding: [{ system: "http://loinc.org", code: "8251-1" }],
          },
          effectiveDateTime: "2024-05-01",
          // No valueQuantity / valueString / valueCodeableConcept, no component[].
        },
      ])
    );
    expect(r.records).toHaveLength(0);
    const report = r.report!;
    expect(
      report.drops.some(
        (d) => d.reason === "no_value" && d.label === "Empty Result"
      )
    ).toBe(true);
  });
});

// Fix 3: a lab whose LOINC has no canonical mapping still imports, and is listed in
// the report's unmappedLoincs annotation (not dropped).
describe("FHIR unmapped-LOINC surfacing", () => {
  it("imports the reading AND lists its LOINC in unmappedLoincs", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "Observation",
          status: "final",
          code: {
            text: "Exotic Assay",
            coding: [{ system: "http://loinc.org", code: "99999-9" }],
          },
          valueQuantity: { value: 3.14, unit: "ng/mL" },
          effectiveDateTime: "2024-06-01",
        },
      ])
    );
    // Still imported (under its printed name).
    expect(r.records.map((x) => x.name)).toEqual(["Exotic Assay"]);
    // And surfaced as an unmapped LOINC — not dropped.
    expect(r.report!.unmappedLoincs).toEqual([
      { loinc: "99999-9", name: "Exotic Assay", count: 1, unit: "ng/mL" },
    ]);
    expect(r.report!.drops.some((d) => d.label === "Exotic Assay")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F15: the SAME logical record imported through BOTH the CCD path
// (extractFromCcda) and the FHIR path (parseFhirBundle) must produce EQUAL
// external_ids for a condition and an allergy (so the two formats dedup to one
// row), and — for a medication whose dates align — an equal medication key too.
// This locks the cross-format dedup that F1/F3 were about.
// ---------------------------------------------------------------------------

// A minimal CCD carrying one problem, one allergy, one medication — the same three
// records the FHIR bundle below encodes.
const CROSS_CCD = `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget><patientRole><patient>
    <name><given>Test</given><family>Patient</family></name>
  </patient></patientRole></recordTarget>
  <component><structuredBody>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>
      <code code="11450-4" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Active Problems</title>
      <entry><act classCode="ACT" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.3"/>
        <statusCode code="active"/>
        <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
          <effectiveTime><low value="20190601"/></effectiveTime>
          <value xsi:type="CD" code="195967001" codeSystem="2.16.840.1.113883.6.96" displayName="Asthma">
            <translation code="J45.909" codeSystem="2.16.840.1.113883.6.90" displayName="Unspecified asthma"/>
          </value>
        </observation></entryRelationship>
      </act></entry>
    </section></component>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.6.1"/>
      <code code="48765-2" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Allergies</title>
      <entry><act classCode="ACT" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.30"/>
        <statusCode code="active"/>
        <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.22.4.7"/>
          <effectiveTime><low value="20180101"/></effectiveTime>
          <participant typeCode="CSM"><participantRole classCode="MANU"><playingEntity classCode="MMAT">
            <code code="7980" codeSystem="2.16.840.1.113883.6.88" displayName="Penicillin"/>
          </playingEntity></participantRole></participant>
        </observation></entryRelationship>
      </act></entry>
    </section></component>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.1.1"/>
      <code code="10160-0" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Medications</title>
      <entry><substanceAdministration classCode="SBADM" moodCode="EVN">
        <effectiveTime type="IVL_TS"><low value="20240101"/><high value="20241231"/></effectiveTime>
        <doseQuantity value="10" unit="mg"/>
        <consumable><manufacturedProduct><manufacturedMaterial>
          <code code="83367" codeSystem="2.16.840.1.113883.6.88" displayName="Atorvastatin"/>
          <name>Atorvastatin 10 mg tablet</name>
        </manufacturedMaterial></manufacturedProduct></consumable>
      </substanceAdministration></entry>
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;

// The equivalent three records as FHIR resources.
const CROSS_FHIR = JSON.stringify({
  resourceType: "Bundle",
  type: "collection",
  entry: [
    {
      resource: {
        resourceType: "Condition",
        code: {
          text: "Asthma",
          coding: [
            { system: "http://snomed.info/sct", code: "195967001" },
            { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "J45.909" },
          ],
        },
        onsetDateTime: "2019-06-01",
      },
    },
    {
      resource: {
        resourceType: "AllergyIntolerance",
        code: {
          text: "Penicillin",
          coding: [
            {
              system: "http://www.nlm.nih.gov/research/umls/rxnorm",
              code: "7980",
            },
          ],
        },
        onsetDateTime: "2018-01-01",
      },
    },
    {
      resource: {
        resourceType: "MedicationStatement",
        status: "active",
        effectiveDateTime: "2024-01-01",
        medicationCodeableConcept: {
          text: "Atorvastatin 10 mg tablet",
          coding: [
            {
              system: "http://www.nlm.nih.gov/research/umls/rxnorm",
              code: "83367",
            },
          ],
        },
      },
    },
  ],
});

describe("CDA ↔ FHIR cross-format external_id dedup (F15)", () => {
  const ccd = extractFromCcda(CROSS_CCD);
  const fhir = parseFhirBundle(CROSS_FHIR);

  it("produces the SAME condition external_id in both formats", () => {
    expect(ccd.conditions).toHaveLength(1);
    expect(fhir.conditions).toHaveLength(1);
    // Both prefer the ICD-10 code → identical key → one row after persist dedup.
    expect(fhir.conditions![0].external_id).toBe(
      ccd.conditions![0].external_id
    );
    expect(fhir.conditions![0].external_id).toBe(
      "ccda:condition:j45.909:2019-06-01"
    );
  });

  it("produces the SAME allergy external_id in both formats", () => {
    expect(ccd.allergies).toHaveLength(1);
    expect(fhir.allergies).toHaveLength(1);
    expect(fhir.allergies![0].external_id).toBe(ccd.allergies![0].external_id);
    expect(fhir.allergies![0].external_id).toBe("ccda:allergy:7980:2018-01-01");
  });

  it("produces the SAME medication external_id when the dates align", () => {
    const ccdRx = ccd.records.filter((r) => r.category === "prescription");
    const fhirRx = fhir.records.filter((r) => r.category === "prescription");
    expect(ccdRx).toHaveLength(1);
    expect(fhirRx).toHaveLength(1);
    // FHIR now prefers effectiveDateTime, matching the CDA effectiveTime low.
    expect(fhirRx[0].external_id).toBe(ccdRx[0].external_id);
    expect(fhirRx[0].external_id).toBe("ccda:rx:83367:2024-01-01");
  });
});

describe("FHIR medicationReference resolution is type-guarded (F5)", () => {
  it("does not resolve a dangling Medication/X to a same-id non-Medication", () => {
    const r = parseFhirBundle(
      bundle([
        // An Observation whose bare id collides with the med reference's id.
        {
          resourceType: "Observation",
          id: "shared-1",
          status: "final",
          code: {
            text: "Glucose",
            coding: [{ system: "http://loinc.org", code: "2345-7" }],
          },
          valueQuantity: { value: 92, unit: "mg/dL" },
          effectiveDateTime: "2024-04-01",
        },
        // The referenced Medication/shared-1 is absent — must NOT fall through to
        // the Observation (which would coin a prescription with a LOINC in the key).
        {
          resourceType: "MedicationStatement",
          status: "active",
          effectiveDateTime: "2024-04-01",
          medicationReference: { reference: "Medication/shared-1" },
        },
      ])
    );
    // Only the Glucose lab survives; no prescription is fabricated.
    expect(r.records.map((x) => x.category)).toEqual(["lab"]);
    expect(r.records.some((x) => x.category === "prescription")).toBe(false);
  });
});

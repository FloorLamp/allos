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

  // #590 parity: the same import intelligence the CDA path applies (birth-event /
  // stale self-limited downgrade, explicit-status authority) fires on FHIR too, so
  // the two formats can't drift.
  it("downgrades a Z38 birth-event problem to resolved (parity)", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "Condition",
          // No clinicalStatus → would default active; the Z38 code downgrades it.
          code: {
            text: "Single liveborn, born in hospital",
            coding: [
              { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "Z38.0" },
            ],
          },
        },
      ])
    );
    expect(r.conditions![0].status).toBe("resolved");
    expect(r.conditions![0].resolved_date).toBeNull();
  });

  it("downgrades a stale self-limited active problem to resolved (parity)", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "Condition",
          code: {
            text: "Acute pharyngitis",
            coding: [
              { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "J02.9" },
            ],
          },
          onsetDateTime: "2020-01-01", // decades-old on any plausible run date
        },
      ])
    );
    expect(r.conditions![0].status).toBe("resolved");
  });

  it("keeps an explicit clinicalStatus active on a listed name (authoritative)", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "Condition",
          clinicalStatus: {
            coding: [
              {
                system:
                  "http://terminology.hl7.org/CodeSystem/condition-clinical",
                code: "active",
              },
            ],
          },
          code: {
            text: "Influenza",
            coding: [
              { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "J11.1" },
            ],
          },
          onsetDateTime: "2020-01-01",
        },
      ])
    );
    expect(r.conditions![0].status).toBe("active");
  });

  it("leaves a chronic-capable active problem untouched (parity)", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "Condition",
          code: {
            text: "Asthma",
            coding: [
              { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "J45.909" },
            ],
          },
          onsetDateTime: "2010-01-01",
        },
      ])
    );
    expect(r.conditions![0].status).toBe("active");
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

  it("captures the encounter TYPE code from type[].coding (#1035)", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "Encounter",
          id: "enc-coded",
          status: "finished",
          class: {
            system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
            code: "AMB",
          },
          // Epic's common shape: a generic display with the CPT preventive-visit
          // code in the coding — the code is what proves it's the annual physical.
          type: [
            {
              text: "Office Visit",
              coding: [
                {
                  system: "http://www.ama-assn.org/go/cpt",
                  code: "99396",
                  display: "Est patient preventive visit 40-64",
                },
              ],
            },
          ],
          period: { start: "2026-03-01" },
        },
      ])
    );
    expect(r.encounters).toHaveLength(1);
    expect(r.encounters![0]).toMatchObject({
      type: "Office Visit",
      code: "99396",
      class_code: "AMB",
    });
    // A coding-less type (text only) leaves the code null.
    const r2 = parseFhirBundle(
      bundle([
        {
          resourceType: "Encounter",
          id: "enc-plain",
          status: "finished",
          type: [{ text: "Office Visit" }],
          period: { start: "2026-03-02" },
        },
      ])
    );
    expect(r2.encounters![0].code).toBeNull();
    expect(r2.encounters![0].code_system).toBeNull();
  });

  // #2589 half 1: the source states the rank as DATA, so it is captured as data.
  // The withdrawn attempts at #2589 tried to read a rank out of the display name;
  // these assert the opposite discipline — a rank exists only where a source
  // wrote one in a structured field.
  it("captures Encounter.diagnosis.rank and .use as structured ranks (#2589)", () => {
    const r = parseFhirBundle(
      bundleWithUrls([
        {
          fullUrl: "urn:uuid:cond-primary",
          resource: {
            resourceType: "Condition",
            id: "cond-primary",
            code: { text: "Acute bronchitis" },
          },
        },
        {
          fullUrl: "urn:uuid:cond-other",
          resource: {
            resourceType: "Condition",
            id: "cond-other",
            code: { text: "Essential hypertension" },
          },
        },
        {
          fullUrl: "urn:uuid:enc-ranked",
          resource: {
            resourceType: "Encounter",
            id: "enc-ranked",
            status: "finished",
            period: { start: "2026-04-01" },
            diagnosis: [
              {
                condition: { reference: "urn:uuid:cond-primary" },
                rank: 1,
                use: {
                  coding: [
                    {
                      system:
                        "http://terminology.hl7.org/CodeSystem/diagnosis-role",
                      code: "DD",
                    },
                  ],
                },
              },
              { condition: { reference: "urn:uuid:cond-other" }, rank: 2 },
            ],
          },
        },
      ])
    );
    const e = r.encounters![0];
    expect(e.diagnoses).toEqual(["Acute bronchitis", "Essential hypertension"]);
    expect(e.diagnosis_ranks).toEqual([
      { name: "Acute bronchitis", rank: 1, use: ["dd"] },
      { name: "Essential hypertension", rank: 2 },
    ]);
  });

  it("withholds a rank the source stated PER ROLE, and keeps both roles (#2589)", () => {
    // R4 defines rank as "ranking of the diagnosis (for each role type)". Rank 2
    // among admission diagnoses and rank 1 among discharge diagnoses are two
    // statements about one condition; taking the lower asserts THE primary
    // diagnosis where the source asserted primary-at-discharge. So the rank goes
    // and the roles stay — the same withholding this file applies to every other
    // ambiguity, rather than a claim the source did not make.
    const r = parseFhirBundle(
      bundleWithUrls([
        {
          fullUrl: "urn:uuid:cond-repeat",
          resource: {
            resourceType: "Condition",
            id: "cond-repeat",
            code: {
              text: "Community acquired pneumonia",
              coding: [{ system: "http://snomed.info/sct", code: "385093006" }],
            },
          },
        },
        {
          fullUrl: "urn:uuid:enc-repeat",
          resource: {
            resourceType: "Encounter",
            id: "enc-repeat",
            status: "finished",
            period: { start: "2026-04-02" },
            diagnosis: [
              {
                condition: { reference: "urn:uuid:cond-repeat" },
                rank: 2,
                // R5 shape: use is 0..*
                use: [
                  {
                    coding: [
                      {
                        system:
                          "http://terminology.hl7.org/CodeSystem/diagnosis-role",
                        code: "AD",
                      },
                    ],
                  },
                ],
              },
              {
                condition: { reference: "urn:uuid:cond-repeat" },
                rank: 1,
                use: [
                  {
                    coding: [
                      {
                        system:
                          "http://terminology.hl7.org/CodeSystem/diagnosis-role",
                        code: "DD",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ])
    );
    const e = r.encounters![0];
    // The name dedupe is unchanged: the two entries are one condition.
    expect(e.diagnoses).toEqual(["Community acquired pneumonia"]);
    expect(e.diagnosis_ranks).toEqual([
      { name: "Community acquired pneumonia", use: ["ad", "dd"] },
    ]);
  });

  it("keeps one rank stated consistently across roles (#2589)", () => {
    // Rank 1 at admission AND rank 1 at discharge is still rank 1 — there is
    // nothing to choose between, so withholding here would lose a fact the source
    // did state.
    const r = parseFhirBundle(
      bundleWithUrls([
        {
          fullUrl: "urn:uuid:cond-agree",
          resource: {
            resourceType: "Condition",
            id: "cond-agree",
            code: {
              text: "Community acquired pneumonia",
              coding: [{ system: "http://snomed.info/sct", code: "385093006" }],
            },
          },
        },
        {
          fullUrl: "urn:uuid:enc-agree",
          resource: {
            resourceType: "Encounter",
            id: "enc-agree",
            status: "finished",
            period: { start: "2026-04-07" },
            diagnosis: [
              {
                condition: { reference: "urn:uuid:cond-agree" },
                rank: 1,
                use: {
                  coding: [
                    {
                      system:
                        "http://terminology.hl7.org/CodeSystem/diagnosis-role",
                      code: "AD",
                    },
                  ],
                },
              },
              {
                condition: { reference: "urn:uuid:cond-agree" },
                rank: 1,
                use: {
                  coding: [
                    {
                      system:
                        "http://terminology.hl7.org/CodeSystem/diagnosis-role",
                      code: "DD",
                    },
                  ],
                },
              },
            ],
          },
        },
      ])
    );
    expect(r.encounters![0].diagnosis_ranks).toEqual([
      { name: "Community acquired pneumonia", rank: 1, use: ["ad", "dd"] },
    ]);
  });

  it("keys the merge on the resolved Condition, not on the display name (#2589)", () => {
    // Two DIFFERENT conditions — a SNOMED entry and an ICD-10 entry — that both
    // display as "Anemia", stated at different ranks. A name-keyed merge folded
    // them together and let the surviving chip claim Primary while discarding the
    // other statement. They are two statements; the names still collapse to one
    // chip (unchanged behaviour), and the badge is withheld rather than guessed.
    const r = parseFhirBundle(
      bundleWithUrls([
        {
          fullUrl: "urn:uuid:cond-snomed",
          resource: {
            resourceType: "Condition",
            id: "cond-snomed",
            code: {
              text: "Anemia",
              coding: [{ system: "http://snomed.info/sct", code: "271737000" }],
            },
          },
        },
        {
          fullUrl: "urn:uuid:cond-icd",
          resource: {
            resourceType: "Condition",
            id: "cond-icd",
            code: {
              text: "Anemia",
              coding: [
                { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "D64.9" },
              ],
            },
          },
        },
        {
          fullUrl: "urn:uuid:enc-two-anemias",
          resource: {
            resourceType: "Encounter",
            id: "enc-two-anemias",
            status: "finished",
            period: { start: "2026-04-04" },
            diagnosis: [
              { condition: { reference: "urn:uuid:cond-snomed" }, rank: 4 },
              { condition: { reference: "urn:uuid:cond-icd" }, rank: 1 },
            ],
          },
        },
      ])
    );
    const e = r.encounters![0];
    expect(e.diagnoses).toEqual(["Anemia"]);
    expect(e.diagnosis_ranks).toEqual([]);
  });

  it("treats two TEXT-ONLY same-named Conditions as one, exactly as the importer does (#2589)", () => {
    // The other side of the guard above, pinned so the claim stays honest. With no
    // coding and no onset there is nothing to tell these apart:
    // `conditionExternalId` falls back to the name, and parseFhirBundle collapses
    // them into ONE imported condition row. To this app they are one condition, so
    // their rank statements combine like any other repeat — here agreeing on
    // rank 1, which is therefore kept. The withhold guard separates only what the
    // importer's own identity separates, and this is that boundary.
    const textOnly = (id: string) => ({
      fullUrl: `urn:uuid:${id}`,
      resource: {
        resourceType: "Condition",
        id,
        code: { text: "Anemia" },
      },
    });
    const r = parseFhirBundle(
      bundleWithUrls([
        textOnly("cond-text-a"),
        textOnly("cond-text-b"),
        {
          fullUrl: "urn:uuid:enc-text-anemias",
          resource: {
            resourceType: "Encounter",
            id: "enc-text-anemias",
            status: "finished",
            period: { start: "2026-04-08" },
            diagnosis: [
              { condition: { reference: "urn:uuid:cond-text-a" }, rank: 1 },
              { condition: { reference: "urn:uuid:cond-text-b" }, rank: 1 },
            ],
          },
        },
      ])
    );
    // One condition row for both, which is what makes one rank statement correct.
    expect(r.conditions!.filter((c) => c.name === "Anemia")).toHaveLength(1);
    expect(r.encounters![0].diagnoses).toEqual(["Anemia"]);
    expect(r.encounters![0].diagnosis_ranks).toEqual([
      { name: "Anemia", rank: 1 },
    ]);
  });

  it("withholds the rank when two text-only same-named Conditions disagree (#2589)", () => {
    // Same shape, differing ranks. They are one condition to this app, so this is
    // the per-condition disagreement rule doing the work rather than the
    // per-name one — and the outcome a reader cares about is the same: no badge
    // rather than a coin flip.
    const textOnly = (id: string) => ({
      fullUrl: `urn:uuid:${id}`,
      resource: {
        resourceType: "Condition",
        id,
        code: { text: "Anemia" },
      },
    });
    const r = parseFhirBundle(
      bundleWithUrls([
        textOnly("cond-text-c"),
        textOnly("cond-text-d"),
        {
          fullUrl: "urn:uuid:enc-text-disagree",
          resource: {
            resourceType: "Encounter",
            id: "enc-text-disagree",
            status: "finished",
            period: { start: "2026-04-09" },
            diagnosis: [
              { condition: { reference: "urn:uuid:cond-text-c" }, rank: 4 },
              { condition: { reference: "urn:uuid:cond-text-d" }, rank: 1 },
            ],
          },
        },
      ])
    );
    expect(r.encounters![0].diagnoses).toEqual(["Anemia"]);
    expect(r.encounters![0].diagnosis_ranks).toEqual([]);
  });

  it("ignores a diagnosis-role code from another code system (#2589)", () => {
    // "AD" in some local system is not HL7's admission role, and this is the one
    // place an unvalidated source string would become a clinical-sounding English
    // word on a card.
    const r = parseFhirBundle(
      bundleWithUrls([
        {
          fullUrl: "urn:uuid:cond-local",
          resource: {
            resourceType: "Condition",
            id: "cond-local",
            code: { text: "Acute bronchitis" },
          },
        },
        {
          fullUrl: "urn:uuid:enc-local-use",
          resource: {
            resourceType: "Encounter",
            id: "enc-local-use",
            status: "finished",
            period: { start: "2026-04-05" },
            diagnosis: [
              {
                condition: { reference: "urn:uuid:cond-local" },
                use: {
                  coding: [
                    { system: "http://example.org/local-codes", code: "AD" },
                  ],
                },
              },
            ],
          },
        },
      ])
    );
    expect(r.encounters![0].diagnoses).toEqual(["Acute bronchitis"]);
    expect(r.encounters![0].diagnosis_ranks).toEqual([]);
  });

  it("drops an out-of-range rank instead of badging it (#2589)", () => {
    const r = parseFhirBundle(
      bundleWithUrls([
        {
          fullUrl: "urn:uuid:cond-huge",
          resource: {
            resourceType: "Condition",
            id: "cond-huge",
            code: { text: "Acute bronchitis" },
          },
        },
        {
          fullUrl: "urn:uuid:enc-huge-rank",
          resource: {
            resourceType: "Encounter",
            id: "enc-huge-rank",
            status: "finished",
            period: { start: "2026-04-06" },
            diagnosis: [
              { condition: { reference: "urn:uuid:cond-huge" }, rank: 1e21 },
            ],
          },
        },
      ])
    );
    expect(r.encounters![0].diagnoses).toEqual(["Acute bronchitis"]);
    expect(r.encounters![0].diagnosis_ranks).toEqual([]);
  });

  it("never infers a rank from a display name that carries one (#2589)", () => {
    const r = parseFhirBundle(
      bundleWithUrls([
        {
          fullUrl: "urn:uuid:cond-flat-plain",
          resource: {
            resourceType: "Condition",
            id: "cond-flat-plain",
            code: { text: "Hyperparathyroidism" },
          },
        },
        {
          fullUrl: "urn:uuid:cond-flat-suffix",
          resource: {
            resourceType: "Condition",
            id: "cond-flat-suffix",
            code: { text: "Hyperparathyroidism - Secondary" },
          },
        },
        {
          fullUrl: "urn:uuid:enc-flat",
          resource: {
            resourceType: "Encounter",
            id: "enc-flat",
            status: "finished",
            period: { start: "2026-04-03" },
            diagnosis: [
              { condition: { reference: "urn:uuid:cond-flat-plain" } },
              { condition: { reference: "urn:uuid:cond-flat-suffix" } },
            ],
          },
        },
      ])
    );
    const e = r.encounters![0];
    // Both names survive byte-for-byte and neither gains a rank: a source that
    // spells a qualifier into a name has stated nothing structurally.
    expect(e.diagnoses).toEqual([
      "Hyperparathyroidism",
      "Hyperparathyroidism - Secondary",
    ]);
    expect(e.diagnosis_ranks).toEqual([]);
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

// #2411: a component-level refusal REACHES the import report. The row-level path has
// always reported every drop; the component-level path reported none, so a BP whose
// diastolic is unusable imported as a lone systolic and the document's report said
// nothing at all — neither in the Dropped list nor in `considered`.
describe("FHIR component[] refusals reach the import report (#2411)", () => {
  const bpWith = (diastolic: object) => ({
    resourceType: "Observation",
    status: "final",
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
        valueQuantity: { value: 118, unit: "mm[Hg]" },
      },
      {
        code: {
          text: "Diastolic",
          coding: [{ system: "http://loinc.org", code: "8462-4" }],
        },
        ...diastolic,
      },
    ],
  });

  it("reports a null-flavored component under its OWN label, and counts it", () => {
    const r = parseFhirBundle(
      bundle([
        bpWith({
          dataAbsentReason: {
            coding: [
              {
                system:
                  "http://terminology.hl7.org/CodeSystem/data-absent-reason",
                code: "not-performed",
              },
            ],
          },
        }),
      ])
    );
    // The systolic still imports — a refused sibling never takes a good reading down.
    expect(r.records.map((x) => x.canonical)).toEqual([
      "Blood Pressure Systolic",
    ]);
    const report = r.report!;
    const drop = report.drops.find((d) => d.label === "Diastolic");
    // Its OWN label and its OWN reason, not the parent panel's.
    expect(drop).toMatchObject({
      kind: "vitals",
      reason: "null_flavor",
      section: "Observation",
    });
    expect(report.drops.some((d) => d.label === "Blood pressure")).toBe(false);
    // Kept + dropped add up: two candidates were considered, one kept.
    expect(report.considered).toBe(report.imported + 1);
  });

  it("classifies a component the duration door refused as unparsable_value", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "Observation",
          status: "final",
          code: { text: "Exercise test" },
          effectiveDateTime: "2024-05-01",
          component: [
            {
              code: { text: "Exercise Duration" },
              valueQuantity: { value: "not recorded", unit: "min:sec" },
            },
            {
              code: { text: "Workload" },
              valueQuantity: { value: 9, unit: "MET" },
            },
          ],
        },
      ])
    );
    expect(r.records.map((x) => x.name)).toEqual(["Workload"]);
    const drop = r.report!.drops.find((d) => d.label === "Exercise Duration");
    // "no value" would say the opposite of what happened — the source stated one.
    expect(drop?.reason).toBe("unparsable_value");
  });

  it("counts every component ONCE when the whole panel is refused", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "Observation",
          status: "final",
          code: {
            text: "Blood pressure",
            coding: [{ system: "http://loinc.org", code: "85354-9" }],
          },
          effectiveDateTime: "2024-05-01",
          component: [
            { code: { text: "Systolic" } },
            { code: { text: "Diastolic" } },
          ],
        },
      ])
    );
    expect(r.records).toHaveLength(0);
    const report = r.report!;
    // TWO candidates, two drops — and no third resource-level "no value" on top of
    // them, which would count a candidate that never existed.
    expect(report.drops.map((d) => d.label).sort()).toEqual([
      "Diastolic",
      "Systolic",
    ]);
    expect(report.considered).toBe(2);
  });

  it("reports a component refused inside a DiagnosticReport's own Observation", () => {
    const r = parseFhirBundle(
      bundleWithUrls([
        {
          resource: {
            resourceType: "DiagnosticReport",
            status: "final",
            code: { text: "Vitals panel" },
            effectiveDateTime: "2024-05-02",
            contained: [
              {
                resourceType: "Observation",
                id: "inner-bp",
                status: "final",
                code: {
                  text: "Blood pressure",
                  coding: [{ system: "http://loinc.org", code: "85354-9" }],
                },
                effectiveDateTime: "2024-05-02",
                component: [
                  {
                    code: {
                      text: "Systolic",
                      coding: [{ system: "http://loinc.org", code: "8480-6" }],
                    },
                    valueQuantity: { value: 120, unit: "mm[Hg]" },
                  },
                  { code: { text: "Diastolic" } },
                ],
              },
            ],
          },
        },
      ])
    );
    expect(r.report!.drops.some((d) => d.label === "Diastolic")).toBe(true);
  });
});

// #1018: an imported Body Temperature converts to canonical °F at the boundary —
// the same conversion every live-entry writer performs — so it joins the one
// series (charts + reference-range flags) instead of sitting verbatim in "Cel".
describe("FHIR imported temperature → canonical °F (#1018)", () => {
  const tempObs = (value: number, unit: string) => ({
    resourceType: "Observation",
    status: "final",
    code: {
      text: "Body temperature",
      coding: [{ system: "http://loinc.org", code: "8310-5" }],
    },
    effectiveDateTime: "2024-05-01",
    valueQuantity: { value, unit },
  });

  it("converts a UCUM Celsius reading (38.5 Cel → 101.3 degF)", () => {
    const r = parseFhirBundle(bundle([tempObs(38.5, "Cel")]));
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({
      canonical: "Body Temperature",
      category: "vitals",
      value_num: 101.3,
      value: "101.3",
      unit: "degF",
    });
    // Dedup identity keys on the AS-SHIPPED value, so a document whose Cel
    // reading was stored before the conversion re-imports onto the same row.
    expect(r.records[0].external_id).toContain(":38.5");
  });

  it("normalizes a UCUM Fahrenheit spelling ([degF]) onto the canonical unit", () => {
    const r = parseFhirBundle(bundle([tempObs(101.3, "[degF]")]));
    expect(r.records[0]).toMatchObject({ value_num: 101.3, unit: "degF" });
  });

  it("stores an unrecognized unit verbatim rather than guessing", () => {
    const r = parseFhirBundle(bundle([tempObs(311.2, "K")]));
    expect(r.records[0]).toMatchObject({ value_num: 311.2, unit: "K" });
  });

  it("stores an implausible converted value verbatim (junk stays out of the series)", () => {
    const r = parseFhirBundle(bundle([tempObs(900, "Cel")]));
    expect(r.records[0]).toMatchObject({ value_num: 900, unit: "Cel" });
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

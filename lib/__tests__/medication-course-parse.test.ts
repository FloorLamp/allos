import { describe, expect, it } from "vitest";
import { parseCcda } from "@/lib/cda";
import { parseFhirBundle } from "@/lib/fhir";

// End-to-end (still pure — no DB) checks that the CCD and FHIR importers carry
// derived medication COURSES on their prescription records (issue #209, Phase 2):
// effective period(s) → course dates, status → open/closed + stop_reason.

function ccdWithMeds(entries: string): string {
  return `<?xml version="1.0"?>
  <ClinicalDocument xmlns="urn:hl7-org:v3">
    <component><structuredBody><component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.1.1"/>
      <code code="10160-0" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Medications</title>
      <text><list>
        <item><content ID="med1">Lisinopril 10 mg tablet</content></item>
        <item><content ID="med2">Amoxicillin 500 mg capsule</content></item>
        <item><content ID="med3">Metformin 500 mg tablet</content></item>
      </list></text>
      ${entries}
    </section></component></structuredBody></component>
  </ClinicalDocument>`;
}

describe("CCD medications → courses (#209 Phase 2)", () => {
  it("active med → one open course from effectiveTime low", () => {
    const r = parseCcda(
      ccdWithMeds(`
      <entry><substanceAdministration classCode="SBADM" moodCode="INT">
        <statusCode code="active"/>
        <effectiveTime xsi:type="IVL_TS" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
          <low value="20251204"/>
        </effectiveTime>
        <consumable><manufacturedProduct><manufacturedMaterial>
          <code code="314076" codeSystem="2.16.840.1.113883.6.88">
            <originalText><reference value="#med1"/></originalText>
          </code>
        </manufacturedMaterial></manufacturedProduct></consumable>
      </substanceAdministration></entry>`)
    );
    const rx = r.records.filter((x) => x.category === "prescription");
    expect(rx).toHaveLength(1);
    expect(rx[0].name).toBe("Lisinopril 10 mg tablet"); // resolved from narrative
    expect(rx[0].courses).toEqual([
      {
        started_on: "2025-12-04",
        stopped_on: null,
        stop_reason: null,
        notes: null,
      },
    ]);
  });

  it("aborted med with low+high → one closed course (provider_discontinued)", () => {
    const r = parseCcda(
      ccdWithMeds(`
      <entry><substanceAdministration classCode="SBADM" moodCode="INT">
        <statusCode code="aborted"/>
        <effectiveTime xsi:type="IVL_TS" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
          <low value="20260508"/><high value="20260608"/>
        </effectiveTime>
        <consumable><manufacturedProduct><manufacturedMaterial>
          <code code="723" codeSystem="2.16.840.1.113883.6.88">
            <originalText><reference value="#med2"/></originalText>
          </code>
        </manufacturedMaterial></manufacturedProduct></consumable>
      </substanceAdministration></entry>`)
    );
    const rx = r.records.filter((x) => x.category === "prescription");
    expect(rx).toHaveLength(1);
    expect(rx[0].courses).toEqual([
      {
        started_on: "2026-05-08",
        stopped_on: "2026-06-08",
        stop_reason: "provider_discontinued",
        notes: null,
      },
    ]);
  });

  it("completed med with low+high → completed_course", () => {
    const r = parseCcda(
      ccdWithMeds(`
      <entry><substanceAdministration classCode="SBADM" moodCode="INT">
        <statusCode code="completed"/>
        <effectiveTime xsi:type="IVL_TS" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
          <low value="20240101"/><high value="20240114"/>
        </effectiveTime>
        <consumable><manufacturedProduct><manufacturedMaterial>
          <code code="860975" codeSystem="2.16.840.1.113883.6.88">
            <originalText><reference value="#med3"/></originalText>
          </code>
        </manufacturedMaterial></manufacturedProduct></consumable>
      </substanceAdministration></entry>`)
    );
    const rx = r.records.filter((x) => x.category === "prescription");
    expect(rx[0].courses?.[0]).toMatchObject({
      started_on: "2024-01-01",
      stopped_on: "2024-01-14",
      stop_reason: "completed_course",
    });
  });

  it("nullified med → dropped entirely (no prescription record)", () => {
    const r = parseCcda(
      ccdWithMeds(`
      <entry><substanceAdministration classCode="SBADM" moodCode="INT">
        <statusCode code="nullified"/>
        <effectiveTime xsi:type="IVL_TS" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
          <low value="20240101"/>
        </effectiveTime>
        <consumable><manufacturedProduct><manufacturedMaterial>
          <code code="314076" codeSystem="2.16.840.1.113883.6.88">
            <originalText><reference value="#med1"/></originalText>
          </code>
        </manufacturedMaterial></manufacturedProduct></consumable>
      </substanceAdministration></entry>`)
    );
    expect(r.records.filter((x) => x.category === "prescription")).toEqual([]);
  });
});

// Fix 2: a plain med-list entry with NO effectiveTime used to be dropped whole.
// Now it imports — dated to the DOCUMENT date, with an open/undated course.
describe("CCD undated medication → document-date fallback (Fix 2)", () => {
  // A Medications section entry with a drug name but no effectiveTime; the
  // ClinicalDocument carries its own effectiveTime (the document date).
  const CCD_UNDATED_MED = `<?xml version="1.0"?>
  <ClinicalDocument xmlns="urn:hl7-org:v3">
    <effectiveTime value="20240115"/>
    <component><structuredBody><component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.1.1"/>
      <code code="10160-0" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Medications</title>
      <entry><substanceAdministration classCode="SBADM" moodCode="INT">
        <statusCode code="active"/>
        <consumable><manufacturedProduct><manufacturedMaterial>
          <name>Atorvastatin 20 mg tablet</name>
        </manufacturedMaterial></manufacturedProduct></consumable>
      </substanceAdministration></entry>
    </section></component></structuredBody></component>
  </ClinicalDocument>`;

  it("imports the undated med, dated to the document, with an open course", () => {
    const r = parseCcda(CCD_UNDATED_MED);
    const rx = r.records.filter((x) => x.category === "prescription");
    expect(rx).toHaveLength(1);
    expect(rx[0].name).toBe("Atorvastatin 20 mg tablet");
    // Record date falls back to the document effectiveTime.
    expect(rx[0].date).toBe("2024-01-15");
    // No effectiveTime on the med → the course is left open/undated (no fabricated
    // start from the document date). The persist layer opens a single course.
    expect(rx[0].courses).toEqual([]);
    // And it is NOT reported as a medication drop.
    expect(r.report!.drops.some((d) => d.kind === "medication")).toBe(false);
  });
});

describe("FHIR medications → courses (#209 Phase 2)", () => {
  const bundle = (resources: object[]) =>
    JSON.stringify({
      resourceType: "Bundle",
      type: "collection",
      entry: resources.map((resource) => ({ resource })),
    });

  it("active MedicationRequest with effectivePeriod.start → open course", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "MedicationRequest",
          status: "active",
          medicationCodeableConcept: { text: "Lisinopril 10 MG" },
          effectivePeriod: { start: "2025-01-10" },
        },
      ])
    );
    const rx = r.records.filter((x) => x.category === "prescription");
    expect(rx).toHaveLength(1);
    expect(rx[0].courses).toEqual([
      {
        started_on: "2025-01-10",
        stopped_on: null,
        stop_reason: null,
        notes: null,
      },
    ]);
  });

  it("completed MedicationStatement with effectivePeriod → closed course + note", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "MedicationStatement",
          status: "completed",
          medicationCodeableConcept: { text: "Amoxicillin 500 MG" },
          effectivePeriod: { start: "2024-02-01", end: "2024-02-11" },
          reasonCode: [{ text: "Sinusitis" }],
        },
      ])
    );
    const rx = r.records.filter((x) => x.category === "prescription");
    expect(rx[0].courses).toEqual([
      {
        started_on: "2024-02-01",
        stopped_on: "2024-02-11",
        stop_reason: "completed_course",
        notes: "Sinusitis",
      },
    ]);
  });

  it("stopped MedicationRequest → provider_discontinued with statusReason note", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "MedicationRequest",
          status: "stopped",
          medicationCodeableConcept: { text: "Atorvastatin 20 MG" },
          effectiveDateTime: "2023-05-01",
          statusReason: { text: "Muscle pain" },
        },
      ])
    );
    const rx = r.records.filter((x) => x.category === "prescription");
    expect(rx[0].courses?.[0]).toMatchObject({
      started_on: "2023-05-01",
      stop_reason: "provider_discontinued",
      notes: "Muscle pain",
    });
    // no explicit end → closed at the fallback (the record's effective date).
    expect(rx[0].courses?.[0].stopped_on).toBe("2023-05-01");
  });

  it("MedicationStatement statusReason ARRAY → note captured (not silently dropped)", () => {
    // MedicationStatement.statusReason is an ARRAY of CodeableConcept (unlike
    // MedicationRequest's single one) — the note must still be read.
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "MedicationStatement",
          status: "stopped",
          medicationCodeableConcept: { text: "Simvastatin 40 MG" },
          effectivePeriod: { start: "2022-01-01", end: "2022-06-01" },
          statusReason: [{ text: "Switched to atorvastatin" }],
        },
      ])
    );
    const rx = r.records.filter((x) => x.category === "prescription");
    expect(rx[0].courses?.[0]).toMatchObject({
      started_on: "2022-01-01",
      stopped_on: "2022-06-01",
      stop_reason: "provider_discontinued",
      notes: "Switched to atorvastatin",
    });
  });

  it("dosage timing boundsPeriod supplies the course dates when no effective* present", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "MedicationRequest",
          status: "completed",
          medicationCodeableConcept: { text: "Prednisone 10 MG" },
          authoredOn: "2024-09-01",
          dosageInstruction: [
            {
              text: "1 tab daily x10d",
              timing: {
                repeat: {
                  boundsPeriod: { start: "2024-09-02", end: "2024-09-12" },
                },
              },
            },
          ],
        },
      ])
    );
    const rx = r.records.filter((x) => x.category === "prescription");
    // boundsPeriod (2024-09-02..09-12) is preferred; authoredOn is only the record date.
    expect(rx[0].courses?.[0]).toMatchObject({
      started_on: "2024-09-02",
      stopped_on: "2024-09-12",
      stop_reason: "completed_course",
    });
  });

  it("entered-in-error MedicationRequest → dropped entirely", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "MedicationRequest",
          status: "entered-in-error",
          medicationCodeableConcept: { text: "Ibuprofen 200 MG" },
          effectiveDateTime: "2024-01-01",
        },
      ])
    );
    expect(r.records.filter((x) => x.category === "prescription")).toEqual([]);
  });
});

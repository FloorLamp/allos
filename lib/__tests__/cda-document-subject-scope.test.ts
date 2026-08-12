// PURE TIER — how many people is a C-CDA about? (#2558)
//
// The header fact that decides what an observation's SILENCE about its subject means.
// It is read off `recordTarget`, which the spec allows to repeat, and it has to
// survive the two shapes a repeat actually takes: two genuinely different people, and
// one person listed twice by an exporter with a taste for aliases.
//
// The companion axis — what a section STATES about its subject — is tested in
// lib/__tests__/instrument-recognize.test.ts; the two meeting is proven end to end in
// lib/__db_tests__/ccd-screening-instrument.test.ts.
//
// SYNTHETIC ONLY: invented patients and fictional dates. No PHI.

import { describe, expect, it } from "vitest";
import { parseCcdaDocument } from "@/lib/cda";

function recordTarget(
  given: string,
  family: string,
  birth: string,
  id?: string
): string {
  return `<recordTarget><patientRole>
    ${id ? `<id root="2.16.840.1.113883.19.5" extension="${id}"/>` : ""}
    <patient>
      <name><given>${given}</given><family>${family}</family></name>
      <administrativeGenderCode code="F"/>
      <birthTime value="${birth}"/>
    </patient>
  </patientRole></recordTarget>`;
}

function ccda(targets: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <id root="1.2.3.4" extension="20260304001"/>
  <effectiveTime value="20260304"/>
  ${targets}
  <component><structuredBody></structuredBody></component>
</ClinicalDocument>`;
}

const WREN = recordTarget("Wren", "Placeholder", "19950101", "SAMPLE-1");
const OTHER = recordTarget("Rowan", "Placeholder", "20250210", "SAMPLE-2");

function scopeOf(xml: string) {
  return parseCcdaDocument(xml).subjectScope;
}

describe("documentSubjectScope (#2558)", () => {
  it("reads the ordinary one-recordTarget CCD as single-patient", () => {
    expect(scopeOf(ccda(WREN))).toBe("single-patient");
  });

  it("reads two DIFFERENT record targets as multiple subjects", () => {
    expect(scopeOf(ccda(`${WREN}\n${OTHER}`))).toBe("multiple-subjects");
  });

  it("counts the same patient listed twice as ONE patient", () => {
    // A duplicated header is an exporter quirk, not a second person, and treating it
    // as one would refuse every screening in the document for no reason.
    expect(scopeOf(ccda(`${WREN}\n${WREN}`))).toBe("single-patient");
  });

  it("falls back to name + birth date when the record targets carry no id", () => {
    const a = recordTarget("Wren", "Placeholder", "19950101");
    const b = recordTarget("Rowan", "Placeholder", "20250210");
    expect(scopeOf(ccda(`${a}\n${a}`))).toBe("single-patient");
    expect(scopeOf(ccda(`${a}\n${b}`))).toBe("multiple-subjects");
  });

  it("reads a document with NO patient at all as multiple subjects, not single", () => {
    // Ignorance is not evidence of single-patient-ness — the strict reading is the
    // safe one, and it is the reading the recogniser's silence rule then applies.
    expect(scopeOf(ccda(""))).toBe("multiple-subjects");
  });

  it("ignores a family-history relatedSubject — a listed relative is not a patient", () => {
    // An ordinary CCD's Family History section is BUILT out of relatedSubject nodes.
    // If those counted, almost no real document would ever be single-patient and the
    // fix would be inert.
    const withFamilyHistory = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <id root="1.2.3.4" extension="20260304002"/>
  <effectiveTime value="20260304"/>
  ${WREN}
  <component><structuredBody>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.15"/>
      <code code="10157-6" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Family History</title>
      <entry><organizer classCode="CLUSTER" moodCode="EVN">
        <subject><relatedSubject classCode="PRS">
          <code code="MTH" displayName="Mother"/>
        </relatedSubject></subject>
      </organizer></entry>
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;
    expect(scopeOf(withFamilyHistory)).toBe("single-patient");
  });
});

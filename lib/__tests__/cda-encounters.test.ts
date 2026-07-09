import { describe, expect, it } from "vitest";
import { extractFromCcda, mergeImportResults } from "../cda";
import type { ImportResult } from "../health-import";

// Wrap section XML in a minimal ClinicalDocument so extractFromCcda can walk it.
function doc(...sections: string[]): string {
  return `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
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

// A realistic Epic-shaped Encounters section: one Office Visit with a CPT type
// code (Office Visit / narrative + AMB class translation), a performing clinician
// with an NPI + org, a LOC participant (the facility), and a nested Problem
// Observation diagnosis ("Fever").
const ENCOUNTERS = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.22.1"/>
  <code code="46240-8" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
  <title>Encounter Details</title>
  <text><table><tbody>
    <tr ID="enc1"><td>06/08/2026</td><td ID="enc1type">Office Visit</td></tr>
  </tbody></table></text>
  <entry><encounter classCode="ENC" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
    <id assigningAuthorityName="EPIC" root="1.2.3.4" extension="100000001"/>
    <code code="99213" codeSystem="2.16.840.1.113883.6.12">
      <originalText><reference value="#enc1type"/></originalText>
      <translation code="AMB" codeSystem="2.16.840.1.113883.5.4"/>
    </code>
    <statusCode code="completed"/>
    <effectiveTime><low value="20260608103000-0400"/><high value="20260608105453-0400"/></effectiveTime>
    <performer typeCode="PRF"><assignedEntity classCode="ASSIGNED">
      <id root="2.16.840.1.113883.4.6" extension="1000000001"/>
      <telecom use="WP" value="tel:+1-555-010-0001"/>
      <assignedPerson><name><given>Grace</given><family>Hopper</family></name></assignedPerson>
      <representedOrganization><name>Sample Care East</name></representedOrganization>
    </assignedEntity></performer>
    <participant typeCode="LOC"><participantRole classCode="SDLOC">
      <id root="1.2.3" extension="200000001"/>
      <addr><streetAddressLine>123 Example Ave</streetAddressLine><city>Springfield</city><state>NY</state><postalCode>10001</postalCode></addr>
      <playingEntity classCode="PLC"><name>Sample Pediatrics - Springfield</name></playingEntity>
    </participantRole></participant>
    <entryRelationship typeCode="SUBJ"><act classCode="ACT" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.80"/>
      <code code="29308-4" codeSystem="2.16.840.1.113883.6.1" displayName="Diagnosis"/>
      <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
        <code code="282291009" codeSystem="2.16.840.1.113883.6.96"/>
        <text>Fever</text>
        <value xsi:type="CD" code="386661006" codeSystem="2.16.840.1.113883.6.96">
          <originalText>Fever</originalText>
          <translation code="R50.9" codeSystem="2.16.840.1.113883.6.90" displayName="Fever, unspecified fever cause"/>
        </value>
      </observation></entryRelationship>
    </act></entryRelationship>
  </encounter></entry>
</section>`;

// Reason for Visit (chief complaint 8661-1) — a separate document-level section
// whose reason is correlated onto the single encounter.
const REASON = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.12"/>
  <code code="29299-5" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
  <title>Reason for Visit</title>
  <text><table><tbody><tr ID="rfv1"><td ID="reasonrfv1">Fever</td></tr></tbody></table></text>
  <entry><observation classCode="OBS" moodCode="EVN">
    <code code="8661-1" codeSystem="2.16.840.1.113883.6.1" displayName="Chief Complaint"/>
    <value code="271897009" codeSystem="2.16.840.1.113883.6.96" displayName="O/E - FEVER" xsi:type="CD">
      <originalText>Fever</originalText>
    </value>
  </observation></entry>
</section>`;

// A minimal immunizations section (a flu shot), used to prove that the same
// section carried in two merged documents collapses to a single row.
const IMMUNIZATIONS = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.2.1"/>
  <code code="11369-6" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Immunizations</title>
  <entry><substanceAdministration classCode="SBADM" moodCode="EVN">
    <effectiveTime value="20251001"/>
    <consumable><manufacturedProduct><manufacturedMaterial>
      <code code="140" codeSystem="2.16.840.1.113883.12.292" displayName="Influenza"/>
    </manufacturedMaterial></manufacturedProduct></consumable>
  </substanceAdministration></entry>
</section>`;

// A COMPREHENSIVE-document Encounters section: it lists the SAME visit (same
// encounter id 100000001) as ENCOUNTERS but thin — no performer/location/diagnosis
// — plus a second, unrelated encounter (so >1 → no reason-correlation runs, exactly
// as a full record's Encounters section behaves).
const ENCOUNTERS_THIN = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.22.1"/>
  <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Encounters</title>
  <entry><encounter classCode="ENC" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
    <id assigningAuthorityName="EPIC" root="1.2.3.4" extension="100000001"/>
    <code code="99213" codeSystem="2.16.840.1.113883.6.12" displayName="Office Visit">
      <translation code="AMB" codeSystem="2.16.840.1.113883.5.4"/>
    </code>
    <effectiveTime><low value="20260608"/></effectiveTime>
  </encounter></entry>
  <entry><encounter classCode="ENC" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
    <id root="1.2.3.4" extension="OTHER-1"/>
    <code code="99204" codeSystem="2.16.840.1.113883.6.12" displayName="Consult"/>
    <effectiveTime><low value="20250101"/></effectiveTime>
  </encounter></entry>
</section>`;

// A single lab result carrying its LOINC — the identical-coding case that must
// collapse across documents even when the printed value precision differs.
function labSection(value: string, withLoinc: boolean): string {
  const code = withLoinc
    ? `<code code="2345-7" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC" displayName="Glucose"/>`
    : `<code code="GLU" codeSystem="1.2.3.9" displayName="Glucose"/>`;
  return `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
  <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Results</title>
  <entry><observation classCode="OBS" moodCode="EVN">
    ${code}
    <effectiveTime value="20260101"/>
    <value xsi:type="PQ" value="${value}" unit="mmol/L"/>
  </observation></entry>
</section>`;
}

// A single medication carrying its RxNorm code — the identical-coding case.
const MED_SECTION = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.1.1"/>
  <code code="10160-0" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Medications</title>
  <entry><substanceAdministration classCode="SBADM" moodCode="EVN">
    <effectiveTime value="20260101"/>
    <doseQuantity value="1" unit="tab"/>
    <consumable><manufacturedProduct><manufacturedMaterial>
      <code code="617314" codeSystem="2.16.840.1.113883.6.88" displayName="Atorvastatin 40 MG"/>
    </manufacturedMaterial></manufacturedProduct></consumable>
  </substanceAdministration></entry>
</section>`;

describe("encounters extraction (#178 Phase B)", () => {
  it("maps an encounter: date/period, type, class, provider, location, diagnoses", () => {
    const r = extractFromCcda(doc(ENCOUNTERS));
    expect(r.encounters).toHaveLength(1);
    const e = r.encounters![0];
    expect(e.date).toBe("2026-06-08");
    expect(e.end_date).toBe("2026-06-08");
    expect(e.type).toBe("Office Visit"); // resolved via the narrative reference
    expect(e.class_code).toBe("AMB"); // HL7 ActEncounterCode translation
    expect(e.diagnoses).toEqual(["Fever"]);
    expect(e.provider).toMatchObject({
      name: "Grace Hopper",
      type: "individual",
      npi: "1000000001",
    });
    expect(e.location).toMatchObject({
      name: "Sample Pediatrics - Springfield",
      type: "organization",
    });
    expect(e.external_id).toBe("ccda:encounter:100000001");
  });

  it("correlates the document-level Reason for Visit onto the single encounter", () => {
    const r = extractFromCcda(doc(ENCOUNTERS, REASON));
    expect(r.encounters![0].reason).toBe("Fever"); // printed text, not "O/E - FEVER"
  });

  it("does not fabricate a reason when the document has no Reason for Visit", () => {
    const r = extractFromCcda(doc(ENCOUNTERS));
    expect(r.encounters![0].reason).toBeNull();
  });

  it("handles an encounter with no performer, location, or diagnosis", () => {
    const bare = `
      <section>
        <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
        <entry><encounter classCode="ENC" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
          <id root="1.2.3" extension="ENC-777"/>
          <code code="99201" codeSystem="2.16.840.1.113883.6.12" displayName="New Visit"/>
          <effectiveTime><low value="20240115"/></effectiveTime>
        </encounter></entry>
      </section>`;
    const r = extractFromCcda(doc(bare));
    expect(r.encounters).toHaveLength(1);
    const e = r.encounters![0];
    expect(e).toMatchObject({
      date: "2024-01-15",
      type: "New Visit",
      provider: null,
      location: null,
      diagnoses: [],
      external_id: "ccda:encounter:ENC-777",
    });
  });

  it("captures the encounter's free-text notes from a nested Comment Activity", () => {
    // A Comment Activity (template 4.64) under the encounter carries the visit
    // summary; its narrative resolves via a #ref into the section text.
    const withComment = `
      <section>
        <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
        <text><table><tbody>
          <tr><td ID="note1">Patient advised to rest and hydrate; follow up in two weeks.</td></tr>
        </tbody></table></text>
        <entry><encounter classCode="ENC" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
          <id root="1.2.3" extension="ENC-NOTE-1"/>
          <code code="99213" codeSystem="2.16.840.1.113883.6.12" displayName="Office Visit"/>
          <effectiveTime><low value="20260610"/></effectiveTime>
          <entryRelationship typeCode="SUBJ"><act classCode="ACT" moodCode="EVN">
            <templateId root="2.16.840.1.113883.10.20.22.4.64"/>
            <code code="48767-8" codeSystem="2.16.840.1.113883.6.1" displayName="Annotation Comment"/>
            <text><reference value="#note1"/></text>
          </act></entryRelationship>
        </encounter></entry>
      </section>`;
    const r = extractFromCcda(doc(withComment));
    expect(r.encounters).toHaveLength(1);
    expect(r.encounters![0].notes).toBe(
      "Patient advised to rest and hydrate; follow up in two weeks."
    );
  });

  it("leaves notes null when the encounter carries no comment", () => {
    expect(extractFromCcda(doc(ENCOUNTERS)).encounters![0].notes).toBeNull();
  });

  it("drops an encounter with no usable date", () => {
    const undated = `
      <section>
        <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
        <entry><encounter classCode="ENC" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
          <code code="99201" codeSystem="2.16.840.1.113883.6.12" displayName="Visit"/>
          <effectiveTime nullFlavor="UNK"/>
        </encounter></entry>
      </section>`;
    expect(extractFromCcda(doc(undated)).encounters).toEqual([]);
  });

  it("keeps two id-less same-day same-type visits distinct (positional key)", () => {
    const twoIdless = `
      <section>
        <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
        <entry><encounter classCode="ENC" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
          <code code="99213" codeSystem="2.16.840.1.113883.6.12" displayName="Office Visit"/>
          <effectiveTime><low value="20240501"/></effectiveTime>
        </encounter></entry>
        <entry><encounter classCode="ENC" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
          <code code="99213" codeSystem="2.16.840.1.113883.6.12" displayName="Office Visit"/>
          <effectiveTime><low value="20240501"/></effectiveTime>
        </encounter></entry>
      </section>`;
    const encs = extractFromCcda(doc(twoIdless)).encounters!;
    expect(encs).toHaveLength(2); // not collapsed to one
    expect(new Set(encs.map((e) => e.external_id)).size).toBe(2);
  });
});

describe("mergeImportResults (multi-document XDM, #178 Phase B)", () => {
  // DOC0001-shaped: the complete record (immunizations), no encounters.
  const complete: ImportResult = extractFromCcda(doc(IMMUNIZATIONS));
  // DOC0002-shaped: the same immunization again PLUS the encounter + reason.
  const perVisit: ImportResult = extractFromCcda(
    doc(IMMUNIZATIONS, ENCOUNTERS, REASON)
  );

  it("collapses a section shared by both documents (no double-count)", () => {
    // Each doc parses one immunization; the merge dedups on external_id → one row.
    expect(complete.immunizations).toHaveLength(1);
    expect(perVisit.immunizations).toHaveLength(1);
    const merged = mergeImportResults([complete, perVisit]);
    expect(merged.immunizations).toHaveLength(1);
  });

  it("unions the encounter that only the second document carries", () => {
    const merged = mergeImportResults([complete, perVisit]);
    expect(merged.encounters).toHaveLength(1);
    expect(merged.encounters![0].reason).toBe("Fever");
  });

  it("is idempotent: merging the same document twice yields one of each", () => {
    const merged = mergeImportResults([perVisit, perVisit]);
    expect(merged.immunizations).toHaveLength(1);
    expect(merged.encounters).toHaveLength(1);
  });

  it("takes demographics from the first (most-complete) document", () => {
    const merged = mergeImportResults([complete, perVisit]);
    expect(merged.demographics).toMatchObject({
      sex: "male",
      name: "Robin Sample",
    });
  });

  it("field-merges a thinner kept encounter with the richer duplicate (1A)", () => {
    // The comprehensive doc (passed first, as parseXdm feeds largest-first) lists the
    // visit thin: reason/diagnoses/provider/location all empty. The per-visit doc
    // carries them. The merge must backfill the kept row, not drop the richer copy.
    const comprehensive = extractFromCcda(doc(ENCOUNTERS_THIN));
    const perVisitFull = extractFromCcda(doc(ENCOUNTERS, REASON));
    const thin = comprehensive.encounters!.find(
      (e) => e.external_id === "ccda:encounter:100000001"
    )!;
    expect(thin.reason).toBeNull();
    expect(thin.diagnoses).toEqual([]);
    expect(thin.provider).toBeNull();

    const merged = mergeImportResults([comprehensive, perVisitFull]);
    const visit = merged.encounters!.find(
      (e) => e.external_id === "ccda:encounter:100000001"
    )!;
    expect(visit.reason).toBe("Fever");
    expect(visit.diagnoses).toEqual(["Fever"]);
    expect(visit.provider).toMatchObject({ name: "Grace Hopper" });
    expect(visit.location).toMatchObject({
      name: "Sample Pediatrics - Springfield",
    });
    // The comprehensive doc's second, unrelated encounter still comes through.
    expect(merged.encounters).toHaveLength(2);
  });

  it("collapses a lab shared across docs with identical coding, even at differing value precision (1B)", () => {
    const docA = extractFromCcda(doc(labSection("5.20", true)));
    const docB = extractFromCcda(doc(labSection("5.2", true)));
    expect(docA.records).toHaveLength(1);
    const merged = mergeImportResults([docA, docB]);
    expect(merged.records).toHaveLength(1); // one real reading → one row
  });

  it("collapses a medication shared across docs with identical RxNorm coding (1B)", () => {
    const docA = extractFromCcda(doc(MED_SECTION));
    const docB = extractFromCcda(doc(MED_SECTION));
    expect(docA.records).toHaveLength(1);
    const merged = mergeImportResults([docA, docB]);
    expect(merged.records).toHaveLength(1);
  });

  it("does NOT collapse a lab coded differently across docs (divergent-coding limitation, 1B)", () => {
    // Same real analyte, but one doc carries the LOINC and the other only the printed
    // name → different content-derived external_id → two rows. Documented limitation
    // (mergeImportResults): reconciling this needs semantic matching we don't attempt.
    const withLoinc = extractFromCcda(doc(labSection("5.2", true)));
    const nameOnly = extractFromCcda(doc(labSection("5.2", false)));
    const merged = mergeImportResults([withLoinc, nameOnly]);
    expect(merged.records).toHaveLength(2);
  });
});

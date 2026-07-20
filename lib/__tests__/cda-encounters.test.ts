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

describe("encounters extraction", () => {
  it("maps an encounter: date/period, type, class, provider, location, diagnoses", () => {
    const r = extractFromCcda(doc(ENCOUNTERS));
    expect(r.encounters).toHaveLength(1);
    const e = r.encounters![0];
    expect(e.date).toBe("2026-06-08");
    expect(e.end_date).toBe("2026-06-08");
    expect(e.type).toBe("Office Visit"); // resolved via the narrative reference
    // The TYPE code is captured alongside the display (#1035) — the CPT coding,
    // never the ActEncounterCode class translation.
    expect(e.code).toBe("99213");
    expect(e.code_system).toBe("CPT");
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

  it("never stores the ActEncounterCode class as the type code (#1035)", () => {
    // The class rides the TOP-LEVEL coding here; the CPT preventive-visit code
    // (99396 — established preventive, 40-64) is a translation. The type code must
    // be the CPT one, and an all-ActCode <code> yields null rather than "AMB".
    const classFirst = `
      <section>
        <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
        <entry><encounter classCode="ENC" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
          <id root="1.2.3" extension="ENC-901"/>
          <code code="AMB" codeSystem="2.16.840.1.113883.5.4">
            <translation code="99396" codeSystem="2.16.840.1.113883.6.12" displayName="Office Visit"/>
          </code>
          <effectiveTime><low value="20260301"/></effectiveTime>
        </encounter></entry>
      </section>`;
    const r = extractFromCcda(doc(classFirst));
    expect(r.encounters).toHaveLength(1);
    expect(r.encounters![0].code).toBe("99396");
    expect(r.encounters![0].code_system).toBe("CPT");
    expect(r.encounters![0].class_code).toBe("AMB");

    const classOnly = `
      <section>
        <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
        <entry><encounter classCode="ENC" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
          <id root="1.2.3" extension="ENC-902"/>
          <code code="AMB" codeSystem="2.16.840.1.113883.5.4"/>
          <effectiveTime><low value="20260302"/></effectiveTime>
        </encounter></entry>
      </section>`;
    const r2 = extractFromCcda(doc(classOnly));
    expect(r2.encounters![0].code).toBeNull();
    expect(r2.encounters![0].code_system).toBeNull();
    expect(r2.encounters![0].class_code).toBe("AMB");
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

describe("mergeImportResults (multi-document XDM)", () => {
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

// ---- encounter notes across documents (#262) ----

// The clinician's full Progress Note (11506-3) — carried only by the SMALLER
// per-visit document in the failing export. Synthetic narrative.
const PROGRESS_NOTE = `
<section>
  <code code="11506-3" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Progress Notes</title>
  <text>Office visit for fever. Exam unremarkable aside from mild pharyngeal erythema. Plan: supportive care, fluids, recheck in three days if not improving.</text>
</section>`;

// A short but REAL note (recognized by the title heuristic) — proves the merge
// keeps both distinct notes even when neither is disclaimer boilerplate.
const SHORT_NOTE = `
<section>
  <code code="99997-7" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Telephone Notes</title>
  <text>Parent called nurse line; advised alternating antipyretics.</text>
</section>`;

// The per-org sharing-disclaimer note (#262) — SYNTHETIC org/patient names. Carries
// an author time so that, absent the disclaimer skip, the standalone path would have
// a date to materialize a note-only encounter from (this file's doc() helper has no
// document-level effectiveTime).
const DISCLAIMER_NOTE = `
<section>
  <code code="88888-8" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Note from Example Health System</title>
  <author><time value="20260608"/></author>
  <text>This document contains information that was shared with Robin Sample. It may not contain the entire record from Example Health System.</text>
</section>`;

describe("encounter notes across merged documents (#262)", () => {
  const visitOf = (r: ImportResult) =>
    r.encounters!.find((e) => e.external_id === "ccda:encounter:100000001")!;

  it("keeps the smaller doc's progress note when the larger doc's copy carried only the disclaimer", () => {
    // The failing shape: the LARGER document (fed first, largest-first) has the same
    // encounter with only the boilerplate note section; the SMALLER document carries
    // the real Progress Note. Pre-fix, first-wins notes kept only the disclaimer.
    const larger = extractFromCcda(doc(ENCOUNTERS, DISCLAIMER_NOTE));
    const smaller = extractFromCcda(doc(ENCOUNTERS, PROGRESS_NOTE));
    // The disclaimer is skipped at extraction, so the larger doc's copy has no notes…
    expect(larger.encounters![0].notes).toBeNull();
    // …and the merged encounter carries the real note, never the boilerplate.
    const merged = mergeImportResults([larger, smaller]);
    expect(visitOf(merged).notes).toBe(
      "Office visit for fever. Exam unremarkable aside from mild pharyngeal erythema. Plan: supportive care, fluids, recheck in three days if not improving."
    );
  });

  it("unions DISTINCT real notes from two documents' copies of one encounter", () => {
    // Even with the disclaimer skip, first-wins would drop a real short note's
    // sibling; the notes field is line-folded instead so both survive.
    const withShort = extractFromCcda(doc(ENCOUNTERS, SHORT_NOTE));
    const withFull = extractFromCcda(doc(ENCOUNTERS, PROGRESS_NOTE));
    const merged = mergeImportResults([withShort, withFull]);
    expect(visitOf(merged).notes).toBe(
      "Parent called nurse line; advised alternating antipyretics.\n" +
        "Office visit for fever. Exam unremarkable aside from mild pharyngeal erythema. Plan: supportive care, fluids, recheck in three days if not improving."
    );
  });

  it("is idempotent: merging the same noted document twice does not duplicate the note", () => {
    const withFull = extractFromCcda(doc(ENCOUNTERS, PROGRESS_NOTE));
    const merged = mergeImportResults([withFull, withFull]);
    expect(visitOf(merged).notes).toBe(withFull.encounters![0].notes);
  });

  it("materializes no note-only encounter when a no-encounter doc carries only the disclaimer", () => {
    // DOC0001-shaped: summary document, no encounter section, disclaimer note.
    const summary = extractFromCcda(doc(IMMUNIZATIONS, DISCLAIMER_NOTE));
    expect(summary.encounters).toEqual([]);
    const perVisit = extractFromCcda(doc(ENCOUNTERS, PROGRESS_NOTE));
    const merged = mergeImportResults([summary, perVisit]);
    expect(merged.encounters).toHaveLength(1);
    expect(merged.encounters![0].external_id).toBe("ccda:encounter:100000001");
  });
});

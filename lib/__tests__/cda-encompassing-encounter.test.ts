import { describe, expect, it } from "vitest";
import { extractFromCcda } from "../cda";

// A document whose Encounters section yields NO Encounter Activity but whose header
// carries the visit (componentOf/encompassingEncounter) — the eClinicalWorks
// packaging — must import the header visit as THE encounter: its responsible
// clinician and facility come through, the document-level correlations (clinical
// notes, reason for visit) attach to it, and no note-only encounters are
// fabricated. All fixtures are SYNTHETIC — obviously-fictional patients/clinicians,
// invented dates, 555-01xx phones, and a sequential (scanner-safe) NPI.

function doc(opts: {
  sections?: string[];
  componentOf?: string;
  documentationOf?: string;
}): string {
  return `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <effectiveTime value="20260603"/>
  <recordTarget><patientRole><patient>
    <name><given>Test</given><family>Patient</family></name>
  </patient></patientRole></recordTarget>
  ${opts.documentationOf ?? ""}
  <component><structuredBody>
    ${(opts.sections ?? []).map((s) => `<component>${s}</component>`).join("")}
  </structuredBody></component>
  ${opts.componentOf ?? ""}
</ClinicalDocument>`;
}

// The full eCW-style header visit: ActEncounterCode class on the <code>, the
// clinician as responsibleParty, the facility as serviceProviderOrganization.
const ENCOMPASSING_FULL = `<componentOf><encompassingEncounter>
  <id root="1.2.3" extension="VISIT-77"/>
  <code code="AMB" codeSystem="2.16.840.1.113883.5.4" displayName="ambulatory"/>
  <effectiveTime><low value="20260603093000-0400"/><high value="20260603094500-0400"/></effectiveTime>
  <responsibleParty><assignedEntity>
    <id root="2.16.840.1.113883.4.6" extension="1234567890"/>
    <addr><streetAddressLine>100 Example Way</streetAddressLine><city>Testville</city><state>NY</state><postalCode>10001</postalCode></addr>
    <telecom value="tel:+1(555)-555-0142"/>
    <assignedPerson><name><given>Pat</given><family>Example</family><suffix>DO</suffix></name></assignedPerson>
  </assignedEntity></responsibleParty>
  <location><healthCareFacility><serviceProviderOrganization>
    <id root="1.2.3.4"/>
    <name>Example Pediatric Urgent Care</name>
    <telecom value="tel:+1(555)-555-0143"/>
    <addr><streetAddressLine>200 Sample St</streetAddressLine><city>Testville</city><state>NY</state><postalCode>10001</postalCode></addr>
  </serviceProviderOrganization></healthCareFacility></location>
</encompassingEncounter></componentOf>`;

const EMPTY_ENCOUNTERS_SECTION = `<section>
  <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Encounters</title>
  <text>No Information</text>
</section>`;

const ENCOUNTER_ACTIVITY = `<section>
  <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Encounters</title>
  <entry><encounter classCode="ENC" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
    <id root="1.2.3" extension="VISIT-77"/>
    <code code="99213" codeSystem="2.16.840.1.113883.6.12" displayName="Office Visit">
      <translation code="AMB" codeSystem="2.16.840.1.113883.5.4"/>
    </code>
    <effectiveTime><low value="20260603"/></effectiveTime>
  </encounter></entry>
</section>`;

const PROGRESS_NOTES = `<section>
  <code code="11506-3" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Progress Notes</title>
  <text>Exam unremarkable, lungs clear.</text>
</section>`;

const HP_NOTES = `<section>
  <code code="34117-2" codeSystem="2.16.840.1.113883.6.1"/>
  <title>History and Physical Notes</title>
  <text>Three days of cough, no fever today.</text>
</section>`;

const REASON_FOR_VISIT = `<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.12"/>
  <code code="29299-5" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Reason for Visit</title>
  <text>Cough and congestion for three days.</text>
</section>`;

describe("encompassing-encounter materialization (empty Encounters section)", () => {
  it("imports the header visit as the encounter, with clinician + facility", () => {
    const r = extractFromCcda(
      doc({
        sections: [EMPTY_ENCOUNTERS_SECTION],
        componentOf: ENCOMPASSING_FULL,
      })
    );
    expect(r.encounters).toHaveLength(1);
    const e = r.encounters![0];
    expect(e.external_id).toBe("ccda:encounter:VISIT-77");
    expect(e.date).toBe("2026-06-03");
    expect(e.end_date).toBe("2026-06-03");
    expect(e.class_code).toBe("AMB");
    // Class-only <code> → the canonical class label, not the source's
    // lowercase "ambulatory" displayName.
    expect(e.type).toBe("Ambulatory");
    expect(e.provider).toMatchObject({
      name: "Pat Example",
      type: "individual",
      npi: "1234567890",
    });
    expect(e.location).toMatchObject({
      name: "Example Pediatric Urgent Care",
      type: "organization",
    });
  });

  it("merges every note section into the visit instead of fabricating note-only encounters", () => {
    const r = extractFromCcda(
      doc({
        sections: [PROGRESS_NOTES, HP_NOTES],
        componentOf: ENCOMPASSING_FULL,
      })
    );
    expect(r.encounters).toHaveLength(1);
    const e = r.encounters![0];
    expect(e.external_id).toBe("ccda:encounter:VISIT-77");
    expect(e.notes).toContain("Exam unremarkable, lungs clear.");
    expect(e.notes).toContain("Three days of cough, no fever today.");
  });

  it("attaches the Reason for Visit to the materialized encounter", () => {
    const r = extractFromCcda(
      doc({
        sections: [REASON_FOR_VISIT, PROGRESS_NOTES],
        componentOf: ENCOMPASSING_FULL,
      })
    );
    expect(r.encounters).toHaveLength(1);
    expect(r.encounters![0].reason).toBe(
      "Cough and congestion for three days."
    );
    // The section is genuinely consumed now — no unrecognized-section drop.
    expect(
      r.report!.drops.some((d) => d.reason === "unrecognized_section")
    ).toBe(false);
  });

  it("does NOT materialize when an Encounter Activity already carries the visit", () => {
    const r = extractFromCcda(
      doc({ sections: [ENCOUNTER_ACTIVITY], componentOf: ENCOMPASSING_FULL })
    );
    expect(r.encounters).toHaveLength(1);
    // The section's activity wins — its richer type coding is intact.
    expect(r.encounters![0].type).toBe("Office Visit");
    expect(r.encounters![0].code).toBe("99213");
  });

  it("falls back to a date-keyed external_id when the header visit has no id", () => {
    const r = extractFromCcda(
      doc({
        componentOf: `<componentOf><encompassingEncounter>
          <effectiveTime><low value="20260603"/></effectiveTime>
        </encompassingEncounter></componentOf>`,
      })
    );
    expect(r.encounters).toHaveLength(1);
    expect(r.encounters![0].external_id).toBe(
      "ccda:encounter:2026-06-03:encompassing"
    );
  });

  it("collects the header serviceEvent performers as document providers", () => {
    const r = extractFromCcda(
      doc({
        documentationOf: `<documentationOf><serviceEvent classCode="PCPR">
          <performer typeCode="PRF">
            <functionCode code="PCP" codeSystem="2.16.840.1.113883.5.88" displayName="Primary Care Provider"/>
            <assignedEntity>
              <id root="2.16.840.1.113883.4.6" extension="1234567890"/>
              <assignedPerson><name><given>Alex</given><family>Fixture</family></name></assignedPerson>
            </assignedEntity>
          </performer>
          <performer typeCode="PRF">
            <assignedEntity>
              <id root="2.16.840.1.113883.4.6" extension="0123456789"/>
              <telecom value="tel:+1(555)-555-0144"/>
              <assignedPerson><name><given>Pat</given><family>Example</family><suffix>DO</suffix></name></assignedPerson>
            </assignedEntity>
          </performer>
        </serviceEvent></documentationOf>`,
      })
    );
    expect(r.providers).toEqual([
      expect.objectContaining({
        name: "Alex Fixture",
        type: "individual",
        npi: "1234567890",
      }),
      expect.objectContaining({
        name: "Pat Example",
        type: "individual",
        npi: "0123456789",
      }),
    ]);
  });

  it("reads the entry-level Note Activity author (eCW) for a standalone note", () => {
    const noteWithEntryAuthor = `<section>
      <code code="11506-3" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Progress Notes</title>
      <text>Exam unremarkable, lungs clear.</text>
      <entry><act classCode="ACT" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.202" extension="2016-11-01"/>
        <code code="34109-9" codeSystem="2.16.840.1.113883.6.1"/>
        <author><time value="20260604"/><assignedAuthor>
          <assignedPerson><name><given>Sam</given><family>Fixture</family></name></assignedPerson>
        </assignedAuthor></author>
      </act></entry>
    </section>`;
    // Standalone (no encompassing visit): the note-only encounter carries the
    // entry author as its provider and the author time as its date.
    const standalone = extractFromCcda(
      doc({ sections: [noteWithEntryAuthor] })
    );
    expect(standalone.encounters).toHaveLength(1);
    expect(standalone.encounters![0].provider).toMatchObject({
      name: "Sam Fixture",
    });
    expect(standalone.encounters![0].date).toBe("2026-06-04");
    // Merged into the materialized visit: the note line is author-prefixed.
    const merged = extractFromCcda(
      doc({ sections: [noteWithEntryAuthor], componentOf: ENCOMPASSING_FULL })
    );
    expect(merged.encounters).toHaveLength(1);
    expect(merged.encounters![0].notes).toBe(
      "Sam Fixture: Exam unremarkable, lungs clear."
    );
  });

  it("keeps the note-only fallback when the header visit is undateable", () => {
    const r = extractFromCcda(
      doc({
        sections: [PROGRESS_NOTES, HP_NOTES],
        componentOf: `<componentOf><encompassingEncounter>
          <id root="1.2.3" extension="VISIT-77"/>
        </encompassingEncounter></componentOf>`,
      })
    );
    // No materialized visit; each note lands as its own note-only encounter.
    expect(r.encounters).toHaveLength(2);
    expect(
      r.encounters!.every((e) => e.external_id.startsWith("ccda:note:"))
    ).toBe(true);
  });
});

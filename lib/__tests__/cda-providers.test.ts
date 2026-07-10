import { describe, it, expect } from "vitest";
import { parseCcda } from "../cda";

// A minimal CCD exercising the provider capture: a lab observation
// with a performing organization (QUEST) + NPI'd person, an immunization with an
// administering organization, and a Care Teams section listing a clinician.
const CCD = `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <component><structuredBody>
    <component><section>
      <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
      <entry><organizer>
        <component><observation>
          <code code="718-7" codeSystem="2.16.840.1.113883.6.1" displayName="Hemoglobin"/>
          <effectiveTime value="20241017"/>
          <value value="13.5" unit="g/dL"/>
          <performer typeCode="PRF"><assignedEntity>
            <id root="2.16.840.1.113883.4.6" extension="1000000002"/>
            <representedOrganization><name>QUEST (BEAKER)</name></representedOrganization>
            <assignedPerson><name><given>Rosalind</given><family>Franklin</family></name></assignedPerson>
          </assignedEntity></performer>
        </observation></component>
      </organizer></entry>
    </section></component>
    <component><section>
      <code code="11369-6" codeSystem="2.16.840.1.113883.6.1"/>
      <entry><substanceAdministration>
        <effectiveTime value="20231127"/>
        <consumable><manufacturedProduct><manufacturedMaterial>
          <code code="08" codeSystem="2.16.840.1.113883.12.292" displayName="Hep B"/>
        </manufacturedMaterial></manufacturedProduct></consumable>
        <performer typeCode="PRF"><assignedEntity classCode="ASSIGNED">
          <id nullFlavor="UNK"/>
          <representedOrganization classCode="ORG"><name>Example Medical Center</name></representedOrganization>
        </assignedEntity></performer>
      </substanceAdministration></entry>
    </section></component>
    <component><section>
      <code code="85847-2" codeSystem="2.16.840.1.113883.6.1"/>
      <entry><organizer><component><act><performer><assignedEntity>
        <id root="2.16.840.1.113883.4.6" extension="1000000003"/>
        <telecom use="WP" value="tel:+1-555-010-0001"/>
        <assignedPerson><name><given>Katherine</given><family>Johnson</family></name></assignedPerson>
        <representedOrganization><name>Sample Care East</name></representedOrganization>
      </assignedEntity></performer></act></component></organizer></entry>
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;

describe("CCD provider capture", () => {
  const r = parseCcda(CCD);

  it("captures the performing organization on a lab observation", () => {
    expect(r.records).toHaveLength(1);
    const p = r.records[0].provider;
    expect(p?.name).toBe("QUEST (BEAKER)");
    expect(p?.type).toBe("organization");
  });

  it("captures the administering organization on an immunization", () => {
    expect(r.immunizations).toHaveLength(1);
    expect(r.immunizations[0].code).toBe("hepb");
    expect(r.immunizations[0].provider?.name).toBe("Example Medical Center");
    expect(r.immunizations[0].provider?.type).toBe("organization");
  });

  it("captures Care Teams clinicians as individual providers with NPI + phone", () => {
    const careTeam = r.providers ?? [];
    const person = careTeam.find((p) => p.name === "Katherine Johnson");
    expect(person).toBeTruthy();
    expect(person?.type).toBe("individual");
    expect(person?.npi).toBe("1000000003");
    expect(person?.phone).toBe("+1-555-010-0001");
  });
});

// An NPI-less org performer carries a local <id root=... extension=.../>; the
// captured identifier must be authority-qualified (`<root>:<ext>`) so two orgs
// sharing an extension under different roots don't collide in the global dedup.
const CCD_NON_NPI_ORG = `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <component><structuredBody>
    <component><section>
      <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
      <entry><organizer>
        <component><observation>
          <code code="718-7" codeSystem="2.16.840.1.113883.6.1" displayName="Hemoglobin"/>
          <effectiveTime value="20241017"/>
          <value value="13.5" unit="g/dL"/>
          <performer typeCode="PRF"><assignedEntity>
            <id root="1.2.840.99999" extension="100"/>
            <representedOrganization><name>Community Clinic</name></representedOrganization>
          </assignedEntity></performer>
        </observation></component>
      </organizer></entry>
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;

describe("CCD provider identifier namespacing", () => {
  it("qualifies a non-NPI identifier with its assigning-authority root OID", () => {
    const r = parseCcda(CCD_NON_NPI_ORG);
    const p = r.records[0].provider;
    expect(p?.name).toBe("Community Clinic");
    expect(p?.npi).toBeNull();
    expect(p?.identifier).toBe("1.2.840.99999:100");
  });
});

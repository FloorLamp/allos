import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import {
  parseCcda,
  parseXdm,
  parseCcdaDocument,
  looksLikeCda,
  CdaError,
  immunizationExtractor,
  type SectionExtractor,
} from "@/lib/cda";

const CCD = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <component><structuredBody>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.2.1"/>
      <code code="11369-6" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Immunizations</title>
      <entry><substanceAdministration classCode="SBADM" moodCode="EVN">
        <effectiveTime value="20210410"/>
        <consumable><manufacturedProduct><manufacturedMaterial>
          <code code="207" codeSystem="2.16.840.1.113883.12.292" displayName="COVID-19 mRNA"/>
          <lotNumberText>EL9264</lotNumberText>
        </manufacturedMaterial></manufacturedProduct></consumable>
      </substanceAdministration></entry>
      <entry><substanceAdministration classCode="SBADM" moodCode="EVN">
        <effectiveTime value="20101101"/>
        <consumable><manufacturedProduct><manufacturedMaterial>
          <code code="08" codeSystem="2.16.840.1.113883.12.292" displayName="Hepatitis B"/>
        </manufacturedMaterial></manufacturedProduct></consumable>
      </substanceAdministration></entry>
      <entry><substanceAdministration classCode="SBADM" moodCode="EVN" negationInd="true">
        <effectiveTime value="20220101"/>
        <consumable><manufacturedProduct><manufacturedMaterial>
          <code code="213" codeSystem="2.16.840.1.113883.12.292" displayName="COVID-19"/>
        </manufacturedMaterial></manufacturedProduct></consumable>
      </substanceAdministration></entry>
    </section></component>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
      <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Results</title>
      <entry><organizer classCode="BATTERY" moodCode="EVN">
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="16935-9" codeSystem="2.16.840.1.113883.6.1" displayName="Hepatitis B Surface Antibody"/>
          <effectiveTime value="20200601"/>
          <value type="PQ" value="45" unit="mIU/mL"/>
        </observation></component>
      </organizer></entry>
    </section></component>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.4.1"/>
      <code code="8716-3" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Vital Signs</title>
      <entry><organizer classCode="CLUSTER" moodCode="EVN">
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="29463-7" codeSystem="2.16.840.1.113883.6.1" displayName="Body Weight"/>
          <effectiveTime value="20230501"/>
          <value type="PQ" value="82" unit="kg"/>
        </observation></component>
      </organizer></entry>
    </section></component>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.1.1"/>
      <code code="10160-0" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Medications</title>
      <entry><substanceAdministration classCode="SBADM" moodCode="EVN">
        <effectiveTime type="IVL_TS"><low value="20240101"/><high value="20241231"/></effectiveTime>
        <effectiveTime type="PIVL_TS" operator="A"><period value="24" unit="h"/></effectiveTime>
        <doseQuantity value="10" unit="mg"/>
        <consumable><manufacturedProduct><manufacturedMaterial>
          <code code="83367" codeSystem="2.16.840.1.113883.6.88" displayName="Atorvastatin"/>
          <name>Atorvastatin 10 mg tablet</name>
        </manufacturedMaterial></manufacturedProduct></consumable>
      </substanceAdministration></entry>
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;

describe("parseCcda", () => {
  it("extracts immunizations with CVX-mapped codes (skipping negated), sorted", () => {
    const r = parseCcda(CCD);
    expect(r.immunizations.map((i) => i.code)).toEqual(["hepb", "covid"]);
    const covid = r.immunizations.find((i) => i.code === "covid")!;
    expect(covid.date).toBe("2021-04-10");
    expect(covid.notes).toBe("Lot EL9264");
    expect(covid.external_id).toBe("ccda:covid:2021-04-10");
    // The negationInd covid dose (2022) must not appear.
    expect(r.immunizations.some((i) => i.date === "2022-01-01")).toBe(false);
  });

  it("extracts labs, vitals, and medications into categorized records", () => {
    const byCat = (cat: string) =>
      parseCcda(CCD).records.filter((r) => r.category === cat);

    const lab = byCat("lab");
    expect(lab).toHaveLength(1);
    expect(lab[0].name).toBe("Hepatitis B Surface Antibody");
    expect(lab[0].value_num).toBe(45);
    expect(lab[0].unit).toBe("mIU/mL");
    // external_id includes the value so two distinct same-day readings of the
    // same code don't collapse to one key (and get dropped by dedupe).
    expect(lab[0].external_id).toBe("ccda:obs:16935-9:2020-06-01:45");

    const vital = byCat("vitals");
    expect(vital).toHaveLength(1);
    expect(vital[0].name).toBe("Body Weight");
    expect(vital[0].value_num).toBe(82);
    expect(vital[0].unit).toBe("kg");

    const rx = byCat("prescription");
    expect(rx).toHaveLength(1);
    expect(rx[0].name).toBe("Atorvastatin 10 mg tablet");
    expect(rx[0].value).toBe("10 mg");
    // Medication effectiveTime is an array (period + frequency) → uses the low.
    expect(rx[0].date).toBe("2024-01-01");
    expect(rx[0].external_id).toBe("ccda:rx:83367:2024-01-01");
  });

  it("recognizes / rejects CDA documents", () => {
    expect(looksLikeCda(CCD)).toBe(true);
    expect(looksLikeCda("<html></html>")).toBe(false);
    expect(() => parseCcda("<html></html>")).toThrow(CdaError);
  });
});

describe("extractor seam", () => {
  it("parseCcdaDocument exposes every section for custom traversal", () => {
    const { sections } = parseCcdaDocument(CCD);
    expect(sections).toHaveLength(4);
    expect(sections.map((s) => s.code)).toContain("11369-6");
    expect(sections.map((s) => s.code)).toContain("10160-0");
    const imm = sections.find((s) => s.code === "11369-6")!;
    expect(imm.title).toBe("Immunizations");
    expect(imm.entries.length).toBe(3);
  });

  it("runs only the extractors passed in (custom registry)", () => {
    // Immunizations only → no records, even though the doc has labs/vitals/meds.
    const r = parseCcda(CCD, [immunizationExtractor]);
    expect(r.immunizations.length).toBe(2);
    expect(r.records).toEqual([]);
  });

  it("supports a brand-new section extractor without touching the core", () => {
    // A toy extractor for the Problems section (not built-in) demonstrates the seam.
    const problemExtractor: SectionExtractor = {
      key: "problems",
      matches: (s) => s.code === "11450-4",
      extract: (s) => ({
        records: s.entries.map((_, i) => ({
          category: "biomarker" as const,
          name: `Problem ${i}`,
          canonical: `Problem ${i}`,
          value: null,
          value_num: null,
          unit: null,
          date: "2020-01-01",
          external_id: `test:problem:${i}`,
        })),
      }),
    };
    // On our fixture (no problems section) it yields nothing but doesn't break.
    expect(parseCcda(CCD, [problemExtractor]).records).toEqual([]);
  });
});

describe("canonical biomarker names", () => {
  const vitalsDoc = (loinc: string, display: string) => `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <component><structuredBody><component><section>
    <code code="8716-3" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Vital Signs</title>
    <entry><organizer classCode="CLUSTER" moodCode="EVN">
      <component><observation classCode="OBS" moodCode="EVN">
        <code code="${loinc}" codeSystem="2.16.840.1.113883.6.1" displayName="${display}"/>
        <effectiveTime value="20230501"/>
        <value type="PQ" value="120" unit="mm[Hg]"/>
      </observation></component>
    </organizer></entry>
  </section></component></structuredBody></component>
</ClinicalDocument>`;

  it("maps a vital's LOINC to the app's canonical name (name kept as printed)", () => {
    const rec = parseCcda(vitalsDoc("8480-6", "Systolic blood pressure"))
      .records[0];
    expect(rec.name).toBe("Systolic blood pressure"); // provenance preserved
    expect(rec.canonical).toBe("Blood Pressure Systolic"); // canonical identity
  });

  it("falls back to the printed name for an unmapped LOINC", () => {
    const rec = parseCcda(vitalsDoc("29463-7", "Body Weight")).records[0];
    expect(rec.canonical).toBe("Body Weight");
  });
});

describe("demographics", () => {
  const withPatient = (inner: string) => `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget><patientRole><patient>${inner}</patient></patientRole></recordTarget>
  <component><structuredBody></structuredBody></component>
</ClinicalDocument>`;

  it("reads name, birthdate, and sex from the CDA header", () => {
    const xml = withPatient(
      `<name><given>Jane</given><given>Q</given><family>Doe</family></name>
       <administrativeGenderCode code="F" codeSystem="2.16.840.1.113883.5.1"/>
       <birthTime value="19850312"/>`
    );
    expect(parseCcda(xml).demographics).toEqual({
      sex: "female",
      birthdate: "1985-03-12",
      name: "Jane Q Doe",
      postalCode: null,
    });
    expect(parseCcdaDocument(xml).demographics).toEqual({
      sex: "female",
      birthdate: "1985-03-12",
      name: "Jane Q Doe",
      postalCode: null,
    });
  });

  it("maps M→male, tolerates a partial header, keeps a name-only patient", () => {
    expect(
      parseCcda(withPatient(`<administrativeGenderCode code="M"/>`))
        .demographics
    ).toEqual({ sex: "male", birthdate: null, name: null, postalCode: null });
    // A name with no sex/birthdate is still carried (document provenance).
    expect(
      parseCcda(withPatient(`<name><family>Solo</family></name>`)).demographics
    ).toEqual({ sex: null, birthdate: null, name: "Solo", postalCode: null });
  });

  it("reads the patient's own postal code from patientRole/addr (#570)", () => {
    // The addr is a sibling of <patient> under <patientRole>, so the fixture puts
    // it there. We keep ONLY the ZIP (a synthetic one) — never the street line.
    const xml = `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget><patientRole>
    <addr><streetAddressLine>1 Test St</streetAddressLine><city>Springfield</city><state>IL</state><postalCode>62704</postalCode></addr>
    <patient><name><family>Doe</family></name></patient>
  </patientRole></recordTarget>
  <component><structuredBody></structuredBody></component>
</ClinicalDocument>`;
    expect(parseCcda(xml).demographics).toEqual({
      sex: null,
      birthdate: null,
      name: "Doe",
      postalCode: "62704",
    });
  });

  it("is null when no demographics are present", () => {
    // The main fixture has no recordTarget.
    expect(parseCcda(CCD).demographics).toBeNull();
    // An unknown gender code with no birthTime yields null, not a bare object.
    expect(
      parseCcda(withPatient(`<administrativeGenderCode code="UN"/>`))
        .demographics
    ).toBeNull();
  });
});

describe("parseXdm", () => {
  function buildZip(files: { name: string; data: Buffer }[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const f of files) {
      const nameBuf = Buffer.from(f.name, "utf8");
      const comp = zlib.deflateRawSync(f.data);
      const local = Buffer.alloc(30 + nameBuf.length);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(comp.length, 18);
      local.writeUInt32LE(f.data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      nameBuf.copy(local, 30);
      locals.push(local, comp);
      const central = Buffer.alloc(46 + nameBuf.length);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(8, 10);
      central.writeUInt32LE(comp.length, 20);
      central.writeUInt32LE(f.data.length, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt32LE(offset, 42);
      nameBuf.copy(central, 46);
      centrals.push(central);
      offset += local.length + comp.length;
    }
    const localBuf = Buffer.concat(locals);
    const centralBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(localBuf.length, 16);
    return Buffer.concat([localBuf, centralBuf, eocd]);
  }

  it("finds and parses the CCD inside an XDM package (ignoring metadata)", () => {
    const zip = buildZip([
      { name: "IHE_XDM/METADATA.XML", data: Buffer.from("<Metadata/>") },
      { name: "IHE_XDM/SUBSET01/DOC0001.XML", data: Buffer.from(CCD) },
    ]);
    const r = parseXdm(zip);
    expect(r.immunizations.map((i) => i.code)).toEqual(["hepb", "covid"]);
    expect(r.records.length).toBe(3); // lab + vital + medication
  });

  it("throws when the package contains no CCD", () => {
    const zip = buildZip([
      { name: "METADATA.XML", data: Buffer.from("<Metadata/>") },
    ]);
    expect(() => parseXdm(zip)).toThrow(CdaError);
  });
});

// #417 — CCD medications must carry the attribution the pharmacy's own record
// holds (prescriber/pharmacy/Rx number) and the sig text FHIR keeps, so the
// auto-structured medication row isn't left unattributed with no schedule.
const MED_ATTRIBUTION_CCD = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <component><structuredBody>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.1.1"/>
      <code code="10160-0" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Medications</title>
      <text>
        <table><tbody>
          <tr ID="med1sig"><td>Take 1 tablet by mouth once daily</td></tr>
        </tbody></table>
      </text>
      <entry><substanceAdministration classCode="SBADM" moodCode="EVN">
        <text><reference value="#med1sig"/></text>
        <effectiveTime type="IVL_TS"><low value="20240101"/></effectiveTime>
        <doseQuantity value="10" unit="mg"/>
        <consumable><manufacturedProduct><manufacturedMaterial>
          <code code="83367" codeSystem="2.16.840.1.113883.6.88" displayName="Atorvastatin"/>
          <name>Atorvastatin 10 mg tablet</name>
        </manufacturedMaterial></manufacturedProduct></consumable>
        <author>
          <assignedAuthor>
            <assignedPerson><name><given>Ada</given><family>Prescriber</family></name></assignedPerson>
          </assignedAuthor>
        </author>
        <entryRelationship typeCode="REFR">
          <supply classCode="SPLY" moodCode="INT">
            <id extension="RX-555023"/>
            <performer><assignedEntity>
              <representedOrganization><name>Test Pharmacy #12</name></representedOrganization>
            </assignedEntity></performer>
          </supply>
        </entryRelationship>
      </substanceAdministration></entry>
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;

describe("CCD medication attribution (#417)", () => {
  it("reads prescriber (author), pharmacy + Rx (<supply>), and the sig into `value`", () => {
    const rx = parseCcda(MED_ATTRIBUTION_CCD).records.filter(
      (r) => r.category === "prescription"
    );
    expect(rx).toHaveLength(1);
    expect(rx[0]).toMatchObject({
      name: "Atorvastatin 10 mg tablet",
      // The sig text (FHIR's field) now populates `value` instead of the bare
      // doseQuantity, so schedule inference sees the same shape as FHIR.
      value: "Take 1 tablet by mouth once daily",
      prescriber: "Ada Prescriber",
      pharmacy: "Test Pharmacy #12",
      rxNumber: "RX-555023",
    });
  });

  it("falls back to the doseQuantity string when no sig narrative is present", () => {
    // The baseline CCD med (no <text> sig) keeps its "10 mg" value — unchanged.
    const rx = parseCcda(CCD).records.filter(
      (r) => r.category === "prescription"
    );
    expect(rx[0].value).toBe("10 mg");
    expect(rx[0].prescriber ?? null).toBeNull();
  });
});

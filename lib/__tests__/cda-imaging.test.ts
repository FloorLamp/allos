import { describe, expect, it } from "vitest";
import { parseCcda } from "../cda";

// Pure routing coverage for the CDA radiology-study → imaging_studies extractor
// (#708 CDA feed). The DB tier (lib/__db_tests__/cda-imaging-study.test.ts) proves it
// persists; this pins the parse-level mapping + the drop rules. Fixtures SYNTHETIC.

function resultsDoc(...entries: string[]): string {
  return `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <effectiveTime value="20240301"/>
  <recordTarget><patientRole><patient><name><given>Test</given><family>Patient</family></name></patient></patientRole></recordTarget>
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
    <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Results</title>
    ${entries.join("")}
  </section></component></structuredBody></component>
</ClinicalDocument>`;
}

function radObs(opts: {
  id?: string;
  method?: string;
  site?: string;
  laterality?: string;
  low?: string;
  negated?: boolean;
}): string {
  return `<entry><observation classCode="OBS" moodCode="EVN"${opts.negated ? ' negationInd="true"' : ""}>
    <templateId root="2.16.840.1.113883.10.20.22.4.2"/>
    ${opts.id ? `<id root="1.2.3" extension="${opts.id}"/>` : ""}
    <code code="18782-3" codeSystem="2.16.840.1.113883.6.1"><originalText>Radiology Study observation (narrative)</originalText></code>
    <statusCode code="completed"/>
    ${opts.low ? `<effectiveTime><low value="${opts.low}"/></effectiveTime>` : '<effectiveTime nullFlavor="UNK"/>'}
    <value xsi:type="ST" nullFlavor="NA"/>
    ${opts.method ? `<methodCode code="4" codeSystem="1.2.840.x"><originalText>${opts.method}</originalText></methodCode>` : ""}
    ${
      opts.site
        ? `<targetSiteCode code="119" codeSystem="1.2.840.y"><originalText>${opts.site}</originalText>${
            opts.laterality
              ? `<qualifier><name code="272741003" codeSystem="2.16.840.1.113883.6.96"/><value xsi:type="CD" displayName="${opts.laterality}"><originalText>${opts.laterality}</originalText></value></qualifier>`
              : ""
          }</targetSiteCode>`
        : ""
    }
  </observation></entry>`;
}

describe("CDA radiology-study extractor", () => {
  it("maps modality / body region / laterality / date via the shared normalizers", () => {
    const r = parseCcda(
      resultsDoc(
        radObs({
          id: "IMG-1",
          method: "Ultrasound",
          site: "Breast",
          laterality: "left",
          low: "20240301120000-0500",
        })
      )
    );
    expect(r.imagingStudies).toHaveLength(1);
    expect(r.imagingStudies![0]).toMatchObject({
      modality: "ultrasound",
      body_region: "Breast",
      laterality: "left",
      study_date: "2024-03-01",
      contrast: false,
      dose_msv: null,
      external_id: "ccda:imaging:IMG-1",
    });
    // It must NOT also become a (null-value) lab record.
    expect(r.records.some((x) => /radiology/i.test(x.name))).toBe(false);
  });

  it("normalizes a mammogram to x-ray and reads bilateral", () => {
    const r = parseCcda(
      resultsDoc(
        radObs({
          id: "IMG-2",
          method: "Mammography",
          site: "Breast",
          laterality: "bilateral",
          low: "20240110",
        })
      )
    );
    expect(r.imagingStudies![0]).toMatchObject({
      modality: "x-ray",
      laterality: "bilateral",
    });
  });

  it("drops a study with neither an id nor a date (nothing to key on)", () => {
    const r = parseCcda(resultsDoc(radObs({ method: "CT" })));
    expect(r.imagingStudies ?? []).toHaveLength(0);
  });

  it("skips a negated observation", () => {
    const r = parseCcda(
      resultsDoc(radObs({ id: "IMG-3", method: "MRI", negated: true }))
    );
    expect(r.imagingStudies ?? []).toHaveLength(0);
  });

  it("falls back to a content-keyed external_id when the study carries no id", () => {
    const r = parseCcda(
      resultsDoc(radObs({ method: "CT", site: "Head", low: "20240115" }))
    );
    expect(r.imagingStudies![0].external_id).toBe(
      "ccda:imaging:2024-01-15:ct:head"
    );
  });
});

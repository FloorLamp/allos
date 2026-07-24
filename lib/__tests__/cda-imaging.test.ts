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
  // A non-laterality qualifier (a view/projection/approach coded by some OTHER
  // SNOMED concept) rendered BEFORE the laterality qualifier, so the laterality
  // entry is NOT qualifier[0] — the #1366 non-laterality-first shape.
  view?: string;
  low?: string;
  negated?: boolean;
}): string {
  const lateralityQual = opts.laterality
    ? `<qualifier><name code="272741003" codeSystem="2.16.840.1.113883.6.96"/><value xsi:type="CD" displayName="${opts.laterality}"><originalText>${opts.laterality}</originalText></value></qualifier>`
    : "";
  // A projection/view qualifier keyed by a DIFFERENT SNOMED name code (260686004,
  // "Method") — not the 272741003 laterality concept — placed first.
  const viewQual = opts.view
    ? `<qualifier><name code="260686004" codeSystem="2.16.840.1.113883.6.96"/><value xsi:type="CD" displayName="${opts.view}"><originalText>${opts.view}</originalText></value></qualifier>`
    : "";
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
        ? `<targetSiteCode code="119" codeSystem="1.2.840.y"><originalText>${opts.site}</originalText>${viewQual}${lateralityQual}</targetSiteCode>`
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

  it("reads laterality by SNOMED 272741003, not qualifier position (#1366)", () => {
    // A view/projection qualifier is qualifier[0]; the actual laterality qualifier
    // is qualifier[1]. Positional reading would import laterality:null; the coded
    // filter recovers "right".
    const r = parseCcda(
      resultsDoc(
        radObs({
          id: "IMG-LAT",
          method: "X-ray",
          site: "Knee",
          view: "AP projection",
          laterality: "right",
          low: "20240220",
        })
      )
    );
    expect(r.imagingStudies).toHaveLength(1);
    expect(r.imagingStudies![0]).toMatchObject({
      body_region: "Knee",
      laterality: "right",
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

  it("leaves a bare (organizer-less) study's impression null (no sibling prose)", () => {
    const r = parseCcda(resultsDoc(radObs({ id: "IMG-8", method: "CT" })));
    expect(r.imagingStudies![0].impression).toBeNull();
  });
});

// A radiology organizer (code 38026-1) holds the study observation and its Epic report
// prose together: nullFlavor-LOINC observations coded only by an Epic.ResultText
// translation (IMP/NAR/…) whose ED value references the narrative table. The study's
// impression is folded from those siblings (#708 follow-up). Fixtures SYNTHETIC.
function organizerDoc(narrativeCells: string, components: string): string {
  return `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <effectiveTime value="20240301"/>
  <recordTarget><patientRole><patient><name><given>Test</given><family>Patient</family></name></patient></patientRole></recordTarget>
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
    <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Results</title>
    <text>${narrativeCells}</text>
    <entry><organizer classCode="BATTERY" moodCode="EVN">
      <code code="38026-1" codeSystem="2.16.840.1.113883.6.1"/>
      <effectiveTime value="20240301"/>
      ${components}
    </organizer></entry>
  </section></component></structuredBody></component>
</ClinicalDocument>`;
}

// The structured radiology-study component (18782-3) — a nullFlavor value + a modality.
const studyComponent = `<component><observation classCode="OBS" moodCode="EVN">
  <templateId root="2.16.840.1.113883.10.20.22.4.2"/>
  <id root="1.2.3" extension="IMG-ORG"/>
  <code code="18782-3" codeSystem="2.16.840.1.113883.6.1"><originalText>Radiology Study observation (narrative)</originalText></code>
  <effectiveTime><low value="20240301"/></effectiveTime>
  <value xsi:type="ST" nullFlavor="NA"/>
  <methodCode code="4" codeSystem="1.2.840.x"><originalText>Ultrasound</originalText></methodCode>
  <targetSiteCode code="119" codeSystem="1.2.840.y"><originalText>Breast</originalText></targetSiteCode>
</observation></component>`;

// An Epic.ResultText report-prose component (IMP/NAR/…) whose ED value references a cell.
function proseComponent(code: string, cellId: string): string {
  return `<component><observation classCode="OBS" moodCode="EVN">
    <code codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC" nullFlavor="UNK">
      <translation code="${code}" codeSystem="1.2.840.114350.1.72.1.5220" codeSystemName="Epic.ResultText"/>
    </code>
    <value xsi:type="ED"><reference value="#${cellId}"/></value>
  </observation></component>`;
}

describe("CDA radiology impression fold (#708 follow-up)", () => {
  it("folds the radiologist's IMPRESSION from the study's report-prose siblings", () => {
    const r = parseCcda(
      organizerDoc(
        `<content ID="Imp">IMPRESSION: Left breast abscess. Recommend follow-up.</content>`,
        studyComponent + proseComponent("IMP", "Imp")
      )
    );
    expect(r.imagingStudies).toHaveLength(1);
    expect(r.imagingStudies![0].impression).toBe(
      "IMPRESSION: Left breast abscess. Recommend follow-up."
    );
    // The prose sibling is NOT also a `report` record (no real report LOINC).
    expect(r.records.some((x) => x.category === "report")).toBe(false);
  });

  it("prefers the IMPRESSION over the fuller narrative", () => {
    const r = parseCcda(
      organizerDoc(
        `<content ID="Imp">Impression text.</content><content ID="Nar">Full narrative body.</content>`,
        studyComponent +
          proseComponent("NAR", "Nar") +
          proseComponent("IMP", "Imp")
      )
    );
    expect(r.imagingStudies![0].impression).toBe("Impression text.");
  });

  it("falls back to the narrative when there is no impression component", () => {
    const r = parseCcda(
      organizerDoc(
        `<content ID="Nar">Narrative-only body.</content>`,
        studyComponent + proseComponent("NAR", "Nar")
      )
    );
    expect(r.imagingStudies![0].impression).toBe("Narrative-only body.");
  });

  it("preserves line breaks in a multi-line impression (block map + br→newline)", () => {
    const r = parseCcda(
      organizerDoc(
        `<content ID="Imp">FINDINGS: Complex fluid collection.<br/>IMPRESSION: Abscess.<br/>Recommend follow-up.</content>`,
        studyComponent + proseComponent("IMP", "Imp")
      )
    );
    expect(r.imagingStudies![0].impression).toBe(
      "FINDINGS: Complex fluid collection.\nIMPRESSION: Abscess.\nRecommend follow-up."
    );
  });

  it("strips a leading narrative-table rule line from the impression", () => {
    const r = parseCcda(
      organizerDoc(
        `<content ID="Imp">--------------------  OBSTETRIC ULTRASOUND: Normal.</content>`,
        studyComponent + proseComponent("IMP", "Imp")
      )
    );
    expect(r.imagingStudies![0].impression).toBe(
      "OBSTETRIC ULTRASOUND: Normal."
    );
  });
});

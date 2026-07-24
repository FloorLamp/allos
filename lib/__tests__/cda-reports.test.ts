import { describe, expect, it } from "vitest";
import { parseCcda } from "../cda";

// Pure routing coverage for the CDA narrative-report → `report` record extractor
// (#708 CDA feed). The DB tier (lib/__db_tests__/cda-report-record.test.ts) proves it
// persists; this pins the parse-level mapping + the drop rules. Fixtures SYNTHETIC —
// obviously-fictional report text, no real PHI.

// A Results section whose <text> narrative table holds the report bodies keyed by the
// same #ids the ED-valued <value>s reference. `entries` are the coded observations.
function resultsDoc(narrativeRows: string, ...entries: string[]): string {
  return `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <effectiveTime value="20240301"/>
  <recordTarget><patientRole><patient><name><given>Test</given><family>Patient</family></name></patient></patientRole></recordTarget>
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
    <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Results</title>
    <text>${narrativeRows}</text>
    ${entries.join("")}
  </section></component></structuredBody></component>
</ClinicalDocument>`;
}

function cell(id: string, text: string): string {
  return `<content ID="${id}">${text}</content>`;
}

// An ED-valued report observation: a real LOINC + originalText name + a <value
// xsi:type="ED"> pointing at a narrative cell.
function reportObs(opts: {
  id?: string;
  loinc: string;
  name: string;
  valueRef?: string; // narrative id the ED value resolves to
  inlineValue?: string; // or inline ED text
  date?: string;
  negated?: boolean;
}): string {
  const value = opts.inlineValue
    ? `<value xsi:type="ED">${opts.inlineValue}</value>`
    : opts.valueRef
      ? `<value xsi:type="ED"><reference value="#${opts.valueRef}"/></value>`
      : `<value xsi:type="ED" nullFlavor="NA"/>`;
  return `<entry><observation classCode="OBS" moodCode="EVN"${opts.negated ? ' negationInd="true"' : ""}>
    <templateId root="2.16.840.1.113883.10.20.22.4.2"/>
    ${opts.id ? `<id root="1.2.3" extension="${opts.id}"/>` : ""}
    <code code="${opts.loinc}" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"><originalText>${opts.name}</originalText></code>
    <statusCode code="completed"/>
    ${opts.date ? `<effectiveTime value="${opts.date}"/>` : '<effectiveTime nullFlavor="UNK"/>'}
    ${value}
  </observation></entry>`;
}

describe("CDA narrative-report extractor", () => {
  it("maps an ED-valued culture report to a `report` record with the body in notes", () => {
    const r = parseCcda(
      resultsDoc(
        cell("CultureBody", "Many Escherichia coli. No anaerobes isolated."),
        reportObs({
          id: "RPT-1",
          loinc: "34574-4",
          name: "Final Report",
          valueRef: "CultureBody",
          date: "20240301",
        })
      )
    );
    const reports = r.records.filter((x) => x.category === "report");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      category: "report",
      name: "Final Report",
      canonical: "Final Report",
      value: null,
      value_num: null,
      date: "2024-03-01",
      loinc: "34574-4",
      notes: "Many Escherichia coli. No anaerobes isolated.",
      external_id: "ccda:report:RPT-1",
    });
    // It must NOT also become a (null-value) lab record.
    expect(r.records.some((x) => x.category === "lab")).toBe(false);
  });

  it("resolves a gram-stain report alongside a real numeric lab in the same section", () => {
    const r = parseCcda(
      resultsDoc(
        cell("GramBody", "Few gram-positive cocci in clusters. Moderate WBCs."),
        reportObs({
          id: "RPT-2",
          loinc: "11502-2",
          name: "Gram Stain Report",
          valueRef: "GramBody",
          date: "20240220",
        }),
        `<entry><observation classCode="OBS" moodCode="EVN">
          <code code="718-7" codeSystem="2.16.840.1.113883.6.1" displayName="Hemoglobin"/>
          <effectiveTime value="20240220"/>
          <value xsi:type="PQ" value="13.9" unit="g/dL"/>
        </observation></entry>`
      )
    );
    const reports = r.records.filter((x) => x.category === "report");
    const labs = r.records.filter((x) => x.category === "lab");
    expect(reports).toHaveLength(1);
    expect(reports[0].name).toBe("Gram Stain Report");
    expect(reports[0].notes).toContain("gram-positive cocci");
    expect(labs.map((l) => l.name)).toEqual(["Hemoglobin"]);
  });

  it("drops an ED report with an empty/unresolvable body (nothing to store)", () => {
    const r = parseCcda(
      resultsDoc(
        "",
        reportObs({
          id: "RPT-3",
          loinc: "33718-8",
          name: "Cytology",
          valueRef: "Missing",
          date: "20240301",
        })
      )
    );
    expect(r.records.filter((x) => x.category === "report")).toHaveLength(0);
  });

  it("skips a negated report observation", () => {
    const r = parseCcda(
      resultsDoc(
        cell("Body", "Report text."),
        reportObs({
          id: "RPT-4",
          loinc: "34574-4",
          name: "Final Report",
          valueRef: "Body",
          date: "20240301",
          negated: true,
        })
      )
    );
    expect(r.records.filter((x) => x.category === "report")).toHaveLength(0);
  });

  it("does NOT treat an ED value without a real LOINC as a report (Epic Result.Text component)", () => {
    // A nullFlavor'd LOINC with only an Epic-proprietary translation — the ADD/IMP/NAR
    // radiology components — is deliberately left out.
    const r = parseCcda(
      resultsDoc(
        cell("NarBody", "Radiology narrative text."),
        `<entry><observation classCode="OBS" moodCode="EVN">
          <code codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC" nullFlavor="UNK">
            <translation code="NAR" codeSystem="1.2.840.114350.1.72.1.5220" codeSystemName="Epic.ResultText"/>
          </code>
          <effectiveTime value="20240301"/>
          <value xsi:type="ED"><reference value="#NarBody"/></value>
        </observation></entry>`
      )
    );
    expect(r.records.filter((x) => x.category === "report")).toHaveLength(0);
  });

  it("falls back to a content-keyed external_id when the report carries no id", () => {
    const r = parseCcda(
      resultsDoc(
        cell("Body", "Culture body."),
        reportObs({
          loinc: "34574-4",
          name: "Final Report",
          valueRef: "Body",
          date: "20240115",
        })
      )
    );
    const reports = r.records.filter((x) => x.category === "report");
    expect(reports[0].external_id).toBe("ccda:report:2024-01-15:34574-4");
  });

  it("preserves line breaks and un-fuses words across a <br/> (block map)", () => {
    // Source cell: text runs separated by <br/>. The parser drops the empty tag and
    // fuses the runs ("aureusNo"); the <br/>→newline preprocess + block map restore the
    // break so the body renders line-by-line through NotesText's pre-wrap.
    const r = parseCcda(
      resultsDoc(
        cell(
          "Body",
          "Moderate S. aureus<br/>No anaerobes isolated<br/>Many WBCs seen"
        ),
        reportObs({
          id: "RPT-9",
          loinc: "34574-4",
          name: "Final Report",
          valueRef: "Body",
          date: "20240301",
        })
      )
    );
    const rep = r.records.find((x) => x.category === "report")!;
    expect(rep.notes).toBe(
      "Moderate S. aureus\nNo anaerobes isolated\nMany WBCs seen"
    );
  });

  it("handles a dash+space padded rule line without catastrophic backtracking (ReDoS guard)", () => {
    // A radiology/path narrative padded with alternating dash-runs and alignment spaces
    // used to hang the edge-rule strip (the (?:\s*[-_=]{2,}\s*)+ ReDoS). The linear
    // strip must return promptly with the leading rule removed.
    const rule = "-- ".repeat(40); // 40 "-- " groups + spaces — the pathological shape
    const started = Date.now();
    const r = parseCcda(
      resultsDoc(
        cell("Body", `${rule} IMPRESSION: Normal study.`),
        reportObs({
          id: "RPT-R",
          loinc: "34574-4",
          name: "Final Report",
          valueRef: "Body",
          date: "20240301",
        })
      )
    );
    // Completing at all is the ReDoS assertion; a generous ceiling catches a regression.
    expect(Date.now() - started).toBeLessThan(2000);
    const rep = r.records.find((x) => x.category === "report")!;
    expect(rep.notes).toBe("IMPRESSION: Normal study.");
  });

  it("resolves an inline ED body (no narrative reference)", () => {
    const r = parseCcda(
      resultsDoc(
        "",
        reportObs({
          id: "RPT-5",
          loinc: "11502-2",
          name: "Gram Stain Report",
          inlineValue: "No organisms seen.",
          date: "20240301",
        })
      )
    );
    const reports = r.records.filter((x) => x.category === "report");
    expect(reports).toHaveLength(1);
    expect(reports[0].notes).toBe("No organisms seen.");
  });
});

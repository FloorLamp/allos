import { describe, expect, it } from "vitest";
import { parseCcda } from "@/lib/cda";

// The CDA half of the duration door (#2322). A stress test reports `Exercise Duration`
// with the unit `min:sec` and a colon-formatted value, in two shapes real documents
// ship: as a PQ whose @_value is not a number, and as an ST value whose unit rides an
// Epic COMP "units" component. Both must land as ONE number in ONE unit; a value the
// declared unit can't explain must DROP with a reason, never store as a string.
// Fixtures SYNTHETIC.

function pqObs(value: string, unit: string): string {
  return `<entry><observation classCode="OBS" moodCode="EVN">
    <code code="55411-3" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC" displayName="Exercise Duration"/>
    <effectiveTime value="20240301"/>
    <value xsi:type="PQ" value="${value}" unit="${unit}"/>
  </observation></entry>`;
}

// The Epic shape: a string value, with the unit on a COMP "units" component.
function stObs(value: string, unit: string): string {
  return `<entry><observation classCode="OBS" moodCode="EVN">
    <code code="55411-3" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC" displayName="Exercise Duration"/>
    <effectiveTime value="20240301"/>
    <value xsi:type="ST">${value}</value>
    <entryRelationship typeCode="COMP"><observation classCode="OBS" moodCode="EVN">
      <code code="246514001" displayName="units"/>
      <value xsi:type="ST">${unit}</value>
    </observation></entryRelationship>
  </observation></entry>`;
}

function doc(...entries: string[]): string {
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

function durationRow(xml: string) {
  return parseCcda(xml).records.find((r) => r.name === "Exercise Duration");
}

describe("CDA duration door (#2322)", () => {
  it("normalizes a non-numeric PQ duration to whole seconds", () => {
    const row = durationRow(doc(pqObs("10:30", "min:sec")));
    expect(row).toMatchObject({
      name: "Exercise Duration",
      value: "630",
      value_num: 630,
      unit: "s",
    });
  });

  it("normalizes the Epic shape (ST value + COMP units component) too", () => {
    const row = durationRow(doc(stObs("8:45", "min:sec")));
    expect(row).toMatchObject({ value_num: 525, unit: "s" });
  });

  it("keeps two same-day durations apart (the key carries the as-shipped value)", () => {
    const records = parseCcda(
      doc(pqObs("10:30", "min:sec"), pqObs("12:00", "min:sec"))
    ).records.filter((r) => r.name === "Exercise Duration");
    expect(records.map((r) => r.value_num).sort()).toEqual([630, 720]);
    expect(new Set(records.map((r) => r.external_id)).size).toBe(2);
  });

  it("DROPS an unparsable duration with a reason instead of storing a string", () => {
    const parsed = parseCcda(doc(pqObs("not recorded", "min:sec")));
    expect(parsed.records.some((r) => r.name === "Exercise Duration")).toBe(
      false
    );
    const drop = parsed.report?.drops.find(
      (d) => d.label === "Exercise Duration"
    );
    expect(drop?.reason).toBe("unparsable_value");
  });

  it("leaves a reading whose unit declares no duration exactly as it arrived", () => {
    const row = parseCcda(
      doc(
        `<entry><observation classCode="OBS" moodCode="EVN">
          <code code="2345-7" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC" displayName="Glucose"/>
          <effectiveTime value="20240301"/>
          <value xsi:type="PQ" value="99" unit="mg/dL"/>
        </observation></entry>`
      )
    ).records.find((r) => r.name === "Glucose");
    expect(row).toMatchObject({ value_num: 99, unit: "mg/dL" });
  });
});

import { describe, expect, it } from "vitest";
import { parseCcda } from "@/lib/cda";

// The source lab's own reference range (<referenceRange>) + abnormal flag
// (<interpretationCode>) capture (#761 follow-up). A CCD lab observation states its
// normal range and an H/L/N/A interpretation; both were discarded. Fixtures SYNTHETIC.

function labObs(opts: {
  loinc: string;
  name: string;
  value: string;
  unit: string;
  interp?: string; // reading-level interpretationCode
  low?: string;
  high?: string;
  rangeText?: string;
  rangeInterp?: string; // the observationRange's OWN label (must NOT become the flag)
}): string {
  const readingInterp = opts.interp
    ? `<interpretationCode code="${opts.interp}" codeSystem="2.16.840.1.113883.5.83"/>`
    : "";
  const range =
    opts.low || opts.high || opts.rangeText
      ? `<referenceRange><observationRange>
          ${opts.rangeText ? `<text>${opts.rangeText}</text>` : ""}
          <value xsi:type="IVL_PQ">
            ${opts.low ? `<low value="${opts.low}" unit="${opts.unit}"/>` : ""}
            ${opts.high ? `<high value="${opts.high}" unit="${opts.unit}"/>` : ""}
          </value>
          ${opts.rangeInterp ? `<interpretationCode code="${opts.rangeInterp}" codeSystem="2.16.840.1.113883.5.83"/>` : ""}
        </observationRange></referenceRange>`
      : "";
  // Numeric result → PQ; a qualitative result (e.g. "Positive") → ST text.
  const value = /^-?\d/.test(opts.value)
    ? `<value xsi:type="PQ" value="${opts.value}" unit="${opts.unit}"/>`
    : `<value xsi:type="ST">${opts.value}</value>`;
  return `<entry><observation classCode="OBS" moodCode="EVN">
    <code code="${opts.loinc}" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC" displayName="${opts.name}"/>
    <effectiveTime value="20240301"/>
    ${value}
    ${readingInterp}
    ${range}
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

describe("CDA lab reference range + interpretation flag", () => {
  it("captures a numeric range and a High reading flag", () => {
    const r = parseCcda(
      doc(
        labObs({
          loinc: "751-8",
          name: "Neutrophils",
          value: "76.4",
          unit: "%",
          interp: "H",
          low: "34.0",
          high: "71.1",
        })
      )
    );
    const rec = r.records.find((x) => x.category === "lab")!;
    expect(rec.flag).toBe("high");
    expect(rec.reference_range).toBe("34.0–71.1 %");
  });

  it("maps L→low, H→high, N→normal, A→abnormal", () => {
    const flags = (interp: string) =>
      parseCcda(
        doc(
          labObs({ loinc: "718-7", name: "X", value: "1", unit: "u", interp })
        )
      ).records.find((x) => x.category === "lab")!.flag;
    expect(flags("L")).toBe("low");
    expect(flags("H")).toBe("high");
    expect(flags("N")).toBe("normal");
    expect(flags("A")).toBe("abnormal");
  });

  it("does NOT mistake the observationRange's own label for the reading flag", () => {
    // The range carries interpretationCode=N (it IS the normal range); the reading
    // itself has no interpretationCode, so the record's flag stays null.
    const r = parseCcda(
      doc(
        labObs({
          loinc: "718-7",
          name: "Hemoglobin",
          value: "14",
          unit: "g/dL",
          low: "13",
          high: "17",
          rangeInterp: "N",
        })
      )
    );
    const rec = r.records.find((x) => x.category === "lab")!;
    expect(rec.flag).toBeNull();
    expect(rec.reference_range).toBe("13–17 g/dL");
  });

  it("formats a one-sided range and falls back to range text", () => {
    const hi = parseCcda(
      doc(
        labObs({ loinc: "1", name: "A", value: "5", unit: "mg/L", high: "10" })
      )
    ).records.find((x) => x.category === "lab")!;
    expect(hi.reference_range).toBe("≤ 10 mg/L");
    const txt = parseCcda(
      doc(
        labObs({
          loinc: "2",
          name: "HPV",
          value: "Positive",
          unit: "",
          interp: "A",
          rangeText: "Negative",
        })
      )
    ).records.find((x) => x.category === "lab")!;
    expect(txt.reference_range).toBe("Negative");
    expect(txt.flag).toBe("abnormal");
  });

  it("does not capture flags/ranges on vitals (they keep their own flag engines)", () => {
    // A vital-LOINC observation in Results is reclassified to vitals (#681); its
    // interpretationCode must NOT seed a flag here.
    const r = parseCcda(
      doc(
        labObs({
          loinc: "8867-4", // Heart rate — a vital LOINC
          name: "Heart Rate",
          value: "180",
          unit: "/min",
          interp: "H",
          low: "60",
          high: "100",
        })
      )
    );
    const rec = r.records.find(
      (x) => x.canonical === "Heart Rate" || x.name === "Heart Rate"
    )!;
    expect(rec.category).toBe("vitals");
    expect(rec.flag ?? null).toBeNull();
    expect(rec.reference_range ?? null).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { parseCcda, parseXdm } from "@/lib/cda";
import { healthRecordToPersistInput } from "@/lib/import-shape";

// Covers the real-world C-CDA shapes that made every imported lab/vital come
// back named "Result" with no LOINC/canonical routing. Fixtures are modeled on
// Epic MyChart "Download My Record" (IHE XDM) and Apple Health exports, where:
//   (epic) the analyte name is INLINE text inside <code><originalText> (which
//       also holds a child <reference>), the code has NO @_displayName, and the
//       observation's own <text> is a bare <reference> — the exact Epic shape;
//       the unit rides a COMP <entryRelationship> "units" component.
//   (a) the observation <code> carries a LOINC @_code but NO @_displayName, and
//       the human-readable analyte name lives only in the section's narrative
//       <text> <table>, reached via <observation><text><reference value="#id"/>.
//   (b) the LOINC is carried in a <translation> child of <code> (or flagged only
//       by codeSystemName="LOINC"), while the top-level code is a local code.

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

// (a) Results section: observations carry a LOINC @_code but no @_displayName;
// analyte names live only in the narrative table, referenced by the observation.
const NARRATIVE_RESULTS_CCD = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
    <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Results</title>
    <text>
      <table>
        <thead><tr><th>Test</th><th>Result</th></tr></thead>
        <tbody>
          <tr ID="lab1"><td ID="lab1name">Glucose</td><td ID="lab1val">99 mg/dL</td></tr>
          <tr ID="lab2"><td ID="lab2name">Potassium</td><td ID="lab2val">4.2 mmol/L</td></tr>
        </tbody>
      </table>
    </text>
    <entry><organizer classCode="BATTERY" moodCode="EVN">
      <component><observation classCode="OBS" moodCode="EVN">
        <code code="2345-7" codeSystem="2.16.840.1.113883.6.1"/>
        <text><reference value="#lab1name"/></text>
        <effectiveTime value="20230101"/>
        <value type="PQ" value="99" unit="mg/dL"/>
      </observation></component>
      <component><observation classCode="OBS" moodCode="EVN">
        <code code="2823-3" codeSystem="2.16.840.1.113883.6.1"/>
        <text><reference value="#lab2name"/></text>
        <effectiveTime value="20230101"/>
        <value type="PQ" value="4.2" unit="mmol/L"/>
      </observation></component>
    </organizer></entry>
  </section></component></structuredBody></component>
</ClinicalDocument>`;

// (epic) The primary Epic MyChart shape (synthetic, invented analytes): the name
// is inline in <code><originalText> next to a child <reference>, the code has no
// @_displayName, obs.text is a bare <reference>, and the unit is a COMP
// <entryRelationship> "units" (SNOMED 246514001) component. A trailing
// nullFlavor="UNK" "Result.Type" marker observation (no name, no value) mirrors
// the noise rows Epic emits — it must be dropped, not surface as "Result".
const EPIC_RESULTS_CCD = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
    <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Results</title>
    <entry><organizer classCode="BATTERY" moodCode="EVN">
      <component><observation classCode="OBS" moodCode="EVN">
        <code code="6690-2" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC">
          <originalText>White Blood Cell Count<reference value="#Result1Comp1Name"/></originalText>
        </code>
        <text><reference value="#Result1Comp1"/></text>
        <statusCode code="completed"/>
        <effectiveTime value="20241017135300+0000"/>
        <value xsi:type="REAL" value="11.0"/>
        <entryRelationship typeCode="COMP"><observation classCode="OBS" moodCode="EVN">
          <code code="246514001" codeSystem="2.16.840.1.113883.6.96" codeSystemName="SNOMED CT" displayName="units"/>
          <value xsi:type="ST">Thousand/uL</value>
        </observation></entryRelationship>
      </observation></component>
      <component><observation classCode="OBS" moodCode="EVN">
        <code code="718-7" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC">
          <originalText>Hemoglobin<reference value="#Result1Comp2Name"/></originalText>
        </code>
        <text><reference value="#Result1Comp2"/></text>
        <effectiveTime value="20241017135300+0000"/>
        <value xsi:type="PQ" value="12.6" unit="g/dL"/>
      </observation></component>
      <component><observation classCode="OBS" moodCode="EVN">
        <code nullFlavor="UNK"/>
        <text><reference value="#Result1TypeMarker"/></text>
        <effectiveTime value="20241017135300+0000"/>
        <value xsi:type="CD" code="16" codeSystem="1.2.840.114350.1.72.1.5007" codeSystemName="Epic.Result.Type"/>
      </observation></component>
      <component><observation classCode="OBS" moodCode="EVN">
        <code code="8251-1" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC">
          <originalText>Comment(s)</originalText>
        </code>
        <effectiveTime value="20241017135300+0000"/>
        <value xsi:type="ST" nullFlavor="NA"/>
      </observation></component>
      <component><observation classCode="OBS" moodCode="EVN">
        <code code="94500-6" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC">
          <originalText>SARS-CoV-2 RNA</originalText>
        </code>
        <effectiveTime value="20241017135300+0000"/>
        <value xsi:type="ST">Not Detected</value>
      </observation></component>
    </organizer></entry>
  </section></component></structuredBody></component>
</ClinicalDocument>`;

// (b) Vital signs whose LOINC is only in a <translation> (top-level code is a
// local/EMR code), or is flagged solely by codeSystemName="LOINC".
const TRANSLATION_LOINC_CCD = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.22.2.4.1"/>
    <code code="8716-3" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Vital Signs</title>
    <entry><organizer classCode="CLUSTER" moodCode="EVN">
      <component><observation classCode="OBS" moodCode="EVN">
        <code code="BP_SYS" codeSystem="1.2.3.4.999" displayName="Systolic BP">
          <translation code="8480-6" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC" displayName="Systolic blood pressure"/>
        </code>
        <effectiveTime value="20230501"/>
        <value type="PQ" value="120" unit="mm[Hg]"/>
      </observation></component>
      <component><observation classCode="OBS" moodCode="EVN">
        <code code="8462-4" codeSystemName="LOINC" displayName="Diastolic blood pressure"/>
        <effectiveTime value="20230501"/>
        <value type="PQ" value="80" unit="mm[Hg]"/>
      </observation></component>
    </organizer></entry>
  </section></component></structuredBody></component>
</ClinicalDocument>`;

describe("Epic MyChart originalText-inline analyte names (primary shape)", () => {
  it("names labs from <code><originalText>, reads the COMP unit, drops noise", () => {
    const xdm = buildZip([
      { name: "IHE_XDM/METADATA.XML", data: Buffer.from("<Metadata/>") },
      {
        name: "IHE_XDM/SUBSET01/DOC0001.XML",
        data: Buffer.from(EPIC_RESULTS_CCD),
      },
    ]);
    const labs = parseXdm(xdm).records.filter((r) => r.category === "lab");
    // Two numeric analytes + one qualitative; the nullFlavor Result.Type marker
    // AND the named-but-empty "Comment(s)" (nullFlavor value) rows are dropped.
    expect(labs.map((r) => r.name)).toEqual([
      "White Blood Cell Count",
      "Hemoglobin",
      "SARS-CoV-2 RNA",
    ]);
    const wbc = labs.find((r) => r.name === "White Blood Cell Count")!;
    expect(wbc.value_num).toBe(11);
    // Unit pulled from the COMP <entryRelationship> "units" component.
    expect(wbc.unit).toBe("Thousand/uL");
    // Names match the app's canonical vocabulary, so they route/group there.
    expect(wbc.canonical).toBe("White Blood Cell Count");
    expect(labs.find((r) => r.name === "Hemoglobin")!.unit).toBe("g/dL");
    // A qualitative string result is productive and kept.
    expect(labs.find((r) => r.name === "SARS-CoV-2 RNA")!.value).toBe(
      "Not Detected"
    );
    // No empty "Comment(s)" row and nothing left named the literal "Result".
    expect(labs.some((r) => /comment/i.test(r.name))).toBe(false);
    expect(labs.some((r) => r.name === "Result")).toBe(false);
  });
});

describe("narrative-referenced analyte names (mode a)", () => {
  it("resolves the printed name from the section narrative table", () => {
    const xdm = buildZip([
      { name: "IHE_XDM/METADATA.XML", data: Buffer.from("<Metadata/>") },
      {
        name: "IHE_XDM/SUBSET01/DOC0001.XML",
        data: Buffer.from(NARRATIVE_RESULTS_CCD),
      },
    ]);
    const labs = parseXdm(xdm).records.filter((r) => r.category === "lab");
    expect(labs).toHaveLength(2);
    // Names come from the narrative <reference> targets, not the literal "Result".
    expect(labs.map((r) => r.name).sort()).toEqual(["Glucose", "Potassium"]);
    // Distinct LOINC-coded analytes get distinct dedup keys (no collapse).
    expect(new Set(labs.map((r) => r.external_id)).size).toBe(2);
    expect(
      labs.every(
        (r) =>
          r.external_id.includes("2345-7") || r.external_id.includes("2823-3")
      )
    ).toBe(true);
  });

  it("routes the named labs into the lab sink via the persist shape", () => {
    const parsed = parseCcda(NARRATIVE_RESULTS_CCD);
    const input = healthRecordToPersistInput(parsed, "ccda", "Health record");
    const names = input.records
      .filter((r) => r.category === "lab")
      .map((r) => r.name)
      .sort();
    expect(names).toEqual(["Glucose", "Potassium"]);
    // Lab names register into the biomarker vocabulary (not left as "Result").
    expect(input.canonicalNamesToRegister.sort()).toEqual([
      "Glucose",
      "Potassium",
    ]);
  });
});

describe("LOINC carried via translation / codeSystemName (mode b)", () => {
  it("extracts the LOINC and reaches the canonical identity", () => {
    const vitals = parseCcda(TRANSLATION_LOINC_CCD).records.filter(
      (r) => r.category === "vitals"
    );
    expect(vitals).toHaveLength(2);
    // LOINC pulled from the <translation> and from codeSystemName="LOINC" now
    // routes each reading to its canonical biomarker; the printed name is kept.
    const bySys = vitals.find((r) => r.name === "Systolic BP")!;
    expect(bySys.canonical).toBe("Blood Pressure Systolic");
    const byDia = vitals.find((r) => r.name === "Diastolic blood pressure")!;
    expect(byDia.canonical).toBe("Blood Pressure Diastolic");
  });
});

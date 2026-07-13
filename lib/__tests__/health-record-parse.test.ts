import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import {
  detectHealthRecord,
  parseHealthRecord,
} from "@/lib/health-record-parse";

const CCD = `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget><patientRole><patient>
    <administrativeGenderCode code="M"/>
    <birthTime value="19800101"/>
  </patient></patientRole></recordTarget>
  <component><structuredBody><component><section>
    <code code="11369-6" codeSystem="2.16.840.1.113883.6.1"/>
    <entry><substanceAdministration classCode="SBADM" moodCode="EVN">
      <effectiveTime value="20210410"/>
      <consumable><manufacturedProduct><manufacturedMaterial>
        <code code="08" codeSystem="2.16.840.1.113883.12.292"/>
      </manufacturedMaterial></manufacturedProduct></consumable>
    </substanceAdministration></entry>
  </section></component></structuredBody></component>
</ClinicalDocument>`;

// Build a minimal valid ZIP (single STORED entry) so detection can peek inside
// for a ClinicalDocument — a bare zip magic isn't enough anymore, since .xlsx /
// .docx are also zips and must not be misrouted to the XDM parser.
function makeZip(name: string, contents: string): Buffer {
  const data = Buffer.from(contents, "utf8");
  const nameBuf = Buffer.from(name, "utf8");
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(0, 8); // method 0 (STORED)
  lfh.writeUInt32LE(data.length, 18);
  lfh.writeUInt32LE(data.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  const fileData = Buffer.concat([lfh, nameBuf, data]);
  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4);
  cdh.writeUInt16LE(20, 6);
  cdh.writeUInt16LE(0, 10); // method 0
  cdh.writeUInt32LE(data.length, 20);
  cdh.writeUInt32LE(data.length, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt32LE(0, 42); // local header offset
  const centralDir = Buffer.concat([cdh, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(fileData.length, 16);
  return Buffer.concat([fileData, centralDir, eocd]);
}

// A minimal SMART Health Card JWS (see smart-health-card.test.ts for the shape).
function makeJws(): string {
  const payload = {
    iss: "https://issuer.example",
    vc: {
      credentialSubject: {
        fhirBundle: {
          resourceType: "Bundle",
          entry: [
            {
              resource: {
                resourceType: "Immunization",
                status: "completed",
                vaccineCode: {
                  coding: [
                    { system: "http://hl7.org/fhir/sid/cvx", code: "08" },
                  ],
                },
                occurrenceDateTime: "2021-04-10",
              },
            },
          ],
        },
      },
    },
  };
  const header = Buffer.from(JSON.stringify({ zip: "DEF" })).toString(
    "base64url"
  );
  const body = zlib
    .deflateRawSync(Buffer.from(JSON.stringify(payload)))
    .toString("base64url");
  return `${header}.${body}.sig`;
}

describe("detectHealthRecord", () => {
  it("recognizes a CCD/CDA XML", () => {
    expect(detectHealthRecord(Buffer.from(CCD))).toBe("cda");
  });

  it("recognizes a zip containing a CCD as XDM", () => {
    expect(detectHealthRecord(makeZip("DOC0001.XML", CCD))).toBe("xdm");
  });

  it("does not treat a non-CCD zip (e.g. .xlsx) as XDM", () => {
    // An OOXML file is a zip too — it must fall through (to AI extraction), not
    // route to the XDM parser and fail.
    const xlsx = makeZip("[Content_Types].xml", "<Types>...</Types>");
    expect(detectHealthRecord(xlsx)).toBeNull();
  });

  it("recognizes SMART Health Card forms (shc:/, file, bare JWS)", () => {
    expect(detectHealthRecord(Buffer.from("shc:/56762909..."))).toBe("shc");
    expect(
      detectHealthRecord(Buffer.from(`{"verifiableCredential":["a.b.c"]}`))
    ).toBe("shc");
    expect(detectHealthRecord(Buffer.from(makeJws()))).toBe("shc");
  });

  it("recognizes a raw FHIR Bundle (but not a lone resource)", () => {
    expect(
      detectHealthRecord(
        Buffer.from(`{"resourceType":"Bundle","type":"collection","entry":[]}`)
      )
    ).toBe("fhir");
    // A bare non-Bundle FHIR resource is not treated as a health-record upload.
    expect(
      detectHealthRecord(Buffer.from(`{"resourceType":"Patient"}`))
    ).toBeNull();
    // A SHC file (verifiableCredential) still wins over the Bundle sniff.
    expect(
      detectHealthRecord(
        Buffer.from(
          `{"verifiableCredential":["a.b.c"],"resourceType":"Bundle"}`
        )
      )
    ).toBe("shc");
  });

  it("returns null for a non-health-record file", () => {
    expect(detectHealthRecord(Buffer.from("%PDF-1.7\n..."))).toBeNull();
    expect(detectHealthRecord(Buffer.from("<html></html>"))).toBeNull();
  });
});

describe("parseHealthRecord", () => {
  it("parses a CCD and tags the ccda source", () => {
    const { parsed, source } = parseHealthRecord(Buffer.from(CCD));
    expect(source).toBe("ccda");
    expect(parsed.immunizations.map((i) => i.code)).toEqual(["hepb"]);
    expect(parsed.demographics).toEqual({
      sex: "male",
      birthdate: "1980-01-01",
      name: null,
      postalCode: null,
    });
  });

  it("parses a SMART Health Card and tags the source", () => {
    const { parsed, source } = parseHealthRecord(Buffer.from(makeJws()));
    expect(source).toBe("smart-health-card");
    expect(parsed.immunizations.map((i) => i.code)).toEqual(["hepb"]);
  });

  it("throws on an unrecognized buffer", () => {
    expect(() => parseHealthRecord(Buffer.from("<html></html>"))).toThrow();
  });
});

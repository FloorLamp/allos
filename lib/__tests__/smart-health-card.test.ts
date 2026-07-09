import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import {
  parseSmartHealthCard,
  decodeSmartHealthCard,
  SmartHealthCardError,
} from "@/lib/smart-health-card";

// --- helpers: build a SMART Health Card from a FHIR bundle the way an issuer would ---

function immunization(cvx: string, date: string, extra: object = {}) {
  return {
    resource: {
      resourceType: "Immunization",
      status: "completed",
      vaccineCode: {
        coding: [{ system: "http://hl7.org/fhir/sid/cvx", code: cvx }],
      },
      patient: { reference: "resource:0" },
      occurrenceDateTime: date,
      ...extra,
    },
  };
}

const BUNDLE = {
  resourceType: "Bundle",
  type: "collection",
  entry: [
    { resource: { resourceType: "Patient", name: [{ family: "Lopez" }] } },
    immunization("208", "2021-03-01", {
      lotNumber: "ABC123",
      protocolApplied: [{ doseNumberPositiveInt: 1 }],
    }),
    immunization("08", "2010-06-15"),
    immunization("158", "2025-10-01"), // influenza
    // A discarded dose must be skipped.
    immunization("213", "2022-01-01", { status: "entered-in-error" }),
    {
      resource: {
        resourceType: "Observation",
        status: "final",
        code: { text: "SARS-CoV-2 Antibody" },
        valueCodeableConcept: { text: "Detected" },
        effectiveDateTime: "2021-06-01",
      },
    },
  ],
};

function makeJws(bundle: object): string {
  const payload = {
    iss: "https://example.org/issuer",
    nbf: 1610000000,
    vc: {
      type: ["https://smarthealth.cards#health-card"],
      credentialSubject: { fhirVersion: "4.0.1", fhirBundle: bundle },
    },
  };
  const header = Buffer.from(
    JSON.stringify({ zip: "DEF", alg: "ES256", kid: "x" })
  ).toString("base64url");
  const body = zlib
    .deflateRawSync(Buffer.from(JSON.stringify(payload)))
    .toString("base64url");
  return `${header}.${body}.c2ln`; // signature is not verified in Phase 1
}

// Encode a JWS as an shc:/ numeric QR payload.
function toShc(jws: string): string {
  let digits = "";
  for (const ch of jws)
    digits += String(ch.charCodeAt(0) - 45).padStart(2, "0");
  return `shc:/${digits}`;
}

describe("parseSmartHealthCard", () => {
  const jws = makeJws(BUNDLE);

  it("decodes a bare JWS into immunizations with catalog codes + dedup keys", () => {
    const r = parseSmartHealthCard(jws);
    expect(r.issuer).toBe("https://example.org/issuer");
    expect(r.immunizations.map((i) => i.code)).toEqual([
      "hepb", // 2010
      "covid", // 2021
      "influenza", // 2025 (sorted by date)
    ]);
    const covid = r.immunizations.find((i) => i.code === "covid")!;
    expect(covid.date).toBe("2021-03-01");
    expect(covid.dose_label).toBe("Dose 1");
    expect(covid.notes).toBe("Lot ABC123");
    expect(covid.external_id).toBe("smart-health-card:covid:2021-03-01");
  });

  it("skips entered-in-error immunizations", () => {
    const codes = parseSmartHealthCard(jws).immunizations.map((i) => i.code);
    // The entered-in-error covid dose (2022) must not appear; only the 2021 one.
    expect(codes.filter((c) => c === "covid")).toHaveLength(1);
  });

  it("maps lab Observations to records (qualitative value preserved)", () => {
    const recs = parseSmartHealthCard(jws).records;
    expect(recs).toHaveLength(1);
    expect(recs[0].category).toBe("lab");
    expect(recs[0].name).toBe("SARS-CoV-2 Antibody");
    expect(recs[0].value).toBe("Detected");
    expect(recs[0].date).toBe("2021-06-01");
  });

  it("accepts the .smart-health-card file form", () => {
    const file = JSON.stringify({ verifiableCredential: [jws] });
    expect(parseSmartHealthCard(file).immunizations.map((i) => i.code)).toEqual(
      ["hepb", "covid", "influenza"]
    );
  });

  it("accepts the shc:/ QR numeric form (round-trips to the same data)", () => {
    const shc = toShc(jws);
    expect(parseSmartHealthCard(shc).immunizations.map((i) => i.code)).toEqual([
      "hepb",
      "covid",
      "influenza",
    ]);
  });

  it("dedupes repeated resources within a card", () => {
    const dupBundle = {
      resourceType: "Bundle",
      entry: [
        immunization("08", "2010-06-15"),
        immunization("08", "2010-06-15"),
      ],
    };
    expect(parseSmartHealthCard(makeJws(dupBundle)).immunizations).toHaveLength(
      1
    );
  });

  it("throws a friendly error on malformed input", () => {
    expect(() => parseSmartHealthCard("")).toThrow(SmartHealthCardError);
    expect(() => parseSmartHealthCard("not-a-card")).toThrow(
      SmartHealthCardError
    );
    expect(() => parseSmartHealthCard("{bad json")).toThrow(
      SmartHealthCardError
    );
  });

  it("reads name / birthDate / gender from the Patient resource", () => {
    // The default bundle's Patient has only a family name → name carried, rest null.
    expect(parseSmartHealthCard(jws).demographics).toEqual({
      sex: null,
      birthdate: null,
      name: "Lopez",
    });
    const withDemo = makeJws({
      resourceType: "Bundle",
      entry: [
        {
          resource: {
            resourceType: "Patient",
            gender: "male",
            birthDate: "1990-07-22",
            name: [{ given: ["Sam"], family: "Lee" }],
          },
        },
        immunization("08", "2010-06-15"),
      ],
    });
    expect(parseSmartHealthCard(withDemo).demographics).toEqual({
      sex: "male",
      birthdate: "1990-07-22",
      name: "Sam Lee",
    });
  });

  it("decodeSmartHealthCard exposes the raw bundle + issuer", () => {
    const cards = decodeSmartHealthCard(jws);
    expect(cards).toHaveLength(1);
    expect(cards[0].bundle.resourceType).toBe("Bundle");
    expect(cards[0].issuer).toBe("https://example.org/issuer");
  });
});

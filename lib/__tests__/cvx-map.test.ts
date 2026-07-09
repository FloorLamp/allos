import { describe, expect, it } from "vitest";
import { codeFromVaccineCode, CVX_TO_CODE } from "@/lib/cvx-map";

const cvx = (code: string, display?: string) => ({
  coding: [{ system: "http://hl7.org/fhir/sid/cvx", code, display }],
});

describe("codeFromVaccineCode", () => {
  it("maps CVX codes to catalog codes", () => {
    expect(codeFromVaccineCode(cvx("08"))).toBe("hepb");
    expect(codeFromVaccineCode(cvx("115"))).toBe("tdap");
    expect(codeFromVaccineCode(cvx("03"))).toBe("mmr");
    expect(codeFromVaccineCode(cvx("187"))).toBe("zoster");
    expect(codeFromVaccineCode(cvx("213"))).toBe("covid");
  });

  it("maps combination CVX codes to the combo code", () => {
    expect(codeFromVaccineCode(cvx("146"))).toBe("vaxelis");
    expect(codeFromVaccineCode(cvx("110"))).toBe("pediarix");
    expect(codeFromVaccineCode(cvx("104"))).toBe("twinrix");
    expect(codeFromVaccineCode(cvx("94"))).toBe("proquad");
  });

  it("also matches the CVX OID system", () => {
    expect(
      codeFromVaccineCode({
        coding: [{ system: "urn:oid:2.16.840.1.113883.12.292", code: "08" }],
      })
    ).toBe("hepb");
  });

  it("falls back to display, then text, when the CVX code is unknown", () => {
    expect(codeFromVaccineCode(cvx("99999", "Boostrix"))).toBe("tdap");
    expect(codeFromVaccineCode({ text: "Vaxelis" })).toBe("vaxelis");
  });

  it("slugs an unrecognized name instead of dropping it, and null on empty", () => {
    expect(codeFromVaccineCode({ text: "Some Weird Shot" })).toBe(
      "some_weird_shot"
    );
    expect(codeFromVaccineCode(null)).toBeNull();
    expect(codeFromVaccineCode({})).toBeNull();
  });

  it("only maps to real catalog/combo codes", () => {
    const known = new Set([
      "hepb",
      "hepa",
      "twinrix",
      "dtap",
      "pediarix",
      "pentacel",
      "kinrix",
      "vaxelis",
      "tdap",
      "hib",
      "ipv",
      "pcv",
      "pneumo_adult",
      "mmr",
      "proquad",
      "varicella",
      "influenza",
      "covid",
      "zoster",
      "hpv",
      "menacwy",
      "menb",
      "rv",
      "rsv",
      "yellow_fever",
      "typhoid",
      "rabies",
      "bcg",
      "je",
      "cholera",
      "mpox",
    ]);
    for (const code of Object.values(CVX_TO_CODE))
      expect(known.has(code)).toBe(true);
  });
});

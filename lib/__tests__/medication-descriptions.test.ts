import { describe, it, expect } from "vitest";
import medsJson from "@/lib/medication-descriptions.json";
import { getMedicationInfo, normalizeMedName } from "@/lib/medication-info";

const meds = medsJson as {
  medications: Record<
    string,
    {
      generic: string;
      brand_names?: string[];
      drug_class?: string;
      description: string;
    }
  >;
  aliases: Record<string, string>;
};

describe("medication-descriptions integrity", () => {
  it("has entries with non-empty generic and description", () => {
    for (const [key, info] of Object.entries(meds.medications)) {
      expect(info.generic?.trim().length, `${key} generic`).toBeGreaterThan(0);
      expect(
        info.description?.trim().length,
        `${key} description`
      ).toBeGreaterThan(20);
      if (info.drug_class !== undefined) {
        expect(
          info.drug_class.trim().length,
          `${key} drug_class`
        ).toBeGreaterThan(0);
      }
    }
  });

  it("keys are already in normalized form (so lookups land)", () => {
    for (const key of Object.keys(meds.medications)) {
      expect(normalizeMedName(key), key).toBe(key);
    }
  });

  it("every alias target resolves to a real medication entry", () => {
    for (const [alias, target] of Object.entries(meds.aliases)) {
      expect(
        meds.medications[target],
        `alias ${alias} -> ${target}`
      ).toBeDefined();
    }
  });

  it("survives a JSON round-trip", () => {
    const round = JSON.parse(JSON.stringify(medsJson));
    expect(round).toEqual(medsJson);
  });
});

describe("getMedicationInfo", () => {
  it("resolves a brand name to its generic (Advil -> Ibuprofen)", () => {
    const info = getMedicationInfo("Advil");
    expect(info?.generic).toBe("Ibuprofen");
  });

  it("resolves a generic directly", () => {
    expect(getMedicationInfo("Budesonide")?.generic).toBe("Budesonide");
  });

  it("is case-insensitive", () => {
    expect(getMedicationInfo("ADVIL")?.generic).toBe("Ibuprofen");
    expect(getMedicationInfo("ibuprofen")?.generic).toBe("Ibuprofen");
  });

  it("strips a trailing strength/form before matching", () => {
    expect(getMedicationInfo("Lisinopril 10 mg")?.generic).toBe("Lisinopril");
    expect(getMedicationInfo("Advil 200 mg tablet")?.generic).toBe("Ibuprofen");
  });

  it("resolves common salt-form aliases", () => {
    expect(getMedicationInfo("Levothyroxine Sodium")?.generic).toBe(
      "Levothyroxine"
    );
    expect(getMedicationInfo("Metoprolol Succinate")?.generic).toBe(
      "Metoprolol"
    );
  });

  it("resolves alternate spellings and abbreviations", () => {
    expect(getMedicationInfo("Paracetamol")?.generic).toBe("Acetaminophen");
    expect(getMedicationInfo("HCTZ")?.generic).toBe("Hydrochlorothiazide");
  });

  it("returns null for unknown drugs and empty input", () => {
    expect(getMedicationInfo("Definitely Not A Drug")).toBeNull();
    expect(getMedicationInfo("")).toBeNull();
    expect(getMedicationInfo(null)).toBeNull();
    expect(getMedicationInfo(undefined)).toBeNull();
  });
});

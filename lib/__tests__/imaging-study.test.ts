import { describe, it, expect } from "vitest";
import {
  normalizeModality,
  normalizeLaterality,
  normalizeContrast,
  modalityLabel,
  lateralityLabel,
  studyDisplayLabel,
} from "../imaging-study";

// Pure coercion + label logic for structured imaging studies (#702). These map a
// report's raw strings onto the DB CHECK vocabularies so an import can never trip a
// constraint — the same coercion the Server Actions and the import path share.

describe("normalizeModality", () => {
  it("maps common modality phrasings", () => {
    expect(normalizeModality("MRI")).toBe("mri");
    expect(normalizeModality("Magnetic Resonance Imaging")).toBe("mri");
    expect(normalizeModality("CT")).toBe("ct");
    expect(normalizeModality("CAT scan")).toBe("ct");
    expect(normalizeModality("Computed Tomography")).toBe("ct");
    expect(normalizeModality("Ultrasound")).toBe("ultrasound");
    expect(normalizeModality("Sonogram")).toBe("ultrasound");
    expect(normalizeModality("Doppler")).toBe("ultrasound");
    expect(normalizeModality("DEXA")).toBe("dexa");
    expect(normalizeModality("DXA bone density")).toBe("dexa");
    expect(normalizeModality("Bone densitometry")).toBe("dexa");
  });

  it("maps X-ray family (radiograph, plain film, mammogram)", () => {
    expect(normalizeModality("X-ray")).toBe("x-ray");
    expect(normalizeModality("XRAY")).toBe("x-ray");
    expect(normalizeModality("Radiograph")).toBe("x-ray");
    expect(normalizeModality("Plain film")).toBe("x-ray");
    expect(normalizeModality("Mammogram")).toBe("x-ray");
    expect(normalizeModality("Screening mammography")).toBe("x-ray");
  });

  it("prefers MRI over CT when both letters could match", () => {
    // "MR angiogram" must not fall to CT via a stray 'ct' match.
    expect(normalizeModality("MR angiogram")).toBe("mri");
  });

  it("falls back to 'other' for unknown / absent", () => {
    expect(normalizeModality(null)).toBe("other");
    expect(normalizeModality("")).toBe("other");
    expect(normalizeModality("PET-CT-ish nuclear thing")).toBe("ct"); // CT wins on the word
    expect(normalizeModality("nuclear medicine")).toBe("other");
    expect(normalizeModality(42)).toBe("other");
  });
});

describe("normalizeLaterality", () => {
  it("maps sides and bilateral", () => {
    expect(normalizeLaterality("Left")).toBe("left");
    expect(normalizeLaterality("L")).toBe("left");
    expect(normalizeLaterality("Right knee")).toBe("right");
    expect(normalizeLaterality("Bilateral")).toBe("bilateral");
    expect(normalizeLaterality("both")).toBe("bilateral");
  });

  it("maps explicit not-applicable / midline to 'na'", () => {
    expect(normalizeLaterality("N/A")).toBe("na");
    expect(normalizeLaterality("not applicable")).toBe("na");
    expect(normalizeLaterality("midline")).toBe("na");
  });

  it("returns null for absent / unrecognized", () => {
    expect(normalizeLaterality(null)).toBeNull();
    expect(normalizeLaterality("")).toBeNull();
    expect(normalizeLaterality("oblique")).toBeNull();
  });
});

describe("normalizeContrast", () => {
  it("recognizes contrast-given phrasings", () => {
    expect(normalizeContrast("with contrast")).toBe(true);
    expect(normalizeContrast("contrast-enhanced")).toBe(true);
    expect(normalizeContrast("gadolinium")).toBe(true);
    expect(normalizeContrast(true)).toBe(true);
    expect(normalizeContrast(1)).toBe(true);
    expect(normalizeContrast("yes")).toBe(true);
  });

  it("recognizes non-contrast phrasings and defaults false", () => {
    expect(normalizeContrast("without contrast")).toBe(false);
    expect(normalizeContrast("non-contrast")).toBe(false);
    expect(normalizeContrast("no contrast")).toBe(false);
    expect(normalizeContrast(null)).toBe(false);
    expect(normalizeContrast("")).toBe(false);
    expect(normalizeContrast("unknown")).toBe(false);
  });
});

describe("labels", () => {
  it("labels every modality and laterality", () => {
    expect(modalityLabel("x-ray")).toBe("X-ray");
    expect(modalityLabel("ct")).toBe("CT");
    expect(modalityLabel("mri")).toBe("MRI");
    expect(modalityLabel("ultrasound")).toBe("Ultrasound");
    expect(modalityLabel("dexa")).toBe("DEXA");
    expect(modalityLabel("other")).toBe("Other");
    expect(lateralityLabel("left")).toBe("Left");
    expect(lateralityLabel("na")).toBe("N/A");
  });
});

describe("studyDisplayLabel", () => {
  const base = {
    modality: "mri" as const,
    body_region: null,
    laterality: null,
  };

  it("combines modality, a real side, and region", () => {
    expect(
      studyDisplayLabel({ ...base, body_region: "Knee", laterality: "left" })
    ).toBe("MRI Left Knee");
    expect(
      studyDisplayLabel({
        modality: "ct",
        body_region: "Chest",
        laterality: null,
      })
    ).toBe("CT Chest");
  });

  it("omits an 'na' laterality (a midline / whole study)", () => {
    expect(
      studyDisplayLabel({
        modality: "x-ray",
        body_region: "Chest",
        laterality: "na",
      })
    ).toBe("X-ray Chest");
  });

  it("falls back to the modality alone with no region", () => {
    expect(studyDisplayLabel(base)).toBe("MRI");
  });
});

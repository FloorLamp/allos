import { describe, it, expect } from "vitest";
import {
  normalizeModality,
  normalizeLaterality,
  normalizeContrast,
  modalityLabel,
  lateralityLabel,
  studyDisplayLabel,
  impressionDisplayText,
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

  it("maps PET phrasings, with PET winning over CT on a hybrid study (#1034)", () => {
    expect(normalizeModality("PET")).toBe("pet");
    expect(normalizeModality("PET/CT")).toBe("pet");
    expect(normalizeModality("PET-CT")).toBe("pet");
    expect(normalizeModality("FDG PET/CT whole body")).toBe("pet");
    expect(normalizeModality("Positron emission tomography")).toBe("pet");
  });

  it("maps nuclear-medicine phrasings, winning over CT/DEXA/x-ray branches (#1034)", () => {
    expect(normalizeModality("Nuclear medicine")).toBe("nuclear-medicine");
    expect(normalizeModality("SPECT")).toBe("nuclear-medicine");
    expect(normalizeModality("SPECT/CT")).toBe("nuclear-medicine");
    expect(normalizeModality("Scintigraphy")).toBe("nuclear-medicine");
    expect(normalizeModality("Myocardial perfusion study")).toBe(
      "nuclear-medicine"
    );
    expect(normalizeModality("Bone scan")).toBe("nuclear-medicine");
    expect(normalizeModality("HIDA scan")).toBe("nuclear-medicine");
    expect(normalizeModality("Thyroid uptake")).toBe("nuclear-medicine");
    expect(normalizeModality("V/Q scan")).toBe("nuclear-medicine");
  });

  it("maps fluoroscopy/angiography phrasings — but CTA/MRA ride their cross-sectional modality (#1034)", () => {
    expect(normalizeModality("Fluoroscopy")).toBe("fluoroscopy");
    expect(normalizeModality("fluoro")).toBe("fluoroscopy");
    expect(normalizeModality("Coronary angiography")).toBe("fluoroscopy");
    expect(normalizeModality("Angiogram")).toBe("fluoroscopy");
    expect(normalizeModality("Interventional radiology procedure")).toBe(
      "fluoroscopy"
    );
    expect(normalizeModality("Barium swallow x-ray")).toBe("fluoroscopy");
    expect(normalizeModality("VCUG")).toBe("fluoroscopy");
    // The dose mechanism rules the hybrids: CT angiography is a CT, MR
    // angiography is an MRI — only catheter/fluoro work lands here.
    expect(normalizeModality("CT angiography")).toBe("ct");
    expect(normalizeModality("MR angiogram")).toBe("mri");
  });

  it("falls back to 'other' for unknown / absent", () => {
    expect(normalizeModality(null)).toBe("other");
    expect(normalizeModality("")).toBe("other");
    // Formerly pinned to 'ct'/'other' — #1034 gave PET and nuclear medicine
    // their own branches, so these now classify instead of miscounting.
    expect(normalizeModality("PET-CT-ish nuclear thing")).toBe("pet");
    expect(normalizeModality("nuclear medicine")).toBe("nuclear-medicine");
    expect(normalizeModality(42)).toBe("other");
    expect(normalizeModality("elastography")).toBe("other");
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
    expect(modalityLabel("pet")).toBe("PET");
    expect(modalityLabel("nuclear-medicine")).toBe("Nuclear medicine");
    expect(modalityLabel("fluoroscopy")).toBe("Fluoroscopy");
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

  it("does not repeat laterality already present in the region", () => {
    expect(
      studyDisplayLabel({
        ...base,
        body_region: "Left Knee",
        laterality: "left",
      })
    ).toBe("MRI Left Knee");
    expect(
      studyDisplayLabel({
        modality: "x-ray",
        body_region: "bilateral hands",
        laterality: "bilateral",
      })
    ).toBe("X-ray bilateral hands");
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

describe("impressionDisplayText — the finding, not its heading (#3498 item 3)", () => {
  it("strips the leading section label the extract carried in", () => {
    // The exact row the phone review met: the label spent the whole clamped line
    // and the clinical payload was what got cut.
    expect(
      impressionDisplayText(
        "OVERALL IMPRESSION: Findings suggestive of a left breast lesion."
      )
    ).toBe("Findings suggestive of a left breast lesion.");
  });

  it("takes the shapes an extract actually writes", () => {
    for (const raw of [
      "IMPRESSION: No acute finding.",
      "Impression: No acute finding.",
      "impression - No acute finding.",
      "  OVERALL IMPRESSION:   No acute finding.",
      "IMPRESSION/CONCLUSION: No acute finding.",
    ])
      expect(impressionDisplayText(raw), raw).toBe("No acute finding.");
  });

  it("leaves a label that is not at the START alone", () => {
    // A second section inside a multi-section impression is CONTENT. Dropping it
    // would change what the report says, which is not a display decision.
    const two = "No acute finding. IMPRESSION: stable since prior.";
    expect(impressionDisplayText(two)).toBe(two);
  });

  it("never invents an empty subtitle", () => {
    expect(impressionDisplayText(null)).toBeNull();
    expect(impressionDisplayText("")).toBeNull();
    expect(impressionDisplayText("   ")).toBeNull();
    // A field that was ONLY the label says nothing.
    expect(impressionDisplayText("IMPRESSION:")).toBeNull();
  });

  it("stays QUIET on an ordinary impression", () => {
    // The guard that cried wolf on every normal row would be deleted in a week.
    const plain = "Mild degenerative change at L4-L5.";
    expect(impressionDisplayText(plain)).toBe(plain);
    // And on a word that merely CONTAINS the label.
    expect(impressionDisplayText("Impressions are unchanged.")).toBe(
      "Impressions are unchanged."
    );
  });

  it("does not touch what is stored — it is a display read", () => {
    const stored = "OVERALL IMPRESSION: Findings suggestive of a lesion.";
    impressionDisplayText(stored);
    expect(stored).toBe("OVERALL IMPRESSION: Findings suggestive of a lesion.");
  });
});

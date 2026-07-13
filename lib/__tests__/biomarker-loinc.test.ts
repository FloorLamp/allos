import { describe, expect, it } from "vitest";
import {
  LOINC_TO_CANONICAL,
  canonicalBiomarkerForLoinc,
  isVitalLoinc,
} from "@/lib/biomarker-loinc";
import { reconciledFlag, referenceRange } from "@/lib/reference-range";
import { convertToCanonical } from "@/lib/unit-conversions";
import type { CanonicalBiomarker } from "@/lib/types";
import canonical from "@/lib/canonical-biomarkers.json";
import {
  buildCanonicalIndex,
  snapCanonicalName,
  distinguishVitaminDIsoform,
} from "@/lib/canonical-name";
import { curateBiomarkers, CURATED_LABS } from "@/lib/curated-biomarkers";

// The committed JSON is the seed for CanonicalBiomarker rows; treat it as such
// (rows omit fields that are null in the DB, so a structural cast is fine here).
const rows = (canonical as { biomarkers: unknown[] })
  .biomarkers as CanonicalBiomarker[];
const byName = new Map<string, CanonicalBiomarker>(
  rows.map((b) => [b.name.toLowerCase(), b])
);
const cb = (name: string): CanonicalBiomarker => {
  const c = byName.get(name.toLowerCase());
  if (!c) throw new Error(`no canonical entry named "${name}"`);
  return c;
};

describe("canonicalBiomarkerForLoinc — CBC + CMP lab mappings", () => {
  it("maps the CBC indices to their canonical entries", () => {
    expect(canonicalBiomarkerForLoinc("718-7")).toBe("Hemoglobin");
    expect(canonicalBiomarkerForLoinc("789-8")).toBe("Red Blood Cell Count");
    expect(canonicalBiomarkerForLoinc("4544-3")).toBe("Hematocrit");
    expect(canonicalBiomarkerForLoinc("787-2")).toBe("MCV");
    expect(canonicalBiomarkerForLoinc("785-6")).toBe("MCH");
    expect(canonicalBiomarkerForLoinc("786-4")).toBe("MCHC");
    expect(canonicalBiomarkerForLoinc("788-0")).toBe("RDW");
    expect(canonicalBiomarkerForLoinc("777-3")).toBe("Platelet Count");
    expect(canonicalBiomarkerForLoinc("6690-2")).toBe("White Blood Cell Count");
    expect(canonicalBiomarkerForLoinc("776-5")).toBe("MPV");
  });

  it("maps common CMP analytes to their canonical entries", () => {
    expect(canonicalBiomarkerForLoinc("2345-7")).toBe("Glucose");
    expect(canonicalBiomarkerForLoinc("3094-0")).toBe("BUN");
    expect(canonicalBiomarkerForLoinc("2160-0")).toBe("Creatinine");
    expect(canonicalBiomarkerForLoinc("2951-2")).toBe("Sodium");
    expect(canonicalBiomarkerForLoinc("2823-3")).toBe("Potassium");
    expect(canonicalBiomarkerForLoinc("2075-0")).toBe("Chloride");
    expect(canonicalBiomarkerForLoinc("2028-9")).toBe("Carbon Dioxide");
    expect(canonicalBiomarkerForLoinc("17861-6")).toBe("Calcium");
    expect(canonicalBiomarkerForLoinc("1751-7")).toBe("Albumin");
    expect(canonicalBiomarkerForLoinc("2885-2")).toBe("Total Protein");
    expect(canonicalBiomarkerForLoinc("1975-2")).toBe("Total Bilirubin");
    expect(canonicalBiomarkerForLoinc("1742-6")).toBe("ALT");
    expect(canonicalBiomarkerForLoinc("1920-8")).toBe("AST");
    expect(canonicalBiomarkerForLoinc("6768-6")).toBe("Alkaline Phosphatase");
  });

  it("routes every eGFR LOINC variant to the single canonical eGFR entry", () => {
    for (const code of ["33914-3", "98979-8", "48642-3", "48643-1", "62238-1"])
      expect(canonicalBiomarkerForLoinc(code)).toBe("eGFR");
  });

  it("returns null for an unmapped code", () => {
    expect(canonicalBiomarkerForLoinc("99999-9")).toBeNull();
    expect(canonicalBiomarkerForLoinc(null)).toBeNull();
  });

  // The most dangerous failure mode: a LOINC pointing at a canonical NAME that no
  // longer exists in the dataset silently makes the mapping inert (no aggregation,
  // no range). Lock every mapped name to a real entry.
  it("every mapped canonical name exists in the canonical dataset", () => {
    for (const [loinc, name] of Object.entries(LOINC_TO_CANONICAL)) {
      expect(byName.has(name.toLowerCase()), `${loinc} -> "${name}"`).toBe(
        true
      );
    }
  });

  it("classifies the lab codes as non-vitals (FHIR path routes them to 'lab')", () => {
    for (const code of ["718-7", "6690-2", "2345-7", "751-8", "770-8"])
      expect(isVitalLoinc(code)).toBe(false);
  });
});

describe("CBC differential — the two report forms map to unit-matched entries", () => {
  // A differential analyte is reported as an absolute count (cells/uL) AND as a
  // percentage of leukocytes (%); the two are NOT interconvertible without the
  // WBC, so each LOINC form must land on the canonical entry carrying its unit —
  // never both onto one identity.
  const pairs: [string, string, string, string][] = [
    // absLoinc, absName(cells/uL), pctLoinc, pctName(%)
    ["751-8", "Neutrophils, Absolute", "770-8", "Neutrophils"],
    ["731-0", "Lymphocytes, Absolute", "736-9", "Lymphocytes"],
    ["742-7", "Monocytes", "5905-5", "Monocytes, Relative"],
    ["711-2", "Eosinophils", "713-8", "Eosinophils, Relative"],
    ["704-7", "Basophils", "706-2", "Basophils, Relative"],
  ];
  it.each(pairs)(
    "%s(abs)→%s / %s(%%)→%s with matching units",
    (absLoinc, absName, pctLoinc, pctName) => {
      expect(canonicalBiomarkerForLoinc(absLoinc)).toBe(absName);
      expect(canonicalBiomarkerForLoinc(pctLoinc)).toBe(pctName);
      expect(absName).not.toBe(pctName);
      expect(cb(absName).unit).toBe("cells/uL");
      expect(cb(pctName).unit).toBe("%");
    }
  );
});

describe("new canonical differential entries — range coverage", () => {
  it("absolute neutrophil/lymphocyte counts convert from K/uL and flag by range", () => {
    const anc = cb("Neutrophils, Absolute");
    // K/uL is 1000× cells/uL — a value reported in K/uL still converts.
    expect(convertToCanonical(2.98, "K/uL", anc)).toBeCloseTo(2980);
    // Adult in-range vs low.
    expect(
      reconciledFlag(null, 4000, "cells/uL", anc, null, 40)
    ).toBeUndefined();
    expect(reconciledFlag(null, 900, "cells/uL", anc, null, 40)).toBe("low");

    const alc = cb("Lymphocytes, Absolute");
    expect(convertToCanonical(3.93, "K/uL", alc)).toBeCloseTo(3930);
  });

  it("applies pediatric lymphocyte age bands so an infant's high ALC is normal", () => {
    const alc = cb("Lymphocytes, Absolute");
    // 7920 cells/uL: physiologic in an infant (band 1–4: 3000–9500) but above the
    // adult 4800 ceiling — proves the age band is consulted, not the adult range.
    expect(referenceRange(alc, null, 1).high).toBe(9500);
    expect(
      reconciledFlag(null, 7920, "cells/uL", alc, null, 1)
    ).toBeUndefined();
    expect(reconciledFlag(null, 7920, "cells/uL", alc, null, 40)).toBe("high");
  });

  it("relative (%) differentials flag against their adult bands", () => {
    expect(
      reconciledFlag(null, 6, "%", cb("Monocytes, Relative"), null, 40)
    ).toBeUndefined();
    expect(
      reconciledFlag(null, 15, "%", cb("Monocytes, Relative"), null, 40)
    ).toBe("high");
    expect(
      reconciledFlag(null, 0.8, "%", cb("Eosinophils, Relative"), null, 40)
    ).toBeUndefined();
    expect(
      reconciledFlag(null, 9, "%", cb("Eosinophils, Relative"), null, 40)
    ).toBe("high");
    expect(
      reconciledFlag(null, 5, "%", cb("Basophils, Relative"), null, 40)
    ).toBe("high");
  });
});

describe("full clinical-lab panel mappings", () => {
  it("maps the lipid panel (calc + direct LDL both route to LDL Cholesterol)", () => {
    expect(canonicalBiomarkerForLoinc("2093-3")).toBe("Total Cholesterol");
    expect(canonicalBiomarkerForLoinc("2085-9")).toBe("HDL Cholesterol");
    expect(canonicalBiomarkerForLoinc("13457-7")).toBe("LDL Cholesterol"); // calc
    expect(canonicalBiomarkerForLoinc("18262-6")).toBe("LDL Cholesterol"); // direct
    expect(canonicalBiomarkerForLoinc("2571-8")).toBe("Triglycerides");
    expect(canonicalBiomarkerForLoinc("9830-1")).toBe("Cholesterol/HDL Ratio");
    expect(canonicalBiomarkerForLoinc("1884-6")).toBe("ApoB");
  });

  it("maps diabetes, thyroid, iron, vitamin, hormone and metabolic analytes", () => {
    expect(canonicalBiomarkerForLoinc("4548-4")).toBe("Hemoglobin A1c");
    expect(canonicalBiomarkerForLoinc("20448-7")).toBe("Insulin");
    expect(canonicalBiomarkerForLoinc("3016-3")).toBe("TSH");
    expect(canonicalBiomarkerForLoinc("3024-7")).toBe("Free T4");
    expect(canonicalBiomarkerForLoinc("2276-4")).toBe("Ferritin");
    expect(canonicalBiomarkerForLoinc("2502-3")).toBe("Transferrin Saturation");
    expect(canonicalBiomarkerForLoinc("62292-8")).toBe("Vitamin D, 25-Hydroxy");
    expect(canonicalBiomarkerForLoinc("2132-9")).toBe("Vitamin B12");
    expect(canonicalBiomarkerForLoinc("2986-8")).toBe("Testosterone, Total");
    expect(canonicalBiomarkerForLoinc("13967-5")).toBe(
      "Sex Hormone Binding Globulin (SHBG)"
    );
    expect(canonicalBiomarkerForLoinc("13965-9")).toBe("Homocysteine");
  });

  it("maps the newly-added canonical entries (Total T4/T3, ESR, LDH, CK, retics)", () => {
    expect(canonicalBiomarkerForLoinc("3026-2")).toBe("Total T4");
    expect(canonicalBiomarkerForLoinc("3053-6")).toBe("Total T3");
    expect(canonicalBiomarkerForLoinc("4537-7")).toBe(
      "Erythrocyte Sedimentation Rate (ESR)"
    );
    expect(canonicalBiomarkerForLoinc("1968-7")).toBe("Direct Bilirubin");
    expect(canonicalBiomarkerForLoinc("2532-0")).toBe(
      "Lactate Dehydrogenase (LDH)"
    );
    expect(canonicalBiomarkerForLoinc("2157-6")).toBe("Creatine Kinase (CK)");
    expect(canonicalBiomarkerForLoinc("33037-3")).toBe("Anion Gap");
    expect(canonicalBiomarkerForLoinc("17849-1")).toBe("Reticulocytes");
    expect(canonicalBiomarkerForLoinc("60474-4")).toBe(
      "Reticulocytes, Absolute"
    );
  });

  // Alternate CBC LOINCs + blood lead observed in real Epic exports (the three
  // patient XDM packages). Each routes to an EXISTING canonical entry whose unit
  // matches the observed unit — no new canonical entry, no rescale.
  it("maps alternate platelet/MPV LOINCs and blood lead to unit-matched entries", () => {
    expect(canonicalBiomarkerForLoinc("26515-7")).toBe("Platelet Count");
    expect(cb("Platelet Count").unit).toBe("10^3/uL");
    expect(canonicalBiomarkerForLoinc("28542-9")).toBe("MPV");
    expect(canonicalBiomarkerForLoinc("32623-1")).toBe("MPV");
    expect(cb("MPV").unit).toBe("fL");
    expect(canonicalBiomarkerForLoinc("77307-7")).toBe("Lead");
    expect(cb("Lead").unit).toBe("ug/dL");
  });

  // These six candidate codes were WRONG (bad check digit or a different analyte
  // entirely — 2285-5 is Follitropin in Semen, 25130-6 a urine ratio); a wrong
  // code silently false-flags patient data. Pin the CORRECTED codes and assert the
  // discredited ones are NOT mapped.
  it("uses the verified-correct codes, not the discredited look-alikes", () => {
    expect(canonicalBiomarkerForLoinc("8099-4")).toBe(
      "Thyroid Peroxidase Antibodies (TPOAb)"
    );
    expect(canonicalBiomarkerForLoinc("8098-6")).toBe(
      "Thyroglobulin Antibodies (TgAb)"
    );
    expect(canonicalBiomarkerForLoinc("2283-0")).toBe("Folate, RBC");
    expect(canonicalBiomarkerForLoinc("13964-2")).toBe(
      "Methylmalonic Acid (MMA)"
    );
    expect(canonicalBiomarkerForLoinc("12841-3")).toBe(
      "Prostate Specific Antigen (PSA), Free %"
    );
    for (const wrong of ["8099-8", "8098-0", "2285-5", "25130-6", "60474-8"])
      expect(canonicalBiomarkerForLoinc(wrong)).toBeNull();
  });

  it("maps total PSA to the actual 'PSA' entry and free% to the ratio entry", () => {
    // The total-PSA canonical entry is named "PSA"; free% is a separate % entry.
    expect(canonicalBiomarkerForLoinc("2857-1")).toBe("PSA");
    expect(cb("PSA").unit).toBe("ng/mL");
    expect(cb("Prostate Specific Antigen (PSA), Free %").unit).toBe("%");
  });

  it("unit-matches molar/mass forms to the canonical unit", () => {
    // Lp(a) canonical is molar (nmol/L) → only the molar LOINC is mapped.
    expect(canonicalBiomarkerForLoinc("43583-4")).toBe("Lipoprotein(a)");
    expect(cb("Lipoprotein(a)").unit).toBe("nmol/L");
    expect(canonicalBiomarkerForLoinc("10835-7")).toBeNull(); // mass form unmapped
    // Magnesium canonical is mass (mg/dL) → the mass LOINC, not the molar one.
    expect(canonicalBiomarkerForLoinc("19123-9")).toBe("Magnesium");
    expect(cb("Magnesium").unit).toBe("mg/dL");
    expect(canonicalBiomarkerForLoinc("2601-3")).toBeNull(); // molar form unmapped
  });

  it("does not map whole-blood glucose (Finding 3)", () => {
    expect(canonicalBiomarkerForLoinc("2345-7")).toBe("Glucose"); // serum/plasma
    expect(canonicalBiomarkerForLoinc("2339-0")).toBeNull(); // whole blood: unmapped
  });
});

describe("sex-specific new-entry flag behavior", () => {
  it("CK flags a 250 U/L result high for a female but in-range for a male", () => {
    const ck = cb("Creatine Kinase (CK)");
    expect(reconciledFlag(null, 250, "U/L", ck, "female", 30)).toBe("high");
    expect(reconciledFlag(null, 250, "U/L", ck, "male", 30)).toBeUndefined();
    // Sex-unknown falls back to the broad generic range (26–308) → in-range.
    expect(reconciledFlag(null, 250, "U/L", ck, null, 30)).toBeUndefined();
  });

  it("ESR flags a 25 mm/h result high for a male but in-range for a female", () => {
    const esr = cb("Erythrocyte Sedimentation Rate (ESR)");
    expect(reconciledFlag(null, 25, "mm/h", esr, "male", 30)).toBe("high");
    expect(reconciledFlag(null, 25, "mm/h", esr, "female", 30)).toBeUndefined();
  });

  it("absolute reticulocytes convert across count scales and flag by range", () => {
    const retic = cb("Reticulocytes, Absolute");
    // 10*9/L is numerically identical to the canonical 10^3/uL.
    expect(convertToCanonical(45, "10*9/L", retic)).toBeCloseTo(45);
    expect(reconciledFlag(null, 120, "10^3/uL", retic, null, 40)).toBe("high");
  });
});

describe("reproductive hormones — sex & life-stage ranges", () => {
  // Exercises the actual committed Estradiol / FSH / LH entries through the same
  // sex × age composition the boot-time reconcile uses (age = the subject's age on
  // the collection date). The bug these fix: a flat single range false-flagged
  // normal physiology (mid-cycle estradiol, post-menopausal FSH/LH).
  const e2 = () => cb("Estradiol");
  const fsh = () => cb("Follicle Stimulating Hormone (FSH)");
  const lh = () => cb("Luteinizing Hormone (LH)");

  it("estradiol: a normal premenopausal mid-cycle value does NOT flag high", () => {
    // ~150–250 pg/mL mid-cycle is normal female physiology; against the old male-ish
    // ~39 ceiling it read 'high'. Now in-range for a reproductive-age woman.
    expect(
      reconciledFlag(null, 200, "pg/mL", e2(), "female", 30)
    ).toBeUndefined();
    expect(
      reconciledFlag(null, 250, "pg/mL", e2(), "female", 30)
    ).toBeUndefined();
  });

  it("estradiol: an abnormally high value DOES flag (both sexes)", () => {
    expect(reconciledFlag(null, 800, "pg/mL", e2(), "female", 30)).toBe("high");
    // 60 pg/mL is above the male ceiling (40) → high for a man.
    expect(reconciledFlag(null, 60, "pg/mL", e2(), "male", 40)).toBe("high");
  });

  it("estradiol: a normal male value is in-range against the male range", () => {
    expect(reconciledFlag(null, 25, "pg/mL", e2(), "male", 40)).toBeUndefined();
  });

  it("estradiol: introduces no false 'low' (open female/generic low bound)", () => {
    // Early-follicular / post-menopausal lows are normal — never flag low.
    expect(
      reconciledFlag(null, 8, "pg/mL", e2(), "female", 30)
    ).toBeUndefined();
    expect(
      reconciledFlag(null, 5, "pg/mL", e2(), "female", 65)
    ).toBeUndefined();
    // …and it does NOT leave a value in the amber "non-optimal" band (the old
    // male-ish 30–35 optimal band was removed), so a normal 200 clears cleanly.
    expect(
      reconciledFlag(null, 200, "pg/mL", e2(), "female", 30)
    ).toBeUndefined();
  });

  it("FSH: reproductive-age vs post-menopausal via the 51+ age band", () => {
    // Mid-cycle FSH ~15 mIU/mL is normal in a cycling woman (repro ceiling 21).
    expect(
      reconciledFlag(null, 15, "mIU/mL", fsh(), "female", 30)
    ).toBeUndefined();
    // The SAME 90 mIU/mL: 'high' for a 30-yr-old, but normal post-menopausal (band
    // ceiling 135) — no misflag once the subject is 51+.
    expect(reconciledFlag(null, 90, "mIU/mL", fsh(), "female", 30)).toBe(
      "high"
    );
    expect(
      reconciledFlag(null, 90, "mIU/mL", fsh(), "female", 60)
    ).toBeUndefined();
    // The age band is what's consulted, not the adult range.
    expect(referenceRange(fsh(), "female", 60)).toEqual({
      low: 1,
      high: 135,
      bySex: true,
      band: { min_age: 51, max_age: null },
    });
    // The 51+ band's MALE override composes too: a 60-yr-old man resolves to the
    // band's male range (1–20), not the female 135 or the adult male 12.5.
    expect(referenceRange(fsh(), "male", 60)).toEqual({
      low: 1,
      high: 20,
      bySex: true,
      band: { min_age: 51, max_age: null },
    });
    // So an FSH of 18 is in-range for a 60-yr-old man, while 20 exceeds it.
    expect(
      reconciledFlag(null, 18, "mIU/mL", fsh(), "male", 60)
    ).toBeUndefined();
    expect(reconciledFlag(null, 22, "mIU/mL", fsh(), "male", 60)).toBe("high");
  });

  it("FSH: flags against the male range", () => {
    expect(reconciledFlag(null, 20, "mIU/mL", fsh(), "male", 30)).toBe("high");
    expect(
      reconciledFlag(null, 8, "mIU/mL", fsh(), "male", 30)
    ).toBeUndefined();
  });

  it("LH: the broad reproductive envelope spans the ovulatory surge and covers post-menopausal", () => {
    // An ovulatory LH surge (~60) is normal — the old 9.3 ceiling false-flagged it.
    expect(
      reconciledFlag(null, 60, "mIU/mL", lh(), "female", 30)
    ).toBeUndefined();
    // Post-menopausal LH (~40) sits inside the reproductive envelope → no band, no
    // misflag.
    expect(
      reconciledFlag(null, 40, "mIU/mL", lh(), "female", 60)
    ).toBeUndefined();
    // Genuinely extreme value still flags.
    expect(reconciledFlag(null, 120, "mIU/mL", lh(), "female", 30)).toBe(
      "high"
    );
  });

  it("LH: flags against the male range", () => {
    expect(reconciledFlag(null, 20, "mIU/mL", lh(), "male", 30)).toBe("high");
    expect(reconciledFlag(null, 6, "mIU/mL", lh(), "male", 30)).toBeUndefined();
  });

  it("all three carry no optimal band (no false amber 'non-optimal')", () => {
    for (const c of [e2(), fsh(), lh()]) {
      expect(c.optimal_low ?? null).toBeNull();
      expect(c.optimal_high ?? null).toBeNull();
    }
  });
});

describe("reproductive hormones — reproductive-status ranges", () => {
  // Exercises the ACTUAL committed Estradiol / FSH / LH entries through the real
  // reconciledFlag/referenceRange path (sex + age + reproductive status), the same
  // composition the boot-time and request-time reconciles use. The gap this closes
  //: a post-menopausal HIGH estradiol wasn't flagged because the
  // reproductive-age ceiling of 400 was kept to avoid false-flagging women still
  // cycling at 51+.
  const e2 = () => cb("Estradiol");
  const fsh = () => cb("Follicle Stimulating Hormone (FSH)");
  const lh = () => cb("Luteinizing Hormone (LH)");

  it("estradiol: a postmenopausal female flags a high E2 (200) that unset/premenopausal does NOT", () => {
    // The headline case. Postmenopausal E2 ceiling is ~30, so 200 pg/mL is high.
    expect(
      reconciledFlag(null, 200, "pg/mL", e2(), "female", 55, "postmenopausal")
    ).toBe("high");
    // Reproductive-age (premenopausal, or unset) does NOT flag 200 — mid-cycle
    // physiology sits inside the ≤400 envelope. This is the false-flag we avoid.
    expect(
      reconciledFlag(null, 200, "pg/mL", e2(), "female", 55, "premenopausal")
    ).toBeUndefined();
    expect(
      reconciledFlag(null, 200, "pg/mL", e2(), "female", 30, null)
    ).toBeUndefined();
    // And a genuinely low postmenopausal E2 (open low bound) is never false-low.
    expect(
      reconciledFlag(null, 8, "pg/mL", e2(), "female", 55, "postmenopausal")
    ).toBeUndefined();
  });

  it("FSH: resolves to the status range when set, else the age band / reproductive range", () => {
    // Postmenopausal range null–134.8 (open low): a set status leaves 30 in-range,
    // while unset at 40 (no age band, repro ceiling 21) would flag 30 high — proving
    // the status range is consulted.
    expect(
      reconciledFlag(null, 30, "mIU/mL", fsh(), "female", 40, "postmenopausal")
    ).toBeUndefined();
    expect(reconciledFlag(null, 30, "mIU/mL", fsh(), "female", 40, null)).toBe(
      "high"
    );
    // Precedence: status > age band. A 60-yr-old with premenopausal status uses the
    // reproductive ceiling 21 (flags 30 high), NOT the 51+ band ceiling 135.
    expect(
      reconciledFlag(null, 30, "mIU/mL", fsh(), "female", 60, "premenopausal")
    ).toBe("high");
    expect(
      reconciledFlag(null, 30, "mIU/mL", fsh(), "female", 60, null)
    ).toBeUndefined(); // age-band 1–135 when status unset
    // A genuinely high FSH still flags even postmenopausally (above 134.8) — but a
    // HIGH post-menopausal FSH is itself normal physiology, so the ceiling is broad.
    expect(
      reconciledFlag(null, 200, "mIU/mL", fsh(), "female", 55, "postmenopausal")
    ).toBe("high");
    // Open low bound: a postmenopausal HRT-suppressed FSH (~5) is NOT false-flagged
    // 'low' — the closed 25.8 low would have wrongly flagged it (the fix).
    expect(
      reconciledFlag(null, 5, "mIU/mL", fsh(), "female", 55, "postmenopausal")
    ).toBeUndefined();
  });

  it("LH: resolves to the postmenopausal status range when set (open low)", () => {
    // Postmenopausal LH null–58.5: 70 is high against it, but the reproductive
    // envelope (≤100) leaves 70 in-range when the status is unset.
    expect(
      reconciledFlag(null, 70, "mIU/mL", lh(), "female", 55, "postmenopausal")
    ).toBe("high");
    expect(
      reconciledFlag(null, 70, "mIU/mL", lh(), "female", 55, null)
    ).toBeUndefined();
    // Open low bound: a postmenopausal HRT-suppressed LH (~3) is NOT false-flagged
    // 'low' (the 7.7 closed low would have wrongly flagged it — the fix).
    expect(
      reconciledFlag(null, 3, "mIU/mL", lh(), "female", 55, "postmenopausal")
    ).toBeUndefined();
  });

  it("male profiles are unaffected by a reproductive status", () => {
    // The status is female-only, so a (nonsensical) status on a male must not change
    // his ranges: a normal male E2 (25) stays in-range; a high one (60) still flags.
    for (const s of ["premenopausal", "postmenopausal", null] as const) {
      expect(reconciledFlag(null, 25, "pg/mL", e2(), "male", 40, s)).toBe(
        reconciledFlag(null, 25, "pg/mL", e2(), "male", 40)
      );
      expect(reconciledFlag(null, 60, "pg/mL", e2(), "male", 40, s)).toBe(
        "high"
      );
      // FSH male range (adult 1–12.5) unchanged by a status.
      expect(reconciledFlag(null, 20, "mIU/mL", fsh(), "male", 30, s)).toBe(
        "high"
      );
    }
  });

  it("the committed entries actually carry ranges_by_status", () => {
    for (const c of [e2(), fsh(), lh()]) {
      expect(c.ranges_by_status).toBeTruthy();
      expect(c.ranges_by_status?.premenopausal).toBeTruthy();
      expect(c.ranges_by_status?.postmenopausal).toBeTruthy();
    }
  });
});

describe("generator ⇄ committed JSON drift guard", () => {
  // The committed JSON must be a FIXED POINT of the --curated-only transform, so a
  // future edit to CURATED_LABS/AGE_BANDS that isn't regenerated can't silently
  // desync the shipped dataset from the generator's source of truth.
  it("committed dataset equals re-running curateBiomarkers over it", () => {
    const before = JSON.parse(JSON.stringify(rows));
    const after = curateBiomarkers(JSON.parse(JSON.stringify(rows)));
    expect(after).toEqual(before);
  });

  it("every CURATED_LABS entry is present in the committed dataset", () => {
    for (const lab of CURATED_LABS)
      expect(byName.has(lab.name.toLowerCase()), lab.name).toBe(true);
  });
});

describe("end-to-end import routing through snapCanonicalName", () => {
  // The real import path (lib/health-record-doc) does:
  //   r.canonical = snapCanonicalName(canonicalBiomarkerForLoinc(loinc) ?? name,
  //                                   buildCanonicalIndex(vocabulary))
  // where the vocabulary is every canonical name (DB-seeded from this JSON).
  // Earlier tests looked entries up by name directly (cb(name)), which BYPASSES
  // snapCanonicalName and so couldn't catch the "%"-key collision. This exercises
  // the real routing.
  const vocabulary = rows.map((b) => b.name);
  const index = buildCanonicalIndex(vocabulary);
  const route = (loinc: string, printedName: string): string =>
    snapCanonicalName(
      distinguishVitaminDIsoform(
        canonicalBiomarkerForLoinc(loinc) ?? printedName,
        printedName
      ),
      index
    );

  it("routes a %-differential to its Relative entry, NOT the absolute entry", () => {
    // 5905-5 is monocytes/100 leukocytes; the printed portal name is "Monocytes".
    // Pre-fix this snapped to the absolute "Monocytes" (cells/uL) and the % never
    // flagged; it must now resolve to "Monocytes, Relative".
    expect(route("5905-5", "Monocytes")).toBe("Monocytes, Relative");
    expect(route("713-8", "Eosinophils")).toBe("Eosinophils, Relative");
    expect(route("706-2", "Basophils")).toBe("Basophils, Relative");
    // And the absolute-count LOINCs still route to the base (cells/uL) entries.
    expect(route("742-7", "Monocytes")).toBe("Monocytes");
    expect(route("704-7", "Basophils")).toBe("Basophils");
  });

  it("flags a monocytosis via the routed entry (6% in-range, 15% high)", () => {
    const routed = route("5905-5", "Monocytes");
    expect(cb(routed).unit).toBe("%");
    expect(reconciledFlag(null, 6, "%", cb(routed), null, 40)).toBeUndefined();
    expect(reconciledFlag(null, 15, "%", cb(routed), null, 40)).toBe("high");
  });

  it("routes a lipid and a corrected-code analyte end-to-end", () => {
    expect(route("13457-7", "LDL Cholesterol Calc")).toBe("LDL Cholesterol");
    expect(route("2283-0", "RBC Folate")).toBe("Folate, RBC");
  });
});

import { describe, expect, it } from "vitest";
import {
  crossCheckOtotoxic,
  ototoxicForCandidate,
  ototoxicTitle,
  ototoxicDetail,
  ototoxicSignalKey,
  type OtotoxicMedInput,
} from "@/lib/ototoxic";

// Pure ototoxic-medication cross-check (issue #717) — the hearing twin of the dental /
// contrast / PGx cross-checks. Given a profile's active meds, it returns a calm, cited,
// NEVER-prescriptive note per ototoxic-drug-class match. Matching is via the shared
// RxCUI-ingredient + synonym machinery (#482); no DB, no network.

const med = (
  id: number,
  name: string,
  rxcui: string | null = null,
  rxcuiIngredients: string[] | null = null
): OtotoxicMedInput => ({ id, name, rxcui, rxcuiIngredients });

describe("crossCheckOtotoxic", () => {
  it("flags an active aminoglycoside by name (the #717 headline case)", () => {
    const hits = crossCheckOtotoxic([med(10, "Gentamicin")]);
    expect(hits).toHaveLength(1);
    expect(hits[0].entryKey).toBe("aminoglycoside");
    expect(hits[0].category).toBe("aminoglycoside");
    expect(hits[0].medId).toBe(10);
    expect(hits[0].dedupeKey).toBe(ototoxicSignalKey(10, "aminoglycoside"));
    // Informational, cited, never prescriptive.
    const detail = ototoxicDetail(hits[0]);
    expect(detail).toMatch(/inner ear|hearing/i);
    expect(detail).toMatch(/discuss/i);
    expect(detail).not.toMatch(/\bstop\b/i);
    expect(detail).toMatch(/Source:/);
    expect(ototoxicTitle(hits[0])).toBe("Ototoxic medication — Gentamicin");
  });

  it("matches a brand name (Lasix → loop diuretic) and cisplatin (platinum chemo)", () => {
    expect(crossCheckOtotoxic([med(1, "Lasix")])[0].entryKey).toBe(
      "loop_diuretic"
    );
    expect(crossCheckOtotoxic([med(2, "Cisplatin")])[0].entryKey).toBe(
      "platinum_chemo"
    );
    expect(crossCheckOtotoxic([med(3, "Vancomycin")])[0].entryKey).toBe(
      "vancomycin"
    );
  });

  it("returns nothing for a non-ototoxic medication (absence is not clearance)", () => {
    expect(crossCheckOtotoxic([med(1, "Lisinopril")])).toEqual([]);
    expect(crossCheckOtotoxic([])).toEqual([]);
  });

  it("keys the dedupeKey on the item id + entry so a rename doesn't drift (#203)", () => {
    const a = crossCheckOtotoxic([med(7, "Tobramycin")])[0];
    const b = crossCheckOtotoxic([med(7, "Renamed but same row")])[0];
    // Same id → same dedupeKey even though the name changed; only the aminoglycoside
    // one carries the entry match, so `b` (unrecognized) produces nothing.
    expect(a.dedupeKey).toBe("ototoxic:7:aminoglycoside");
    expect(b).toBeUndefined();
  });

  it("is deterministically ordered by med name then entry key", () => {
    const hits = crossCheckOtotoxic([med(1, "Vancomycin"), med(2, "Amikacin")]);
    expect(hits.map((h) => h.medName)).toEqual(["Amikacin", "Vancomycin"]);
  });

  it("ototoxicForCandidate reuses the one cross-check (id 0)", () => {
    const hits = ototoxicForCandidate({ name: "Furosemide", rxcui: null });
    expect(hits).toHaveLength(1);
    expect(hits[0].medId).toBe(0);
    expect(hits[0].entryKey).toBe("loop_diuretic");
    expect(ototoxicForCandidate({ name: "  ", rxcui: null })).toEqual([]);
  });
});

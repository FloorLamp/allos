import { describe, expect, it } from "vitest";
import {
  COMMON_MEDICATIONS,
  curatedMedicationOptions,
  rankedMedicationBrandOptions,
  rankedMedicationOptions,
} from "../medication-rank";
import {
  GENERIC_BRAND_OPTION,
  medicationBrandNames,
  medicationCatalogOptions,
  catalogLabelGeneric,
} from "../medication-info";
import { medEntryForName } from "../datasets/medication-descriptions";

// The Combobox shows 8 rows and an empty query keeps source order, so these first
// eight entries ARE the medication picker (#1677).
const PICKER_ROWS = 8;

function head(options: string[]): string[] {
  return options.slice(0, PICKER_ROWS);
}

function labelOf(generic: string): string {
  const label = curatedMedicationOptions().find(
    (o) => catalogLabelGeneric(o).toLowerCase() === generic.toLowerCase()
  );
  if (!label) throw new Error(`no catalog label for ${generic}`);
  return label;
}

describe("the curated medication head", () => {
  it("names only medications the curated description set actually knows", () => {
    // A catalog rename must never leave a dangling head entry pointing at nothing.
    for (const generic of COMMON_MEDICATIONS) {
      expect(medEntryForName(generic)?.generic).toBe(generic);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(COMMON_MEDICATIONS).size).toBe(COMMON_MEDICATIONS.length);
  });

  it("changes ORDER only — membership matches the flat catalog exactly", () => {
    expect(new Set(curatedMedicationOptions())).toEqual(
      new Set(medicationCatalogOptions())
    );
    expect(curatedMedicationOptions()).toHaveLength(
      medicationCatalogOptions().length
    );
  });

  it("replaces the alphabet's accidents with drugs people take", () => {
    // The flat list's visible eight is whatever sorts first: Adalimumab (a biologic),
    // Alendronate, Allopurinol, Alprazolam, Amitriptyline — there only by spelling,
    // and none of them the household analgesic the same set contains.
    expect(head(medicationCatalogOptions()).join("|")).toMatch(/Adalimumab/);
    expect(head(medicationCatalogOptions()).join("|")).not.toMatch(/Ibuprofen/);

    expect(head(curatedMedicationOptions())[0]).toMatch(/^Acetaminophen/);
    expect(head(curatedMedicationOptions()).join("|")).toMatch(/Ibuprofen/);
    expect(head(curatedMedicationOptions()).join("|")).not.toMatch(
      /Adalimumab/
    );
  });

  it("keeps the non-head catalog alphabetical behind it", () => {
    const tail = curatedMedicationOptions().slice(COMMON_MEDICATIONS.length);
    expect(tail).toEqual([...tail].sort((a, b) => a.localeCompare(b)));
  });
});

describe("rankedMedicationOptions", () => {
  it("is the curated order byte for byte for a profile with no ledger", () => {
    expect(rankedMedicationOptions([])).toEqual(curatedMedicationOptions());
  });

  it("floats the profile's own medications ahead of the curated head", () => {
    // A profile on metformin sees metformin first — even though the curated head opens
    // on the OTC shelf.
    const ranked = rankedMedicationOptions([
      { name: "Metformin", current: true },
    ]);
    expect(ranked[0]).toBe(labelOf("Metformin"));
    expect(ranked[1]).toBe(curatedMedicationOptions()[0]);
  });

  it("ranks a CURRENT medication above a past one (usage buckets)", () => {
    const ranked = rankedMedicationOptions([
      { name: "Warfarin", current: false },
      { name: "Metformin", current: true },
    ]);
    expect(head(ranked).slice(0, 2)).toEqual([
      labelOf("Metformin"),
      labelOf("Warfarin"),
    ]);
  });

  it("does not let duplicate ledger rows outrank a different current med", () => {
    // Three past rows for the same import-split course must not beat one live med.
    const ranked = rankedMedicationOptions([
      { name: "Warfarin", current: false },
      { name: "Warfarin", current: false },
      { name: "Warfarin", current: false },
      { name: "Metformin", current: true },
    ]);
    expect(ranked[0]).toBe(labelOf("Metformin"));
    expect(ranked[1]).toBe(labelOf("Warfarin"));
  });

  it("resolves a stored BRAND name onto its generic's one catalog option", () => {
    // The ledger says "Tylenol"; the picker's option is the collapsed
    // "Acetaminophen (Tylenol, …)" entry, and it must be floated once, not twice.
    const ranked = rankedMedicationOptions([
      { name: "Tylenol", current: true },
    ]);
    expect(ranked[0]).toBe(labelOf("Acetaminophen"));
    expect(ranked).toHaveLength(curatedMedicationOptions().length);
  });

  it("floats a profile's OWN free-text medication, keeping every catalog entry", () => {
    const ranked = rankedMedicationOptions([
      { name: "Compounded LDN", current: true },
    ]);
    expect(ranked[0]).toBe("Compounded LDN");
    expect(ranked).toHaveLength(curatedMedicationOptions().length + 1);
  });

  it("ignores blank ledger names", () => {
    expect(rankedMedicationOptions([{ name: "   ", current: true }])).toEqual(
      curatedMedicationOptions()
    );
  });
});

describe("rankedMedicationBrandOptions", () => {
  it("passes the post-pick narrowing through unchanged", () => {
    // Once a medication is picked its own brands already lead; "Generic" keeps its
    // #851-item-3 place and nothing else is offered.
    expect(
      rankedMedicationBrandOptions(["Advil"], ["Advil", "Motrin"])
    ).toEqual([GENERIC_BRAND_OPTION, "Advil", "Motrin"]);
  });

  it("leads the PRE-PICK list with the profile's own brands", () => {
    const ranked = rankedMedicationBrandOptions(["Motrin", "Tylenol"]);
    expect(head(ranked).slice(0, 3)).toEqual([
      GENERIC_BRAND_OPTION,
      "Motrin",
      "Tylenol",
    ]);
    // Membership is unchanged: the whole catalog is still behind them.
    expect(new Set(ranked)).toEqual(
      new Set([GENERIC_BRAND_OPTION, ...medicationBrandNames()])
    );
  });

  it("is the plain catalog list when the profile has recorded no brand", () => {
    expect(rankedMedicationBrandOptions([])).toEqual([
      GENERIC_BRAND_OPTION,
      ...medicationBrandNames(),
    ]);
  });

  it("de-duplicates a used brand against the catalog, case-insensitively", () => {
    const ranked = rankedMedicationBrandOptions(["advil", "ADVIL"]);
    expect(ranked[1]).toBe("Advil"); // the catalog's casing wins
    expect(ranked.filter((b) => b.toLowerCase() === "advil")).toHaveLength(1);
  });

  it("keeps a store-brand 'Generic' entry from being offered twice", () => {
    const ranked = rankedMedicationBrandOptions([GENERIC_BRAND_OPTION]);
    expect(ranked.filter((b) => b === GENERIC_BRAND_OPTION)).toHaveLength(1);
    expect(ranked[0]).toBe(GENERIC_BRAND_OPTION);
  });
});

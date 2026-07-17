import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMedicationDescriptionsDataset } from "@/scripts/gen-medication-descriptions";
import meds from "@/lib/datasets/data/medication-descriptions.json";
import {
  medicationDescriptionsDataset,
  medDescriptionsStrategy,
  medEntryForName,
} from "@/lib/datasets/medication-descriptions";
import {
  citationPresent,
  identityResolves,
  refusalGate,
  noKeyCollisions,
  runHarness,
} from "@/lib/datasets";
import { getMedicationInfo, splitMedicationName } from "@/lib/medication-info";

// Framework-contract + anti-drift pins for the medication-descriptions dataset (issue
// #860 Track B, wave 2). This is the dataset migrated with a NEW generator + fixed-point
// test (it previously had neither). The committed lib/datasets/data JSON must be a fixed
// point of the generator, it must pass the multi-value framework harness (citation /
// identity / refusal / no-collisions), and the domain accessor must stay behavior-
// identical. Pure — reads the generator + committed JSON, no DB/network.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/datasets/data/medication-descriptions.json");

describe("medication-descriptions.json dataset", () => {
  it("is a fixed point of buildMedicationDescriptionsDataset() (regenerate with `npm run gen:medication-descriptions`)", () => {
    const generated =
      JSON.stringify(buildMedicationDescriptionsDataset(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("carries a citation with a source", () => {
    const r = citationPresent(medicationDescriptionsDataset);
    expect(r.problems).toEqual([]);
    expect(medicationDescriptionsDataset.citation[0].source).toMatch(
      /MedlinePlus|FDA|DailyMed/i
    );
  });

  it("resolves every entry by its own identity (any of its match keys)", () => {
    const r = identityResolves(
      medicationDescriptionsDataset,
      medDescriptionsStrategy
    );
    expect(r.problems).toEqual([]);
  });

  it("has no colliding match keys across entries (multi-value safety)", () => {
    const r = noKeyCollisions(
      medicationDescriptionsDataset,
      medDescriptionsStrategy
    );
    expect(r.problems).toEqual([]);
  });

  it("refuses an absent medication (returns null — never a guess)", () => {
    const r = refusalGate(
      medicationDescriptionsDataset,
      medDescriptionsStrategy,
      ["Definitely Not A Drug", "", "   "]
    );
    expect(r.problems).toEqual([]);
    expect(medEntryForName("Definitely Not A Drug")).toBeNull();
  });

  it("passes the aggregate framework harness", () => {
    const r = runHarness(
      medicationDescriptionsDataset,
      medDescriptionsStrategy
    );
    expect(r.ok, r.problems.join("; ")).toBe(true);
  });

  it("resolves every audited name from issue #881 (the systematic top-300 fill)", () => {
    // The two audits in issue #881 (19 spot-check misses + the whole-category sweep) —
    // every generic must now resolve via the accessor, by generic OR by a brand/alias.
    const audited: string[] = [
      // Cold/cough OTC (the #843 aisle)
      "dextromethorphan",
      "Delsym",
      "phenylephrine",
      "Sudafed PE",
      "chlorpheniramine",
      "doxylamine",
      "Unisom",
      "benzonatate",
      "oxymetazoline",
      "Afrin",
      // Modern metabolic
      "tirzepatide",
      "Mounjaro",
      "Zepbound",
      // GI OTC
      "bismuth subsalicylate",
      "Pepto-Bismol",
      "Pepto",
      "simethicone",
      "Gas-X",
      "polyethylene glycol 3350",
      "MiraLAX",
      "meclizine",
      // Eye/nasal allergy
      "azelastine",
      "olopatadine",
      "Pataday",
      "ketotifen",
      // Family staples
      "permethrin",
      "ofloxacin",
      // Carry/emergency
      "epinephrine",
      "EpiPen",
      "naloxone",
      "Narcan",
      "glucagon",
      // ADHD completeness
      "amphetamine salts",
      "Adderall",
      // Contraceptives/hormonal
      "ethinyl estradiol",
      "norethindrone",
      "levonorgestrel",
      "Plan B",
      "medroxyprogesterone",
      "Depo-Provera",
      // Insulins (rapid + ultra-long)
      "insulin lispro",
      "Humalog",
      "insulin aspart",
      "Novolog",
      "insulin degludec",
      "Tresiba",
      // Ophthalmic
      "latanoprost",
      "Xalatan",
      "timolol",
      // Smoking cessation
      "varenicline",
      "Chantix",
      "nicotine",
      "Nicorette",
      // Singles (incl. combos)
      "hydrocodone-acetaminophen",
      "Vicodin",
      "Norco",
      "nirmatrelvir-ritonavir",
      "Paxlovid",
      "phenazopyridine",
      "AZO",
      "alendronate",
      "oxcarbazepine",
    ];
    for (const name of audited) {
      expect(getMedicationInfo(name), name).not.toBeNull();
    }
  });

  it("models combination products so their brands resolve to the combo, not a component (#881)", () => {
    // Vicodin/Norco are hydrocodone-acetaminophen combos — they must resolve to the
    // COMBO entry, and pure hydrocodone must NOT claim them (the collision resolution).
    expect(getMedicationInfo("Vicodin")?.generic).toBe(
      "Hydrocodone-Acetaminophen"
    );
    expect(getMedicationInfo("Norco")?.generic).toBe(
      "Hydrocodone-Acetaminophen"
    );
    expect(getMedicationInfo("Paxlovid")?.generic).toBe(
      "Nirmatrelvir-Ritonavir"
    );
    expect(getMedicationInfo("hydrocodone")?.generic).toBe("Hydrocodone");
  });

  it("every combo entry's ingredients resolve to catalog generic keys (#881 reflection)", () => {
    // The combination-product tier (#881): an entry carrying `ingredients` lists the
    // catalog generic KEYS of its active components, and each MUST resolve to a real
    // catalog entry (the #279/#798 ingredient path relies on this). At least one combo
    // must actually carry ingredients (guards against the field silently going unused).
    let withIngredients = 0;
    for (const e of meds.entries) {
      if (!e.ingredients) continue;
      withIngredients++;
      expect(Array.isArray(e.ingredients), e.key).toBe(true);
      expect(e.ingredients.length, e.key).toBeGreaterThan(0);
      for (const ingKey of e.ingredients) {
        // The listed key is itself a catalog entry (resolves to a MedicationInfo).
        expect(
          getMedicationInfo(ingKey),
          `${e.key} → ${ingKey}`
        ).not.toBeNull();
      }
    }
    expect(withIngredients).toBeGreaterThan(0);
  });

  it("carries a broad curated set and gives every entry a key + generic + description", () => {
    expect(meds.entries.length).toBeGreaterThan(150);
    const keys = new Set<string>();
    for (const e of meds.entries) {
      expect(e.key.trim().length, e.key).toBeGreaterThan(0);
      expect(keys.has(e.key), `duplicate ${e.key}`).toBe(false);
      keys.add(e.key);
      expect(e.generic.trim().length, e.key).toBeGreaterThan(0);
      expect(e.description.trim().length, e.key).toBeGreaterThan(20);
      expect(Array.isArray(e.match_keys), e.key).toBe(true);
      expect(e.match_keys.length, e.key).toBeGreaterThan(0);
    }
  });
});

describe("multi-value resolution is behavior-identical (the accessor pin)", () => {
  // A representative set spanning generic / brand / alternate-spelling / salt-form /
  // strength-stripped inputs — the same lookups the med cards + form rely on.
  const cases: Array<[string, string]> = [
    ["Ibuprofen", "Ibuprofen"],
    ["Advil", "Ibuprofen"],
    ["ADVIL", "Ibuprofen"],
    ["Ibuprofen 200 mg tablet", "Ibuprofen"],
    ["Tylenol", "Acetaminophen"],
    ["Paracetamol", "Acetaminophen"],
    ["HCTZ", "Hydrochlorothiazide"],
    ["Levothyroxine Sodium", "Levothyroxine"],
    ["Metoprolol Succinate", "Metoprolol"],
    ["Hydrocortisone 2.5%", "Hydrocortisone"],
  ];

  it("resolves each representative name to the right generic", () => {
    for (const [input, generic] of cases) {
      expect(getMedicationInfo(input)?.generic, input).toBe(generic);
    }
  });

  it("returns null for unknown / empty input", () => {
    expect(getMedicationInfo("Definitely Not A Drug")).toBeNull();
    expect(getMedicationInfo("")).toBeNull();
    expect(getMedicationInfo(null)).toBeNull();
  });

  it("splits brand vs synonym vs generic exactly as before", () => {
    expect(splitMedicationName("Tylenol")).toEqual({
      name: "Acetaminophen",
      brand: "Tylenol",
    });
    expect(splitMedicationName("Paracetamol")).toEqual({
      name: "Acetaminophen",
      brand: null,
    });
    expect(splitMedicationName("Ibuprofen")).toEqual({
      name: "Ibuprofen",
      brand: null,
    });
    expect(splitMedicationName("Compounded Mystery Cream")).toEqual({
      name: "Compounded Mystery Cream",
      brand: null,
    });
  });

  it("returns the historical MedicationInfo shape (no internal fields leak)", () => {
    const info = getMedicationInfo("Advil");
    expect(info).not.toBeNull();
    // Only the public MedicationInfo fields — never the entry's internal key /
    // synonyms / match_keys.
    const allowed = new Set([
      "generic",
      "brand_names",
      "drug_class",
      "description",
      "typical",
    ]);
    for (const k of Object.keys(info!)) {
      expect(allowed.has(k), `unexpected leaked field ${k}`).toBe(true);
    }
    expect(info).toHaveProperty("generic", "Ibuprofen");
    expect(info).not.toHaveProperty("match_keys");
    expect(info).not.toHaveProperty("synonyms");
    expect(info).not.toHaveProperty("key");
  });
});

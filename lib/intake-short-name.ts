// Curated short display names for intake items — "Vitamin D3 + K2" → "D3+K2",
// "Coenzyme Q10" → "CoQ10" — for surfaces with a hard width budget: inline
// keyboard button labels, where the Telegram client cuts a long label mid-word.
// Body lines keep the full name; the full name is the record, the short name is
// a control label (the same body/button split the message renderers already
// draw). Pure.
//
// CURATED, NEVER DERIVED. An algorithmic shortener would truncate on a guess —
// the #1817 lesson: only a lookup can tell "Cholecalciferol (Vitamin D3)" apart
// from a name with a brand suffix. An unknown name passes through WHOLE.
//
// Rules for adding entries:
//   • The short name must be recognizable on its own — "B12", "CoQ10", "NAC"
//     are; a bare "C" for Vitamin C is not, so Vitamin C has no entry.
//   • Two DISTINCT substances must never collapse onto one short name (the K2
//     forms keep MK-4/MK-7); aliases of the SAME substance (Coenzyme Q10 /
//     Ubiquinone) deliberately share one.
//   • The vocabulary is supplement/vitamin shorthand — but several entries are
//     ALSO drug names (ergocalciferol, magnesium citrate), so "medications are
//     never shortened" is enforced by an explicit kind gate in
//     intakeItemShortLabel, never by what the map happens to contain.
//
// Keys are stored normalized (see normalizeIntakeName); the invariant tests in
// lib/__tests__/intake-short-name.test.ts pin key stability and idempotency.

import type { IntakeItemKind } from "./types";

// Case-, whitespace- and separator-insensitive lookup form: lowercased, "&"
// read as "+", runs of whitespace collapsed, and no spaces around "+" — so
// "Vitamin D3 + K2", "vitamin d3+k2" and "Vitamin D3 & K2" are one key.
export function normalizeIntakeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, "+")
    .replace(/\s+/g, " ")
    .replace(/ ?\+ ?/g, "+")
    .trim();
}

export const INTAKE_SHORT_NAMES: Record<string, string> = {
  // Vitamins
  "vitamin d3+k2": "D3+K2",
  "vitamin d3": "D3",
  "vitamin d2": "D2",
  cholecalciferol: "D3",
  "cholecalciferol (vitamin d3)": "D3",
  ergocalciferol: "D2",
  "ergocalciferol (vitamin d2)": "D2",
  "vitamin k2": "K2",
  "vitamin k2 (mk-7)": "K2 MK-7",
  "vitamin k2 (mk-4)": "K2 MK-4",
  "vitamin b12": "B12",
  "vitamin b6": "B6",

  // Antioxidants / longevity
  "coenzyme q10": "CoQ10",
  "coenzyme q-10": "CoQ10",
  "co-q10": "CoQ10",
  "co q10": "CoQ10",
  ubiquinone: "CoQ10",
  "nicotinamide mononucleotide": "NMN",
  "nicotinamide riboside": "NR",
  "pyrroloquinoline quinone": "PQQ",

  // Compounds best known by their acronym
  "n-acetyl cysteine": "NAC",
  "n-acetylcysteine": "NAC",
  "n-acetyl-l-cysteine": "NAC",
  "acetyl-l-carnitine": "ALCAR",
  methylsulfonylmethane: "MSM",
  "gamma-aminobutyric acid": "GABA",
  "5-hydroxytryptophan": "5-HTP",
  trimethylglycine: "TMG",
  "betaine (tmg)": "TMG",
  "branched-chain amino acids": "BCAA",
  "branched chain amino acids": "BCAA",
  "eicosapentaenoic acid": "EPA",
  "docosahexaenoic acid": "DHA",
  "s-adenosylmethionine": "SAMe",
  "s-adenosyl methionine": "SAMe",
  "s-adenosyl-l-methionine": "SAMe",
  "beta-hydroxy beta-methylbutyrate": "HMB",

  // Magnesium forms — "Mag" + the form, never a bare "Magnesium": the form is
  // what tells two tracked magnesiums apart, so it survives the shortening.
  // Bisglycinate and glycinate are the same chelate, so they share one.
  "magnesium glycinate": "Mag glycinate",
  "magnesium bisglycinate": "Mag glycinate",
  "magnesium citrate": "Mag citrate",
  "magnesium l-threonate": "Mag threonate",
  "magnesium threonate": "Mag threonate",
  "magnesium malate": "Mag malate",
  "magnesium oxide": "Mag oxide",
  "magnesium taurate": "Mag taurate",

  // Methylation / homocysteine support
  "p-5-p (pyridoxal-5-phosphate)": "P5P",
  "pyridoxal-5-phosphate": "P5P",
  "p-5-p": "P5P",

  // Botanicals and blends
  "grape seed extract": "Grape seed",
  "pine bark extract": "Pine bark",
  pycnogenol: "Pine bark",
  "olive leaf extract": "Olive leaf",
  "evening primrose oil": "Primrose oil",
  "stinging nettle": "Nettle",
  "holy basil (tulsi)": "Holy basil",
  "beetroot powder": "Beetroot",
  "fadogia agrestis": "Fadogia",
  "preservision areds 2": "AREDS 2",
  "ritual essential multivitamin": "Ritual multi",

  // Common names with a redundant tail
  "creatine monohydrate": "Creatine",
  "collagen peptides": "Collagen",
  "psyllium husk": "Psyllium",
  "whey protein": "Whey",
  "casein protein": "Casein",
  "citicoline (cdp-choline)": "Citicoline",
  "cdp-choline": "Citicoline",
  "rhodiola rosea": "Rhodiola",
  "bacopa monnieri": "Bacopa",
  "ginkgo biloba": "Ginkgo",
  "valerian root": "Valerian",
  "tart cherry extract": "Tart cherry",
  "glucosamine sulfate": "Glucosamine",
  "chondroitin sulfate": "Chondroitin",
};

/**
 * The curated short display name for an intake item, or the name unchanged
 * when it has no entry. Safe to apply to any label the map might not cover —
 * unknown and custom names come back whole, never truncated on a guess.
 */
export function intakeShortName(name: string): string {
  return INTAKE_SHORT_NAMES[normalizeIntakeName(name)] ?? name;
}

/**
 * The button label for an intake item, from the row's own fields: the curated
 * short form when the map knows the name; else the item's own PRODUCT when it
 * is genuinely shorter — the "name carries the composition, product carries
 * the product identity" convention (name "Astaxanthin/Lutein/Zeaxanthin",
 * product "Eye Health+"); else the full name.
 *
 * A MEDICATION is excluded from BOTH substitutions, explicitly: a shortened
 * drug name is a misread risk however it was produced — the map holds
 * supplement vocabulary, but several entries are drug names too (an Rx
 * "Ergocalciferol (Vitamin D2)", an OTC "Magnesium Citrate" laxative), so the
 * kind gate has to sit here, not in the map's curation. A medication's
 * product is a formulation label besides ("Children's oral suspension
 * (160 mg / 5 mL)"), already rendered beside the dose.
 */
export function intakeItemShortLabel(item: {
  name: string;
  kind?: IntakeItemKind | null;
  product?: string | null;
}): string {
  if (item.kind === "medication") return item.name;
  const curated = INTAKE_SHORT_NAMES[normalizeIntakeName(item.name)];
  if (curated) return curated;
  const product = item.product?.trim();
  if (product && product.length < item.name.trim().length) {
    return product;
  }
  return item.name;
}

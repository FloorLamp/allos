// Canonical supplement catalog — a committed, offline-usable dataset of common
// over-the-counter supplements with realistic common dosages and a sensible
// default time of day. This file is the runtime source of truth for supplement
// autocomplete/defaults and works entirely offline (no API call at runtime).
//
// Maintained by hand: add or edit entries directly, keeping the category
// grouping below. These are informational defaults, NOT medical advice or
// dosing guidance.

import type { TimeBucket } from "./intake-schedule";
import type { FoodTiming } from "./types";

// One ingredient on a catalogued blend's label, per SINGLE dose unit (one capsule,
// softgel, scoop or stick — not per day). `amount` is the label text; leave it out
// when the label states no number for that ingredient (a proprietary blend), which
// still names the substance for the interaction and allergen matchers.
export interface CatalogIngredient {
  name: string;
  amount?: string;
}

export interface SupplementCatalogEntry {
  name: string;
  dosages: string[];
  defaultTimeOfDay?: TimeBucket;
  // Optional food-relationship default; when absent the form falls back to a
  // fat-soluble heuristic (see defaultFoodTiming in intake-schedule).
  defaultFoodTiming?: FoodTiming;
  // Label composition for a BLEND (issue #2856), per single dose unit. Picking the
  // entry SEEDS the form's ingredients repeater — it never writes: the person's save
  // is the write (#798), and the figures below are what a typical label states, to be
  // checked against the bottle in hand rather than trusted.
  //
  // Only blends carry this. A single-substance entry ("Zinc") needs no decomposition:
  // its name already says what is in it, and the engines have always read that.
  ingredients?: CatalogIngredient[];
  // True when the list above is a CURATED SUBSET of a long label rather than all of
  // it — the AG1 case, where a faithful transcription would be seventy-odd rows. The
  // form says so out loud beside the seeded rows; claiming completeness we don't have
  // would be worse than the free-text notes this feature replaces.
  ingredientsPartial?: boolean;
}

export const SUPPLEMENT_CATALOG: SupplementCatalogEntry[] = [
  // Vitamins
  { name: "Vitamin A", dosages: ["3000 mcg", "5000 IU", "10000 IU"] },
  {
    name: "Vitamin C",
    dosages: ["250 mg", "500 mg", "1000 mg"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Vitamin D3",
    dosages: ["1000 IU", "2000 IU", "5000 IU", "10000 IU"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Vitamin D3 + K2",
    dosages: ["2000 IU / 100 mcg", "5000 IU / 100 mcg", "5000 IU / 200 mcg"],
    defaultTimeOfDay: "Morning",
  },
  { name: "Vitamin E", dosages: ["100 IU", "200 IU", "400 IU"] },
  { name: "Vitamin K2", dosages: ["45 mcg", "100 mcg", "200 mcg"] },
  {
    name: "Vitamin B12",
    dosages: ["500 mcg", "1000 mcg", "5000 mcg"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "B-Complex",
    dosages: ["1 capsule", "1 tablet"],
    defaultTimeOfDay: "Morning",
  },
  { name: "Folate", dosages: ["400 mcg", "800 mcg", "1000 mcg"] },
  { name: "Biotin", dosages: ["1000 mcg", "5000 mcg", "10000 mcg"] },
  { name: "Niacin", dosages: ["100 mg", "250 mg", "500 mg"] },
  { name: "Vitamin B6", dosages: ["25 mg", "50 mg", "100 mg"] },
  { name: "Riboflavin", dosages: ["100 mg", "400 mg"] },
  { name: "Thiamine", dosages: ["100 mg", "250 mg"] },
  { name: "Pantothenic Acid", dosages: ["250 mg", "500 mg"] },

  // Methylation / homocysteine support
  {
    name: "L-Methylfolate",
    dosages: ["400 mcg", "1 mg", "5 mg"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Methylcobalamin",
    dosages: ["1000 mcg", "5000 mcg"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "P-5-P (Pyridoxal-5-Phosphate)",
    dosages: ["25 mg", "50 mg"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "SAMe",
    dosages: ["200 mg", "400 mg"],
    defaultTimeOfDay: "Morning",
    defaultFoodTiming: "empty_stomach",
  },
  { name: "Choline", dosages: ["250 mg", "500 mg"] },

  // Minerals
  {
    name: "Magnesium Glycinate",
    dosages: ["100 mg", "200 mg", "400 mg"],
    defaultTimeOfDay: "Evening",
  },
  {
    name: "Magnesium Citrate",
    dosages: ["150 mg", "200 mg", "400 mg"],
    defaultTimeOfDay: "Evening",
  },
  {
    name: "Magnesium L-Threonate",
    dosages: ["1000 mg", "2000 mg"],
    defaultTimeOfDay: "Evening",
  },
  { name: "Zinc", dosages: ["15 mg", "30 mg", "50 mg"] },
  {
    name: "Iron",
    dosages: ["18 mg", "27 mg", "65 mg"],
    defaultTimeOfDay: "Morning",
  },
  { name: "Calcium", dosages: ["500 mg", "600 mg", "1000 mg"] },
  { name: "Selenium", dosages: ["100 mcg", "200 mcg"] },
  { name: "Potassium", dosages: ["99 mg", "200 mg"] },
  { name: "Copper", dosages: ["1 mg", "2 mg"] },
  { name: "Iodine", dosages: ["150 mcg", "225 mcg"] },
  { name: "Chromium", dosages: ["200 mcg", "500 mcg"] },
  { name: "Boron", dosages: ["3 mg", "6 mg"] },
  {
    name: "Magnesium Malate",
    dosages: ["1250 mg", "2000 mg"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Magnesium Oxide",
    dosages: ["250 mg", "400 mg", "500 mg"],
    defaultTimeOfDay: "Evening",
  },
  { name: "Manganese", dosages: ["2 mg", "5 mg", "10 mg"] },
  { name: "Molybdenum", dosages: ["50 mcg", "75 mcg"] },

  // Omega / fats
  {
    name: "Fish Oil",
    dosages: ["1000 mg", "2000 mg", "3000 mg"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Omega-3",
    dosages: ["1000 mg", "1500 mg", "2000 mg"],
    defaultTimeOfDay: "Morning",
  },
  { name: "Krill Oil", dosages: ["500 mg", "1000 mg"] },
  { name: "Cod Liver Oil", dosages: ["1 tsp", "1000 mg"] },
  { name: "Flaxseed Oil", dosages: ["1000 mg", "2000 mg"] },

  // Protein / fitness
  {
    name: "Whey Protein",
    dosages: ["1 scoop", "20 g", "25 g", "30 g"],
    defaultTimeOfDay: "Anytime",
  },
  {
    name: "Casein Protein",
    dosages: ["1 scoop", "25 g", "30 g"],
    defaultTimeOfDay: "Evening",
  },
  {
    name: "Creatine Monohydrate",
    dosages: ["3 g", "5 g", "10 g"],
    defaultTimeOfDay: "Anytime",
  },
  {
    name: "Pre-Workout",
    dosages: ["1 scoop", "1 serving"],
    defaultTimeOfDay: "Morning",
  },
  { name: "BCAA", dosages: ["5 g", "10 g"], defaultTimeOfDay: "Anytime" },
  {
    name: "Beta-Alanine",
    dosages: ["1.5 g", "3.2 g"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "L-Citrulline",
    dosages: ["3 g", "6 g", "8 g"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Collagen Peptides",
    dosages: ["10 g", "20 g"],
    defaultTimeOfDay: "Anytime",
  },
  {
    name: "Electrolytes",
    dosages: ["1 packet", "1 serving"],
    defaultTimeOfDay: "Anytime",
  },

  // Amino acids
  {
    name: "Glycine",
    dosages: ["3 g", "5 g"],
    defaultTimeOfDay: "Before sleep",
  },
  {
    name: "Taurine",
    dosages: ["500 mg", "1000 mg", "2000 mg"],
    defaultTimeOfDay: "Anytime",
  },
  {
    name: "L-Glutamine",
    dosages: ["5 g", "10 g"],
    defaultTimeOfDay: "Anytime",
  },
  {
    name: "L-Tyrosine",
    dosages: ["500 mg", "1000 mg"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "L-Carnitine",
    dosages: ["500 mg", "1000 mg", "2000 mg"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Acetyl-L-Carnitine",
    dosages: ["500 mg", "1000 mg"],
    defaultTimeOfDay: "Morning",
  },
  { name: "L-Arginine", dosages: ["1000 mg", "3000 mg", "5000 mg"] },
  { name: "L-Lysine", dosages: ["500 mg", "1000 mg"] },
  {
    name: "Betaine (TMG)",
    dosages: ["500 mg", "1000 mg", "2500 mg"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Creatine HCl",
    dosages: ["2 g", "3 g"],
    defaultTimeOfDay: "Anytime",
  },

  // Gut / fiber
  {
    name: "Probiotics",
    dosages: ["10 billion CFU", "30 billion CFU", "50 billion CFU"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Psyllium Husk",
    dosages: ["5 g", "1 tbsp"],
    defaultTimeOfDay: "Anytime",
  },
  { name: "Fiber", dosages: ["5 g", "10 g"], defaultTimeOfDay: "Anytime" },
  // Fiber products (#2752) — gram-dosed defaults lead so fiberDoseGrams
  // quantifies a picked dose out of the box; a tsp/tbsp variant is honest-unknown.
  {
    name: "Ground Flaxseed",
    dosages: ["7 g", "14 g", "1 tbsp"],
    defaultTimeOfDay: "Anytime",
  },
  {
    name: "Chia Seeds",
    dosages: ["12 g", "28 g", "1 tbsp"],
    defaultTimeOfDay: "Anytime",
  },
  {
    name: "Beta-Glucan",
    dosages: ["3 g", "5 g"],
    defaultTimeOfDay: "Anytime",
  },
  {
    name: "Glucomannan",
    dosages: ["1 g", "3 g"],
    defaultTimeOfDay: "Anytime",
  },
  {
    name: "Acacia Fiber",
    dosages: ["5 g", "10 g", "1 tbsp"],
    defaultTimeOfDay: "Anytime",
  },
  // Household fiber brands, so the honest full spelling is the path of least
  // resistance (a truncated free-text "metam" is invisible to the fiber matcher).
  {
    name: "Metamucil",
    dosages: ["1 rounded tsp", "1 packet"],
    defaultTimeOfDay: "Anytime",
  },
  {
    name: "Benefiber",
    dosages: ["2 tsp", "1 stick"],
    defaultTimeOfDay: "Anytime",
  },
  {
    name: "Digestive Enzymes",
    dosages: ["1 capsule", "1 tablet"],
    defaultTimeOfDay: "Anytime",
  },
  {
    name: "Prebiotics",
    dosages: ["5 g", "1 scoop"],
    defaultTimeOfDay: "Morning",
  },

  // Sleep / calm / nootropic
  {
    name: "Melatonin",
    dosages: ["0.5 mg", "1 mg", "3 mg", "5 mg"],
    defaultTimeOfDay: "Evening",
  },
  { name: "L-Theanine", dosages: ["100 mg", "200 mg"] },
  {
    name: "Ashwagandha",
    dosages: ["300 mg", "600 mg"],
    defaultTimeOfDay: "Evening",
  },
  {
    name: "Rhodiola Rosea",
    dosages: ["200 mg", "400 mg"],
    defaultTimeOfDay: "Morning",
  },
  { name: "GABA", dosages: ["250 mg", "500 mg"], defaultTimeOfDay: "Evening" },
  { name: "5-HTP", dosages: ["50 mg", "100 mg"], defaultTimeOfDay: "Evening" },
  {
    name: "Lion's Mane",
    dosages: ["500 mg", "1000 mg"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Caffeine",
    dosages: ["100 mg", "200 mg"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Valerian Root",
    dosages: ["300 mg", "500 mg", "600 mg"],
    defaultTimeOfDay: "Before sleep",
  },
  {
    name: "Alpha-GPC",
    dosages: ["300 mg", "600 mg"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Citicoline (CDP-Choline)",
    dosages: ["250 mg", "500 mg"],
    defaultTimeOfDay: "Morning",
  },
  { name: "Phosphatidylserine", dosages: ["100 mg", "300 mg"] },
  {
    name: "Bacopa Monnieri",
    dosages: ["300 mg", "600 mg"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Ginkgo Biloba",
    dosages: ["120 mg", "240 mg"],
    defaultTimeOfDay: "Morning",
  },

  // Antioxidants / longevity / metabolic
  {
    name: "CoQ10",
    dosages: ["100 mg", "200 mg", "300 mg"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Curcumin",
    dosages: ["500 mg", "1000 mg"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Turmeric",
    dosages: ["500 mg", "1000 mg"],
    defaultTimeOfDay: "Morning",
  },
  { name: "NAC", dosages: ["600 mg", "1200 mg"] },
  { name: "Alpha-Lipoic Acid", dosages: ["300 mg", "600 mg"] },
  { name: "Berberine", dosages: ["500 mg", "1000 mg", "1500 mg"] },
  {
    name: "Resveratrol",
    dosages: ["250 mg", "500 mg"],
    defaultTimeOfDay: "Morning",
  },
  { name: "Quercetin", dosages: ["250 mg", "500 mg"] },
  { name: "Glutathione", dosages: ["250 mg", "500 mg"] },
  {
    name: "Ubiquinol",
    dosages: ["100 mg", "200 mg"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Astaxanthin",
    dosages: ["4 mg", "12 mg"],
    defaultTimeOfDay: "Morning",
  },
  { name: "PQQ", dosages: ["10 mg", "20 mg"], defaultTimeOfDay: "Morning" },
  { name: "NMN", dosages: ["250 mg", "500 mg"], defaultTimeOfDay: "Morning" },
  {
    name: "Nicotinamide Riboside",
    dosages: ["300 mg", "500 mg"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Inositol",
    dosages: ["1000 mg", "2000 mg", "4000 mg"],
    defaultTimeOfDay: "Evening",
  },
  {
    name: "Green Tea Extract",
    dosages: ["400 mg", "500 mg"],
    defaultTimeOfDay: "Morning",
  },
  { name: "Spirulina", dosages: ["1 g", "3 g"] },
  { name: "Chlorella", dosages: ["1 g", "3 g"] },

  // Carotenoids (fat-soluble — the with-fat default comes from the shared
  // heuristic in intake-schedule)
  { name: "Lutein", dosages: ["10 mg", "20 mg"], defaultTimeOfDay: "Morning" },
  {
    name: "Zeaxanthin",
    dosages: ["2 mg", "4 mg"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Lutein + Zeaxanthin",
    dosages: ["10 mg / 2 mg", "20 mg / 4 mg"],
    defaultTimeOfDay: "Morning",
  },
  { name: "Lycopene", dosages: ["10 mg", "20 mg"] },
  { name: "Beta-Carotene", dosages: ["6 mg", "15 mg", "25000 IU"] },

  // Mushrooms
  {
    name: "Cordyceps",
    dosages: ["500 mg", "1000 mg"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Reishi",
    dosages: ["500 mg", "1000 mg"],
    defaultTimeOfDay: "Evening",
  },
  { name: "Chaga", dosages: ["500 mg", "1000 mg"] },
  { name: "Turkey Tail", dosages: ["500 mg", "1000 mg"] },

  // Joint
  { name: "Glucosamine", dosages: ["500 mg", "1500 mg"] },
  { name: "Chondroitin", dosages: ["400 mg", "1200 mg"] },
  { name: "MSM", dosages: ["1000 mg", "3000 mg"] },

  // Herbal / other
  { name: "Milk Thistle", dosages: ["150 mg", "300 mg"] },
  { name: "Saw Palmetto", dosages: ["160 mg", "320 mg"] },
  { name: "Elderberry", dosages: ["300 mg", "500 mg"] },
  {
    name: "Tart Cherry Extract",
    dosages: ["480 mg", "1000 mg"],
    defaultTimeOfDay: "Before sleep",
  },
  { name: "Echinacea", dosages: ["400 mg", "800 mg"] },
  { name: "Garlic Extract", dosages: ["600 mg", "1200 mg"] },
  { name: "Cranberry", dosages: ["500 mg", "1000 mg"] },
  {
    name: "Maca",
    dosages: ["1500 mg", "3000 mg"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Tongkat Ali",
    dosages: ["200 mg", "400 mg"],
    defaultTimeOfDay: "Morning",
  },
  { name: "DHEA", dosages: ["25 mg", "50 mg"], defaultTimeOfDay: "Morning" },
  { name: "DIM", dosages: ["100 mg", "200 mg"] },
  {
    name: "Panax Ginseng",
    dosages: ["200 mg", "400 mg"],
    defaultTimeOfDay: "Morning",
  },
  { name: "Ginger", dosages: ["500 mg", "1000 mg"] },
  { name: "Boswellia", dosages: ["300 mg", "500 mg"] },
  { name: "Cinnamon", dosages: ["500 mg", "1000 mg"] },
  { name: "Fenugreek", dosages: ["500 mg", "600 mg"] },
  {
    name: "Holy Basil (Tulsi)",
    dosages: ["300 mg", "600 mg"],
    defaultTimeOfDay: "Evening",
  },
  {
    name: "St. John's Wort",
    dosages: ["300 mg", "600 mg", "900 mg"],
    defaultTimeOfDay: "Morning",
  },
  { name: "Black Seed Oil", dosages: ["500 mg", "1000 mg", "1 tsp"] },
  { name: "Stinging Nettle", dosages: ["300 mg", "500 mg"] },
  {
    name: "Passionflower",
    dosages: ["250 mg", "500 mg"],
    defaultTimeOfDay: "Before sleep",
  },
  {
    name: "Lemon Balm",
    dosages: ["300 mg", "600 mg"],
    defaultTimeOfDay: "Evening",
  },
  {
    name: "Chamomile",
    dosages: ["350 mg", "500 mg"],
    defaultTimeOfDay: "Before sleep",
  },
  { name: "Saffron", dosages: ["28 mg", "30 mg"] },
  { name: "Grape Seed Extract", dosages: ["100 mg", "300 mg"] },
  { name: "Pine Bark Extract", dosages: ["100 mg", "200 mg"] },
  { name: "Olive Leaf Extract", dosages: ["500 mg", "750 mg"] },
  { name: "Oregano Oil", dosages: ["150 mg", "1 softgel"] },
  { name: "Evening Primrose Oil", dosages: ["500 mg", "1300 mg"] },
  { name: "Black Cohosh", dosages: ["20 mg", "40 mg"] },
  {
    name: "Red Yeast Rice",
    dosages: ["600 mg", "1200 mg"],
    defaultTimeOfDay: "Evening",
  },
  { name: "Bilberry", dosages: ["80 mg", "160 mg"] },
  { name: "Artichoke Extract", dosages: ["300 mg", "600 mg"] },
  { name: "Triphala", dosages: ["500 mg", "1000 mg"] },
  { name: "Moringa", dosages: ["500 mg", "1 tsp"] },
  {
    name: "Beetroot Powder",
    dosages: ["5 g", "1 scoop"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Shilajit",
    dosages: ["250 mg", "500 mg"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Fadogia Agrestis",
    dosages: ["300 mg", "600 mg"],
    defaultTimeOfDay: "Morning",
  },
  { name: "Sea Moss", dosages: ["1000 mg", "1 tsp"] },
  {
    name: "Multivitamin",
    dosages: ["1 tablet", "1 capsule", "1 serving"],
    defaultTimeOfDay: "Morning",
  },

  // Brand blends — well-known branded formulations tracked as one item. The
  // brand rides the item NAME here (it is the product's identity, e.g. "AG1");
  // the free-text brand field stays for manufacturer detail on generic entries.
  {
    name: "AG1",
    dosages: ["1 scoop", "12 g"],
    defaultTimeOfDay: "Morning",
    defaultFoodTiming: "empty_stomach",
    // A curated SUBSET (#2856): the label runs to seventy-odd entries, so the seed
    // carries the ones the engines act on — the micronutrients with upper limits, and
    // the herbal actives the interaction belt knows — and the form says out loud that
    // the rest of the label is not here. Amounts are per scoop.
    ingredientsPartial: true,
    ingredients: [
      { name: "Vitamin C", amount: "420 mg" },
      { name: "Zinc", amount: "15 mg" },
      { name: "Selenium", amount: "20 mcg" },
      { name: "Copper", amount: "0.19 mg" },
      { name: "Ashwagandha" },
      { name: "Rhodiola Rosea" },
      { name: "Milk Thistle" },
      { name: "Green Tea Extract" },
    ],
  },
  {
    name: "LMNT",
    dosages: ["1 packet"],
    defaultTimeOfDay: "Anytime",
    // Per stick. Potassium and magnesium are the reason this entry carries a
    // composition at all: an electrolyte stick is invisible to both the potassium
    // interaction screens and the magnesium upper limit under its brand name.
    ingredients: [
      { name: "Sodium", amount: "1000 mg" },
      { name: "Chloride", amount: "1500 mg" },
      { name: "Potassium", amount: "200 mg" },
      { name: "Magnesium", amount: "60 mg" },
    ],
  },
  { name: "Liquid I.V.", dosages: ["1 packet"], defaultTimeOfDay: "Anytime" },
  {
    name: "Emergen-C",
    dosages: ["1 packet"],
    defaultTimeOfDay: "Morning",
    // Per packet.
    ingredients: [
      { name: "Vitamin C", amount: "1000 mg" },
      { name: "Vitamin B6", amount: "10 mg" },
      { name: "Vitamin B12", amount: "25 mcg" },
      { name: "Zinc", amount: "2 mg" },
      { name: "Manganese", amount: "0.5 mg" },
      { name: "Potassium", amount: "200 mg" },
    ],
  },
  { name: "Ka'Chava", dosages: ["2 scoops"], defaultTimeOfDay: "Anytime" },
  {
    name: "Ritual Essential Multivitamin",
    dosages: ["2 capsules"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Basic Nutrients 2/Day",
    dosages: ["2 capsules"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "O.N.E. Multivitamin",
    dosages: ["1 capsule"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "Methyl-Guard Plus",
    dosages: ["3 capsules"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "HomocysteX Plus",
    dosages: ["1 capsule"],
    defaultTimeOfDay: "Morning",
  },
  {
    name: "PreserVision AREDS 2",
    dosages: ["1 softgel", "2 softgels"],
    defaultTimeOfDay: "Morning",
    // Per SOFTGEL — the label states the AREDS2 formula over the two-softgel daily
    // serving, and ingredient amounts here are per single dose unit throughout, so the
    // schedule (one softgel twice a day, or two at once) does the doubling. The zinc
    // this adds up to is deliberately above the upper limit: that is what the trial
    // formula contains, and it is exactly the fact a name-only stack could not see.
    ingredients: [
      { name: "Vitamin C", amount: "250 mg" },
      { name: "Vitamin E", amount: "200 IU" },
      { name: "Lutein", amount: "5 mg" },
      { name: "Zeaxanthin", amount: "1 mg" },
      { name: "Zinc", amount: "40 mg" },
      { name: "Copper", amount: "1 mg" },
    ],
  },
];

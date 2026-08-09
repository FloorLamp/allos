// Pre-generate the baked biomarker→supplement map (lib/datasets/data/biomarker-supplement-map.json)
// used by the DETERMINISTIC supplement-suggestion engine (issue #2378): when a profile's
// current reading for a biomarker family is flagged low, propose the supplement that
// repletes it — safety-screened against allergies, medications, and conditions BEFORE
// it renders. It is the exact twin of the biomarker→food map (gen-nutrient-food-map.ts,
// #577), and it exists for the same reason: the half of the question that recommends a
// substance a user SWALLOWS should not be the less deterministic half.
//
// Like gen-mets / gen-dri / gen-nutrient-food-map this needs NO API key — the map is
// curated inline, so generation is fully deterministic:
//
//   npm run gen:biomarker-supplement-map
//
// ── THE CURATION STANDARD (read before adding an entry) ───────────────────────
//
// The engine is a copy of the food engine. THIS TABLE IS NOT. "An orange contains
// vitamin C" is a stable, uncontested fact; "this biomarker warrants this supplement"
// carries dose, form, bioavailability, an interaction surface, and efficacy that is
// frequently contested or weak. So the bar here is deliberately higher than the food
// map's, and the map is deliberately SMALL:
//
//   1. The pair must be UNCONTESTED AT THE LEVEL OF THE MARKER: taking the supplement
//      raises (or repletes) the very quantity the biomarker measures. That is a much
//      narrower claim than "this supplement improves an outcome", and it is the only
//      claim this map is allowed to make.
//   2. Every entry carries `evidence` (a one-line reason a reviewer can check) and
//      `source` (a public, citable reference). If you cannot write the one-liner, the
//      entry does not belong.
//   3. NO ENTRY STATES A DOSE. Not in the name, not in the evidence, not in the caveat.
//      Nothing here is a prescription; dose, duration and monitoring belong to a
//      clinician. lib/__tests__/biomarker-supplement-map-dataset.test.ts fails any
//      dose-shaped number that sneaks in.
//   4. An UNCOVERED family is fine. It falls through to the AI route
//      (lib/supplement-suggest.ts) and loses nothing, so coverage is a measurable thing
//      that GROWS — never pad the table to look complete.
//   5. When in doubt, LEAVE IT OUT and say why in the PR. Some pairs deliberately
//      excluded so far, and the reason:
//        • Zinc — serum zinc is a poor status marker (it falls with inflammation and
//          low albumin) and sustained supplementation induces copper deficiency.
//        • Selenium — narrow window between sufficiency and toxicity; a low serum
//          selenium is not by itself a supplementation indication.
//        • Iodine — supplementing iodine can precipitate thyroid dysfunction in both
//          directions (Jod-Basedow, Wolff-Chaikoff); a spot level does not support it.
//        • Copper, vitamin A, vitamin E — either a poor marker, a narrow window, or an
//          intake question rather than a supplement question.
//        • Potassium — flagged-low potassium is a clinical event with a cause, not a
//          supplement suggestion; the shared condition screen already hard-drops
//          supplemental potassium for CKD/hyperkalemia.
//        • Testosterone, thyroid, cortisol and every other hormone — a hormonal
//          abnormality is a diagnosis, not a supplement gap.
//
// ── SAFETY ───────────────────────────────────────────────────────────────────
//
// The engine (lib/supplement-suggest-curated.ts) reuses the EXISTING screens rather
// than declaring its own: screenSuggestionSafety (allergen × cross-reactivity,
// medication interaction, condition→nutrient) from lib/supplement-safety.ts, and the
// food–drug inverse index (`interactionKeys` → matchFoodInteractions) that the food
// engine already uses for its medication notes. This table therefore carries ONLY what
// is genuinely its own: which supplement answers which biomarker, and the
// supplement-specific condition tags no shared rule covers (sarcoidosis × vitamin D,
// haemochromatosis × iron). Magnesium deliberately declares NO CKD tag: that rule
// already lives in CONDITION_NUTRIENT_RULES and the shared screen applies it — a second
// copy here is exactly the drift this repo forbids.

import fs from "node:fs";
import path from "node:path";
import { DATASET_SCHEMA, type DatasetEnvelope } from "../lib/datasets/types";
import type { Contraindication } from "./gen-nutrient-food-map";
import type { FoodTiming } from "../lib/types";

const OUT = path.join(
  process.cwd(),
  "lib",
  "datasets",
  "data",
  "biomarker-supplement-map.json"
);

// One curated supplement that answers a biomarker shortfall. NO DOSE — `name` carries
// the substance and, where the form genuinely matters for absorption or effect, the
// form; everything about how much and for how long belongs to a clinician.
export interface SupplementSource {
  // Display label ("Vitamin D3 (cholecalciferol)").
  name: string;
  // Lowercase tokens that identify this substance in an intake item's NAME, for the
  // "already in your stack" screen (a user already taking vitamin D is not told to
  // start it). Matched as whole-token subsequences by the shared tokenizer.
  matchTokens: string[];
  // How to take it relative to food, in the SAME vocabulary the schedule uses
  // (lib/supplement-schedule FOOD_TIMINGS), so a suggestion and a scheduled item speak
  // one language.
  foodTiming: FoodTiming;
  // One-line, dose-free practical note ("absorbed better with a fat-containing meal"),
  // or null.
  note: string | null;
  // The lib/datasets/data/food-drug-interactions.json entry keys this substance
  // participates in — the SAME inverse index the food engine uses (#577). When a stack
  // medication matches one, that rule's advice rides along as a medication note; it is
  // a timing note, never a silent drop (hard drops are the shared belt's job).
  interactionKeys?: string[];
}

// One biomarker-family → supplement mapping.
export interface BiomarkerSupplementEntry {
  // Stable key for the nutrient concept — the suggestion's identity, so several flagged
  // members of one family (Vitamin D2/D3/total) collapse to ONE suggestion (#482).
  key: string;
  // Display label ("Vitamin D").
  label: string;
  // Canonical biomarker names (lib/canonical-biomarkers.json) whose CURRENT reading
  // being flagged low triggers this suggestion. Matched case-insensitively.
  biomarkers: string[];
  // Which flag direction triggers it. Always "low": a supplement can answer a shortfall,
  // and "stop taking something" is a different question this map does not answer.
  direction: "low";
  // The curated supplement(s), best-supported first.
  supplements: SupplementSource[];
  // What to surface INSTEAD when every primary is struck by a safety screen (a fish
  // allergy striking fish oil → algal oil). Itself screened before it renders. Null when
  // there is no honest swap.
  allergyAlternative: SupplementSource | null;
  // The one-line, plain-language justification a reviewer can check — scoped to the
  // MARKER, never to an outcome.
  evidence: string;
  // Public, citable provenance for that justification.
  source: string;
  // Supplement-specific condition/situation tags, checked against the profile's active
  // conditions AND situations. "drop" withholds the whole suggestion (increasing the
  // substance is hazardous with that condition); "caution" annotates it. Rules already
  // covered by CONDITION_NUTRIENT_RULES are NOT repeated here.
  contraindications: Contraindication[];
  // The honest caveat surfaced with the suggestion — what this map is not claiming, or
  // what a user should take to a clinician. Null when none applies.
  caveat: string | null;
}

// ── The curated biomarker → supplement table ─────────────────────────────────
// Six entries. Each one is a claim about the MARKER, each carries its justification and
// a public source, and none of them states a dose.
const ENTRIES: BiomarkerSupplementEntry[] = [
  {
    key: "vitamin-d",
    label: "Vitamin D",
    biomarkers: [
      "Vitamin D, 25-Hydroxy",
      "Vitamin D3, 25-Hydroxy",
      "Vitamin D2, 25-Hydroxy",
    ],
    direction: "low",
    supplements: [
      {
        name: "Vitamin D3 (cholecalciferol)",
        matchTokens: ["vitamin d", "vitamin d3", "cholecalciferol"],
        foodTiming: "with_fat",
        note: "Fat-soluble — absorbed better taken with a meal containing fat.",
      },
    ],
    allergyAlternative: {
      // D3 is usually lanolin-derived (sheep's wool); lichen-derived D3 and
      // ergocalciferol are the routes that avoid it.
      name: "Vitamin D2 (ergocalciferol) or lichen-derived vegan D3",
      matchTokens: ["vitamin d2", "ergocalciferol"],
      foodTiming: "with_fat",
      note: "The routes that avoid lanolin (wool-derived) vitamin D3.",
    },
    evidence:
      "25-hydroxyvitamin D is the storage form the test measures, and oral vitamin D raises it directly and dose-dependently — the most direct biomarker-to-supplement relationship there is.",
    source:
      "NIH Office of Dietary Supplements — Vitamin D fact sheet; Endocrine Society clinical practice guideline on vitamin D deficiency",
    contraindications: [
      {
        match: "sarcoidosis",
        caution:
          "Sarcoidosis and other granulomatous conditions activate vitamin D outside the usual controls and can push calcium high — vitamin D here is a clinician's call, not a self-started one.",
        severity: "drop",
      },
      {
        match: "hypercalcemia",
        caution:
          "With high calcium, adding vitamin D can raise it further — this needs a clinician first.",
        severity: "drop",
      },
      {
        match: "chronic kidney",
        caution:
          "With reduced kidney function, vitamin D handling changes and an activated form may be what is needed — check with your clinician before starting.",
      },
    ],
    caveat:
      "Vitamin D is fat-soluble and accumulates, so more is not better. A repeat level some months later is how you find out where you actually landed.",
  },
  {
    key: "vitamin-b12",
    label: "Vitamin B12",
    biomarkers: ["Vitamin B12"],
    direction: "low",
    supplements: [
      {
        name: "Vitamin B12 (cyanocobalamin)",
        matchTokens: [
          "vitamin b12",
          "b12",
          "cyanocobalamin",
          "methylcobalamin",
          "cobalamin",
        ],
        foodTiming: "any",
        note: null,
      },
    ],
    allergyAlternative: null,
    evidence:
      "Oral cobalamin raises a low B12: alongside the intrinsic-factor route there is a passive absorption route that does not need it, which is why oral repletion works even when the cause is malabsorption.",
    source: "NIH Office of Dietary Supplements — Vitamin B12 fact sheet",
    contraindications: [],
    caveat:
      "A low B12 has a cause worth naming — a plant-based diet, metformin or long-term acid-lowering medication, or pernicious anaemia. Numbness, tingling or balance trouble alongside a low B12 is a reason to see a clinician rather than self-treat.",
  },
  {
    key: "folate",
    label: "Folate",
    biomarkers: ["Folate", "Folate, RBC"],
    direction: "low",
    supplements: [
      {
        name: "Folic acid (or methylfolate)",
        matchTokens: ["folic acid", "folate", "methylfolate", "folinic acid"],
        foodTiming: "any",
        note: null,
      },
    ],
    allergyAlternative: null,
    evidence:
      "Serum and red-cell folate rise reliably on supplemental folic acid — it is the standard repletion route and the same form used in food fortification.",
    source: "NIH Office of Dietary Supplements — Folate fact sheet",
    contraindications: [],
    caveat:
      "Have B12 checked alongside it: folate can correct the anaemia of B12 deficiency while nerve damage continues underneath, so low folate is not treated in isolation.",
  },
  {
    key: "iron",
    label: "Iron",
    biomarkers: ["Ferritin", "Iron"],
    direction: "low",
    supplements: [
      {
        name: "Iron (ferrous sulfate or ferrous bisglycinate)",
        matchTokens: [
          "iron",
          "ferrous sulfate",
          "ferrous fumarate",
          "ferrous gluconate",
          "ferrous bisglycinate",
          "iron bisglycinate",
        ],
        foodTiming: "empty_stomach",
        note: "Absorbed best away from food, with a vitamin-C source; tea, coffee, calcium and antacids all cut absorption.",
        // Polyvalent-cation chelation: the SAME curated rules the food engine cites.
        interactionKeys: [
          "dairy-levothyroxine",
          "dairy-tetracycline",
          "dairy-fluoroquinolone",
        ],
      },
    ],
    allergyAlternative: null,
    evidence:
      "Oral iron raises ferritin and refills iron stores; this is the standard repletion route for iron deficiency and the response is measured on the same test that found it.",
    source:
      "NIH Office of Dietary Supplements — Iron fact sheet; WHO guideline on iron supplementation",
    contraindications: [
      {
        // One term covers both spellings — "chromatosis" is a substring of
        // haemochromatosis and hemochromatosis alike, and of nothing else.
        match: "chromatosis",
        caution:
          "Haemochromatosis loads iron rather than losing it — supplemental iron is the wrong direction here.",
        severity: "drop",
      },
      {
        match: "iron overload",
        caution:
          "With iron overload, adding iron is the wrong direction — this is a clinician-guided restriction.",
        severity: "drop",
      },
      {
        // "thalass" covers thalassemia and thalassaemia.
        match: "thalass",
        caution:
          "Thalassaemia carries its own iron-loading risk — do not start iron without your clinician.",
        severity: "drop",
      },
    ],
    caveat:
      "A low ferritin is a finding with a cause, and the cause is worth explaining rather than only replacing — persistent or unexplained iron loss should be looked into. Iron is also the one substance here with a serious overdose risk, particularly for children in the house.",
  },
  {
    key: "magnesium",
    label: "Magnesium",
    biomarkers: ["Magnesium", "Magnesium, RBC"],
    direction: "low",
    supplements: [
      {
        name: "Magnesium (glycinate or citrate)",
        matchTokens: [
          "magnesium",
          "magnesium glycinate",
          "magnesium citrate",
          "magnesium oxide",
        ],
        foodTiming: "with_food",
        note: "The organic salts (glycinate, citrate) are absorbed better and are gentler on the gut than magnesium oxide.",
        interactionKeys: ["dairy-fluoroquinolone", "dairy-tetracycline"],
      },
    ],
    allergyAlternative: null,
    evidence:
      "A measured low magnesium rises on oral magnesium, and the better-absorbed organic salts do it with less of the laxative effect that limits the oxide form.",
    source: "NIH Office of Dietary Supplements — Magnesium fact sheet",
    // NOTE: chronic kidney disease is DELIBERATELY not repeated here — that rule lives in
    // CONDITION_NUTRIENT_RULES (derived from the food map) and the shared condition screen
    // already hard-drops supplemental magnesium for it.
    contraindications: [],
    caveat:
      "Serum magnesium is a narrow window on the body's total: most magnesium sits inside cells, so a normal level does not rule a shortfall out and a low one is worth rechecking.",
  },
  {
    key: "omega-3",
    label: "Omega-3 (EPA/DHA)",
    biomarkers: [
      "Omega-3 Total (OmegaCheck)",
      "Omega-3 EPA",
      "Omega-3 DHA",
      "Omega-3 DPA",
    ],
    direction: "low",
    supplements: [
      {
        name: "Fish or krill oil (EPA and DHA)",
        matchTokens: [
          "fish oil",
          "krill oil",
          "omega 3",
          "omega-3",
          "epa",
          "dha",
        ],
        foodTiming: "with_food",
        note: "Taken with a meal for absorption and to reduce the aftertaste.",
      },
    ],
    allergyAlternative: {
      name: "Algal oil (EPA and DHA from microalgae)",
      matchTokens: ["algal oil", "algae oil"],
      foodTiming: "with_food",
      note: "Supplies EPA and DHA directly without fish or shellfish.",
    },
    evidence:
      "The omega-3 index measures the EPA and DHA carried in red-cell membranes, and supplemental EPA/DHA raises exactly that, dose-dependently — the supplement and the measurement are the same substance.",
    source:
      "NIH Office of Dietary Supplements — Omega-3 Fatty Acids fact sheet",
    contraindications: [
      {
        match: "pregnan",
        caution:
          "In pregnancy, prefer a purified or algal source and keep to low-mercury species if you are getting omega-3s from fish.",
      },
    ],
    caveat:
      "This is a claim about the marker, not about outcomes: supplemental omega-3 reliably raises the index, while its effect on cardiovascular events remains debated. Oily fish gets you there too. Higher intakes can add to the effect of a blood thinner — worth raising with whoever prescribes it.",
  },
];

// Dataset-level metadata: none today. Declared for symmetry with the food map, whose
// meta carries the reduce table — this map has no second direction (see `direction`).
export type BiomarkerSupplementMapMeta = undefined;

export type BiomarkerSupplementMap = DatasetEnvelope<
  BiomarkerSupplementEntry,
  BiomarkerSupplementMapMeta
>;

// Pure builder: assemble the map from the curated table. The committed
// lib/datasets/data/biomarker-supplement-map.json is a FIXED POINT of this (guarded by
// the dataset test), so the generator and the committed file can't silently diverge.
export function buildBiomarkerSupplementMap(): BiomarkerSupplementMap {
  return {
    $schema: DATASET_SCHEMA,
    id: "biomarker-supplement-map",
    title: "Biomarker→supplement recommendation map",
    description:
      "Baked biomarker→supplement map for the DETERMINISTIC supplement-suggestion " +
      "engine (issue #2378), the twin of the biomarker→food map (#577): when a " +
      "biomarker family reads low, the curated supplement that repletes it, each with " +
      "an evidence note and a public source. Committed + HUMAN-REVIEWABLE. Regenerate " +
      "with `npm run gen:biomarker-supplement-map`. Deliberately SMALL — an uncovered " +
      "family falls through to the AI route and loses nothing. INFORMATIONAL, NOT " +
      "medical advice: NO entry states a dose, every suggestion is safety-screened " +
      "before it renders, and each cites the flagged biomarker as its reason.",
    citation: [
      {
        source: "NIH Office of Dietary Supplements (ODS) nutrient fact sheets",
        url: "https://ods.od.nih.gov/factsheets/list-all/",
        note: "Repletion and absorption guidance for each nutrient; every entry's own `source` field carries that mapping's specific provenance.",
      },
    ],
    identity: { keys: ["key"] },
    entries: ENTRIES,
  };
}

function writeDataset(): void {
  const dataset = buildBiomarkerSupplementMap();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(
    `Wrote ${dataset.entries.length} biomarker→supplement entries to ${OUT}`
  );
  console.log(
    "Review every mapping, its evidence line, and its source before committing — this table recommends an ingestible."
  );
}

// Run only as the CLI entry point — NOT when imported (the dataset drift test imports
// buildBiomarkerSupplementMap).
if (process.argv[1]?.includes("gen-biomarker-supplement-map")) {
  writeDataset();
}

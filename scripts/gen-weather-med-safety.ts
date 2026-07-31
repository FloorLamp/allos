// Pre-generate the baked med × WEATHER safety dataset
// (lib/datasets/data/weather-med-safety.json), used to enrich an existing UV or
// heatwave line when an ACTIVE medication or supplement interacts with the conditions
// (issue #1727) — the environmental sibling of the ototoxic (gen-ototoxic.ts), dental
// (gen-dental-safety.ts), contrast (gen-contrast-safety.ts), drug–drug
// (gen-drug-interactions.ts), and pharmacogenomics (gen-pgx.ts) cross-checks.
//
// TWO ATTRIBUTES, one table. Each entry declares which environmental exposure it is
// about, so one curated list serves both compositions:
//
//   • PHOTOSENSITIZING — drugs with well-documented drug-induced photosensitivity
//     (phototoxic or photoallergic): TETRACYCLINES (doxycycline especially),
//     FLUOROQUINOLONES, THIAZIDE diuretics (hydrochlorothiazide), AMIODARONE,
//     ISOTRETINOIN and other systemic retinoids, SULFONAMIDE antibacterials, oral
//     NSAIDs of the propionic class (piroxicam, naproxen), VORICONAZOLE, and
//     ST JOHN'S WORT — which is a SUPPLEMENT, and is in the list precisely because
//     this check is kind-blind by construction: the sun does not care which surface
//     of the app an item was entered on.
//
//   • HEAT-RISK — drugs that impair thermoregulation or promote dehydration and so
//     raise heat-illness risk during a heatwave: DIURETICS (volume loss),
//     ANTICHOLINERGICS incl. sedating antihistamines and tricyclics (reduced
//     sweating), BETA-BLOCKERS (blunted cardiovascular heat response), STIMULANTS
//     incl. ADHD agents (increased heat production), ANTIPSYCHOTICS (impaired central
//     thermoregulation), and SGLT2 INHIBITORS (osmotic volume loss).
//
// SOURCING / LICENSE: a small CURATED table, NOT an exhaustive reference. The
// uncopyrightable clinical FACTS (this drug class causes photosensitivity; this class
// impairs thermoregulation) are stated in our own words and CITED to their public
// source; drug generic/brand names are public nomenclature. Membership is deliberately
// CONSERVATIVE — a class earns a row only when the association is well established in
// public guidance, because a heat/sun caution that fires on half a medicine cabinet
// teaches people to ignore it. NO AI-GENERATED MEMBERSHIP: every row below was chosen
// and cited by hand, and reviewing this table is the actual work of this dataset.
//
// EVERYTHING HERE IS INFORMATIONAL, NEVER PRESCRIPTIVE. A note flags a precaution to
// take and a conversation to have with the prescriber — it never says "stop your drug",
// never blocks anything, and the ABSENCE of a flag is NOT clearance (a curated subset;
// an unrecognized drug carries no flag). Fully OFFLINE — the table is baked here and
// shipped in the repo; no medication name is ever sent to any external API.
//
// GENERATION: mirrors gen-ototoxic.ts — the curated constants below are the SOURCE OF
// TRUTH, the JSON is GENERATED from them and COMMITTED, and is never hand-edited. Edit
// the table below and re-run:
//
//   npm run gen:weather-med-safety
//
// The committed lib/datasets/data/weather-med-safety.json is a FIXED POINT of
// buildWeatherMedSafetyDataset() (guarded by
// lib/__tests__/weather-med-safety-dataset.test.ts) so the generator and the file can't
// silently diverge. Emitted with `JSON.stringify(dataset, null, 2)`, matching Prettier's
// JSON formatting.

import fs from "node:fs";
import path from "node:path";
import { DATASET_SCHEMA, type DatasetEnvelope } from "../lib/datasets/types";

const OUT = path.join(
  process.cwd(),
  "lib",
  "datasets",
  "data",
  "weather-med-safety.json"
);

// Which environmental exposure an entry is about. The composition layer reads this to
// decide which condition the entry pairs with — sun for `photosensitizing`, a heatwave
// for `heat-risk`.
export type WeatherExposure = "photosensitizing" | "heat-risk";

// One framework entry: a DRUG concept the cross-check detects in the active stack,
// matched by RxNorm ingredient CUI + synonym (the shared matchConceptKeysIn machinery,
// #482). Structurally a superset of drug-interactions' `Concept`
// ({key,label,rxcuis,synonyms}) so it feeds that matcher directly; `exposure` selects
// the composition and `note`/`source` are the finding copy.
export interface WeatherMedEntry {
  key: string;
  exposure: WeatherExposure;
  label: string;
  rxcuis: string[];
  synonyms: string[];
  // The SHORT clause used when the fact is folded into an existing line ("increases sun
  // sensitivity"). Kept separate from `note` because the enriched-line copy has to stay
  // one clause long — a paragraph would drown the line it is enriching.
  clause: string;
  // The fuller informational note for the standalone calm line.
  note: string;
  source: string;
}

export interface WeatherMedMeta {
  version: number;
}

export type WeatherMedDataset = DatasetEnvelope<
  WeatherMedEntry,
  WeatherMedMeta
>;

// Normalize a synonym for storage + matching: lowercased, non-alphanumerics collapsed
// to single spaces, trimmed — the SAME normalization the drug-interaction matcher uses.
export function normalizeSynonym(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function norm(list: string[]): string[] {
  return [...new Set(list.map(normalizeSynonym))].filter(Boolean).sort();
}

const FDA_PHOTO =
  "U.S. FDA — The Sun and Your Medicine (drug-induced photosensitivity)";
const DAILYMED =
  "U.S. NLM DailyMed — FDA-approved labeling (photosensitivity warnings)";
const CDC_HEAT =
  "U.S. CDC — Heat and Medications / Heat-Related Illness guidance";
const NIH_HEAT =
  "U.S. NIH NIA — Hot Weather Safety for Older Adults; CDC heat guidance";
const NCCIH_SJW =
  "U.S. NIH NCCIH — St. John's Wort; DailyMed labeling (photosensitivity)";

// The GUARDRAIL suffix belongs to the DOMAIN layer (lib/weather-med-safety.ts), NOT the
// note here, so a note is just the class-specific fact stated in our own words.
const ENTRIES: WeatherMedEntry[] = [
  // ---- Photosensitizing --------------------------------------------------------
  {
    key: "tetracycline",
    exposure: "photosensitizing",
    label: "Tetracycline antibiotics (doxycycline, minocycline, tetracycline)",
    rxcuis: [],
    synonyms: [
      "doxycycline",
      "vibramycin",
      "doryx",
      "oracea",
      "adoxa",
      "minocycline",
      "minocin",
      "solodyn",
      "tetracycline",
      "demeclocycline",
      "sarecycline",
    ],
    clause: "increases sun sensitivity",
    note: "Tetracycline antibiotics — doxycycline most of all — are among the best-documented causes of drug-induced photosensitivity: skin can burn faster and at lower sun exposure than usual.",
    source: FDA_PHOTO,
  },
  {
    key: "fluoroquinolone",
    exposure: "photosensitizing",
    label: "Fluoroquinolone antibiotics (ciprofloxacin, levofloxacin)",
    rxcuis: [],
    synonyms: [
      "ciprofloxacin",
      "cipro",
      "levofloxacin",
      "levaquin",
      "ofloxacin",
      "moxifloxacin",
      "avelox",
      "norfloxacin",
      "fluoroquinolone",
    ],
    clause: "can increase sun sensitivity",
    note: "Fluoroquinolone antibiotics carry a labeled photosensitivity warning; sun exposure during a course can produce an exaggerated sunburn reaction.",
    source: DAILYMED,
  },
  {
    key: "thiazide_diuretic",
    exposure: "photosensitizing",
    label: "Thiazide diuretics (hydrochlorothiazide, chlorthalidone)",
    rxcuis: [],
    synonyms: [
      "hydrochlorothiazide",
      "hctz",
      "microzide",
      "chlorthalidone",
      "indapamide",
      "metolazone",
      "thiazide",
    ],
    clause: "increases sun sensitivity",
    note: "Thiazide diuretics, hydrochlorothiazide in particular, are a well-documented cause of drug-induced photosensitivity with long-term use.",
    source: FDA_PHOTO,
  },
  {
    key: "amiodarone",
    exposure: "photosensitizing",
    label: "Amiodarone",
    rxcuis: [],
    synonyms: ["amiodarone", "cordarone", "pacerone", "nexterone"],
    clause: "increases sun sensitivity",
    note: "Amiodarone causes photosensitivity in a substantial share of people taking it, and prolonged exposure can leave lasting skin discoloration.",
    source: DAILYMED,
  },
  {
    key: "systemic_retinoid",
    exposure: "photosensitizing",
    label: "Systemic retinoids (isotretinoin, acitretin)",
    rxcuis: [],
    synonyms: [
      "isotretinoin",
      "accutane",
      "absorica",
      "claravis",
      "amnesteem",
      "acitretin",
      "soriatane",
    ],
    clause: "increases sun sensitivity",
    note: "Systemic retinoids thin the outer skin layer and are labeled for increased sensitivity to sunlight.",
    source: DAILYMED,
  },
  {
    key: "sulfonamide",
    exposure: "photosensitizing",
    label: "Sulfonamide antibacterials (sulfamethoxazole/trimethoprim)",
    rxcuis: [],
    synonyms: [
      "sulfamethoxazole",
      "trimethoprim sulfamethoxazole",
      "bactrim",
      "septra",
      "cotrimoxazole",
      "sulfadiazine",
      "sulfisoxazole",
    ],
    clause: "can increase sun sensitivity",
    note: "Sulfonamide antibacterials carry a labeled photosensitivity warning.",
    source: DAILYMED,
  },
  {
    key: "photosensitizing_nsaid",
    exposure: "photosensitizing",
    label: "Photosensitizing NSAIDs (piroxicam, naproxen)",
    rxcuis: [],
    synonyms: [
      "piroxicam",
      "feldene",
      "naproxen",
      "naprosyn",
      "aleve",
      "ketoprofen",
    ],
    clause: "can increase sun sensitivity",
    note: "Some NSAIDs — piroxicam and naproxen most notably — are documented photosensitizers, unlike the class as a whole.",
    source: FDA_PHOTO,
  },
  {
    key: "voriconazole",
    exposure: "photosensitizing",
    label: "Voriconazole",
    rxcuis: [],
    synonyms: ["voriconazole", "vfend"],
    clause: "increases sun sensitivity",
    note: "Voriconazole causes marked photosensitivity, and its labeling advises avoiding strong direct sunlight during treatment.",
    source: DAILYMED,
  },
  {
    key: "st_johns_wort",
    exposure: "photosensitizing",
    label: "St John's Wort",
    rxcuis: [],
    // Both spellings: the shared matcher collapses non-alphanumerics to spaces, so
    // "St. John's Wort" normalizes to "st john s wort" while a bare "St Johns Wort"
    // normalizes to "st johns wort". Carrying both means either way a user types it
    // matches.
    synonyms: [
      "St John's Wort",
      "St Johns Wort",
      "hypericum",
      "hypericum perforatum",
    ],
    clause: "can increase sun sensitivity",
    note: "St John's Wort can increase sensitivity to sunlight, particularly at higher doses — a supplement with a drug-like photosensitizing effect.",
    source: NCCIH_SJW,
  },
  // ---- Heat-risk ---------------------------------------------------------------
  {
    key: "diuretic_heat",
    exposure: "heat-risk",
    label: "Diuretics (loop and thiazide)",
    rxcuis: [],
    synonyms: [
      "furosemide",
      "lasix",
      "bumetanide",
      "bumex",
      "torsemide",
      "hydrochlorothiazide",
      "hctz",
      "chlorthalidone",
      "indapamide",
      "spironolactone",
      "aldactone",
      "diuretic",
    ],
    clause: "can add to dehydration risk in heat",
    note: "Diuretics increase fluid loss, which compounds the dehydration a hot spell already causes.",
    source: CDC_HEAT,
  },
  {
    key: "anticholinergic_heat",
    exposure: "heat-risk",
    label: "Anticholinergics (sedating antihistamines, tricyclics, oxybutynin)",
    rxcuis: [],
    synonyms: [
      "diphenhydramine",
      "benadryl",
      "hydroxyzine",
      "atarax",
      "vistaril",
      "chlorpheniramine",
      "amitriptyline",
      "nortriptyline",
      "doxepin",
      "oxybutynin",
      "ditropan",
      "tolterodine",
      "benztropine",
      "scopolamine",
    ],
    clause: "can reduce sweating in heat",
    note: "Anticholinergic medicines reduce sweating, which is the body's main way of shedding heat.",
    source: CDC_HEAT,
  },
  {
    key: "beta_blocker_heat",
    exposure: "heat-risk",
    label: "Beta-blockers (metoprolol, atenolol, propranolol)",
    rxcuis: [],
    synonyms: [
      "metoprolol",
      "lopressor",
      "toprol",
      "atenolol",
      "tenormin",
      "propranolol",
      "inderal",
      "bisoprolol",
      "carvedilol",
      "coreg",
      "nebivolol",
      "beta blocker",
    ],
    clause: "can blunt the body's heat response",
    note: "Beta-blockers blunt the increase in heart rate and skin blood flow the body uses to shed heat, so hot weather is harder to compensate for.",
    source: NIH_HEAT,
  },
  {
    key: "stimulant_heat",
    exposure: "heat-risk",
    label: "Stimulants (amphetamines, methylphenidate)",
    rxcuis: [],
    synonyms: [
      "amphetamine",
      "dextroamphetamine",
      "adderall",
      "vyvanse",
      "lisdexamfetamine",
      "methylphenidate",
      "ritalin",
      "concerta",
      "modafinil",
    ],
    clause: "can raise heat production",
    note: "Stimulants raise body heat production and can mask the tiredness that would otherwise be a cue to stop.",
    source: CDC_HEAT,
  },
  {
    key: "antipsychotic_heat",
    exposure: "heat-risk",
    label: "Antipsychotics (olanzapine, risperidone, quetiapine)",
    rxcuis: [],
    synonyms: [
      "olanzapine",
      "zyprexa",
      "risperidone",
      "risperdal",
      "quetiapine",
      "seroquel",
      "haloperidol",
      "haldol",
      "aripiprazole",
      "abilify",
      "clozapine",
      "chlorpromazine",
    ],
    clause: "can impair temperature regulation",
    note: "Antipsychotics can interfere with the brain's temperature regulation and with sweating, raising heat-illness risk in a hot spell.",
    source: CDC_HEAT,
  },
  {
    key: "sglt2_heat",
    exposure: "heat-risk",
    label: "SGLT2 inhibitors (empagliflozin, dapagliflozin)",
    rxcuis: [],
    synonyms: [
      "empagliflozin",
      "jardiance",
      "dapagliflozin",
      "farxiga",
      "canagliflozin",
      "invokana",
      "ertugliflozin",
    ],
    clause: "can add to dehydration risk in heat",
    note: "SGLT2 inhibitors increase urinary fluid loss, which adds to the dehydration risk of a hot spell.",
    source: CDC_HEAT,
  },
];

export function buildWeatherMedSafetyDataset(): WeatherMedDataset {
  const entries: WeatherMedEntry[] = ENTRIES.map((d) => ({
    key: d.key,
    exposure: d.exposure,
    label: d.label,
    rxcuis: [...new Set(d.rxcuis)].sort(),
    synonyms: norm(d.synonyms),
    clause: d.clause,
    note: d.note,
    source: d.source,
  })).sort((a, b) => a.key.localeCompare(b.key));

  return {
    $schema: DATASET_SCHEMA,
    id: "weather-med-safety",
    title: "Medication × weather safety",
    description:
      "Baked medication/supplement × WEATHER safety dataset (issue #1727) — the " +
      "curated attribute lists behind two compositions: PHOTOSENSITIZING items " +
      "(tetracyclines, fluoroquinolones, thiazides, amiodarone, systemic retinoids, " +
      "sulfonamides, some NSAIDs, voriconazole, St John's Wort) enrich the existing " +
      "high-UV line, and HEAT-RISK items (diuretics, anticholinergics, beta-blockers, " +
      "stimulants, antipsychotics, SGLT2 inhibitors) enrich the heatwave line. Items " +
      "match by RxNorm ingredient CUI + synonym (the shared machinery) and the check is " +
      "KIND-BLIND — a supplement can be a photosensitizer. INFORMATIONAL, never " +
      "prescriptive; the absence of a flag is NOT clearance (a curated subset). Fully " +
      "OFFLINE. Committed + HUMAN-REVIEWABLE; regenerate with " +
      "`npm run gen:weather-med-safety`.",
    citation: [
      {
        source: FDA_PHOTO,
        url: "https://www.fda.gov/drugs/special-features/sun-and-your-medicine",
        note: "Uncopyrightable clinical facts (these drug classes cause photosensitivity) stated in our own words and cited to the FDA consumer reference. Drug generic/brand names are public nomenclature.",
      },
      {
        source: DAILYMED,
        url: "https://dailymed.nlm.nih.gov/dailymed/",
        note: "Photosensitivity warnings appear in the FDA-approved labeling for these agents; facts restated in our own words.",
      },
      {
        source: CDC_HEAT,
        url: "https://www.cdc.gov/heat-health/",
        note: "Public-health guidance that these medication classes raise heat-illness risk, stated in our own words.",
      },
      {
        source: NIH_HEAT,
        url: "https://www.nia.nih.gov/health/safety/hot-weather-safety-older-adults",
        note: "NIH consumer guidance on heat risk including medication effects, stated in our own words.",
      },
      {
        source: NCCIH_SJW,
        url: "https://www.nccih.nih.gov/health/st-johns-wort",
        note: "NIH reference for St John's Wort, including increased sun sensitivity; stated in our own words.",
      },
    ],
    identity: { keys: ["key"] },
    meta: { version: 1 },
    entries,
  };
}

function writeDataset(): void {
  const dataset = buildWeatherMedSafetyDataset();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(
    `Wrote ${dataset.entries.length} weather-med safety entries to ${OUT}`
  );
  console.log("Review the table for plausibility before committing.");
}

// Run only as the CLI entry point — NOT when imported (the dataset drift test imports
// buildWeatherMedSafetyDataset).
if (process.argv[1]?.includes("gen-weather-med-safety")) {
  writeDataset();
}

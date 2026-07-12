// Pre-generate the baked drug-/supplement-interaction dataset
// (lib/drug-interactions.json), used to flag when two ACTIVE items in a profile's
// supplement + medication stack are known to interact (issue #144).
//
// SOURCING / LICENSE
// ------------------
// This is a CURATED, HIGH-VALUE subset of well-established interactions, NOT an
// exhaustive interaction database. The facts (which pairs interact, the severity,
// the one-line mechanism) are drawn from PUBLIC, license-clean clinical references:
//
//   • FDA Structured Product Labeling / DailyMed — the `drug_interactions` section
//     of a drug's official label is a PUBLIC-DOMAIN U.S. Government work, also served
//     by openFDA (https://open.fda.gov/apis/drug/label/). Public domain.
//   • NIH MedlinePlus / NLM LiverTox — public-domain U.S. Government health refs.
//   • RxNorm (NLM) — the ingredient RxCUIs below are from RxNorm, a public-domain
//     U.S. Government normalized drug vocabulary (https://www.nlm.nih.gov/research/
//     umls/rxnorm/). Public domain.
//
// We deliberately DO NOT vendor a copyrighted commercial interaction database
// (Micromedex, Lexicomp, First Databank, Multum): those are licensed products whose
// terms are incompatible with shipping the data in an AGPL repo. The curated pairs
// here are common, textbook interactions any clinical reference states plainly.
//
// EVERYTHING HERE IS INFORMATIONAL, NEVER PRESCRIPTIVE. A flag means "this pair is
// known to interact — discuss with your prescriber/pharmacist", not "stop taking X".
// It is not a substitute for a pharmacist's review and is not exhaustive: the absence
// of a flag does NOT mean a combination is safe.
//
// GENERATION
// ----------
// Mirrors gen-icd10.ts / gen-dri.ts: the curated constants below are the SOURCE OF
// TRUTH, the JSON is GENERATED from them and COMMITTED, and it is never hand-edited.
// Edit the tables below and re-run:
//
//   npm run gen:interactions
//
// The committed lib/drug-interactions.json is a FIXED POINT of
// buildDrugInteractionsDataset() (guarded by lib/__tests__/drug-interactions-dataset
// .test.ts) so the generator and the file can't silently diverge. lib/drug-interactions
// .json is in .prettierignore — prettier reformatting would break the fixed-point
// string compare.

import fs from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "lib", "drug-interactions.json");

export type Severity = "major" | "moderate" | "minor";

// A drug/supplement CONCEPT — an ingredient or an ingredient CLASS (e.g. "nsaid",
// "ssri"). An active intake item resolves to a concept by RxCUI (authoritative) or,
// failing that, by a name/synonym match. Class concepts let one interaction rule
// (warfarin × NSAID) cover every member (ibuprofen, naproxen, …).
export interface RawConcept {
  key: string; // stable identity — interactions reference this; ids/keys never recycle
  label: string; // human display, e.g. "NSAIDs (ibuprofen, naproxen, …)"
  rxcuis: string[]; // RxNorm ingredient CUIs that map to this concept (authoritative)
  synonyms: string[]; // lay/brand names for the name-fallback matcher (no RxCUI)
}

// A known interaction between two concepts, severity-ranked, with a one-line
// mechanism and a citation. `a`/`b` reference RawConcept.key.
export interface RawInteraction {
  a: string;
  b: string;
  severity: Severity;
  mechanism: string; // one line: what happens / why
  source: string; // citation
}

// ---- Concept vocabulary --------------------------------------------------
// RxCUIs are RxNorm INGREDIENT concepts (public domain). Synonyms are lowercased by
// the builder; include generic + common US brand names for name-fallback matching.
//
// COMBINATION BRANDS (issue #279): a combination product sold under its OWN brand
// name ("Hyzaar" = losartan/HCTZ, "Vytorin" = ezetimibe/simvastatin) contains no
// member-ingredient token, so the name fallback never resolved it — list such a
// brand as a synonym under EVERY concept one of its ingredients belongs to (e.g.
// "glucovance" under both metformin and sulfonylurea). "Brand HCT"-style suffixed
// names (Diovan HCT) already match through the base brand token and need no entry.
// Slash/space-joined generic names ("losartan/hydrochlorothiazide") also already
// match — the normalizer collapses punctuation, so each ingredient token matches.
const CONCEPTS: RawConcept[] = [
  // Anticoagulants / antiplatelets
  {
    key: "warfarin",
    label: "Warfarin",
    rxcuis: ["11289"],
    synonyms: ["warfarin", "coumadin", "jantoven"],
  },
  {
    key: "doac",
    label: "Direct oral anticoagulants (apixaban, rivaroxaban, dabigatran)",
    rxcuis: ["1364430", "1114195", "1037045"],
    synonyms: [
      "apixaban",
      "eliquis",
      "rivaroxaban",
      "xarelto",
      "dabigatran",
      "pradaxa",
      "edoxaban",
      "savaysa",
    ],
  },
  {
    key: "clopidogrel",
    label: "Clopidogrel",
    rxcuis: ["32968"],
    synonyms: ["clopidogrel", "plavix"],
  },
  {
    key: "aspirin",
    label: "Aspirin",
    rxcuis: ["1191"],
    synonyms: ["aspirin", "acetylsalicylic acid", "asa", "ecotrin", "bayer"],
  },
  // NSAIDs (class)
  {
    key: "nsaid",
    label: "NSAIDs (ibuprofen, naproxen, diclofenac, …)",
    rxcuis: ["5640", "7258", "3355", "35827", "5781", "41493", "140587"],
    synonyms: [
      "ibuprofen",
      "advil",
      "motrin",
      "naproxen",
      "aleve",
      "naprosyn",
      "diclofenac",
      "voltaren",
      "ketorolac",
      "toradol",
      "indomethacin",
      "meloxicam",
      "mobic",
      "celecoxib",
      "celebrex",
      "nsaid",
      // Combination brand containing an NSAID (issue #279).
      "treximet", // sumatriptan/naproxen — also under triptan
    ],
  },
  // Antidepressants / serotonergic
  {
    key: "ssri",
    label: "SSRIs (sertraline, fluoxetine, citalopram, …)",
    rxcuis: ["36437", "4493", "32937", "2556", "321988", "42355"],
    synonyms: [
      "sertraline",
      "zoloft",
      "fluoxetine",
      "prozac",
      "paroxetine",
      "paxil",
      "citalopram",
      "celexa",
      "escitalopram",
      "lexapro",
      "fluvoxamine",
      "luvox",
      "ssri",
    ],
  },
  {
    key: "snri",
    label: "SNRIs (venlafaxine, duloxetine)",
    rxcuis: ["39786", "72625", "15996"],
    synonyms: [
      "venlafaxine",
      "effexor",
      "duloxetine",
      "cymbalta",
      "desvenlafaxine",
      "pristiq",
      "snri",
    ],
  },
  {
    key: "maoi",
    label: "MAO inhibitors (phenelzine, tranylcypromine, selegiline)",
    rxcuis: ["8123", "10734", "36117", "6011"],
    synonyms: [
      "phenelzine",
      "nardil",
      "tranylcypromine",
      "parnate",
      "selegiline",
      "emsam",
      "isocarboxazid",
      "marplan",
      "maoi",
      "linezolid",
    ],
  },
  {
    key: "tramadol",
    label: "Tramadol",
    rxcuis: ["10689"],
    synonyms: ["tramadol", "ultram", "conzip"],
  },
  {
    key: "triptan",
    label: "Triptans (sumatriptan, rizatriptan, …)",
    rxcuis: ["37418", "36960"],
    synonyms: [
      "sumatriptan",
      "imitrex",
      "rizatriptan",
      "maxalt",
      "triptan",
      "eletriptan",
      "relpax",
      // Combination brand containing a triptan (issue #279).
      "treximet", // sumatriptan/naproxen — also under nsaid
    ],
  },
  // Cardiac / metabolic
  {
    // CYP3A4-MAJOR statins only — simvastatin/lovastatin exposure rises sharply
    // with a CYP3A4 inhibitor (major myopathy risk). Atorvastatin, a CYP3A4
    // substrate with a much smaller effect, is split into its own concept below
    // so it isn't mislabeled "major" with a macrolide/azole (issue #437).
    key: "statin",
    label: "Statins strongly affected by CYP3A4 (simvastatin, lovastatin)",
    rxcuis: ["36567", "6472"],
    synonyms: [
      "simvastatin",
      "zocor",
      "lovastatin",
      "mevacor",
      // Combination brand containing a CYP3A4-major statin (issue #279).
      "vytorin", // ezetimibe/simvastatin
    ],
  },
  {
    // Atorvastatin — a CYP3A4 substrate, but the interaction magnitude with
    // CYP3A4 inhibitors is moderate, not major (issue #437). Kept separate from
    // `statin` so the severities differ correctly.
    key: "atorvastatin",
    label: "Atorvastatin",
    rxcuis: ["83367"],
    synonyms: [
      "atorvastatin",
      "lipitor",
      // Combination brand containing atorvastatin (issue #279).
      "caduet", // amlodipine/atorvastatin
    ],
  },
  {
    key: "gemfibrozil",
    label: "Gemfibrozil",
    rxcuis: ["4719"],
    synonyms: ["gemfibrozil", "lopid"],
  },
  {
    key: "macrolide",
    label: "Macrolide antibiotics (clarithromycin, erythromycin)",
    rxcuis: ["21212", "4053"],
    synonyms: [
      "clarithromycin",
      "biaxin",
      "erythromycin",
      "ery-tab",
      "macrolide",
    ],
  },
  {
    key: "azole_antifungal",
    label: "Azole antifungals (ketoconazole, itraconazole, fluconazole)",
    rxcuis: ["6135", "28031", "4450"],
    synonyms: [
      "ketoconazole",
      "itraconazole",
      "sporanox",
      "fluconazole",
      "diflucan",
      "voriconazole",
      "posaconazole",
    ],
  },
  {
    key: "digoxin",
    label: "Digoxin",
    rxcuis: ["3407"],
    synonyms: ["digoxin", "lanoxin"],
  },
  {
    key: "lithium",
    label: "Lithium",
    rxcuis: ["6448"],
    synonyms: ["lithium", "lithobid", "eskalith"],
  },
  {
    key: "loop_thiazide_diuretic",
    label: "Loop / thiazide diuretics (furosemide, hydrochlorothiazide, …)",
    rxcuis: ["4603", "5487"],
    synonyms: [
      "furosemide",
      "lasix",
      "torsemide",
      "bumetanide",
      "bumex",
      "hydrochlorothiazide",
      "hctz",
      "chlorthalidone",
      "indapamide",
      "metolazone",
      "thiazide",
      "loop diuretic",
    ],
  },
  {
    key: "allopurinol",
    label: "Allopurinol",
    rxcuis: ["519"],
    synonyms: ["allopurinol", "zyloprim", "aloprim"],
  },
  {
    key: "azathioprine",
    label: "Azathioprine",
    rxcuis: ["1256"],
    synonyms: ["azathioprine", "imuran", "azasan"],
  },
  {
    key: "acetaminophen",
    label: "Acetaminophen (paracetamol)",
    rxcuis: ["161"],
    synonyms: ["acetaminophen", "tylenol", "paracetamol", "apap"],
  },
  {
    key: "methotrexate",
    label: "Methotrexate",
    rxcuis: ["6851"],
    synonyms: ["methotrexate", "trexall", "otrexup", "rasuvo", "mtx"],
  },
  {
    key: "ace_arb",
    label: "ACE inhibitors / ARBs (lisinopril, losartan, …)",
    rxcuis: ["29046", "3827", "52175", "83515"],
    synonyms: [
      "lisinopril",
      "zestril",
      "prinivil",
      "enalapril",
      "vasotec",
      "ramipril",
      "altace",
      "losartan",
      "cozaar",
      "valsartan",
      "diovan",
      "benazepril",
      "lotensin",
      // Combination brands containing an ACE inhibitor/ARB (issue #279) — the
      // combo name carries no ingredient token, so it must be listed itself.
      "zestoretic", // lisinopril/HCTZ
      "prinzide", // lisinopril/HCTZ
      "hyzaar", // losartan/HCTZ
      "vaseretic", // enalapril/HCTZ
      "lotrel", // amlodipine/benazepril
      "entresto", // sacubitril/valsartan
    ],
  },
  {
    key: "potassium_sparing_diuretic",
    label: "Potassium-sparing diuretics (spironolactone, triamterene)",
    rxcuis: ["9997", "10763", "644"],
    synonyms: [
      "spironolactone",
      "aldactone",
      "triamterene",
      "amiloride",
      "eplerenone",
      "inspra",
      // Combination brands containing a potassium-sparing diuretic (issue #279).
      "aldactazide", // spironolactone/HCTZ
      "dyazide", // triamterene/HCTZ
      "maxzide", // triamterene/HCTZ
    ],
  },
  {
    key: "ppi",
    label: "Proton-pump inhibitors (omeprazole, esomeprazole, …)",
    rxcuis: ["7646", "283742", "40790"],
    synonyms: [
      "omeprazole",
      "prilosec",
      "esomeprazole",
      "nexium",
      "pantoprazole",
      "protonix",
      "lansoprazole",
      "prevacid",
    ],
  },
  {
    key: "levothyroxine",
    label: "Levothyroxine",
    rxcuis: ["10582"],
    synonyms: [
      "levothyroxine",
      "synthroid",
      "levoxyl",
      "unithroid",
      "euthyrox",
      "thyroxine",
    ],
  },
  {
    key: "metformin",
    label: "Metformin",
    rxcuis: ["6809"],
    synonyms: [
      "metformin",
      "glucophage",
      "fortamet",
      // Combination brands containing metformin (issue #279).
      "glucovance", // glyburide/metformin — also under sulfonylurea
      "janumet", // sitagliptin/metformin
    ],
  },
  {
    key: "sulfonylurea",
    label: "Sulfonylureas (glipizide, glyburide, …)",
    rxcuis: ["4821", "25789"],
    synonyms: [
      "glipizide",
      "glucotrol",
      "glyburide",
      "glimepiride",
      "amaryl",
      // Combination brand containing a sulfonylurea (issue #279).
      "glucovance", // glyburide/metformin — also under metformin
    ],
  },
  {
    key: "nitrate",
    label: "Nitrates (nitroglycerin, isosorbide)",
    rxcuis: ["7417", "24947"],
    synonyms: [
      "nitroglycerin",
      "nitrostat",
      "isosorbide",
      "imdur",
      "isordil",
      "nitrate",
    ],
  },
  {
    key: "pde5_inhibitor",
    label: "PDE5 inhibitors (sildenafil, tadalafil)",
    rxcuis: ["136411", "358263"],
    synonyms: [
      "sildenafil",
      "viagra",
      "revatio",
      "tadalafil",
      "cialis",
      "vardenafil",
      "levitra",
    ],
  },
  {
    key: "benzodiazepine",
    label: "Benzodiazepines (alprazolam, diazepam, lorazepam)",
    rxcuis: ["596", "3322", "6470", "2598"],
    synonyms: [
      "alprazolam",
      "xanax",
      "diazepam",
      "valium",
      "lorazepam",
      "ativan",
      "clonazepam",
      "klonopin",
      "temazepam",
    ],
  },
  {
    key: "opioid",
    label: "Opioids (oxycodone, hydrocodone, morphine, …)",
    rxcuis: ["7804", "5489", "7052", "4337"],
    synonyms: [
      "oxycodone",
      "oxycontin",
      "percocet",
      "hydrocodone",
      "norco",
      "vicodin",
      "morphine",
      "ms contin",
      "fentanyl",
      "codeine",
      "hydromorphone",
      "dilaudid",
    ],
  },
  // Supplements & foods (the combined-tracker edge)
  {
    key: "st_johns_wort",
    label: "St. John's Wort",
    rxcuis: [],
    synonyms: [
      "st johns wort",
      "st john s wort",
      "hypericum",
      "hypericum perforatum",
    ],
  },
  {
    key: "vitamin_k",
    label: "Vitamin K",
    rxcuis: [],
    synonyms: [
      "vitamin k",
      "vitamin k1",
      "vitamin k2",
      "phytonadione",
      "menaquinone",
      "mk-7",
    ],
  },
  {
    key: "vitamin_e",
    label: "Vitamin E",
    rxcuis: [],
    synonyms: [
      "vitamin e",
      "tocopherol",
      "alpha-tocopherol",
      "d-alpha tocopherol",
    ],
  },
  {
    key: "fish_oil",
    label: "Fish oil / omega-3",
    rxcuis: [],
    synonyms: [
      "fish oil",
      "omega-3",
      "omega 3",
      "epa",
      "dha",
      "krill oil",
      "cod liver oil",
    ],
  },
  {
    key: "ginkgo",
    label: "Ginkgo biloba",
    rxcuis: [],
    synonyms: ["ginkgo", "ginkgo biloba"],
  },
  {
    key: "garlic",
    label: "Garlic (concentrated)",
    rxcuis: [],
    synonyms: ["garlic", "allium sativum", "aged garlic extract"],
  },
  {
    key: "calcium",
    label: "Calcium",
    rxcuis: [],
    synonyms: [
      "calcium",
      "calcium carbonate",
      "calcium citrate",
      "coral calcium",
    ],
  },
  {
    key: "iron",
    label: "Iron",
    rxcuis: [],
    synonyms: [
      "iron",
      "ferrous sulfate",
      "ferrous gluconate",
      "ferrous fumarate",
      "iron bisglycinate",
    ],
  },
  {
    key: "magnesium",
    label: "Magnesium",
    rxcuis: [],
    synonyms: [
      "magnesium",
      "magnesium glycinate",
      "magnesium citrate",
      "magnesium oxide",
    ],
  },
  {
    key: "zinc",
    label: "Zinc",
    rxcuis: [],
    synonyms: ["zinc", "zinc gluconate", "zinc picolinate"],
  },
  {
    key: "potassium",
    label: "Potassium",
    rxcuis: [],
    synonyms: [
      "potassium",
      "potassium chloride",
      "potassium citrate",
      "klor-con",
    ],
  },
  {
    key: "coq10",
    label: "Coenzyme Q10",
    rxcuis: [],
    synonyms: ["coenzyme q10", "coq10", "ubiquinone", "ubiquinol"],
  },
  {
    key: "sam_e",
    label: "SAM-e",
    rxcuis: [],
    synonyms: ["sam-e", "sam e", "s-adenosylmethionine", "ademetionine"],
  },
  {
    key: "five_htp",
    label: "5-HTP",
    rxcuis: [],
    synonyms: ["5-htp", "5 htp", "5-hydroxytryptophan", "griffonia"],
  },
  {
    key: "oral_contraceptive",
    label: "Oral contraceptives",
    rxcuis: [],
    synonyms: [
      "oral contraceptive",
      "birth control",
      "ethinyl estradiol",
      "levonorgestrel",
      "norethindrone",
      "drospirenone",
    ],
  },
];

// ---- Interaction rules ----------------------------------------------------
// Common, textbook interactions. Class concepts (nsaid/ssri/…) fan each rule out to
// every member. Severity: major = potentially serious, avoid/close-monitor;
// moderate = clinically significant, usually manageable; minor = minor/monitor.
const INTERACTIONS: RawInteraction[] = [
  // ---- Bleeding risk with anticoagulants/antiplatelets ----
  {
    a: "warfarin",
    b: "nsaid",
    severity: "major",
    mechanism:
      "NSAIDs add antiplatelet and GI-mucosal injury on top of anticoagulation, sharply raising the risk of serious (especially GI) bleeding.",
    source: "FDA warfarin & ibuprofen prescribing information (DailyMed)",
  },
  {
    a: "warfarin",
    b: "aspirin",
    severity: "major",
    mechanism:
      "Aspirin's antiplatelet effect plus warfarin's anticoagulation markedly increases bleeding risk; combined use should be clinician-directed.",
    source: "FDA warfarin prescribing information (DailyMed)",
  },
  {
    a: "warfarin",
    b: "ssri",
    severity: "moderate",
    mechanism:
      "SSRIs impair platelet aggregation and can raise the INR, increasing bleeding risk when combined with warfarin.",
    source: "NIH MedlinePlus; FDA SSRI labeling",
  },
  {
    a: "warfarin",
    b: "fish_oil",
    severity: "moderate",
    mechanism:
      "High-dose omega-3 fatty acids have a mild antiplatelet effect that can add to warfarin's bleeding risk.",
    source: "NIH Office of Dietary Supplements — Omega-3 fact sheet",
  },
  {
    a: "warfarin",
    b: "ginkgo",
    severity: "moderate",
    mechanism:
      "Ginkgo can inhibit platelet-activating factor, adding to bleeding risk with anticoagulants.",
    source: "NCCIH Ginkgo herb-drug interaction summary",
  },
  {
    a: "warfarin",
    b: "garlic",
    severity: "moderate",
    mechanism:
      "Concentrated garlic supplements have antiplatelet activity that may increase bleeding risk with warfarin.",
    source: "NCCIH Garlic herb-drug interaction summary",
  },
  {
    a: "warfarin",
    b: "vitamin_e",
    severity: "moderate",
    mechanism:
      "High-dose vitamin E can inhibit platelet aggregation and antagonize vitamin K, potentially increasing bleeding risk.",
    source: "NIH Office of Dietary Supplements — Vitamin E fact sheet",
  },
  {
    a: "warfarin",
    b: "vitamin_k",
    severity: "moderate",
    mechanism:
      "Vitamin K directly antagonizes warfarin, reducing its anticoagulant effect and lowering the INR; keep intake consistent.",
    source: "FDA warfarin prescribing information (DailyMed)",
  },
  {
    a: "warfarin",
    b: "coq10",
    severity: "minor",
    mechanism:
      "CoQ10 is structurally similar to vitamin K and may modestly reduce warfarin's effect (lower INR) in some people.",
    source: "NIH MedlinePlus — Coenzyme Q10",
  },
  {
    a: "warfarin",
    b: "st_johns_wort",
    severity: "major",
    mechanism:
      "St. John's Wort induces CYP metabolism of warfarin, reducing its anticoagulant effect and the INR (risk of clot).",
    source: "NCCIH St. John's Wort herb-drug interaction summary",
  },
  {
    a: "clopidogrel",
    b: "nsaid",
    severity: "moderate",
    mechanism:
      "Adding an NSAID to clopidogrel compounds antiplatelet effect and GI-mucosal injury, raising bleeding risk.",
    source: "FDA clopidogrel prescribing information (DailyMed)",
  },
  {
    a: "clopidogrel",
    b: "ppi",
    severity: "moderate",
    mechanism:
      "Some PPIs (esp. omeprazole/esomeprazole) inhibit CYP2C19 and can reduce clopidogrel's antiplatelet activation.",
    source: "FDA clopidogrel Drug Safety Communication",
  },
  {
    a: "doac",
    b: "nsaid",
    severity: "major",
    mechanism:
      "NSAIDs add antiplatelet and GI-injury effects to a direct oral anticoagulant, increasing serious bleeding risk.",
    source: "FDA apixaban/rivaroxaban prescribing information (DailyMed)",
  },
  {
    a: "aspirin",
    b: "nsaid",
    severity: "moderate",
    mechanism:
      "Ibuprofen and other NSAIDs can block aspirin's cardioprotective antiplatelet effect and add GI-bleeding risk.",
    source: "FDA aspirin/ibuprofen labeling (DailyMed)",
  },
  {
    a: "nsaid",
    b: "ssri",
    severity: "moderate",
    mechanism:
      "SSRIs impair platelet aggregation and NSAIDs injure the GI mucosa, so together they raise the risk of upper-GI bleeding.",
    source: "NIH MedlinePlus; FDA SSRI prescribing information (DailyMed)",
  },
  {
    a: "acetaminophen",
    b: "warfarin",
    severity: "moderate",
    mechanism:
      "Regular (chronic or high-dose) acetaminophen can raise the INR and increase bleeding risk with warfarin; occasional single doses are lower-risk.",
    source: "FDA warfarin prescribing information (DailyMed); NIH MedlinePlus",
  },

  // ---- Serotonin syndrome ----
  {
    a: "ssri",
    b: "maoi",
    severity: "major",
    mechanism:
      "Combining an SSRI with an MAO inhibitor can cause life-threatening serotonin syndrome; a washout period is required.",
    source: "FDA SSRI & MAOI prescribing information (DailyMed)",
  },
  {
    a: "snri",
    b: "maoi",
    severity: "major",
    mechanism:
      "SNRI + MAO inhibitor can precipitate life-threatening serotonin syndrome; contraindicated without a washout.",
    source: "FDA SNRI prescribing information (DailyMed)",
  },
  {
    a: "ssri",
    b: "tramadol",
    severity: "moderate",
    mechanism:
      "Both raise serotonin and tramadol lowers the seizure threshold, so the combination increases serotonin-syndrome and seizure risk.",
    source: "FDA tramadol prescribing information (DailyMed)",
  },
  {
    a: "snri",
    b: "tramadol",
    severity: "moderate",
    mechanism:
      "Additive serotonergic effect plus tramadol's seizure-threshold lowering raises serotonin-syndrome and seizure risk.",
    source: "FDA tramadol prescribing information (DailyMed)",
  },
  {
    a: "ssri",
    b: "triptan",
    severity: "moderate",
    mechanism:
      "Adding a triptan to an SSRI can raise serotonin levels and, rarely, cause serotonin syndrome.",
    source: "FDA triptan labeling; FDA serotonin-syndrome advisory",
  },
  {
    a: "ssri",
    b: "st_johns_wort",
    severity: "major",
    mechanism:
      "St. John's Wort is serotonergic; combined with an SSRI it can cause serotonin syndrome.",
    source: "NCCIH St. John's Wort herb-drug interaction summary",
  },
  {
    a: "ssri",
    b: "five_htp",
    severity: "moderate",
    mechanism:
      "5-HTP is a serotonin precursor; adding it to an SSRI can raise serotonin levels and serotonin-syndrome risk.",
    source: "NIH MedlinePlus — 5-HTP",
  },
  {
    a: "ssri",
    b: "sam_e",
    severity: "moderate",
    mechanism:
      "SAM-e may have serotonergic activity that can add to an SSRI, with a theoretical serotonin-syndrome risk.",
    source: "NIH MedlinePlus — SAMe",
  },
  {
    a: "tramadol",
    b: "maoi",
    severity: "major",
    mechanism:
      "Tramadol with an MAO inhibitor risks serotonin syndrome and seizures; the combination is contraindicated.",
    source: "FDA tramadol prescribing information (DailyMed)",
  },

  // ---- CNS / respiratory depression ----
  {
    a: "opioid",
    b: "benzodiazepine",
    severity: "major",
    mechanism:
      "Opioids plus benzodiazepines cause additive sedation and respiratory depression — a leading cause of overdose (FDA boxed warning).",
    source: "FDA opioid + benzodiazepine boxed warning",
  },

  // ---- Statin myopathy (CYP3A4) ----
  {
    a: "statin",
    b: "macrolide",
    severity: "major",
    mechanism:
      "Clarithromycin/erythromycin inhibit CYP3A4, raising levels of simvastatin/lovastatin and the risk of myopathy/rhabdomyolysis.",
    source: "FDA simvastatin prescribing information (DailyMed)",
  },
  {
    a: "azole_antifungal",
    b: "statin",
    severity: "major",
    mechanism:
      "Azole antifungals inhibit CYP3A4, increasing statin levels and the risk of muscle injury (rhabdomyolysis).",
    source: "FDA simvastatin prescribing information (DailyMed)",
  },
  {
    a: "atorvastatin",
    b: "macrolide",
    severity: "moderate",
    mechanism:
      "Clarithromycin/erythromycin inhibit CYP3A4 and raise atorvastatin levels, increasing myopathy risk — but less than with simvastatin/lovastatin.",
    source: "FDA atorvastatin prescribing information (DailyMed)",
  },
  {
    a: "atorvastatin",
    b: "azole_antifungal",
    severity: "moderate",
    mechanism:
      "Azole antifungals inhibit CYP3A4 and raise atorvastatin levels, increasing myopathy risk — but less than with simvastatin/lovastatin.",
    source: "FDA atorvastatin prescribing information (DailyMed)",
  },
  {
    a: "gemfibrozil",
    b: "statin",
    severity: "major",
    mechanism:
      "Gemfibrozil raises statin exposure and independently causes myopathy, sharply increasing rhabdomyolysis risk (gemfibrozil + simvastatin is contraindicated).",
    source: "FDA simvastatin & gemfibrozil prescribing information (DailyMed)",
  },
  {
    a: "atorvastatin",
    b: "gemfibrozil",
    severity: "major",
    mechanism:
      "Gemfibrozil raises atorvastatin exposure and adds its own myopathy risk, increasing the chance of muscle injury/rhabdomyolysis.",
    source: "FDA atorvastatin & gemfibrozil prescribing information (DailyMed)",
  },

  // ---- Methotrexate ----
  {
    a: "methotrexate",
    b: "nsaid",
    severity: "major",
    mechanism:
      "NSAIDs reduce renal clearance of methotrexate, raising its levels and the risk of serious toxicity.",
    source: "FDA methotrexate prescribing information (DailyMed)",
  },
  {
    a: "methotrexate",
    b: "ppi",
    severity: "moderate",
    mechanism:
      "PPIs can reduce renal elimination of high-dose methotrexate, increasing exposure and toxicity risk.",
    source: "FDA methotrexate prescribing information (DailyMed)",
  },

  // ---- Hyperkalemia ----
  {
    a: "ace_arb",
    b: "potassium_sparing_diuretic",
    severity: "major",
    mechanism:
      "Both raise serum potassium; together they can cause dangerous hyperkalemia and arrhythmia.",
    source: "FDA lisinopril & spironolactone labeling (DailyMed)",
  },
  {
    a: "ace_arb",
    b: "potassium",
    severity: "moderate",
    mechanism:
      "Potassium supplements plus an ACE inhibitor/ARB can raise serum potassium into a dangerous range.",
    source: "FDA ACE inhibitor prescribing information (DailyMed)",
  },
  {
    a: "ace_arb",
    b: "nsaid",
    severity: "moderate",
    mechanism:
      "NSAIDs blunt the antihypertensive effect and, with an ACE/ARB, can impair kidney function and raise potassium (the 'triple whammy' with a diuretic).",
    source: "NIH MedlinePlus; FDA NSAID labeling",
  },

  // ---- Levothyroxine absorption ----
  {
    a: "levothyroxine",
    b: "calcium",
    severity: "moderate",
    mechanism:
      "Calcium binds levothyroxine in the gut and reduces its absorption; separate doses by ≥4 hours.",
    source: "FDA levothyroxine prescribing information (DailyMed)",
  },
  {
    a: "levothyroxine",
    b: "iron",
    severity: "moderate",
    mechanism:
      "Iron binds levothyroxine and reduces its absorption; separate doses by ≥4 hours.",
    source: "FDA levothyroxine prescribing information (DailyMed)",
  },
  {
    a: "levothyroxine",
    b: "magnesium",
    severity: "minor",
    mechanism:
      "Magnesium (and other polyvalent cations) can reduce levothyroxine absorption; separate the doses.",
    source: "FDA levothyroxine prescribing information (DailyMed)",
  },
  {
    a: "levothyroxine",
    b: "ppi",
    severity: "minor",
    mechanism:
      "PPIs raise gastric pH and may reduce levothyroxine absorption, sometimes requiring a dose review.",
    source: "NIH MedlinePlus — Levothyroxine",
  },

  // ---- Chelation with mineral supplements ----
  {
    a: "calcium",
    b: "iron",
    severity: "minor",
    mechanism:
      "Calcium reduces non-heme iron absorption; separate the two if iron repletion is the goal.",
    source: "NIH Office of Dietary Supplements — Iron fact sheet",
  },

  // ---- Cardiac / other ----
  {
    a: "nitrate",
    b: "pde5_inhibitor",
    severity: "major",
    mechanism:
      "PDE5 inhibitors plus nitrates cause profound, potentially life-threatening hypotension; the combination is contraindicated.",
    source: "FDA sildenafil prescribing information (DailyMed)",
  },
  {
    a: "digoxin",
    b: "macrolide",
    severity: "moderate",
    mechanism:
      "Clarithromycin/erythromycin raise digoxin levels, increasing the risk of digoxin toxicity (nausea, arrhythmia).",
    source: "FDA digoxin prescribing information (DailyMed)",
  },
  {
    a: "digoxin",
    b: "loop_thiazide_diuretic",
    severity: "moderate",
    mechanism:
      "Loop and thiazide diuretics can lower potassium and magnesium, which increases the risk of digoxin toxicity and arrhythmia.",
    source: "FDA digoxin prescribing information (DailyMed)",
  },
  {
    a: "allopurinol",
    b: "azathioprine",
    severity: "major",
    mechanism:
      "Allopurinol blocks xanthine-oxidase breakdown of azathioprine, raising its active metabolites and the risk of severe bone-marrow suppression; the azathioprine dose must be sharply reduced or the pair avoided.",
    source: "FDA azathioprine prescribing information (DailyMed)",
  },
  {
    a: "lithium",
    b: "nsaid",
    severity: "moderate",
    mechanism:
      "NSAIDs reduce renal lithium clearance, raising lithium levels toward a toxic range.",
    source: "FDA lithium prescribing information (DailyMed)",
  },
  {
    a: "lithium",
    b: "ace_arb",
    severity: "moderate",
    mechanism:
      "ACE inhibitors/ARBs reduce renal lithium clearance and can raise lithium into a toxic range.",
    source: "FDA lithium prescribing information (DailyMed)",
  },

  // ---- Supplement ↔ contraceptive ----
  {
    a: "st_johns_wort",
    b: "oral_contraceptive",
    severity: "major",
    mechanism:
      "St. John's Wort induces CYP3A4 and lowers contraceptive hormone levels, risking breakthrough bleeding and unintended pregnancy.",
    source: "NCCIH St. John's Wort herb-drug interaction summary",
  },
];

export interface DrugInteractionsDataset {
  $comment: string;
  version: number;
  severities: Severity[];
  concepts: RawConcept[];
  interactions: RawInteraction[];
}

const SEVERITIES: Severity[] = ["major", "moderate", "minor"];

// Normalize a synonym to the matcher's canonical form: lowercased, punctuation
// collapsed to single spaces, trimmed. The pure matcher (lib/drug-interactions.ts)
// normalizes item names the same way, so keys line up.
export function normalizeTerm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Pure builder: validate + normalize + sort the curated tables into the committed
// dataset (a FIXED POINT, guarded by the dataset test). Throws on any structural
// problem so a curated typo can't ship.
export function buildDrugInteractionsDataset(): DrugInteractionsDataset {
  // Concept keys unique.
  const keys = new Set<string>();
  for (const c of CONCEPTS) {
    if (keys.has(c.key))
      throw new Error(`gen-drug-interactions: duplicate concept key ${c.key}`);
    keys.add(c.key);
    if (!c.label.trim())
      throw new Error(`gen-drug-interactions: concept ${c.key} has no label`);
    if (c.rxcuis.length === 0 && c.synonyms.length === 0)
      throw new Error(
        `gen-drug-interactions: concept ${c.key} has no rxcuis or synonyms to match on`
      );
  }

  const concepts = [...CONCEPTS]
    .map((c) => ({
      key: c.key,
      label: c.label,
      // RxCUIs are compared as strings; de-dupe + sort for a stable diff.
      rxcuis: [
        ...new Set(c.rxcuis.map((r) => r.trim()).filter(Boolean)),
      ].sort(),
      // Synonyms normalized to the matcher's form, de-duped, sorted.
      synonyms: [
        ...new Set(c.synonyms.map(normalizeTerm).filter(Boolean)),
      ].sort(),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  // Interactions reference existing keys, a != b, no duplicate unordered pair.
  const seenPairs = new Set<string>();
  const interactions = [...INTERACTIONS]
    .map((it) => {
      if (!keys.has(it.a))
        throw new Error(`gen-drug-interactions: unknown concept ${it.a}`);
      if (!keys.has(it.b))
        throw new Error(`gen-drug-interactions: unknown concept ${it.b}`);
      if (it.a === it.b)
        throw new Error(`gen-drug-interactions: self-interaction on ${it.a}`);
      if (!SEVERITIES.includes(it.severity))
        throw new Error(
          `gen-drug-interactions: bad severity ${it.severity} on ${it.a}/${it.b}`
        );
      if (!it.mechanism.trim() || !it.source.trim())
        throw new Error(
          `gen-drug-interactions: ${it.a}/${it.b} missing mechanism or source`
        );
      // Store the pair in a canonical (sorted) order so the diff is stable and the
      // matcher never needs to try both orders.
      const [a, b] = [it.a, it.b].sort();
      const pair = `${a}|${b}`;
      if (seenPairs.has(pair))
        throw new Error(`gen-drug-interactions: duplicate pair ${pair}`);
      seenPairs.add(pair);
      return {
        a,
        b,
        severity: it.severity,
        mechanism: it.mechanism.trim(),
        source: it.source.trim(),
      };
    })
    .sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b));

  return {
    $comment:
      "Baked drug-/supplement-interaction dataset (issue #144) — flags known " +
      "interactions between two ACTIVE items in a profile's supplement + medication " +
      "stack. CURATED HIGH-VALUE SUBSET, not exhaustive; facts from public-domain " +
      "FDA/DailyMed labeling, NIH MedlinePlus/ODS/NCCIH, RxNorm (all public domain). " +
      "INFORMATIONAL, never prescriptive — absence of a flag does NOT mean safe. " +
      "Committed + HUMAN-REVIEWABLE; regenerate with `npm run gen:interactions`.",
    version: 1,
    severities: SEVERITIES,
    concepts,
    interactions,
  };
}

function writeDataset(): void {
  const dataset = buildDrugInteractionsDataset();
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(
    `Wrote ${dataset.concepts.length} concepts and ${dataset.interactions.length} interactions to ${OUT}`
  );
  console.log("Review the pairs for plausibility before committing.");
}

// Run only as the CLI entry point — NOT when imported (the dataset drift test
// imports buildDrugInteractionsDataset).
if (process.argv[1]?.includes("gen-drug-interactions")) {
  writeDataset();
}

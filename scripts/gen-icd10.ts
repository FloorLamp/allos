// Pre-generate the baked ICD-10-CM common-conditions map (lib/icd10-common.json),
// used to SUGGEST a diagnosis code for a manually entered / code-less extracted
// condition and to strengthen the cross-document condition de-dup natural key
// (issue #155).
//
// SOURCING / LICENSE
// ------------------
// ICD-10-CM (the U.S. Clinical Modification of ICD-10) is maintained by CMS and the
// CDC's National Center for Health Statistics and is released as a PUBLIC-DOMAIN
// U.S. Government work — the code set and its official descriptions may be freely
// used and redistributed (https://www.cms.gov/medicare/coding-billing/icd-10-codes,
// https://www.cdc.gov/nchs/icd/icd-10-cm.htm). That makes it license-compatible with
// this AGPL project.
//
// We DELIBERATELY AVOID SNOMED CT here: SNOMED requires an IHTSDO/SNOMED
// International affiliate license whose terms are incompatible with shipping the
// codes in an open-source (AGPL) repo. LOINC (used elsewhere for lab observations)
// is not touched by this map. This file therefore carries ICD-10-CM codes ONLY, and
// the stored `code_system` is always the string "ICD-10-CM".
//
// This is a CURATED COMMON-CONDITIONS SUBSET — a few hundred everyday diagnoses with
// lay-term synonyms — NOT the full ~70k ICD-10-CM tabular list. The codes below are
// well-established public descriptions; they are INFORMATIONAL suggestions meant to
// be human-reviewed/confirmed at entry, not billing-grade coding advice.
//
// GENERATION
// ----------
// Mirrors the gen-mets.ts / gen-growth-charts.ts pattern: the values are FIXED public
// constants embedded inline as the source of truth, the JSON is GENERATED from them
// and COMMITTED, and it is never hand-edited — edit the CURATED_CONDITIONS table
// below and re-run:
//
//   npm run gen:icd10
//
// The committed lib/icd10-common.json is a FIXED POINT of buildIcd10Dataset()
// (guarded by lib/__tests__/icd10-dataset.test.ts) so the generator and the file
// can't silently diverge.

import fs from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "lib", "icd10-common.json");

// The code system every entry belongs to. Stored verbatim into conditions.code_system
// so lib/fhir-export.ts emits the canonical http://hl7.org/fhir/sid/icd-10-cm URI.
export const ICD10_SYSTEM = "ICD-10-CM";

export interface Icd10CuratedEntry {
  code: string; // ICD-10-CM code, e.g. "J45.909"
  name: string; // the canonical display term stored on the condition row
  synonyms: string[]; // lay terms / abbreviations the fuzzy matcher also indexes
}

// Curated common-conditions table, grouped by ICD-10-CM chapter. Public-domain
// ICD-10-CM codes + descriptions (CMS/NCHS), with everyday synonyms added for
// fuzzy matching. Keep names as the clinical display term; put lay phrasings and
// abbreviations in `synonyms`. Codes are unspecified/uncomplicated variants where a
// generic "problem-list" entry is the intent.
const CURATED_CONDITIONS: Icd10CuratedEntry[] = [
  // ---- Endocrine, nutritional, metabolic (E) ----
  {
    code: "E11.9",
    name: "Type 2 diabetes mellitus without complications",
    synonyms: ["type 2 diabetes", "t2dm", "diabetes", "diabetes mellitus"],
  },
  {
    code: "E10.9",
    name: "Type 1 diabetes mellitus without complications",
    synonyms: ["type 1 diabetes", "t1dm", "juvenile diabetes"],
  },
  {
    code: "R73.03",
    name: "Prediabetes",
    synonyms: [
      "prediabetes",
      "impaired glucose tolerance",
      "borderline diabetes",
    ],
  },
  {
    code: "E03.9",
    name: "Hypothyroidism, unspecified",
    synonyms: ["hypothyroidism", "underactive thyroid", "low thyroid"],
  },
  {
    code: "E06.3",
    name: "Autoimmune thyroiditis",
    synonyms: [
      "hashimoto's thyroiditis",
      "hashimoto's",
      "hashimoto thyroiditis",
    ],
  },
  {
    code: "E05.90",
    name: "Thyrotoxicosis, unspecified",
    synonyms: ["hyperthyroidism", "overactive thyroid", "thyrotoxicosis"],
  },
  {
    code: "E04.9",
    name: "Nontoxic goiter, unspecified",
    synonyms: ["goiter", "goitre"],
  },
  {
    code: "E04.1",
    name: "Nontoxic single thyroid nodule",
    synonyms: ["thyroid nodule"],
  },
  {
    code: "E66.9",
    name: "Obesity, unspecified",
    synonyms: ["obesity", "obese"],
  },
  {
    code: "E66.01",
    name: "Morbid (severe) obesity due to excess calories",
    synonyms: ["morbid obesity", "severe obesity"],
  },
  {
    code: "E78.5",
    name: "Hyperlipidemia, unspecified",
    synonyms: [
      "hyperlipidemia",
      "high cholesterol",
      "dyslipidemia",
      "high lipids",
    ],
  },
  {
    code: "E78.00",
    name: "Pure hypercholesterolemia, unspecified",
    synonyms: ["hypercholesterolemia", "high cholesterol"],
  },
  {
    code: "E78.1",
    name: "Pure hyperglyceridemia",
    synonyms: ["hypertriglyceridemia", "high triglycerides"],
  },
  {
    code: "E55.9",
    name: "Vitamin D deficiency, unspecified",
    synonyms: ["vitamin d deficiency", "low vitamin d"],
  },
  {
    code: "E28.2",
    name: "Polycystic ovarian syndrome",
    synonyms: ["pcos", "polycystic ovary syndrome"],
  },
  {
    code: "E29.1",
    name: "Testicular hypofunction",
    synonyms: ["low testosterone", "hypogonadism", "testosterone deficiency"],
  },
  {
    code: "M10.9",
    name: "Gout, unspecified",
    synonyms: ["gout", "gouty arthritis"],
  },
  {
    code: "E86.0",
    name: "Dehydration",
    synonyms: ["dehydration"],
  },

  // ---- Blood / immune (D) ----
  {
    code: "D50.9",
    name: "Iron deficiency anemia, unspecified",
    synonyms: ["iron deficiency anemia", "iron deficiency", "low iron"],
  },
  {
    code: "D64.9",
    name: "Anemia, unspecified",
    synonyms: ["anemia", "anaemia", "low blood count"],
  },
  {
    code: "D51.9",
    name: "Vitamin B12 deficiency anemia, unspecified",
    synonyms: ["b12 deficiency", "vitamin b12 deficiency", "pernicious anemia"],
  },

  // ---- Mental, behavioral (F) ----
  {
    code: "F41.1",
    name: "Generalized anxiety disorder",
    synonyms: ["generalized anxiety disorder", "gad", "anxiety"],
  },
  {
    code: "F41.9",
    name: "Anxiety disorder, unspecified",
    synonyms: ["anxiety", "anxiety disorder"],
  },
  {
    code: "F32.9",
    name: "Major depressive disorder, single episode, unspecified",
    synonyms: [
      "depression",
      "major depressive disorder",
      "mdd",
      "depressive disorder",
    ],
  },
  {
    code: "F33.9",
    name: "Major depressive disorder, recurrent, unspecified",
    synonyms: ["recurrent depression", "recurrent major depression"],
  },
  {
    code: "F31.9",
    name: "Bipolar disorder, unspecified",
    synonyms: ["bipolar disorder", "bipolar", "manic depression"],
  },
  {
    code: "F90.9",
    name: "Attention-deficit hyperactivity disorder, unspecified type",
    synonyms: ["adhd", "attention deficit hyperactivity disorder", "add"],
  },
  {
    code: "F43.10",
    name: "Post-traumatic stress disorder, unspecified",
    synonyms: [
      "ptsd",
      "post-traumatic stress disorder",
      "post traumatic stress",
    ],
  },
  {
    code: "F42.9",
    name: "Obsessive-compulsive disorder, unspecified",
    synonyms: [
      "ocd",
      "obsessive-compulsive disorder",
      "obsessive compulsive disorder",
    ],
  },
  {
    code: "F17.210",
    name: "Nicotine dependence, cigarettes, uncomplicated",
    synonyms: ["nicotine dependence", "smoking", "cigarette dependence"],
  },
  {
    code: "F10.20",
    name: "Alcohol dependence, uncomplicated",
    synonyms: ["alcohol dependence", "alcoholism", "alcohol use disorder"],
  },
  {
    code: "F51.01",
    name: "Primary insomnia",
    synonyms: ["primary insomnia"],
  },

  // ---- Nervous system (G) ----
  {
    code: "G47.00",
    name: "Insomnia, unspecified",
    synonyms: ["insomnia", "trouble sleeping", "sleeplessness"],
  },
  {
    code: "G47.33",
    name: "Obstructive sleep apnea (adult) (pediatric)",
    synonyms: ["obstructive sleep apnea", "sleep apnea", "osa"],
  },
  {
    code: "G43.909",
    name: "Migraine, unspecified, not intractable, without status migrainosus",
    synonyms: ["migraine", "migraines", "migraine headache"],
  },
  {
    code: "R51.9",
    name: "Headache, unspecified",
    synonyms: ["headache", "headaches"],
  },
  {
    code: "G40.909",
    name: "Epilepsy, unspecified, not intractable, without status epilepticus",
    synonyms: ["epilepsy", "seizure disorder", "seizures"],
  },
  {
    code: "G20",
    name: "Parkinson's disease",
    synonyms: ["parkinson's disease", "parkinsons", "parkinson disease"],
  },
  {
    code: "G35",
    name: "Multiple sclerosis",
    synonyms: ["multiple sclerosis", "ms"],
  },
  {
    code: "G30.9",
    name: "Alzheimer's disease, unspecified",
    synonyms: ["alzheimer's disease", "alzheimers", "dementia"],
  },
  {
    code: "G62.9",
    name: "Polyneuropathy, unspecified",
    synonyms: ["neuropathy", "peripheral neuropathy", "polyneuropathy"],
  },
  {
    code: "G56.00",
    name: "Carpal tunnel syndrome, unspecified upper limb",
    synonyms: ["carpal tunnel syndrome", "carpal tunnel"],
  },
  {
    code: "G25.81",
    name: "Restless legs syndrome",
    synonyms: ["restless legs syndrome", "rls", "restless leg syndrome"],
  },
  {
    code: "G89.4",
    name: "Chronic pain syndrome",
    synonyms: ["chronic pain", "chronic pain syndrome"],
  },

  // ---- Eye / ear (H) ----
  {
    code: "H40.9",
    name: "Unspecified glaucoma",
    synonyms: ["glaucoma"],
  },
  {
    code: "H25.9",
    name: "Unspecified age-related cataract",
    synonyms: ["cataract", "cataracts"],
  },
  {
    code: "H35.30",
    name: "Unspecified macular degeneration",
    synonyms: [
      "macular degeneration",
      "amd",
      "age-related macular degeneration",
    ],
  },
  {
    code: "H10.9",
    name: "Unspecified conjunctivitis",
    synonyms: ["conjunctivitis", "pink eye"],
  },
  {
    code: "H66.90",
    name: "Otitis media, unspecified, unspecified ear",
    synonyms: ["ear infection", "otitis media"],
  },
  {
    code: "H93.19",
    name: "Tinnitus, unspecified ear",
    synonyms: ["tinnitus", "ringing in ears"],
  },

  // ---- Circulatory (I) ----
  {
    code: "I10",
    name: "Essential (primary) hypertension",
    synonyms: [
      "hypertension",
      "high blood pressure",
      "htn",
      "elevated blood pressure",
    ],
  },
  {
    code: "I25.10",
    name: "Atherosclerotic heart disease of native coronary artery without angina pectoris",
    synonyms: ["coronary artery disease", "cad", "coronary heart disease"],
  },
  {
    code: "I20.9",
    name: "Angina pectoris, unspecified",
    synonyms: ["angina", "chest pain angina"],
  },
  {
    code: "I21.9",
    name: "Acute myocardial infarction, unspecified",
    synonyms: ["heart attack", "myocardial infarction", "mi"],
  },
  {
    code: "I48.91",
    name: "Atrial fibrillation, unspecified",
    synonyms: ["atrial fibrillation", "afib", "a-fib", "af"],
  },
  {
    code: "I50.9",
    name: "Heart failure, unspecified",
    synonyms: ["heart failure", "congestive heart failure", "chf"],
  },
  {
    code: "I63.9",
    name: "Cerebral infarction, unspecified",
    synonyms: ["stroke", "cerebral infarction", "cva"],
  },
  {
    code: "I73.9",
    name: "Peripheral vascular disease, unspecified",
    synonyms: [
      "peripheral vascular disease",
      "pvd",
      "peripheral artery disease",
      "pad",
    ],
  },
  {
    code: "I73.00",
    name: "Raynaud's syndrome without gangrene",
    synonyms: ["raynaud's", "raynauds", "raynaud syndrome"],
  },
  {
    code: "I83.90",
    name: "Asymptomatic varicose veins of unspecified lower extremity",
    synonyms: ["varicose veins"],
  },
  {
    code: "I87.2",
    name: "Venous insufficiency (chronic) (peripheral)",
    synonyms: ["venous insufficiency", "chronic venous insufficiency"],
  },

  // ---- Respiratory (J) ----
  {
    code: "J45.909",
    name: "Unspecified asthma, uncomplicated",
    synonyms: ["asthma"],
  },
  {
    code: "J44.9",
    name: "Chronic obstructive pulmonary disease, unspecified",
    synonyms: ["copd", "chronic obstructive pulmonary disease", "emphysema"],
  },
  {
    code: "J20.9",
    name: "Acute bronchitis, unspecified",
    synonyms: ["bronchitis", "acute bronchitis"],
  },
  {
    code: "J06.9",
    name: "Acute upper respiratory infection, unspecified",
    synonyms: ["upper respiratory infection", "uri", "common cold", "cold"],
  },
  {
    code: "J02.9",
    name: "Acute pharyngitis, unspecified",
    synonyms: ["sore throat", "pharyngitis"],
  },
  {
    code: "J30.9",
    name: "Allergic rhinitis, unspecified",
    synonyms: [
      "allergic rhinitis",
      "hay fever",
      "seasonal allergies",
      "nasal allergies",
    ],
  },
  {
    code: "J01.90",
    name: "Acute sinusitis, unspecified",
    synonyms: ["sinusitis", "sinus infection"],
  },
  {
    code: "J18.9",
    name: "Pneumonia, unspecified organism",
    synonyms: ["pneumonia"],
  },
  {
    code: "J11.1",
    name: "Influenza due to unidentified influenza virus with other respiratory manifestations",
    synonyms: ["influenza", "flu"],
  },
  {
    code: "U07.1",
    name: "COVID-19",
    synonyms: ["covid-19", "covid", "coronavirus", "sars-cov-2"],
  },

  // ---- Digestive (K) ----
  {
    code: "K21.9",
    name: "Gastro-esophageal reflux disease without esophagitis",
    synonyms: [
      "gerd",
      "acid reflux",
      "reflux",
      "gastroesophageal reflux disease",
    ],
  },
  {
    code: "K21.0",
    name: "Gastro-esophageal reflux disease with esophagitis",
    synonyms: ["gerd with esophagitis", "reflux esophagitis"],
  },
  {
    code: "K29.70",
    name: "Gastritis, unspecified, without bleeding",
    synonyms: ["gastritis"],
  },
  {
    code: "K59.00",
    name: "Constipation, unspecified",
    synonyms: ["constipation"],
  },
  {
    code: "K58.9",
    name: "Irritable bowel syndrome without diarrhea",
    synonyms: ["ibs", "irritable bowel syndrome"],
  },
  {
    code: "K50.90",
    name: "Crohn's disease, unspecified, without complications",
    synonyms: ["crohn's disease", "crohns", "crohn disease"],
  },
  {
    code: "K51.90",
    name: "Ulcerative colitis, unspecified, without complications",
    synonyms: ["ulcerative colitis", "uc"],
  },
  {
    code: "K57.30",
    name: "Diverticulosis of large intestine without perforation or abscess without bleeding",
    synonyms: ["diverticulosis"],
  },
  {
    code: "K57.92",
    name: "Diverticulitis of intestine, part unspecified, without perforation or abscess without bleeding",
    synonyms: ["diverticulitis"],
  },
  {
    code: "K80.20",
    name: "Calculus of gallbladder without cholecystitis without obstruction",
    synonyms: ["gallstones", "gallstone", "cholelithiasis"],
  },
  {
    code: "K76.0",
    name: "Fatty (change of) liver, not elsewhere classified",
    synonyms: [
      "fatty liver",
      "nafld",
      "hepatic steatosis",
      "nonalcoholic fatty liver",
    ],
  },
  {
    code: "K74.60",
    name: "Unspecified cirrhosis of liver",
    synonyms: ["cirrhosis", "liver cirrhosis"],
  },
  {
    code: "K85.90",
    name: "Acute pancreatitis without necrosis or infection, unspecified",
    synonyms: ["pancreatitis", "acute pancreatitis"],
  },
  {
    code: "K90.0",
    name: "Celiac disease",
    synonyms: ["celiac disease", "coeliac disease", "gluten enteropathy"],
  },
  {
    code: "K64.9",
    name: "Unspecified hemorrhoids",
    synonyms: ["hemorrhoids", "haemorrhoids", "piles"],
  },
  {
    code: "B18.2",
    name: "Chronic viral hepatitis C",
    synonyms: ["hepatitis c", "hep c", "chronic hepatitis c"],
  },
  {
    code: "A09",
    name: "Infectious gastroenteritis and colitis, unspecified",
    synonyms: ["gastroenteritis", "stomach flu", "stomach bug"],
  },

  // ---- Skin (L) ----
  {
    code: "L20.9",
    name: "Atopic dermatitis, unspecified",
    synonyms: ["eczema", "atopic dermatitis"],
  },
  {
    code: "L40.0",
    name: "Psoriasis vulgaris",
    synonyms: ["psoriasis", "plaque psoriasis"],
  },
  {
    code: "L70.0",
    name: "Acne vulgaris",
    synonyms: ["acne"],
  },
  {
    code: "L50.9",
    name: "Urticaria, unspecified",
    synonyms: ["hives", "urticaria"],
  },
  {
    code: "L30.9",
    name: "Dermatitis, unspecified",
    synonyms: ["dermatitis", "rash", "skin rash"],
  },
  {
    code: "L71.9",
    name: "Rosacea, unspecified",
    synonyms: ["rosacea"],
  },
  {
    code: "L80",
    name: "Vitiligo",
    synonyms: ["vitiligo"],
  },
  {
    code: "L65.9",
    name: "Nonscarring hair loss, unspecified",
    synonyms: ["hair loss", "alopecia"],
  },

  // ---- Musculoskeletal (M) ----
  {
    code: "M54.50",
    name: "Low back pain, unspecified",
    synonyms: ["low back pain", "lower back pain", "lbp", "back pain"],
  },
  {
    code: "M54.2",
    name: "Cervicalgia",
    synonyms: ["neck pain", "cervicalgia"],
  },
  {
    code: "M54.30",
    name: "Sciatica, unspecified side",
    synonyms: ["sciatica"],
  },
  {
    code: "M51.9",
    name: "Unspecified thoracic, thoracolumbar and lumbosacral intervertebral disc disorder",
    synonyms: [
      "herniated disc",
      "disc herniation",
      "slipped disc",
      "bulging disc",
    ],
  },
  {
    code: "M41.9",
    name: "Scoliosis, unspecified",
    synonyms: ["scoliosis"],
  },
  {
    code: "M19.90",
    name: "Unspecified osteoarthritis, unspecified site",
    synonyms: [
      "osteoarthritis",
      "oa",
      "arthritis",
      "degenerative joint disease",
    ],
  },
  {
    code: "M17.9",
    name: "Osteoarthritis of knee, unspecified",
    synonyms: ["knee osteoarthritis", "knee arthritis"],
  },
  {
    code: "M16.9",
    name: "Osteoarthritis of hip, unspecified",
    synonyms: ["hip osteoarthritis", "hip arthritis"],
  },
  {
    code: "M06.9",
    name: "Rheumatoid arthritis, unspecified",
    synonyms: ["rheumatoid arthritis", "ra"],
  },
  {
    code: "M32.9",
    name: "Systemic lupus erythematosus, unspecified",
    synonyms: ["lupus", "sle", "systemic lupus erythematosus"],
  },
  {
    code: "M81.0",
    name: "Age-related osteoporosis without current pathological fracture",
    synonyms: ["osteoporosis"],
  },
  {
    code: "M79.7",
    name: "Fibromyalgia",
    synonyms: ["fibromyalgia"],
  },
  {
    code: "M72.2",
    name: "Plantar fascial fibromatosis",
    synonyms: ["plantar fasciitis"],
  },
  {
    code: "M77.10",
    name: "Lateral epicondylitis, unspecified elbow",
    synonyms: ["tennis elbow", "lateral epicondylitis"],
  },

  // ---- Genitourinary (N) ----
  {
    code: "N18.9",
    name: "Chronic kidney disease, unspecified",
    synonyms: [
      "chronic kidney disease",
      "ckd",
      "kidney disease",
      "renal insufficiency",
    ],
  },
  {
    code: "N39.0",
    name: "Urinary tract infection, site not specified",
    synonyms: ["urinary tract infection", "uti", "bladder infection"],
  },
  {
    code: "N20.0",
    name: "Calculus of kidney",
    synonyms: ["kidney stones", "kidney stone", "nephrolithiasis"],
  },
  {
    code: "N40.0",
    name: "Benign prostatic hyperplasia without lower urinary tract symptoms",
    synonyms: ["bph", "benign prostatic hyperplasia", "enlarged prostate"],
  },
  {
    code: "N52.9",
    name: "Male erectile dysfunction, unspecified",
    synonyms: ["erectile dysfunction", "ed", "impotence"],
  },
  {
    code: "N80.9",
    name: "Endometriosis, unspecified",
    synonyms: ["endometriosis"],
  },
  {
    code: "N95.1",
    name: "Menopausal and female climacteric states",
    synonyms: ["menopause", "menopausal", "climacteric"],
  },
  {
    code: "D25.9",
    name: "Leiomyoma of uterus, unspecified",
    synonyms: ["uterine fibroids", "fibroids", "leiomyoma"],
  },

  // ---- Infectious (A/B) ----
  {
    code: "B20",
    name: "Human immunodeficiency virus [HIV] disease",
    synonyms: ["hiv", "aids", "hiv disease"],
  },

  // ---- Neoplasms (C) ----
  {
    code: "C61",
    name: "Malignant neoplasm of prostate",
    synonyms: ["prostate cancer"],
  },
  {
    code: "C18.9",
    name: "Malignant neoplasm of colon, unspecified",
    synonyms: ["colon cancer", "colorectal cancer", "bowel cancer"],
  },
  {
    code: "C34.90",
    name: "Malignant neoplasm of unspecified part of unspecified bronchus or lung",
    synonyms: ["lung cancer"],
  },
  {
    code: "C50.919",
    name: "Malignant neoplasm of unspecified site of unspecified female breast",
    synonyms: ["breast cancer"],
  },
  {
    code: "C44.90",
    name: "Unspecified malignant neoplasm of skin, unspecified",
    synonyms: ["skin cancer"],
  },
];

export interface Icd10Dataset {
  $comment: string;
  system: string;
  conditions: Icd10CuratedEntry[];
}

// Pure builder: normalize + sort the curated table into the committed dataset. The
// committed lib/icd10-common.json is a FIXED POINT of this (guarded by the dataset
// test). Entries are emitted sorted by code for a stable, chapter-grouped, reviewable
// diff; duplicate codes throw (a curated typo must not ship two rows for one code).
export function buildIcd10Dataset(): Icd10Dataset {
  const seen = new Set<string>();
  for (const e of CURATED_CONDITIONS) {
    if (seen.has(e.code)) {
      throw new Error(`gen-icd10: duplicate ICD-10-CM code ${e.code}`);
    }
    seen.add(e.code);
  }
  const conditions = [...CURATED_CONDITIONS]
    .map((e) => ({
      code: e.code,
      name: e.name,
      // De-duplicate + lowercase synonyms for a stable index; drop any that equal
      // the name (the name is always indexed as its own term).
      synonyms: [
        ...new Set(
          e.synonyms
            .map((s) => s.trim().toLowerCase())
            .filter((s) => s && s !== e.name.toLowerCase())
        ),
      ],
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
  return {
    $comment:
      "Baked ICD-10-CM common-conditions map for SUGGESTING a diagnosis code on a " +
      "manually entered / code-less extracted condition and strengthening the " +
      "cross-document condition de-dup key (issue #155). Public-domain ICD-10-CM " +
      "codes + descriptions (CMS/NCHS); SNOMED deliberately avoided (affiliate " +
      "license). Curated COMMON subset, NOT the full tabular list. Committed + " +
      "HUMAN-REVIEWABLE; regenerate with `npm run gen:icd10`. INFORMATIONAL entry " +
      "suggestions, confirmed by the user — NOT billing-grade coding advice.",
    system: ICD10_SYSTEM,
    conditions,
  };
}

function writeDataset(): void {
  const dataset = buildIcd10Dataset();
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(`Wrote ${dataset.conditions.length} ICD-10-CM entries to ${OUT}`);
  console.log("Review the codes for plausibility before committing.");
}

// Run only as the CLI entry point — NOT when imported (the dataset drift test
// imports buildIcd10Dataset).
if (process.argv[1]?.includes("gen-icd10")) {
  writeDataset();
}

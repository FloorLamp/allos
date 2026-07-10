import type { PreventiveKind } from "./preventive-catalog";

// Concept-mapping layer for record-driven preventive-care inference (issue #86).
// Manual and imported records name the same screening/visit in many ways — a
// colonoscopy arrives as CPT 45378, a SNOMED code, or a typed-in "Screening
// colonoscopy" string — so a per-rule bundle of code sets + name synonyms maps
// any of those onto a stable catalog rule key. This is the same committed-data
// pattern `lib/canonical-biomarkers.json` uses for lab names, kept here as a
// typed module alongside the catalog it references (`lib/preventive-catalog.ts`).
//
// DETERMINISTIC and CONSERVATIVE by design (issue #86 constraints): only clear,
// specific evidence maps to a rule. Codes are exact screening/procedure codes
// (not broad category codes); name synonyms are matched WHOLE-WORD (see
// `lib/preventive-inference.ts`) so "pap" never matches "papilloma". Anything
// ambiguous simply does not match and the user can still mark it done manually.
// No AI matching lives in this layer.
//
// Result-aware rescreen intervals (colonoscopy 10y vs stool-based annual;
// cytology 3y vs HPV co-test 5y) are NOT modeled here — the catalog defaults to a
// single conservative interval per rule. To avoid UNDER-reminding, rules whose
// interval assumes the long-interval modality (colorectal → 10y colonoscopy) map
// ONLY that modality; short-interval modalities (FIT/FOBT) are deliberately left
// unmapped rather than silently granted a 10-year pass. See the per-rule notes.
//
// NOT clinical software; codes are curated for personal-tracking inference only.

export interface ConceptMatcher {
  // The catalog rule this evidence satisfies (a stable key in PREVENTIVE_CATALOG).
  ruleKey: string;
  // Mirrors the catalog rule's kind; used to gate which record SOURCES may satisfy
  // it (procedures/labs → screening, appointments/encounters → visit), so an
  // appointment titled "colonoscopy consult" never counts as the screening itself.
  kind: PreventiveKind;
  // Exact procedure/lab codes (CPT, HCPCS, SNOMED CT) that unambiguously identify
  // the event. Matched case-insensitively and exactly (normalized) — never as a
  // prefix — so only the specific screening code counts.
  codes: string[];
  // Whole-word name/title/description synonyms, matched against normalized text.
  // Keep these specific to the screening/visit itself.
  names: string[];
  // Exact canonical biomarker names (lib/canonical-biomarkers.json) whose presence
  // as a result satisfies a lab-based screening. Empty for non-lab rules.
  canonicalBiomarkers: string[];
}

// The curated map. One entry per inferable catalog rule; rules absent here are
// never auto-satisfied (they stay manual-only) — e.g. the well-child milestones,
// whose exact age band can't be inferred from a generic visit, and the risk-gated
// lung/AAA screenings.
export const PREVENTIVE_CONCEPT_MAP: ConceptMatcher[] = [
  // ---- Screenings (satisfied by a procedure or lab result) -----------------
  {
    ruleKey: "colorectal_cancer",
    kind: "screening",
    // Colonoscopy ONLY — the catalog's 10-year interval assumes it. Stool-based
    // tests (FIT/FOBT/Cologuard) need annual/triennial rescreening, so mapping
    // them here would wrongly grant a 10-year pass; they stay unmapped until a
    // result-aware interval exists.
    codes: [
      "45378", // CPT diagnostic colonoscopy
      "45380",
      "45381",
      "45384",
      "45385",
      "45388",
      "G0105", // HCPCS colonoscopy on individual at high risk
      "G0121", // HCPCS colonoscopy on individual not meeting high-risk criteria
      "73761001", // SNOMED colonoscopy
      "174184006", // SNOMED diagnostic endoscopic examination on colon
    ],
    names: ["colonoscopy"],
    canonicalBiomarkers: [],
  },
  {
    ruleKey: "mammography",
    kind: "screening",
    codes: [
      "77067", // CPT screening mammography, bilateral
      "77066", // CPT diagnostic mammography, bilateral
      "77065", // CPT diagnostic mammography, unilateral
      "77063", // CPT screening digital breast tomosynthesis
      "G0202", // HCPCS screening mammography, digital
      "71651007", // SNOMED mammography
      "241055006", // SNOMED screening mammography
    ],
    names: ["mammogram", "mammography"],
    canonicalBiomarkers: [],
  },
  {
    ruleKey: "cervical_cancer",
    kind: "screening",
    codes: [
      "88141", // CPT cytopathology, cervical/vaginal, interpretation
      "88142",
      "88143",
      "88147",
      "88148",
      "88150",
      "88152",
      "88153",
      "88164",
      "88174",
      "88175",
      "87624", // CPT HPV, high-risk types
      "87625", // CPT HPV types 16 & 18
      "G0123", // HCPCS screening cytopathology, cervical/vaginal
      "G0124",
      "G0141",
      "G0143",
      "G0144",
      "G0145",
      "G0147",
      "G0148",
      "Q0091", // HCPCS obtaining screening Pap smear
      "171149006", // SNOMED cervical smear
      "44160009", // SNOMED Papanicolaou smear
    ],
    names: [
      "pap smear",
      "pap test",
      "cervical cytology",
      "cervical smear",
      "papanicolaou",
      "hpv test",
      "hpv screening",
    ],
    canonicalBiomarkers: [],
  },
  {
    ruleKey: "osteoporosis",
    kind: "screening",
    codes: [
      "77080", // CPT DXA, axial skeleton
      "77081", // CPT DXA, appendicular skeleton
      "77085", // CPT DXA, axial, with vertebral fracture assessment
      "G0130", // HCPCS single-energy x-ray bone density
      "312681000", // SNOMED bone density scan
    ],
    names: [
      "dexa",
      "dxa",
      "bone density",
      "bone densitometry",
      "dual energy x ray absorptiometry",
    ],
    canonicalBiomarkers: [],
  },
  {
    ruleKey: "lipid_screening",
    kind: "screening",
    codes: [
      "80061", // CPT lipid panel
      "82465", // CPT cholesterol, serum/whole blood, total
      "83718", // CPT lipoprotein, direct, HDL
      "83721", // CPT lipoprotein, direct, LDL
      "84478", // CPT triglycerides
    ],
    names: ["lipid panel", "lipid profile", "cholesterol panel"],
    canonicalBiomarkers: [
      "Total Cholesterol",
      "LDL Cholesterol",
      "HDL Cholesterol",
      "Triglycerides",
    ],
  },
  {
    ruleKey: "diabetes_screening",
    kind: "screening",
    codes: [
      "83036", // CPT hemoglobin A1c
      "83037", // CPT hemoglobin A1c, home device
      "82947", // CPT glucose, quantitative, blood
      "82950", // CPT glucose, post glucose dose
      "82951", // CPT glucose tolerance test
    ],
    names: [
      "hemoglobin a1c",
      "hba1c",
      "a1c",
      "glycated hemoglobin",
      "fasting glucose",
      "fasting blood glucose",
      "oral glucose tolerance",
    ],
    canonicalBiomarkers: ["Hemoglobin A1c", "Glucose"],
  },
  {
    ruleKey: "hepatitis_c",
    kind: "screening",
    // No tracked HCV biomarker, so this infers from a coded/named test only.
    codes: [
      "86803", // CPT hepatitis C antibody
      "86804", // CPT hepatitis C antibody, confirmatory
      "87520", // CPT hepatitis C, RNA, direct probe
      "87521", // CPT hepatitis C, RNA, amplified probe
      "87522", // CPT hepatitis C, RNA, quantification
      "G0472", // HCPCS hepatitis C antibody screening
    ],
    names: [
      "hepatitis c antibody",
      "hcv antibody",
      "hepatitis c rna",
      "hcv rna",
    ],
    canonicalBiomarkers: [],
  },
  {
    ruleKey: "blood_pressure",
    kind: "screening",
    // A recorded blood-pressure reading is itself the screening. Matched by the
    // canonical vitals names the app stores; the 12-month interval means it simply
    // re-surfaces yearly, so a stale reading never suppresses the reminder for long.
    codes: [],
    names: ["blood pressure"],
    canonicalBiomarkers: [
      "Blood Pressure Systolic",
      "Blood Pressure Diastolic",
    ],
  },

  // ---- Recurring visits (satisfied by a completed appointment/encounter) ----
  {
    ruleKey: "adult_physical",
    kind: "visit",
    codes: [
      "99385", // CPT preventive visit, new, 18-39
      "99386", // CPT preventive visit, new, 40-64
      "99395", // CPT preventive visit, established, 18-39
      "99396", // CPT preventive visit, established, 40-64
      "G0438", // HCPCS annual wellness visit, initial
      "G0439", // HCPCS annual wellness visit, subsequent
    ],
    names: [
      "annual physical",
      "physical exam",
      "wellness visit",
      "well adult",
      "preventive visit",
      "annual exam",
      "annual checkup",
      "annual check up",
      "periodic health exam",
    ],
    canonicalBiomarkers: [],
  },
  {
    ruleKey: "dental_cleaning",
    kind: "visit",
    codes: [
      "D1110", // CDT prophylaxis, adult
      "D1120", // CDT prophylaxis, child
      "D0120", // CDT periodic oral evaluation
      "D0150", // CDT comprehensive oral evaluation
    ],
    names: [
      "dental cleaning",
      "dental exam",
      "dental checkup",
      "dental check up",
      "teeth cleaning",
      "dental prophylaxis",
    ],
    canonicalBiomarkers: [],
  },
  {
    ruleKey: "vision_exam",
    kind: "visit",
    codes: [
      "92004", // CPT comprehensive ophthalmological, new
      "92014", // CPT comprehensive ophthalmological, established
      "92002", // CPT intermediate ophthalmological, new
      "92012", // CPT intermediate ophthalmological, established
    ],
    names: [
      "eye exam",
      "vision exam",
      "comprehensive eye",
      "optometry",
      "ophthalmology",
      "ophthalmological",
    ],
    canonicalBiomarkers: [],
  },
  {
    ruleKey: "skin_check",
    kind: "visit",
    codes: [],
    names: [
      "skin check",
      "skin cancer screening",
      "full body skin exam",
      "total body skin exam",
    ],
    canonicalBiomarkers: [],
  },
];

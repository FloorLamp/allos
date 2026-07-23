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

// The two in-app instrument surfaces a "satisfiedBy: instrument" screening links
// to (#1083). Literal-typed so the per-class deep link `preventiveHref` builds
// (`<page>?screen=<INSTRUMENT>`) stays an AppRoute — a page removed in a
// consolidation fails the build (#285). Substance instruments live on the
// substance-use page; PHQ-9/GAD-7 on the mental-health page.
export type InstrumentPage =
  "/records/specialty/substance-use" | "/records/specialty/mental-health";

// What a SCREENING is actually satisfied by — the explicit concept, driving the
// per-class deep link + CTA copy on the Upcoming row, the page, AND the nudge so
// all three say the identical thing (#1083, #221). Only kind:"screening" matchers
// carry one; kind:"visit" rules keep the existing Book path. Replaces the fragile
// `canonicalBiomarkers.length > 0` guess (wrong for the instrument/vital classes
// #1076 moved off the biomarker surface).
export type ScreeningSatisfiedBy =
  // A validated screening instrument taken/entered in-app. `instrument` is the
  // exact `?screen=` token (a canonical instrument name — AUDIT-C/PHQ-9/DAST-10…);
  // `entry` drives the CTA verb: "in-app" ⇒ "Complete the …", "total-only" ⇒
  // "Enter your … score" (a copyright-restricted instrument can't be administered
  // in-app — see lib/substance-use.ts; #1085 flips DAST-10 in-app → verb follows).
  | {
      kind: "instrument";
      instrument: string;
      page: InstrumentPage;
      entry: "in-app" | "total-only";
    }
  // A lab result. `primary` is the canonical biomarker the add-form deep link
  // prefills (`/results/biomarkers?new=1&name=<primary>`, #662); absent when no
  // tracked biomarker exists (e.g. hepatitis C) → the add form opens unprefilled.
  | { kind: "lab"; primary?: string }
  // A self-recordable vital — a recorded reading IS the screening. Links to the
  // vitals entry surface (#1076), NOT the biomarkers form.
  | { kind: "vital"; primary: string }
  // A clinician-performed procedure. `procedure` is the display noun the procedures
  // add-form deep link prefills (`/records/history/procedures?new=1&name=<procedure>`).
  | { kind: "procedure"; procedure: string };

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
  // What satisfies this screening — drives its deep link + CTA (#1083). REQUIRED for
  // every kind:"screening" matcher (asserted by preventive-inference.test.ts); absent
  // on kind:"visit" rules, which keep the existing Book path.
  satisfiedBy?: ScreeningSatisfiedBy;
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
    satisfiedBy: { kind: "procedure", procedure: "Colonoscopy" },
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
    satisfiedBy: { kind: "procedure", procedure: "Mammogram" },
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
    satisfiedBy: { kind: "procedure", procedure: "Pap smear" },
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
    satisfiedBy: { kind: "procedure", procedure: "DEXA scan" },
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
    satisfiedBy: { kind: "lab", primary: "LDL Cholesterol" },
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
    satisfiedBy: { kind: "lab", primary: "Hemoglobin A1c" },
  },
  {
    ruleKey: "depression_screening",
    kind: "screening",
    // A recorded depression screen (PHQ-2/PHQ-9) satisfies it; the annual default
    // means it re-surfaces yearly, so an old screen never suppresses it for long.
    codes: [
      "96127", // CPT brief emotional/behavioral assessment (e.g. PHQ)
      "G0444", // HCPCS annual depression screening
      "171207006", // SNOMED depression screening
    ],
    names: [
      "depression screening",
      "phq 9",
      "phq 2",
      "patient health questionnaire",
      // A completed MENTAL-HEALTH visit is legitimate evidence toward this screening
      // (#997), so a person in active behavioral-health care isn't also nagged to get
      // screened. The `mental_health` appointment KIND folds in "mental health visit"
      // (appointmentKindInferenceText) and, uniquely, widens its inference `allow` to
      // include "screening" so it reaches this screening matcher through the SAME
      // shared stream a physical uses for its check-up — no forked satisfaction path.
      // Names are UNAMBIGUOUS behavioral-health terms only (bare "therapy"/"therapist"
      // are left out — they collapse with physical/occupational therapy, an over-match
      // #86 conservatism forbids).
      "mental health visit",
      "psychotherapy",
      "counseling",
      "psychiatry",
      "psychiatrist",
      "psychologist",
      "behavioral health",
    ],
    // A recorded PHQ-9 SCORE (the biomarker-shaped instrument reading, #716) is
    // stronger evidence than a bare coded screen, so it satisfies the screening too.
    canonicalBiomarkers: ["PHQ-9"],
    satisfiedBy: {
      kind: "instrument",
      instrument: "PHQ-9",
      page: "/records/specialty/mental-health",
      entry: "in-app",
    },
  },
  {
    // Anxiety screening (#716): a recorded GAD-7 score satisfies it. Matched by the
    // GAD-7 canonical biomarker + name synonyms — deliberately NOT by CPT 96127 (the
    // generic brief-assessment code depression also uses), so a PHQ-9 depression screen
    // can't cross-satisfy anxiety. (There was no anxiety entry before instrument scores
    // existed — a visit/encounter satisfied it only through the catalog, not a record.)
    ruleKey: "anxiety_screening",
    kind: "screening",
    codes: [],
    names: [
      "anxiety screening",
      "gad 7",
      "generalized anxiety disorder",
      // A completed mental-health visit satisfies the anxiety screening too (#997) —
      // same unambiguous behavioral-health synonyms + folded kind text as depression.
      "mental health visit",
      "psychotherapy",
      "counseling",
      "psychiatry",
      "psychiatrist",
      "psychologist",
      "behavioral health",
    ],
    canonicalBiomarkers: ["GAD-7"],
    satisfiedBy: {
      kind: "instrument",
      instrument: "GAD-7",
      page: "/records/specialty/mental-health",
      entry: "in-app",
    },
  },
  {
    // Alcohol-use screening (#998): a recorded AUDIT-C or AUDIT score (the
    // biomarker-shaped instrument reading) satisfies it, as does a coded alcohol
    // screen. G0442 is alcohol-specific; 99408/99409 (SBIRT structured screening +
    // brief intervention) are kept HERE only — they read "alcohol and/or substance
    // abuse", but crediting one code to two screenings is the #86 over-match
    // conservatism forbids, and alcohol is their overwhelmingly common use.
    ruleKey: "alcohol_screening",
    kind: "screening",
    codes: [
      "G0442", // HCPCS annual alcohol misuse screening
      "99408", // CPT alcohol/substance abuse structured screening + brief intervention (15–30 min)
      "99409", // CPT alcohol/substance abuse structured screening + brief intervention (>30 min)
    ],
    names: [
      "alcohol screening",
      "alcohol use screening",
      "alcohol misuse screening",
      "audit c",
      "alcohol use disorders identification test",
    ],
    canonicalBiomarkers: ["AUDIT-C", "AUDIT"],
    // Deep-links to the in-app AUDIT-C (the substance-use page's default) — AUDIT is
    // total-only, so the actionable next step is the administrable AUDIT-C.
    satisfiedBy: {
      kind: "instrument",
      instrument: "AUDIT-C",
      page: "/records/specialty/substance-use",
      entry: "in-app",
    },
  },
  {
    // Drug-use screening (#998): a recorded DAST-10 score satisfies it. Matched by
    // the canonical biomarker + unambiguous name synonyms only — deliberately NO
    // shared SBIRT codes (see alcohol_screening above) so an alcohol screen can't
    // cross-satisfy the drug screening.
    ruleKey: "drug_use_screening",
    kind: "screening",
    codes: [],
    names: [
      "drug use screening",
      "drug screening questionnaire",
      "drug abuse screening test",
      "dast 10",
      "dast",
    ],
    canonicalBiomarkers: ["DAST-10"],
    // DAST-10 is in-app since #1085 (the owner-reversed #998 licensing call — see
    // lib/substance-use.ts), so the CTA verb is "Complete the DAST-10".
    satisfiedBy: {
      kind: "instrument",
      instrument: "DAST-10",
      page: "/records/specialty/substance-use",
      entry: "in-app",
    },
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
    // A blood test, but no tracked HCV biomarker — the add form opens unprefilled.
    satisfiedBy: { kind: "lab" },
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
    // A recorded reading IS the screening — a self-recordable VITAL, not a lab.
    // Links to the vitals entry surface (#1076), never the biomarkers form.
    satisfiedBy: { kind: "vital", primary: "Blood Pressure Systolic" },
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
      "dentist",
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
      "optometrist",
      "ophthalmology",
      "ophthalmological",
      "ophthalmologist",
    ],
    canonicalBiomarkers: [],
  },
  {
    // Hearing screening (issue #713): a recorded audiometry/audiogram or an audiology
    // visit satisfies the age-related hearing screening. CPT audiometry codes are
    // specific; names are single, unambiguous audiology terms (whole-word matched).
    // A recorded pure-tone threshold reading is a strong satisfying signal too, so the
    // audiogram analytes count as canonical biomarkers.
    ruleKey: "hearing_screening",
    kind: "visit",
    codes: [
      "92557", // CPT comprehensive audiometry (air + bone + speech)
      "92552", // CPT pure-tone audiometry, air only
      "92553", // CPT pure-tone audiometry, air and bone
      "92555", // CPT speech audiometry, threshold
      "92556", // CPT speech audiometry, threshold with speech recognition
      "1425003", // SNOMED audiometry
    ],
    names: [
      "audiogram",
      "audiometry",
      "hearing test",
      "hearing exam",
      "hearing screening",
      "audiology",
      "audiologist",
      "pure tone audiometry",
    ],
    canonicalBiomarkers: [
      "Hearing Threshold, Right Ear 1 kHz",
      "Hearing Threshold, Left Ear 1 kHz",
      "Hearing Threshold, Right Ear 4 kHz",
      "Hearing Threshold, Left Ear 4 kHz",
    ],
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
      // Provider-specialty evidence (issue #515): a visit to a dermatology
      // provider/facility is strong, specific evidence a skin exam occurred.
      // Specialty terms are single, unambiguous words (unlike bare "skin"), so
      // whole-word matching them stays within the #86 conservatism — the matcher
      // now folds the encounter's provider/facility name into the matched text
      // (see lib/queries/upcoming/preventive.ts).
      "dermatology",
      "dermatologist",
    ],
    canonicalBiomarkers: [],
  },
];

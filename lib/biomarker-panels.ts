// The normalized biomarker PANEL taxonomy (issue #1502) — the controlled
// vocabulary that answers "which clinical panel is this analyte part of?".
//
// WHY THIS EXISTS. `medical_records.panel` is source-authored free text the
// importer copies off a document's section heading, and in practice it lands as
// PROVENANCE, not clinical meaning: the seeded corpus's top values are
// "Quest Diagnostics", "LabCorp", "BioReference". That made three surfaces worse
// than they had to be — the Timeline titled a lab draw "Quest Diagnostics
// results", the Biomarkers browser's panel facet filtered by lab VENDOR, and a
// biomarker detail page had no way to offer "the rest of this panel". All three
// want the same missing thing: a canonical_name -> panel resolver. This module is
// it, and it is deliberately built as shared infrastructure rather than inside any
// one consumer (#1499's Results-hub grouping is a later consumer, not the owner).
//
// SLUG IDS, NOT DISPLAY STRINGS. A panel is a closed set of slug ids (`lipids`,
// `cbc`, `thyroid`, …) with ONE `PANEL_LABELS` map owning the display string and
// sort order. Rationale (the registry pattern `RULE_FINDING_PREFIXES` / `AppRoute`
// already use): the `?panel=` URL param stays a stable clean slug across
// rewording; a typo can't silently fork a group (an unknown slug is a type error);
// reword/reorder is one edit; and any persisted state keys on a stable identity
// rather than a recyclable display name (#203 — names recycle, ids don't).
//
// #482 INTERPLAY (this is a DIFFERENT question than biomarkerFamily()). The family
// convention answers "same ANALYTE?" (Total/D2/D3 vitamin D, A1c ↔ eAG); this
// answers "same ORDER/panel?". They compose rather than compete: resolution here
// is FAMILY-FIRST, so every spelling that biomarkerFamily() collapses onto one
// analyte lands in ONE panel — "Estimated Average Glucose" resolves to `glycemic`
// exactly like "Hemoglobin A1c", and "25-OH Vitamin D" to `vitamins` exactly like
// "Vitamin D, 25-Hydroxy". A pure test pins that no registered family straddles two
// panels, so an over-broad family can't quietly split a group.
//
// SQL REALIZATION (#394 finite preimage). SQL can't call this matcher, so
// `panelKeyOfExpr()` inlines each panel's member spellings as an `IN (...)`
// preimage over a name expression — the same shape `biomarkerFamilyKey()` uses in
// lib/queries/medical.ts, generated from the SAME data below so the JS and SQL
// answers can never disagree. Every other name falls through to `other`.
//
// FALLBACK POSTURE. `other` is reserved for names the taxonomy does NOT know —
// an un-canonicalized reading the extractor coined. It is NOT a dumping ground for
// canonical entries: a pure test (lib/__tests__/biomarker-panels.test.ts) fails
// when any of lib/canonical-biomarkers.json's entries lacks an explicit assignment,
// so a NEW canonical biomarker added without a panel breaks the build instead of
// silently becoming "Other".
//
// The assignment is curated from routine ordering practice (which analytes arrive
// on one requisition / one report section). It is INFORMATIONAL grouping for
// navigation — not medical advice, and not a claim about how any given lab bundles
// its own menu.
//
// Pure — no DB, no network, auth-blind.

import {
  BIOMARKER_FAMILIES,
  biomarkerFamily,
  normalizeCanonicalKey,
} from "./canonical-name";

// ---- The closed panel id set ----------------------------------------------

// Every panel slug, in display order. `other` is the reserved fallback and always
// sorts last. Adding a panel means adding its slug here, its label below, and its
// members in BIOMARKER_PANELS — all three are total over PanelId by construction.
export const PANEL_IDS = [
  "lipids",
  "lipoprotein-particles",
  "glycemic",
  "inflammation",
  "kidney",
  "electrolytes",
  "liver",
  "tissue-enzymes",
  "cbc",
  "iron",
  "hemoglobin-variants",
  "thyroid",
  "hormones",
  "vitamins",
  "minerals",
  "omega-fatty-acids",
  "immunoglobulins",
  "allergy",
  "tumor-markers",
  "infectious-disease",
  "immunity-titers",
  "prenatal-screening",
  "blood-type",
  "urinalysis",
  "heavy-metals",
  "pfas",
  "vital-signs",
  "body-composition",
  "fitness",
  "vision",
  "hearing",
  "dental",
  "mental-health",
  "biological-age",
  "other",
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

// The reserved fallback slug for a name the taxonomy doesn't know.
export const OTHER_PANEL: PanelId = "other";

// The ONE display map: slug -> { label, order }. Total over PanelId (the Record
// type enforces it), so a new slug without a label is a compile error. `order` is
// the sort key every panel-grouped surface reads; `other` sorts last on purpose.
export const PANEL_LABELS: Record<PanelId, { label: string; order: number }> = {
  lipids: { label: "Lipids", order: 10 },
  "lipoprotein-particles": { label: "Lipoprotein particles", order: 20 },
  glycemic: { label: "Glucose & insulin", order: 30 },
  inflammation: { label: "Inflammation", order: 40 },
  kidney: { label: "Kidney", order: 50 },
  electrolytes: { label: "Electrolytes & minerals", order: 60 },
  liver: { label: "Liver & protein", order: 70 },
  "tissue-enzymes": { label: "Pancreatic & tissue enzymes", order: 80 },
  cbc: { label: "Complete blood count", order: 90 },
  iron: { label: "Iron studies", order: 100 },
  "hemoglobin-variants": { label: "Hemoglobin variants", order: 110 },
  thyroid: { label: "Thyroid", order: 120 },
  hormones: { label: "Hormones", order: 130 },
  vitamins: { label: "Vitamins", order: 140 },
  minerals: { label: "Trace minerals", order: 150 },
  "omega-fatty-acids": { label: "Fatty acids", order: 160 },
  immunoglobulins: { label: "Immunoglobulins & autoantibodies", order: 170 },
  allergy: { label: "Allergy (IgE)", order: 180 },
  "tumor-markers": { label: "Tumor markers", order: 190 },
  "infectious-disease": { label: "Infectious disease", order: 200 },
  "immunity-titers": { label: "Immunity titers", order: 210 },
  "prenatal-screening": { label: "Prenatal screening", order: 220 },
  "blood-type": { label: "Blood type", order: 230 },
  urinalysis: { label: "Urinalysis", order: 240 },
  "heavy-metals": { label: "Heavy metals", order: 250 },
  pfas: { label: "PFAS", order: 260 },
  "vital-signs": { label: "Vital signs", order: 270 },
  "body-composition": { label: "Body composition", order: 280 },
  fitness: { label: "Functional fitness", order: 290 },
  vision: { label: "Vision", order: 300 },
  hearing: { label: "Hearing", order: 310 },
  dental: { label: "Dental", order: 320 },
  "mental-health": { label: "Mental health screens", order: 330 },
  "biological-age": { label: "Biological age", order: 340 },
  other: { label: "Other", order: 9999 },
};

// ---- The curated assignment ------------------------------------------------

// Every canonical biomarker name, keyed by its panel. Members are EXACT canonical
// names from lib/canonical-biomarkers.json (matched case-/punctuation-/word-order-
// insensitively via normalizeCanonicalKey, so a stored "Creatinine, Urine" and
// "Urine Creatinine" both land). `other` carries no members — it is the fallback,
// and a canonical entry that ends up there fails the 0-unmapped test.
//
// Curation notes for the judgement calls (all INFORMATIONAL):
//  - `lipids` is the routine lipid panel + the derived ratios; the NMR/ion-mobility
//    subfraction report is its OWN order, so it stays in `lipoprotein-particles`
//    (a standard panel and an advanced panel drawn the same day are two results,
//    and titling them apart is the point).
//  - `glycemic` holds the gestational glucose challenge: it is a glucose
//    measurement read against glycemic thresholds. The NIPT/fetal-fraction set is
//    the pregnancy SCREEN and stays in `prenatal-screening`.
//  - Leptin sits in `glycemic` — an adiposity/energy-balance hormone interpreted
//    beside insulin, not with the reproductive/adrenal axis.
//  - `electrolytes` carries the CMP mineral core (calcium/magnesium/phosphorus)
//    and the derived anion gap; the nutritional TRACE elements (zinc, selenium,
//    copper, iodine, chromium, molybdenum, RBC magnesium) are a separate
//    micronutrient order in `minerals`, and the TOXIC ones are in `heavy-metals`.
//    Keeping toxic and nutritional apart is deliberate — collapsing them would
//    put a lead level in the same group as a zinc level.
//  - `liver` is the hepatic-function set INCLUDING the protein fractions
//    (albumin/globulin/total protein/A:G) that ship on the same report; the
//    non-hepatic organ-damage enzymes (amylase, lipase, CK, LDH) are
//    `tissue-enzymes`.
//  - `cbc` is CBC WITH DIFFERENTIAL as labs actually order it — the counts,
//    indices, the percentage AND absolute differential, reticulocytes, nucleated
//    RBCs and immature granulocytes are one report. The electrophoresis fractions
//    (Hgb A/A2/F) are a separate order in `hemoglobin-variants`.
//  - `hormones` is the combined reproductive + adrenal/pituitary axis (the way a
//    "hormone panel" is ordered and read), not split into two thin groups.
//  - Homocysteine sits in `inflammation` with hs-CRP/CRP/ESR — the
//    cardiovascular-risk inflammatory set it is ordered with — rather than in
//    `vitamins` beside its B-vitamin cofactors.
//  - The hepatitis SURFACE ANTIBODY stays in `infectious-disease` with the rest of
//    the hepatitis serology (it arrives on that panel) even though it reads as an
//    immunity titer; `immunity-titers` is the MMR/varicella immunity set.
//  - Rheumatoid factor sits with the immunoglobulins (it IS an immunoglobulin
//    assay) rather than minting a one-member autoimmune panel; the thyroid
//    autoantibodies stay with `thyroid`, where they are ordered.
export const BIOMARKER_PANELS: Record<
  Exclude<PanelId, "other">,
  readonly string[]
> = {
  lipids: [
    "Total Cholesterol",
    "LDL Cholesterol",
    "HDL Cholesterol",
    "Triglycerides",
    "VLDL Cholesterol",
    "Non-HDL Cholesterol",
    "Apolipoprotein B (ApoB)",
    "Lipoprotein(a)",
    "Cholesterol/HDL Ratio",
    "Triglyceride/HDL Ratio",
    "LDL/HDL Ratio",
  ],
  "lipoprotein-particles": [
    "LDL Particle Number",
    "LDL Small",
    "LDL Medium",
    "LDL Peak Size",
    "LDL Pattern",
    "HDL Large",
  ],
  glycemic: [
    "Glucose",
    "Glucose, Fasting",
    "Hemoglobin A1c",
    "Insulin",
    "HOMA-IR",
    "C-Peptide",
    "Glucose, Gestational Screen (50 g)",
    "Leptin",
  ],
  inflammation: [
    "High-Sensitivity C-Reactive Protein (hs-CRP)",
    "C-Reactive Protein",
    "Erythrocyte Sedimentation Rate (ESR)",
    "Homocysteine",
  ],
  kidney: [
    "Blood Urea Nitrogen (BUN)",
    "Creatinine",
    "eGFR",
    "Cystatin C",
    "BUN/Creatinine Ratio",
    "Uric Acid",
  ],
  electrolytes: [
    "Sodium",
    "Potassium",
    "Chloride",
    "Carbon Dioxide",
    "Anion Gap",
    "Calcium",
    "Magnesium",
    "Phosphorus",
  ],
  liver: [
    "Alanine Aminotransferase (ALT)",
    "Aspartate Aminotransferase (AST)",
    "Alkaline Phosphatase",
    "Gamma-Glutamyl Transferase (GGT)",
    "Total Bilirubin",
    "Direct Bilirubin",
    "Albumin",
    "Globulin",
    "Total Protein",
    "Albumin/Globulin Ratio",
  ],
  "tissue-enzymes": [
    "Amylase",
    "Lipase",
    "Creatine Kinase (CK)",
    "Lactate Dehydrogenase (LDH)",
  ],
  cbc: [
    "Hemoglobin",
    "Hematocrit",
    "White Blood Cell Count",
    "Red Blood Cell Count",
    "Platelet Count",
    "Mean Corpuscular Volume (MCV)",
    "Mean Corpuscular Hemoglobin (MCH)",
    "Mean Corpuscular Hemoglobin Concentration (MCHC)",
    "Red Cell Distribution Width (RDW)",
    "Mean Platelet Volume (MPV)",
    "Neutrophils",
    "Neutrophils, Absolute",
    "Lymphocytes",
    "Lymphocytes, Absolute",
    "Monocytes",
    "Monocytes, Relative",
    "Eosinophils",
    "Eosinophils, Relative",
    "Basophils",
    "Basophils, Relative",
    "Immature Granulocytes",
    "Immature Granulocytes, Absolute",
    "Nucleated Red Blood Cells",
    "Nucleated Red Blood Cells, Absolute",
    "Reticulocytes",
    "Reticulocytes, Absolute",
  ],
  iron: [
    "Ferritin",
    "Iron",
    "Total Iron-Binding Capacity (TIBC)",
    "Transferrin Saturation",
  ],
  "hemoglobin-variants": [
    "Hemoglobin Electrophoresis",
    "Hemoglobin A",
    "Hemoglobin A2",
    "Hemoglobin F",
  ],
  thyroid: [
    "Thyroid-Stimulating Hormone (TSH)",
    "Free T4",
    "Free T3",
    "Total T4",
    "Total T3",
    "Thyroid Peroxidase Antibodies (TPOAb)",
    "Thyroglobulin Antibodies (TgAb)",
  ],
  hormones: [
    "Testosterone, Total",
    "Testosterone, Free",
    "Sex Hormone Binding Globulin (SHBG)",
    "Estradiol",
    "Progesterone",
    "Follicle Stimulating Hormone (FSH)",
    "Luteinizing Hormone (LH)",
    "Prolactin",
    "DHEA-Sulfate",
    "Cortisol",
    "Insulin-Like Growth Factor 1 (IGF-1)",
  ],
  vitamins: [
    "Vitamin D, 25-Hydroxy",
    "Vitamin D2, 25-Hydroxy",
    "Vitamin D3, 25-Hydroxy",
    "Vitamin D, 1,25-Dihydroxy",
    "Vitamin B12",
    "Methylmalonic Acid (MMA)",
    "Folate",
    "Folate, RBC",
    "Vitamin A (Retinol)",
    "Vitamin E (Alpha-Tocopherol)",
    "Vitamin E (Beta/Gamma-Tocopherol)",
    "Coenzyme Q10",
  ],
  minerals: [
    "Zinc",
    "Copper",
    "Selenium",
    "Iodine",
    "Chromium",
    "Molybdenum",
    "Magnesium, RBC",
  ],
  "omega-fatty-acids": [
    "Omega-3 Total (OmegaCheck)",
    "Omega-3 EPA",
    "Omega-3 DHA",
    "Omega-3 DPA",
    "Omega-6 Arachidonic Acid",
    "Omega-6 Linoleic Acid",
    "Omega-6/Omega-3 Ratio",
    "Arachidonic Acid/EPA Ratio",
  ],
  immunoglobulins: [
    "Immunoglobulin G",
    "Immunoglobulin A",
    "Immunoglobulin M",
    "Immunoglobulin G Subclass 1",
    "Immunoglobulin G Subclass 2",
    "Immunoglobulin G Subclass 3",
    "Immunoglobulin G Subclass 4",
    "Rheumatoid Factor (RF)",
  ],
  allergy: [
    "Immunoglobulin E (Total)",
    "Alternaria Alternata (M6) IgE",
    "Aspergillus Fumigatus (M3) IgE",
    "Bermuda Grass (G2) IgE",
    "Birch (T3) IgE",
    "Cat Dander (E1) IgE",
    "Cladosporium Herbarum (M2) IgE",
    "Cockroach (I6) IgE",
    "Common Ragweed (Short) (W1) IgE",
    "Cottonwood (T14) IgE",
    "Dermatophagoides Farinae (D2) IgE",
    "Dermatophagoides Pteronyssinus (D1) IgE",
    "Dog Dander (E5) IgE",
    "Elm (T8) IgE",
    "Maple (Box Elder) (T1) IgE",
    "Mountain Cedar (T6) IgE",
    "Mouse Urine Proteins (E72) IgE",
    "Mugwort (W6) IgE",
    "Oak (T7) IgE",
    "Penicillium Notatum (M1) IgE",
    "Rough Pigweed (W14) IgE",
    "Sheep Sorrel (W18) IgE",
    "Sycamore (T11) IgE",
    "Timothy Grass (G6) IgE",
    "Walnut Tree (T10) IgE",
    "White Ash (T15) IgE",
    "White Mulberry (T70) IgE",
  ],
  "tumor-markers": [
    "Prostate-Specific Antigen (PSA)",
    "Prostate Specific Antigen (PSA), Free %",
    "Alpha-Fetoprotein (AFP)",
    "Carcinoembryonic Antigen (CEA)",
  ],
  "infectious-disease": [
    "Hepatitis B Surface Antigen (HBsAg)",
    "Hepatitis B Surface Antibody (HBsAb)",
    "Hepatitis C Antibody (Anti-HCV)",
    "HIV Antigen/Antibody",
    "RPR",
    "Chlamydia trachomatis NAAT",
    "Neisseria gonorrhoeae NAAT",
    "HPV, High-Risk",
    "HPV Genotype 16",
    "HPV Genotype 18/45",
    "SARS-CoV-2 NAAT",
    "SARS-CoV-2 Antigen",
    "Influenza A NAAT",
    "Influenza B NAAT",
    "Influenza A Antigen",
    "Influenza B Antigen",
    "RSV NAAT",
    "Streptococcus A NAAT",
    "Group B Streptococcus",
    "Culture Organism",
  ],
  "immunity-titers": [
    "Measles Antibody IgG",
    "Mumps Antibody IgG",
    "Rubella Antibody IgG",
    "Varicella Zoster Antibody IgG",
  ],
  "prenatal-screening": [
    "Trisomy 21 Screen",
    "Trisomy 18 Screen",
    "Trisomy 13 Screen",
    "Fetal Fraction",
  ],
  "blood-type": ["Blood Type", "ABO Blood Group", "Rh Type"],
  urinalysis: [
    "Urine pH",
    "Urine Specific Gravity",
    "Protein, Urine",
    "Glucose, Urine",
    "Ketones, Urine",
    "Bilirubin, Urine",
    "Blood, Urine",
    "Nitrite, Urine",
    "Leukocyte Esterase, Urine",
    "Urobilinogen, Urine",
    "Albumin, Urine",
    "Creatinine, Urine",
    "Red Blood Cells, Urine",
    "White Blood Cells, Urine",
    "Squamous Epithelial Cells, Urine",
  ],
  "heavy-metals": ["Lead", "Mercury", "Arsenic", "Aluminum"],
  pfas: [
    "PFAS - NASEM Recommended Summation",
    "PFAS - Linear PFOA Isomers",
    "PFAS - Branched PFOA Isomers",
    "PFAS - Linear PFOS Isomers",
    "PFAS - Branched PFOS Isomers",
    "PFAS - MeFOSAA",
    "PFAS - PFDA",
    "PFAS - PFHxS",
    "PFAS - PFNA",
    "PFAS - PFUnDA",
  ],
  "vital-signs": [
    "Blood Pressure Systolic",
    "Blood Pressure Diastolic",
    "Resting Heart Rate",
    "Respiratory Rate",
    "Oxygen Saturation",
    "Body Temperature",
  ],
  "body-composition": [
    "Body Fat Percentage",
    "Visceral Adipose Tissue",
    "Appendicular Lean Mass Index",
    "Bone Mineral Density T-Score",
  ],
  fitness: [
    "VO2 Max",
    "Grip Strength",
    "30-Second Chair Stand",
    "Single-Leg Balance",
  ],
  vision: [
    "Visual Acuity",
    "Visual Acuity, Right Eye",
    "Visual Acuity, Left Eye",
    "Intraocular Pressure",
    "Intraocular Pressure, Right Eye",
    "Intraocular Pressure, Left Eye",
  ],
  hearing: [
    "Hearing Threshold, Right Ear 250 Hz",
    "Hearing Threshold, Right Ear 500 Hz",
    "Hearing Threshold, Right Ear 1 kHz",
    "Hearing Threshold, Right Ear 2 kHz",
    "Hearing Threshold, Right Ear 4 kHz",
    "Hearing Threshold, Right Ear 8 kHz",
    "Hearing Threshold, Left Ear 250 Hz",
    "Hearing Threshold, Left Ear 500 Hz",
    "Hearing Threshold, Left Ear 1 kHz",
    "Hearing Threshold, Left Ear 2 kHz",
    "Hearing Threshold, Left Ear 4 kHz",
    "Hearing Threshold, Left Ear 8 kHz",
  ],
  dental: [
    "Periodontal Probing Depth",
    "Bleeding on Probing",
    "Clinical Attachment Loss",
  ],
  "mental-health": ["PHQ-9", "GAD-7", "AUDIT", "AUDIT-C", "DAST-10"],
  "biological-age": ["Biological Age", "PhenoAge"],
};

// ---- Resolution ------------------------------------------------------------

// The `family:<key>` prefix biomarkerFamily() returns for a REAL family identity
// (a non-family name comes back as the bare trimmed name).
const FAMILY_PREFIX = "family:";

// Lookup indexes, built once at module load: the exact-name index (normalized
// canonical key -> PanelId) and the #482 FAMILY index (`family:<key>` -> PanelId).
// They are separate maps so the two namespaces can never collide, and the exact
// index is consulted FIRST — an explicit assignment always beats the family a name
// happens to belong to.
const { byKey: PANEL_BY_KEY, byFamily: PANEL_BY_FAMILY } = (() => {
  const byKey = new Map<string, PanelId>();
  const byFamily = new Map<string, PanelId>();
  for (const [panel, names] of Object.entries(BIOMARKER_PANELS) as [
    PanelId,
    readonly string[],
  ][]) {
    for (const name of names) {
      byKey.set(normalizeCanonicalKey(name), panel);
      const fam = biomarkerFamily(name);
      // First assignment wins; the "no family straddles two panels" test proves
      // one family's members never disagree, so "first" is unambiguous.
      if (fam.startsWith(FAMILY_PREFIX) && !byFamily.has(fam))
        byFamily.set(fam, panel);
    }
  }
  return { byKey, byFamily };
})();

// Resolve a biomarker name to its panel. Family-aware: an exact canonical
// assignment wins, then the name's #482 family identity (so every spelling of one
// analyte shares its panel), else `other`.
//
// Takes the CANONICAL name (post-snapCanonicalName). A raw lab string works when
// it normalizes to a known key, but a genuinely un-canonicalized analyte resolves
// to `other` — by design: the taxonomy describes the controlled vocabulary, and an
// unknown name has no panel to claim.
export function panelForCanonicalName(
  name: string | null | undefined
): PanelId {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return OTHER_PANEL;
  const exact = PANEL_BY_KEY.get(normalizeCanonicalKey(trimmed));
  if (exact) return exact;
  const fam = biomarkerFamily(trimmed);
  if (fam.startsWith(FAMILY_PREFIX)) {
    const byFam = PANEL_BY_FAMILY.get(fam);
    if (byFam) return byFam;
  }
  return OTHER_PANEL;
}

// The display label for a panel slug.
export function panelLabel(id: PanelId): string {
  return PANEL_LABELS[id].label;
}

// True when `value` is a real panel slug. The `?panel=` param guard: an unknown
// slug is ignored rather than filtering to nothing (and can never fork a group).
export function isPanelId(value: string | null | undefined): value is PanelId {
  return !!value && (PANEL_IDS as readonly string[]).includes(value);
}

// Parse a `?panel=` query value into a PanelId, or undefined when absent/unknown.
export function parsePanelId(
  value: string | null | undefined
): PanelId | undefined {
  const v = value?.trim();
  return isPanelId(v) ? v : undefined;
}

// Every panel slug in PANEL_LABELS order (`other` last). The ONE ordering every
// panel-grouped surface reads.
export function orderedPanelIds(): PanelId[] {
  return [...PANEL_IDS].sort(
    (a, b) => PANEL_LABELS[a].order - PANEL_LABELS[b].order
  );
}

// ---- SQL finite-preimage realization (#394) --------------------------------

// Member spellings of a `family:<key>` identity, from the shared BIOMARKER_FAMILIES
// data (imported, never duplicated — one source of truth with lib/canonical-name.ts,
// the same discipline familyKeyOfExpr uses for the family preimage).
const FAMILY_MEMBERS = new Map<string, readonly string[]>(
  BIOMARKER_FAMILIES.map((f) => [`${FAMILY_PREFIX}${f.key}`, f.members])
);

// The lowercased spellings that resolve to each panel: its assigned canonical
// names PLUS every member spelling of any #482 family those names belong to, so
// the SQL preimage and the JS matcher agree on "25-OH Vitamin D" and "eAG".
// Deduped, insertion-ordered, so the generated SQL is deterministic.
export function panelMemberSpellings(id: Exclude<PanelId, "other">): string[] {
  const out = new Set<string>();
  for (const name of BIOMARKER_PANELS[id]) {
    out.add(name.toLowerCase());
    const fam = biomarkerFamily(name);
    for (const spelling of FAMILY_MEMBERS.get(fam) ?? [])
      out.add(spelling.toLowerCase());
  }
  return [...out];
}

function sqlStringLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// The panel identity as a SQL expression over an arbitrary name expression — the
// finite-preimage (#394) realization of panelForCanonicalName(), mirroring
// familyKeyOfExpr() in lib/queries/medical.ts. Each panel's member spellings are
// inlined as an `IN (...)` preimage; everything else falls through to `'other'`.
// Slugs and member strings are hardcoded constants (single-quote escaped), so this
// is injection-safe. Pass a name expression that already resolves canonical-or-raw
// (e.g. biomarkerNameKey()).
export function panelKeyOfExpr(nameExpr: string): string {
  const whens = (
    Object.keys(BIOMARKER_PANELS) as Exclude<PanelId, "other">[]
  ).map((id) => {
    const inList = panelMemberSpellings(id).map(sqlStringLiteral).join(", ");
    return `WHEN lower(${nameExpr}) IN (${inList}) THEN ${sqlStringLiteral(id)}`;
  });
  return `CASE ${whens.join(" ")} ELSE ${sqlStringLiteral(OTHER_PANEL)} END`;
}

// The panel's SORT ORDER as a SQL expression, mapping an already-resolved panel
// slug expression (i.e. panelKeyOfExpr's output, or a column holding it) to its
// PANEL_LABELS order. Deliberately takes the SLUG rather than the name so the big
// finite-preimage CASE is evaluated ONCE and this stays a small lookup — the
// "ORDER BY panel" clause and the JS comparator in lib/derived-table then sort by
// the SAME curated order instead of an alphabetical accident of the slug spelling.
export function panelOrderOfPanelExpr(panelExpr: string): string {
  const whens = PANEL_IDS.map(
    (id) => `WHEN ${sqlStringLiteral(id)} THEN ${PANEL_LABELS[id].order}`
  ).join(" ");
  return `CASE ${panelExpr} ${whens} ELSE ${PANEL_LABELS.other.order} END`;
}

// The sort order for a resolved panel — the JS twin of panelOrderOfPanelExpr, so
// the merged stored+derived table orders identically to the SQL-only list.
export function panelSortOrder(id: PanelId): number {
  return PANEL_LABELS[id].order;
}

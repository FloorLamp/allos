// Maps common LOINC codes to the app's canonical biomarker names (the ones
// seeded from lib/canonical-biomarkers.json), so a vital sign / lab pulled out of
// a CCD or SMART Health Card aggregates under the same identity — and picks up
// the same reference band — as the rest of the app, instead of the portal's raw
// display name (e.g. "Systolic blood pressure" vs the canonical "Blood Pressure
// Systolic"). Only codes with a curated canonical entry are listed; an unmapped
// code keeps its printed name. Pure + unit-tested; keyed by LOINC because that's
// the stable, display-name-independent identifier both formats carry.

export const LOINC_TO_CANONICAL: Record<string, string> = {
  // Vital signs (canonical entries live under category "vitals").
  "8480-6": "Blood Pressure Systolic", // Systolic blood pressure
  "8462-4": "Blood Pressure Diastolic", // Diastolic blood pressure
  "8867-4": "Resting Heart Rate", // Heart rate
  "9279-1": "Respiratory Rate", // Respiratory rate
  "2708-6": "Oxygen Saturation", // Oxygen saturation in Arterial blood
  "59408-5": "Oxygen Saturation", // SpO2 by pulse oximetry
  "8310-5": "Body Temperature", // Body temperature

  // ── Complete Blood Count (CBC) ──────────────────────────────────────────────
  // Indices. Each LOINC was confirmed against the LOINC identity (name +
  // property/units) so the reading routes to the canonical entry sharing its unit
  // (canonical units in parentheses); a same-day duplicate reported in an
  // alternate unit still dedups by LOINC. Validated against a real Epic CCD.
  "718-7": "Hemoglobin", // Hemoglobin [Mass/volume] in Blood (g/dL)
  "789-8": "Red Blood Cell Count", // Erythrocytes [#/volume] in Blood by Automated count (10^6/uL)
  "4544-3": "Hematocrit", // Hematocrit [Volume Fraction] of Blood by Automated count (%)
  "787-2": "MCV", // MCV [Entitic volume] by Automated count (fL)
  "785-6": "MCH", // MCH [Entitic mass] by Automated count (pg)
  "786-4": "MCHC", // MCHC [Mass/volume] by Automated count (g/dL)
  "788-0": "RDW", // Erythrocyte distribution width [Ratio] by Automated count (%)
  "777-3": "Platelet Count", // Platelets [#/volume] in Blood by Automated count (10^3/uL)
  "6690-2": "White Blood Cell Count", // Leukocytes [#/volume] in Blood by Automated count (10^3/uL)
  "776-5": "MPV", // Platelet mean volume [Entitic volume] in Blood by Automated count (fL)
  // Alternate platelet/MPV LOINCs emitted by real Epic exports — same unit as the
  // automated-count forms above, so they route to the same canonical entries.
  "26515-7": "Platelet Count", // Platelets [#/volume] in Blood (method-less; 10^3/uL)
  "28542-9": "MPV", // Platelet mean volume [Entitic volume] in Blood (method-less; fL)
  "32623-1": "MPV", // Platelet mean volume [Entitic volume] in Blood by Rees-Ecker (fL)

  // WBC differential. The differential is reported in TWO complementary quantities
  // — an absolute count (cells/uL) and a fraction of leukocytes (%) — which are
  // NOT interconvertible without the WBC, so each LOINC form maps to the canonical
  // entry carrying the MATCHING unit (never both forms onto one identity):
  //   absolute-count LOINC  → the cells/uL canonical entry
  //   /100-leukocytes LOINC → the "…, Relative" (%) canonical entry. The %-forms
  //     are named "Relative", NOT "…, %": normalizeCanonicalKey strips "%", so
  //     "Monocytes, %" would collide with the absolute "Monocytes" entry and never
  //     route. Neutrophils/Lymphocytes have no absolute/percent name clash (the
  //     base name is the % form; "…​, Absolute" is the count form).
  "751-8": "Neutrophils, Absolute", // Neutrophils [#/volume] by Automated count (cells/uL)
  "770-8": "Neutrophils", // Neutrophils/100 leukocytes by Automated count (%)
  "731-0": "Lymphocytes, Absolute", // Lymphocytes [#/volume] by Automated count (cells/uL)
  "736-9": "Lymphocytes", // Lymphocytes/100 leukocytes by Automated count (%)
  "742-7": "Monocytes", // Monocytes [#/volume] by Automated count (cells/uL)
  "5905-5": "Monocytes, Relative", // Monocytes/100 leukocytes by Automated count (%)
  "711-2": "Eosinophils", // Eosinophils [#/volume] by Automated count (cells/uL)
  "713-8": "Eosinophils, Relative", // Eosinophils/100 leukocytes by Automated count (%)
  "704-7": "Basophils", // Basophils [#/volume] by Automated count (cells/uL)
  "706-2": "Basophils, Relative", // Basophils/100 leukocytes by Automated count (%)

  // ── Comprehensive Metabolic Panel (CMP) ─────────────────────────────────────
  // All map to existing canonical entries (unit in parentheses). Serum/plasma
  // codes; identities confirmed against LOINC.
  "2345-7": "Glucose", // Glucose [Mass/volume] in Serum/Plasma (mg/dL). The
  // whole-blood form (2339-0) is intentionally NOT mapped: whole blood runs ~10%
  // below plasma, so mapping it to the serum range would false-flag normals low.
  "3094-0": "BUN", // Urea nitrogen [Mass/volume] in Serum/Plasma (mg/dL)
  "2160-0": "Creatinine", // Creatinine [Mass/volume] in Serum/Plasma (mg/dL)
  "2951-2": "Sodium", // Sodium [Moles/volume] in Serum/Plasma (mmol/L)
  "2823-3": "Potassium", // Potassium [Moles/volume] in Serum/Plasma (mmol/L)
  "2075-0": "Chloride", // Chloride [Moles/volume] in Serum/Plasma (mmol/L)
  "2028-9": "Carbon Dioxide", // Carbon dioxide, total [Moles/volume] in Serum/Plasma (mmol/L)
  "17861-6": "Calcium", // Calcium [Mass/volume] in Serum/Plasma (mg/dL)
  "1751-7": "Albumin", // Albumin [Mass/volume] in Serum/Plasma (g/dL)
  "2885-2": "Total Protein", // Protein [Mass/volume] in Serum/Plasma (g/dL)
  "1975-2": "Total Bilirubin", // Bilirubin.total [Mass/volume] in Serum/Plasma (mg/dL)
  "1742-6": "ALT", // Alanine aminotransferase [Enzymatic activity/volume] (U/L)
  "1920-8": "AST", // Aspartate aminotransferase [Enzymatic activity/volume] (U/L)
  "6768-6": "Alkaline Phosphatase", // Alkaline phosphatase [Enzymatic activity/volume] (U/L)
  // eGFR is fragmented across many LOINCs (formula + population variants); all
  // resolve to the one canonical eGFR entry (mL/min/1.73m2).
  "33914-3": "eGFR", // GFR/1.73 sq M.predicted by Creatinine-based formula (MDRD)
  "98979-8": "eGFR", // GFR/1.73 sq M.predicted, Creatinine-based formula (CKD-EPI 2021)
  "48642-3": "eGFR", // GFR/1.73 sq M.predicted among non-blacks (CKD-EPI/MDRD)
  "48643-1": "eGFR", // GFR/1.73 sq M.predicted among blacks (CKD-EPI/MDRD)
  "62238-1": "eGFR", // GFR/1.73 sq M.predicted by Creatinine-based formula (CKD-EPI)

  // ── Lipid panel ─────────────────────────────────────────────────────────────
  // All map to existing canonical entries (mg/dL, except ratio / Lp(a)).
  "2093-3": "Total Cholesterol", // Cholesterol [Mass/volume] in Serum/Plasma
  "2085-9": "HDL Cholesterol", // Cholesterol in HDL [Mass/volume] in Serum/Plasma
  "13457-7": "LDL Cholesterol", // Cholesterol in LDL [Mass/volume], by calculation
  "18262-6": "LDL Cholesterol", // Cholesterol in LDL [Mass/volume], by Direct assay
  "2571-8": "Triglycerides", // Triglyceride [Mass/volume] in Serum/Plasma
  "43396-1": "Non-HDL Cholesterol", // Cholesterol non HDL [Mass/volume] in Serum/Plasma
  "13458-5": "VLDL Cholesterol", // Cholesterol in VLDL [Mass/volume], by calculation
  "9830-1": "Cholesterol/HDL Ratio", // Cholesterol.total/Cholesterol in HDL [Mass Ratio]
  "1884-6": "ApoB", // Apolipoprotein B [Mass/volume] in Serum/Plasma (mg/dL)
  // Canonical Lp(a) is molar (nmol/L); map only the molar LOINC. The mass form
  // (10835-7, mg/dL) has no fixed unit conversion (particle mass varies), so it is
  // intentionally left unmapped rather than mis-scaled.
  "43583-4": "Lipoprotein(a)", // Lipoprotein a [Moles/volume] in Serum/Plasma (nmol/L)

  // ── Diabetes ────────────────────────────────────────────────────────────────
  "4548-4": "Hemoglobin A1c", // Hemoglobin A1c/Hemoglobin.total in Blood (%)
  "17856-6": "Hemoglobin A1c", // HbA1c in Blood by HPLC (%)
  "4549-2": "Hemoglobin A1c", // HbA1c in Blood by Electrophoresis (%)
  "20448-7": "Insulin", // Insulin [Units/volume] in Serum/Plasma (uIU/mL) — the
  // arbitrary-units form matching the canonical uIU/mL, NOT the molar pmol/L code.
  "1986-9": "C-Peptide", // C peptide [Mass/volume] in Serum/Plasma (ng/mL)

  // ── Thyroid ─────────────────────────────────────────────────────────────────
  "3016-3": "TSH", // Thyrotropin [Units/volume] in Serum/Plasma (uIU/mL)
  "3024-7": "Free T4", // Thyroxine (T4) free [Mass/volume] in Serum/Plasma (ng/dL)
  "3051-0": "Free T3", // Triiodothyronine (T3) free [Mass/volume] in Serum/Plasma (pg/mL)
  "8099-4": "Thyroid Peroxidase Antibodies (TPOAb)", // Thyroperoxidase Ab [Units/volume] (IU/mL)
  "8098-6": "Thyroglobulin Antibodies (TgAb)", // Thyroglobulin Ab [Units/volume] (IU/mL)
  "3026-2": "Total T4", // Thyroxine (T4) [Mass/volume] in Serum/Plasma (ug/dL)
  "3053-6": "Total T3", // Triiodothyronine (T3) [Mass/volume] in Serum/Plasma (ng/dL)

  // ── Iron studies ────────────────────────────────────────────────────────────
  "2276-4": "Ferritin", // Ferritin [Mass/volume] in Serum/Plasma (ng/mL)
  "2498-4": "Iron", // Iron [Mass/volume] in Serum/Plasma (ug/dL)
  "2500-7": "TIBC", // Iron binding capacity [Mass/volume] in Serum/Plasma (ug/dL)
  "2502-3": "Transferrin Saturation", // Iron saturation [Mass Fraction] in Serum/Plasma (%)

  // ── Vitamins ────────────────────────────────────────────────────────────────
  "62292-8": "Vitamin D, 25-Hydroxy", // 25-OH-D3+D2 [Mass/volume] (total; ng/mL)
  "2132-9": "Vitamin B12", // Cobalamin (Vitamin B12) [Mass/volume] (pg/mL)
  "2284-8": "Folate", // Folate [Mass/volume] in Serum/Plasma (ng/mL)
  "2283-0": "Folate, RBC", // Folate [Mass/volume] in Red Blood Cells (ng/mL).
  // (NOT 2285-5, which is Follitropin in Semen — a wrong-analyte trap.)
  "2923-1": "Vitamin A (Retinol)", // Retinol [Mass/volume] in Serum/Plasma (ug/dL)
  "1823-4": "Vitamin E (Alpha-Tocopherol)", // Alpha tocopherol [Mass/volume] (mg/L)

  // ── Inflammatory ────────────────────────────────────────────────────────────
  "30522-7": "hs-CRP", // C reactive protein by High sensitivity method (mg/L)
  "4537-7": "Erythrocyte Sedimentation Rate (ESR)", // ESR by Westergren (mm/h)
  "30341-2": "Erythrocyte Sedimentation Rate (ESR)", // ESR in Blood (method-less; mm/h)

  // ── Liver / pancreas ────────────────────────────────────────────────────────
  "2324-2": "GGT", // Gamma glutamyl transferase [Enzymatic activity/volume] (U/L)
  "10834-0": "Globulin", // Globulin [Mass/volume] in Serum by calculation (g/dL)
  "1759-0": "Albumin/Globulin Ratio", // Albumin/Globulin [Mass Ratio] in Serum/Plasma
  "1798-8": "Amylase", // Amylase [Enzymatic activity/volume] in Serum/Plasma (U/L)
  "3040-3": "Lipase", // Lipase [Enzymatic activity/volume] in Serum/Plasma (U/L)
  "1968-7": "Direct Bilirubin", // Bilirubin.direct [Mass/volume] in Serum/Plasma (mg/dL)
  "2532-0": "Lactate Dehydrogenase (LDH)", // Lactate dehydrogenase [Enzymatic activity/volume] (U/L)
  "14804-9": "Lactate Dehydrogenase (LDH)", // LDH by Lactate→pyruvate reaction (U/L)
  "2157-6": "Creatine Kinase (CK)", // Creatine kinase [Enzymatic activity/volume] (U/L)

  // ── Chemistry extras ────────────────────────────────────────────────────────
  "19123-9": "Magnesium", // Magnesium [Mass/volume] in Serum/Plasma (mg/dL) — the
  // mass form matching the canonical mg/dL, NOT the molar mmol/L code (2601-3).
  "2777-1": "Phosphorus", // Phosphate [Mass/volume] in Serum/Plasma (mg/dL)
  "3084-1": "Uric Acid", // Urate [Mass/volume] in Serum/Plasma (mg/dL)
  "33037-3": "Anion Gap", // Anion gap in Serum/Plasma by calculation (mmol/L)
  "1863-0": "Anion Gap", // Anion gap 4 in Serum/Plasma (mmol/L)

  // ── Renal ───────────────────────────────────────────────────────────────────
  "33863-2": "Cystatin C", // Cystatin C [Mass/volume] in Serum/Plasma (mg/L)

  // ── Hormones (several are sex-specific — canonical entries carry sex ranges) ─
  "2986-8": "Testosterone, Total", // Testosterone [Mass/volume] in Serum/Plasma (ng/dL)
  "2991-8": "Testosterone, Free", // Testosterone Free [Mass/volume] in Serum/Plasma (pg/mL)
  "2243-4": "Estradiol", // Estradiol (E2) [Mass/volume] in Serum/Plasma (pg/mL)
  "2143-6": "Cortisol", // Cortisol [Mass/volume] in Serum/Plasma (ug/dL)
  "15067-2": "Follicle Stimulating Hormone (FSH)", // Follitropin [Units/volume] (mIU/mL)
  "10501-5": "Luteinizing Hormone (LH)", // Lutropin [Units/volume] (mIU/mL)
  "2191-5": "DHEA-Sulfate", // DHEA-S [Mass/volume] in Serum/Plasma (ug/dL)
  "13967-5": "Sex Hormone Binding Globulin (SHBG)", // SHBG [Moles/volume] (nmol/L)
  "2842-3": "Prolactin", // Prolactin [Mass/volume] in Serum/Plasma (ng/mL)
  "2484-4": "IGF-1", // Insulin-like growth factor-I [Mass/volume] (ng/mL)

  // ── Tumor markers ───────────────────────────────────────────────────────────
  "2857-1": "PSA", // Prostate specific Ag [Mass/volume] in Serum/Plasma (ng/mL)
  "12841-3": "Prostate Specific Antigen (PSA), Free %", // free/total PSA [Mass Fraction] (%).
  // (NOT 10886-0, which is free-PSA absolute in ng/mL, a different quantity.)

  // ── Metabolic ───────────────────────────────────────────────────────────────
  "13965-9": "Homocysteine", // Homocysteine [Moles/volume] in Serum/Plasma (umol/L)
  "13964-2": "Methylmalonic Acid (MMA)", // Methylmalonate [Moles/volume] in Serum/Plasma
  // (nmol/L). NOT 25130-6, which is a urine Pyridinoline/Creatinine ratio.

  // ── Hematology (reticulocytes) ──────────────────────────────────────────────
  "17849-1": "Reticulocytes", // Reticulocytes/Erythrocytes in Blood by Automated count (%)
  "4679-7": "Reticulocytes", // Reticulocytes/Erythrocytes in Blood (method-less; %)
  "60474-4": "Reticulocytes, Absolute", // Reticulocytes [#/volume] in Blood (10^3/uL)

  // ── Hematology (nucleated RBC, immature granulocytes) — issue #723 ──────────
  // Each analyte imports as an absolute count (×10^3/uL) AND as a fraction of
  // leukocytes (%); like the WBC differential the two are NOT interconvertible, so
  // each form routes to the canonical entry carrying its unit — never both onto one
  // identity. Epic emits alternate LOINCs per form (automated-count vs method-less),
  // all routing to the one entry (like the eGFR / platelet variants above).
  "771-6": "Nucleated Red Blood Cells, Absolute", // Nucleated erythrocytes [#/volume] in Blood (10^3/uL)
  "58413-6": "Nucleated Red Blood Cells", // Nucleated erythrocytes/100 leukocytes in Blood (%)
  "34165-1": "Immature Granulocytes, Absolute", // Immature granulocytes [#/volume] in Blood (10^3/uL)
  "51584-1": "Immature Granulocytes, Absolute", // Immature granulocytes [#/volume] in Blood by Automated count (10^3/uL)
  "71695-1": "Immature Granulocytes", // Immature granulocytes/100 leukocytes in Blood (%)
  "38518-7": "Immature Granulocytes", // Immature granulocytes/100 leukocytes in Blood by Automated count (%)

  // ── Hemoglobin electrophoresis fractions — issue #723 ───────────────────────
  // Distinct from Hemoglobin (g/dL, LOINC 718-7) and Hemoglobin A1c (%); each
  // fraction is its own % entry on electrophoresis.
  "20572-4": "Hemoglobin A", // Hemoglobin A/Hemoglobin.total in Blood (%)
  "4552-6": "Hemoglobin A2", // Hemoglobin A2/Hemoglobin.total in Blood (%)
  "32682-7": "Hemoglobin F", // Hemoglobin F/Hemoglobin.total in Blood (%)

  // ── Blood group ─────────────────────────────────────────────────────────────
  // The COMBINED ABO+Rh result Epic reports as one "ABORh Interpretation" row
  // ("O Positive"). It carries both halves, so it routes to the combined canonical
  // entry rather than the ABO-only one — mapping it to "ABO Blood Group" would
  // quietly drop the Rh factor. Canonicalizing it also makes the classifier's
  // name path recognize it ("Blood Type" matches IMMUTABLE_ATTRIBUTE), alongside
  // the LOINC `identity` class below (#910).
  "19057-9": "Blood Type", // ABO+Rh group
  // ── Toxic / trace metals ────────────────────────────────────────────────────
  // Blood lead. Canonical "Lead" is ug/dL; venous (confirmatory) and capillary
  // (pediatric screening) specimens share the unit and interpretation threshold, so
  // both LOINCs route to the one entry (mcg/dL == ug/dL). Kept as distinct readings
  // by LOINC, grouped under Lead — like the eGFR variants above.
  "77307-7": "Lead", // Lead [Mass/volume] in Venous blood (ug/dL)
  "10368-9": "Lead", // Lead [Mass/volume] in Capillary blood (mcg/dL)
};

// The canonical biomarker name for a LOINC code, or null when unmapped.
export function canonicalBiomarkerForLoinc(
  loinc: string | null | undefined
): string | null {
  if (!loinc) return null;
  return LOINC_TO_CANONICAL[loinc] ?? null;
}

// LOINC codes that denote vital signs (as opposed to lab results). A FHIR
// Observation carries no section context, so this is how the FHIR path decides
// category "vitals" vs "lab" — matching the CDA path, which reads the section.
// Keep in sync with the vitals block of LOINC_TO_CANONICAL above.
const VITAL_LOINCS = new Set([
  "8480-6", // Systolic blood pressure
  "8462-4", // Diastolic blood pressure
  "8867-4", // Heart rate
  "9279-1", // Respiratory rate
  "2708-6", // Oxygen saturation (arterial)
  "59408-5", // SpO2 by pulse oximetry
  "8310-5", // Body temperature
  // Body height/length is an anthropometric vital (not a lab), so it routes to
  // the vitals category and stays out of the biomarker vocabulary. It is projected
  // into metric_samples by the height recognizer — see lib/height-extract
  // (HEIGHT_LOINCS). Keep these two lists in sync.
  "8302-2", // Body height
  "3137-7", // Body height, Measured
  "8306-3", // Body height, Lying (length)
  "8308-9", // Body height, Standing
  // Head (occipital-frontal) circumference is likewise an anthropometric vital,
  // projected into metric_samples ('head_circumference_cm') by the head-circ
  // recognizer — see lib/head-circ-extract (HEADCIRC_LOINCS). Keep these two lists
  // in sync. The percentile code 8289-1 is intentionally NOT here (it's a derived
  // percentile, not a measurement).
  "8287-5", // Head Occipital-frontal circumference by Tape measure
  "9843-4", // Head circumference (alias)
  // Body weight and BMI are anthropometric vitals, not lab analytes — but Epic
  // reports them inside the Results section, so without this they classify as
  // "unmapped labs" (the two highest-frequency such codes across real exports).
  // isVitalLoinc keeps both out of the unmapped-lab report; the observation mapper
  // routes them to the vitals category. On persist, weight is projected into
  // body_metrics (the existing weight-reading rule), while BMI — not a body-metric
  // kind — lands as a vitals record.
  "29463-7", // Body weight (kg)
  "39156-5", // Body mass index (BMI) [Ratio] (kg/m2)
]);

export function isVitalLoinc(loinc: string | null | undefined): boolean {
  return loinc != null && VITAL_LOINCS.has(loinc);
}

// A lab observation LOINC that imported but has NO canonical mapping (and isn't a
// vital) — so it lands under its raw printed name with no biomarker grouping /
// reference band. The import debugger surfaces these (issue: unmapped-LOINC
// visibility) so a maintainer can see which codes to add to LOINC_TO_CANONICAL. A
// vital LOINC (routed by isVitalLoinc, e.g. a BP component or a height) is NOT
// "unmapped" for this purpose — it's intentionally kept out of the biomarker
// vocabulary — so it's excluded here.
export function isUnmappedLabLoinc(loinc: string | null | undefined): boolean {
  return (
    loinc != null &&
    loinc !== "" &&
    !isVitalLoinc(loinc) &&
    !isNonAnalyteLoinc(loinc) &&
    !isDerivedPercentileLoinc(loinc) &&
    canonicalBiomarkerForLoinc(loinc) == null
  );
}

// Non-analyte structural/administrative observations Epic packs into the Results
// section — a specimen expiration date, the performing method, "Approved By", a
// bibliography, an accession number. They carry no measurement, so importing them
// as lab records inflates the record count and the unmapped-code report with rows
// that are annotations ON a result, not results (#681). Deliberately CONSERVATIVE:
// only codes that are unambiguously administrative are listed — a code that could
// carry a real qualitative result (an interpretation, an organism id, an
// amplification call) is left OUT so a genuine result is never dropped. The
// observation mapper drops these before they become records.
const NON_ANALYTE_LOINCS = new Set([
  "45374-6", // Specimen Expiration Date
  "49549-9", // Test Method
  "72486-4", // Approved By
  "62364-5", // Performance (performing-lab metadata)
  "75608-0", // References
  "77202-0", // About The Test
  "8262-8", // Limitations of The Test
  "106201-7", // Cytology accession #
  "19066-0", // Status Information
]);

// Derived anthropometric PERCENTILES that pediatric CCDs report alongside the raw
// measurement — a BMI / weight-for-length / head-circumference percentile "per age
// and sex". They are computed values, not measurements, and the app derives its own
// growth percentiles from the raw height/weight/head-circ readings, so importing the
// source's percentile as a lab record just yields a range-less, ungrouped row (the
// same reasoning that already keeps the head-circ percentile 8289-1 out of
// VITAL_LOINCS). The observation mapper drops these, and they're excluded from the
// unmapped-lab report. Keyed by LOINC — the percentile codes are stable.
const DERIVED_PERCENTILE_LOINCS = new Set([
  "59576-9", // Body mass index (BMI) [Percentile] Per age and sex
  "77606-2", // Weight-for-length [Percentile] Per age and sex
  "8289-1", // Head Occipital-frontal circumference [Percentile] Per age and sex
]);

// Whether a LOINC is a derived anthropometric percentile that should not import as a
// lab record (#684 follow-up).
export function isDerivedPercentileLoinc(
  loinc: string | null | undefined
): boolean {
  return loinc != null && DERIVED_PERCENTILE_LOINCS.has(loinc);
}

// Whether a LOINC is a known non-analyte (administrative/structural) observation
// that should not be imported as a lab record (#681).
export function isNonAnalyteLoinc(loinc: string | null | undefined): boolean {
  return loinc != null && NON_ANALYTE_LOINCS.has(loinc);
}

// The qualitative CLASS a LOINC belongs to (#684). classifyQualitativeResult
// (lib/reference-range) resolves a value's meaning-class from the analyte NAME via
// regexes, which is fragile across EHR naming variance — a positive HPV genotype,
// culture organism, or influenza PCR the name regex doesn't recognize gets no flag
// verdict at all. This LOINC-keyed table is the deterministic hint: when a reading
// carries a known LOINC, the class comes from here instead of the name.
//   • infection  — a POSITIVE is bad (antigen/NAAT/culture/HPV/STI). Keep flagging.
//   • immunity   — a durable-immunity IgG titer; an immune-POSITIVE is good (#516).
//   • screen     — a prenatal/genetic risk screen (NIPT trisomy). Carries a
//                  low/high-risk axis (#687), NOT presence positive/negative; a
//                  high-risk screen flags like an infection-positive.
//   • qc         — a run-quality metric (fetal fraction), NOT a health signal (#687):
//                  never flags, never ranges, never nudges.
//   • identity   — an IMMUTABLE identity attribute (blood type, genotype): never
//                  abnormal, never stale. Named for the immutability on purpose —
//                  it drives the retest exemption, so a MUTABLE neutral attribute
//                  (urinalysis colour, morphology pattern) must NOT be listed here
//                  or it would silently stop going stale.
// Codes are drawn from real Epic exports (the patient XDM packages). Only classes
// whose polarity is unambiguous are listed.
export type QualitativeLoincClass =
  "infection" | "immunity" | "screen" | "qc" | "identity";

const QUALITATIVE_CLASS_BY_LOINC: Record<string, QualitativeLoincClass> = {
  // Infection / active-disease markers (positive = bad).
  "5196-1": "infection", // Hepatitis B surface antigen
  "13955-0": "infection", // Hepatitis C antibody
  "56888-1": "infection", // HIV Ag/Ab, 4th generation
  "20507-0": "infection", // RPR (syphilis)
  "48683-7": "infection", // Group B Streptococcus
  "21613-5": "infection", // C. trachomatis amplification
  "24111-7": "infection", // N. gonorrhoeae amplification
  "5028-6": "infection", // N. gonorrhoeae amplification
  "30167-1": "infection", // HPV high risk
  "59263-4": "infection", // HPV genotype 16
  "75694-0": "infection", // HPV genotype 18/45
  "94500-6": "infection", // SARS-CoV-2 NAAT
  "60489-2": "infection", // Strep A PCR
  "85479-4": "infection", // RSV PCR
  "92141-1": "infection", // Influenza B PCR
  "92142-9": "infection", // Influenza A PCR
  "80382-5": "infection", // Rapid Influenza A antigen
  "80383-3": "infection", // Rapid Influenza B antigen
  "94558-4": "infection", // SARS-CoV-2 rapid antigen
  "6463-4": "infection", // Culture organism 1
  "44841-5": "infection", // Culture organism 2
  // Durable-immunity IgG titers (immune-positive = good, #516).
  "20479-2": "immunity", // Measles IgG
  "5244-9": "immunity", // Measles antibody (IgG)
  "25418-5": "immunity", // Mumps virus antibody (IgG)
  "7966-5": "immunity", // Mumps antibody IgG
  "25514-1": "immunity", // Rubella antibody IgG
  "5334-8": "immunity", // Rubella antibody (IgG)
  "5403-1": "immunity", // Varicella zoster virus antibody (IgG)
  "8046-5": "immunity", // Varicella zoster antibody IgG
  // Prenatal / genetic risk screens (low/high-risk axis, #687).
  "73824-5": "screen", // Trisomy 13 (Patau)
  "75558-7": "screen", // Trisomy 18 (Edwards)
  "75983-7": "screen", // Trisomy 21 (Down)
  // Fetal fraction is a QC metric of the NIPT draw, not a risk call (#687).
  "75605-6": "qc", // Fetal fraction of cell-free DNA
  // Immutable identity attributes (#910). Epic reports the blood type as ONE
  // combined "ABORh Interpretation" row, and the name path's IMMUTABLE_ATTRIBUTE
  // regex keys on `\babo\b` — which does NOT match "ABORh" (no word boundary), so a
  // recorded blood type got no verdict at all: the extractor's guessed "abnormal"
  // stood (a blood type on the attention hero / Telegram push) and it missed the
  // never-stale exemption ("retest overdue" nudged yearly for a value that cannot
  // change). The LOINC settles it regardless of how the source spells the name.
  "19057-9": "identity", // ABO+Rh group ("ABORh Interpretation")
};

// The qualitative class for a LOINC, or null when unknown (→ name-regex fallback).
export function qualitativeClassForLoinc(
  loinc: string | null | undefined
): QualitativeLoincClass | null {
  if (!loinc) return null;
  return QUALITATIVE_CLASS_BY_LOINC[loinc] ?? null;
}

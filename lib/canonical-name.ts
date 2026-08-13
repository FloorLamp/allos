// Deterministic canonicalization of biomarker names.
//
// The AI extractor is *asked* to reuse a known canonical name, but the model
// often mirrors the lab report's spelling instead (e.g. it emits
// "25-OH Vitamin D" when the canonical entry is "Vitamin D, 25-Hydroxy").
// Relying on the model for cross-document consistency is unreliable and
// self-reinforcing — every freeform spelling that slips through gets added to
// the vocabulary and pollutes later prompts. So after extraction we snap the
// model's canonical_name back onto the known vocabulary in code.
//
// Matching is by a normalized key: lowercase, expand a small set of clinical
// synonyms, strip punctuation, then compare as an order-independent set of
// tokens. Token-set (rather than substring) matching means word order and
// comma inversion don't matter ("Creatinine, Urine" == "Urine Creatinine")
// while a genuinely different measurement stays distinct ("Creatinine" alone
// has a different token set than "Creatinine, Urine", preserving the
// blood-vs-urine split the extractor is told to keep).

// Clinical spelling synonyms applied to the lowercased string before
// tokenizing. Keep this list small and well-justified — each entry risks
// collapsing two genuinely distinct analytes. Patterns run in order.
const SYNONYMS: [RegExp, string][] = [
  // 1,25-OH / 1,25 diOH  ->  1,25-dihydroxy (active vitamin D). Must run before
  // the plain 25-OH rule, which would otherwise match the "25-OH" substring.
  [/\b1[\s,]*25[\s-]*(?:di)?oh\b/g, "1,25-dihydroxy"],
  // 25-OH / 25 OH / 25OH  ->  25-hydroxy (vitamin D metabolite)
  [/\b25[\s-]*oh\b/g, "25-hydroxy"],
];

// Reduce a name to an order-independent, punctuation-insensitive key.
export function normalizeCanonicalKey(name: string): string {
  let s = name.toLowerCase();
  for (const [re, to] of SYNONYMS) s = s.replace(re, to);
  const tokens = s
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .sort();
  return tokens.join(" ");
}

// WHAT A CANONICAL NAME MUST CARRY (#2335)
//
// The rule the dataset is held to, written down here because this is where the
// naming discipline already lives — and enforced, so it can't regrow: the scan in
// lib/__tests__/canonical-naming-rule.test.ts fails a bare name that has a qualified
// sibling in canonical-biomarkers.json.
//
//   • A bare name is permitted ONLY where a single universal convention fixes its
//     meaning. In practice that is the SERUM specimen: "Albumin", "Creatinine",
//     "Magnesium" and "Folate" beside their ", Urine" / ", RBC" siblings are
//     unambiguous to every clinician and stay bare.
//   • Where two members of ONE family differ by measure (relative/absolute),
//     specimen (blood/urine), fraction (free/total), or side (left/right), EVERY
//     member states its qualifier — INCLUDING the one that feels like the default.
//
// The second half is what the CBC differential taught. It held both conventions at
// once: bare "Neutrophils" was the percentage while bare "Monocytes" was the cell
// count, so within one panel a bare name meant opposite things. Picking a convention
// and fixing the outliers would not have held — a bare name keeps attracting
// mis-mapped imports whatever we declare it to mean. Explicit names plus the
// unit-aware arbitration in lib/canonical-unit-guard (which resolved exactly this
// %-versus-count collision on a real import) is the combination that does.

// Curated alias -> canonical-name routes for synonym/abbreviation drift.
// normalizeCanonicalKey folds case, punctuation and word order (plus the
// vitamin-D synonyms), but NOT abbreviation<->spelled-out or clinical synonyms —
// so a lab report's spelling that the extractor mirrors ("HbA1c", "SGPT", a bare
// "FSH") lands in its OWN biomarker series instead of the dataset entry, and once
// it's registered as an ai-coined name it permanently pollutes the vocabulary
// (the self-reinforcing loop this module exists to prevent). Each entry routes one
// such spelling onto an EXISTING dataset canonical name (the right column must be
// a real seeded name — the alias is dropped if that target isn't in the active
// vocabulary). Discipline: alias ONLY spellings of the SAME analyte — never merge
// genuinely distinct assays (plain CRP vs hs-CRP, Free vs Total hormone fractions,
// a serum vs a urine/RBC specimen, a total vs an active metabolite). A dataset
// entry written "Full Name (ABBREV)" needs NEITHER its bare abbreviation nor its
// bare full name listed — buildCanonicalIndex derives both (see FULL_ABBR_RE and the
// NB at the end of this table). Only WORD synonyms, and parentheticals the
// abbreviation heuristic rejects, need a curated route.
const CANONICAL_ALIASES: [string, string][] = [
  // Glycated hemoglobin
  ["HbA1c", "Hemoglobin A1c"],
  ["Hgb A1c", "Hemoglobin A1c"],
  ["A1c", "Hemoglobin A1c"],
  ["Glycated Hemoglobin", "Hemoglobin A1c"],
  ["Glycosylated Hemoglobin", "Hemoglobin A1c"],
  ["Glycohemoglobin", "Hemoglobin A1c"],
  // Liver enzymes (legacy SGPT/SGOT spellings)
  ["Alanine Aminotransferase", "Alanine Aminotransferase (ALT)"],
  ["Alanine Transaminase", "Alanine Aminotransferase (ALT)"],
  ["SGPT", "Alanine Aminotransferase (ALT)"],
  ["Aspartate Aminotransferase", "Aspartate Aminotransferase (AST)"],
  ["Aspartate Transaminase", "Aspartate Aminotransferase (AST)"],
  ["SGOT", "Aspartate Aminotransferase (AST)"],
  ["Gamma-Glutamyl Transferase", "Gamma-Glutamyl Transferase (GGT)"],
  ["Gamma-Glutamyl Transpeptidase", "Gamma-Glutamyl Transferase (GGT)"],
  ["Gamma GT", "Gamma-Glutamyl Transferase (GGT)"],
  ["GGTP", "Gamma-Glutamyl Transferase (GGT)"],
  // Renal
  ["Urea Nitrogen", "Blood Urea Nitrogen (BUN)"],
  ["Blood Urea Nitrogen", "Blood Urea Nitrogen (BUN)"],
  // The bare "eGFR" abbreviation AND the bare "Estimated Glomerular Filtration Rate"
  // long form are auto-derived from the "Full Name (ABBR)" entry (#2335), so neither
  // is listed — nor is "Glomerular Filtration Rate, Estimated", whose token set is
  // that long form's. Only the GFR-abbreviating spellings need a curated route.
  ["Estimated GFR", "Estimated Glomerular Filtration Rate (eGFR)"],
  ["GFR, Estimated", "Estimated Glomerular Filtration Rate (eGFR)"],
  // Thyroid
  ["Thyroid Stimulating Hormone", "Thyroid-Stimulating Hormone (TSH)"],
  // The model sometimes mirrors the "Full Name (ABBREV)" print form even though the
  // canonical entry is the bare abbreviation, adding a `tsh` token the bare-name
  // alias above doesn't carry (seen in AI extractions, #918).
  ["Thyroid Stimulating Hormone (TSH)", "Thyroid-Stimulating Hormone (TSH)"],
  ["Thyrotropin", "Thyroid-Stimulating Hormone (TSH)"],
  // Inflammation (high-sensitivity ONLY — plain CRP is a distinct assay)
  ["hsCRP", "High-Sensitivity C-Reactive Protein (hs-CRP)"],
  ["High Sensitivity CRP", "High-Sensitivity C-Reactive Protein (hs-CRP)"],
  [
    "High-Sensitivity C-Reactive Protein",
    "High-Sensitivity C-Reactive Protein (hs-CRP)",
  ],
  [
    "C-Reactive Protein, High Sensitivity",
    "High-Sensitivity C-Reactive Protein (hs-CRP)",
  ],
  ["Cardio CRP", "High-Sensitivity C-Reactive Protein (hs-CRP)"],
  // Plain (standard-sensitivity) CRP — a DIFFERENT assay than hs-CRP (mg/L, acute
  // inflammation/infection cutoffs, not the CV-risk hs range), so the bare "CRP"
  // abbreviation routes to its OWN "C-Reactive Protein" entry (#1195), NEVER folded
  // onto hs-CRP. The spelled-out "C-Reactive Protein" normalizes onto that entry
  // directly; the abbreviation needs the explicit route.
  ["CRP", "C-Reactive Protein"],
  // Prostate (unqualified PSA = total; the Free % entry stays distinct)
  ["Prostate Specific Antigen", "Prostate-Specific Antigen (PSA)"],
  ["Prostate-Specific Antigen", "Prostate-Specific Antigen (PSA)"],
  ["Prostate Specific Antigen (PSA)", "Prostate-Specific Antigen (PSA)"],
  ["Prostate Specific Antigen, Total", "Prostate-Specific Antigen (PSA)"],
  ["PSA, Total", "Prostate-Specific Antigen (PSA)"],
  // NOTE: no alias for the free-fraction PERCENT. normalizeCanonicalKey strips "%",
  // so "PSA, Free %" (the % ratio) and "PSA, Free" (the distinct free-ABSOLUTE assay,
  // ng/mL) collapse to the SAME key {free, psa} — an alias would capture both and
  // mis-group the absolute onto the % entry (the unit guard can't rescue it: the two
  // share no stem sibling). Since the free-absolute assay isn't curated yet (a #918
  // §3b gap), leaving both unresolved and surfaced is safer than a confident
  // mis-grouping; resolving them properly needs the curated absolute entry + the unit
  // guard, tracked separately.
  // Lipids / apolipoprotein
  ["Apolipoprotein B", "Apolipoprotein B (ApoB)"],
  ["Apo B", "Apolipoprotein B (ApoB)"],
  ["Apolipoprotein B-100", "Apolipoprotein B (ApoB)"],
  // LDL cholesterol: the near-universal "LDL-C" print form and the calculated-method
  // drift the token set misses ({c, ldl} / {calculated, ldl} ≠ {cholesterol, ldl}),
  // so they orphan into their own band-less series (#1195). Route them onto the real
  // "LDL Cholesterol" entry so a report's abbreviation joins the right series.
  ["LDL-C", "LDL Cholesterol"],
  ["LDL Calculated", "LDL Cholesterol"],
  ["LDL Cholesterol, Calculated", "LDL Cholesterol"],
  // The lipid RATIOS (#1582). A lab that prints one must land on the same entry the
  // derived index computes, or the analyte forks into a reported series and a
  // computed one. The token set already folds "LDL:HDL Ratio" and "LDL HDL Ratio"
  // onto "LDL/HDL Ratio"; these two spellings it does not ({hdl, ldl} and
  // {cholesterol, hdl, ldl, ratio} match no entry).
  ["LDL/HDL", "LDL/HDL Ratio"],
  ["LDL/HDL Cholesterol Ratio", "LDL/HDL Ratio"],
  // Same analyte, the spelling that names the numerator in full. NOT aliased, on
  // purpose: a bare "Cholesterol/HDL" — its token set {cholesterol, hdl} is exactly
  // "HDL Cholesterol"'s, so the spelling is genuinely ambiguous and an alias could
  // only guess which analyte a report meant.
  ["Total Cholesterol/HDL Ratio", "Cholesterol/HDL Ratio"],
  // Iron
  ["Total Iron Binding Capacity", "Total Iron-Binding Capacity (TIBC)"],
  // CBC differential — ABSOLUTE counts (cells/uL). The model prefixes "Absolute"
  // where the vocabulary suffixes ", Absolute". Routing the wrong way would drop a
  // cells/uL value onto a "%" series (#549/#482), so each targets the cells/uL entry,
  // checked against its unit (#918). Strongest signal was "Absolute Neutrophil
  // Count", which missed in three separate extractions. The bare-plural spellings
  // ("Absolute Monocytes") are NOT listed: their token set IS the ", Absolute"
  // entry's, so the entry claims that key itself and a curated row would be inert
  // (#2335 — the entries the differential rename gave an explicit ", Absolute").
  ["Absolute Neutrophil Count", "Neutrophils, Absolute"],
  // Lymphocytes were the ONE cell line the curated "Absolute X Count" set skipped
  // (#1195) — the ", Absolute" entry exists but the prefixed print form orphaned.
  // Route it to the cells/uL entry like its neutrophil sibling above.
  ["Absolute Lymphocyte Count", "Lymphocytes, Absolute"],
  ["Absolute Monocyte Count", "Monocytes, Absolute"],
  ["Absolute Eosinophil Count", "Eosinophils, Absolute"],
  ["Absolute Basophil Count", "Basophils, Absolute"],
  // Vitamins / cofactors
  ["B12", "Vitamin B12"],
  ["Vitamin B-12", "Vitamin B12"],
  ["Cobalamin", "Vitamin B12"],
  ["Cyanocobalamin", "Vitamin B12"],
  ["Micronutrient, Vitamin B12", "Vitamin B12"],
  ["Folic Acid", "Folate"],
  ["Vitamin B9", "Folate"],
  ["Retinol", "Vitamin A (Retinol)"],
  ["Vitamin A", "Vitamin A (Retinol)"],
  // 25-OH vitamin D. normalizeCanonicalKey folds "25-OH Vitamin D" onto the TOTAL
  // storage-marker entry via the 25-OH->25-hydroxy synonym. The D2/D3 fractions are
  // DISTINCT analytes (#1193) — each has its OWN catalog entry and its own trendable
  // series that flags independently — so an isoform-suffixed print form routes to its
  // OWN fraction entry, NEVER folded onto the total (a low D2 is normal for anyone not
  // on ergocalciferol and must not inherit the total's 30-100 sufficiency band). The
  // exact "25-OH Vitamin Dn" forms already normalize onto "Vitamin Dn, 25-Hydroxy"
  // directly; the concatenated "25-Hydroxyvitamin Dn" form needs the explicit route.
  // NOT bare "Vitamin D2/D3" — that is the parent vitamin (ergo-/cholecalciferol), a
  // distinct thing from its 25-hydroxy metabolite.
  ["25-OH Vitamin D2", "Vitamin D2, 25-Hydroxy"],
  ["25-Hydroxyvitamin D2", "Vitamin D2, 25-Hydroxy"],
  ["25-OH Vitamin D3", "Vitamin D3, 25-Hydroxy"],
  ["25-Hydroxyvitamin D3", "Vitamin D3, 25-Hydroxy"],
  // Active hormone (calcitriol) — the 1,25-dihydroxy metabolite is its OWN pg/mL
  // analyte (hypercalcemia / sarcoidosis / CKD workups), never the 25-OH storage
  // form (#1193). "1,25-OH Vitamin D" already normalizes onto the entry via the
  // 1,25-diOH synonym; the concatenated/eponymous forms need the explicit route.
  ["1,25-Dihydroxyvitamin D", "Vitamin D, 1,25-Dihydroxy"],
  ["Calcitriol", "Vitamin D, 1,25-Dihydroxy"],
  // Electrolytes (the BMP CO2/bicarbonate line)
  ["CO2", "Carbon Dioxide"],
  ["Total CO2", "Carbon Dioxide"],
  ["Bicarbonate", "Carbon Dioxide"],
  ["HCO3", "Carbon Dioxide"],
  // Hormones / metabolites
  ["DHEA-S", "DHEA-Sulfate"],
  ["DHEAS", "DHEA-Sulfate"],
  ["Dehydroepiandrosterone Sulfate", "DHEA-Sulfate"],
  ["Urate", "Uric Acid"],
  ["IGF-I", "Insulin-Like Growth Factor 1 (IGF-1)"],
  ["Insulin-like Growth Factor 1", "Insulin-Like Growth Factor 1 (IGF-1)"],
  ["Insulin-Like Growth Factor-1", "Insulin-Like Growth Factor 1 (IGF-1)"],
  ["Somatomedin C", "Insulin-Like Growth Factor 1 (IGF-1)"],
  // "Full Name (ABBREV)" entries: alias BOTH the abbreviation and the full name.
  ["CK", "Creatine Kinase (CK)"],
  ["CPK", "Creatine Kinase (CK)"],
  ["Creatine Phosphokinase", "Creatine Kinase (CK)"],
  ["Creatine Kinase", "Creatine Kinase (CK)"],
  ["Creatine Kinase, Total", "Creatine Kinase (CK)"],
  ["LDH", "Lactate Dehydrogenase (LDH)"],
  ["Lactate Dehydrogenase", "Lactate Dehydrogenase (LDH)"],
  ["ESR", "Erythrocyte Sedimentation Rate (ESR)"],
  ["Sed Rate", "Erythrocyte Sedimentation Rate (ESR)"],
  ["Sedimentation Rate", "Erythrocyte Sedimentation Rate (ESR)"],
  ["Erythrocyte Sedimentation Rate", "Erythrocyte Sedimentation Rate (ESR)"],
  ["FSH", "Follicle Stimulating Hormone (FSH)"],
  ["Follicle Stimulating Hormone", "Follicle Stimulating Hormone (FSH)"],
  ["Follicle-Stimulating Hormone", "Follicle Stimulating Hormone (FSH)"],
  ["LH", "Luteinizing Hormone (LH)"],
  ["Luteinizing Hormone", "Luteinizing Hormone (LH)"],
  ["SHBG", "Sex Hormone Binding Globulin (SHBG)"],
  ["Sex Hormone Binding Globulin", "Sex Hormone Binding Globulin (SHBG)"],
  ["Sex Hormone-Binding Globulin", "Sex Hormone Binding Globulin (SHBG)"],
  ["RF", "Rheumatoid Factor (RF)"],
  ["Rheumatoid Factor", "Rheumatoid Factor (RF)"],
  ["TgAb", "Thyroglobulin Antibodies (TgAb)"],
  ["Anti-Thyroglobulin", "Thyroglobulin Antibodies (TgAb)"],
  ["Anti-Thyroglobulin Antibody", "Thyroglobulin Antibodies (TgAb)"],
  ["Thyroglobulin Antibody", "Thyroglobulin Antibodies (TgAb)"],
  ["Thyroglobulin Ab", "Thyroglobulin Antibodies (TgAb)"],
  ["TPOAb", "Thyroid Peroxidase Antibodies (TPOAb)"],
  ["Anti-TPO", "Thyroid Peroxidase Antibodies (TPOAb)"],
  ["TPO Antibody", "Thyroid Peroxidase Antibodies (TPOAb)"],
  ["Thyroid Peroxidase Antibody", "Thyroid Peroxidase Antibodies (TPOAb)"],
  ["Thyroid Peroxidase Ab", "Thyroid Peroxidase Antibodies (TPOAb)"],
  ["Anti-Thyroid Peroxidase", "Thyroid Peroxidase Antibodies (TPOAb)"],
  // Immunoglobulins (#918): the abbreviation the model/labs usually print snaps onto
  // the full canonical name. Subclasses alias the "IgGn" short form onto the spelled-
  // out entry (the tokens "igg1" and "immunoglobulin g subclass 1" share none).
  ["IgG", "Immunoglobulin G"],
  ["IgA", "Immunoglobulin A"],
  ["IgM", "Immunoglobulin M"],
  ["IgG1", "Immunoglobulin G Subclass 1"],
  ["IgG Subclass 1", "Immunoglobulin G Subclass 1"],
  ["IgG2", "Immunoglobulin G Subclass 2"],
  ["IgG Subclass 2", "Immunoglobulin G Subclass 2"],
  ["IgG3", "Immunoglobulin G Subclass 3"],
  ["IgG Subclass 3", "Immunoglobulin G Subclass 3"],
  ["IgG4", "Immunoglobulin G Subclass 4"],
  ["IgG Subclass 4", "Immunoglobulin G Subclass 4"],
  // Urinalysis dipstick (#918): the canonical entries are specimen-qualified
  // ("…, Urine"), matching how the extractor names them. A bare spelling of an
  // always-urine pad (Nitrite, Leukocyte Esterase, Urobilinogen) is unambiguous, so
  // it routes to the urine entry; "Occult Blood" is the same pad as urine "Blood".
  ["Nitrite", "Nitrite, Urine"],
  ["Leukocyte Esterase", "Leukocyte Esterase, Urine"],
  ["Urobilinogen", "Urobilinogen, Urine"],
  ["Occult Blood, Urine", "Blood, Urine"],
  // Urinalysis spelling drift from ONE lab whose naming diverges from the rest of the
  // corpus (#2300). Both are the SAME measurement under a different word, not a
  // different analyte: the microscopy line every other report prints as "Squamous
  // Epithelial Cells" (its token set {cells, epithelial, urine} misses the curated
  // {cells, epithelial, squamous, urine}), and the physical-description line other
  // reports call "Appearance".
  ["Epithelial Cells, Urine", "Squamous Epithelial Cells, Urine"],
  ["Urine Clarity", "Urine Appearance"],
  // Urine-sediment CASTS (#2319). #2300 curated the three in the PLURAL,
  // comma-inverted form ("Casts, Hyaline, Urine"); plenty of reports print the same
  // microscopy line SINGULAR ("Hyaline Cast, Urine"). normalizeCanonicalKey folds
  // case, punctuation and word order but NOT inflection, so {cast, hyaline, urine}
  // and {casts, hyaline, urine} are different keys and the singular spelling orphans
  // into its own band-less series right beside its own curated entry.
  //
  // Three explicit routes, deliberately NOT a trailing-`s` rule in the normalizer:
  // inflection folding is exactly the kind of rule that eventually merges two
  // genuinely distinct analytes, and it would fire on every name in the vocabulary
  // to fix three. Do not widen this — a fourth cast type gets a fourth row.
  ["Hyaline Cast, Urine", "Casts, Hyaline, Urine"],
  ["Granular Cast, Urine", "Casts, Granular, Urine"],
  ["RBC Cast, Urine", "Casts, RBC, Urine"],
  // Drift a FRESH re-extraction surfaced (#918): the model, given the same
  // vocabulary, still coined off-list names. The CBC counts often print as bare
  // abbreviations; specific gravity is always a urine test. (The two neutrophil
  // "Relative" routes that lived here are gone: since #2335 the %-form entry IS
  // "Neutrophils, Relative", so both rows became identity routes onto it.)
  ["WBC", "White Blood Cell Count"],
  ["RBC", "Red Blood Cell Count"],
  ["Specific Gravity", "Urine Specific Gravity"],
  // Newly curated gaps (#918): the abbreviation/short forms onto the "Full (ABBREV)"
  // canonical entries the model already emits in long form.
  ["AFP", "Alpha-Fetoprotein (AFP)"],
  ["Alpha-Fetoprotein", "Alpha-Fetoprotein (AFP)"],
  ["CEA", "Carcinoembryonic Antigen (CEA)"],
  ["Carcinoembryonic Antigen", "Carcinoembryonic Antigen (CEA)"],
  // Hepatitis A TOTAL antibody. `normalizeCanonicalKey` sorts tokens, so "Hepatitis A
  // Total Antibody" already folds onto the entry and needs no route; what does need one
  // is the abbreviated "Ab" spelling, which is what a real Epic export printed
  // ("HEPATITIS A Ab/TOTAL") and what an AI import then coined as its own vocabulary
  // row. NOT aliased, deliberately: bare "Hepatitis A Antibody" / bare "Anti-HAV". The
  // IgM-only assay is a DIFFERENT test — it answers acute infection where the total
  // answers immunity — so an unqualified spelling must coin its own entry rather than
  // inherit this one's identity (the §2 trap, same shape as bare "ANA" and bare "pH").
  ["Hepatitis A Ab Total", "Hepatitis A Antibody, Total"],
  ["HAV Ab Total", "Hepatitis A Antibody, Total"],
  ["Anti-HAV Total", "Hepatitis A Antibody, Total"],
  ["HBsAg", "Hepatitis B Surface Antigen (HBsAg)"],
  ["Hepatitis B Surface Antigen", "Hepatitis B Surface Antigen (HBsAg)"],
  ["HBsAb", "Hepatitis B Surface Antibody (HBsAb)"],
  ["Anti-HBs", "Hepatitis B Surface Antibody (HBsAb)"],
  ["Hepatitis B Surface Antibody", "Hepatitis B Surface Antibody (HBsAb)"],
  ["Anti-HCV", "Hepatitis C Antibody (Anti-HCV)"],
  ["HCV Antibody", "Hepatitis C Antibody (Anti-HCV)"],
  ["Hepatitis C Antibody", "Hepatitis C Antibody (Anti-HCV)"],
  // Mental-health instruments (#716) — the common print spellings snap onto the bare
  // canonical scores so an extracted questionnaire total joins the right series. PHQ-9
  // and GAD-7 stay DISTINCT identities (different instruments) — never one family.
  ["PHQ9", "PHQ-9"],
  ["PHQ 9", "PHQ-9"],
  ["Patient Health Questionnaire-9", "PHQ-9"],
  ["Patient Health Questionnaire 9", "PHQ-9"],
  ["GAD7", "GAD-7"],
  ["GAD 7", "GAD-7"],
  ["Generalized Anxiety Disorder-7", "GAD-7"],
  ["Generalized Anxiety Disorder 7", "GAD-7"],
  // Respiratory function (#1850) — the spellings a peak-flow meter's leaflet and a
  // spirometry report actually print, routed onto the curated entries so an extracted
  // reading joins the series it belongs to instead of coining a fourth "PEFR".
  // DISCIPLINE HELD: nothing here merges the ABSOLUTE volume with a PERCENT-PREDICTED
  // one ("FEV1 % Predicted" is a different quantity in a different unit and is left
  // surfaced rather than folded onto the litres entry), and FEV1 / FVC / the ratio stay
  // three distinct identities — a normal FVC must never mark an obstructed ratio fine.
  ["PEF", "Peak Expiratory Flow"],
  ["PEFR", "Peak Expiratory Flow"],
  ["Peak Flow", "Peak Expiratory Flow"],
  ["Peak Expiratory Flow Rate", "Peak Expiratory Flow"],
  // "FEV1" and "FVC" — and their long forms — are auto-derived from the two
  // "Full Name (ABBR)" entries (#2335), so the two rows that used to spell them out
  // here ("Forced Expiratory Volume in 1 Second", "Forced Vital Capacity") are gone.
  // These two survive because the token set of a SPACED or HYPHENATED "FEV 1"
  // ({1, fev}) is not the token set of "FEV1" ({fev1}).
  ["FEV-1", "Forced Expiratory Volume in 1 Second (FEV1)"],
  ["FEV 1", "Forced Expiratory Volume in 1 Second (FEV1)"],
  ["FEV1/FVC", "FEV1/FVC Ratio"],
  // The spellings #2335 RETIRED. Each was a canonical entry until the rename that
  // made every member of its family state its qualifier; a document that still
  // reports the old form has to land on the surviving entry, so each old spelling
  // routes here. The differential's bare names are the reason the rule exists — and
  // routing them is safe precisely because the unit is the arbiter after the snap: a
  // bare "Monocytes" printed in "%" snaps to the ", Absolute" entry and
  // unitAwareCanonical then re-resolves it to ", Relative" (its %-sibling), and the
  // same in reverse for the neutrophil/lymphocyte pair.
  ["Neutrophils", "Neutrophils, Relative"],
  ["Lymphocytes", "Lymphocytes, Relative"],
  ["Monocytes", "Monocytes, Absolute"],
  ["Eosinophils", "Eosinophils, Absolute"],
  ["Basophils", "Basophils, Absolute"],
  ["Immature Granulocytes", "Immature Granulocytes, Relative"],
  ["Nucleated Red Blood Cells", "Nucleated Red Blood Cells, Relative"],
  ["Reticulocytes", "Reticulocytes, Relative"],
  // The eye pair. A report that states no laterality is not a third measurement, so
  // the surviving entry SAYS the eye is unstated rather than reading like "the" IOP —
  // which is also exactly what LOINC 56844-4 ("of Eye (unspecified)") names.
  ["Intraocular Pressure", "Intraocular Pressure, Unspecified Eye"],
  ["Visual Acuity", "Visual Acuity, Unspecified Eye"],
  // The thyroid fractions. Their parentheticals contain a SPACE, so
  // looksLikeAbbreviation rejects them and the bare print form is NOT auto-derived —
  // these four routes are load-bearing, unlike the FEV1/FVC/eGFR ones the same
  // rename deleted. One route covers both word orders ("Free T4" and "T4, Free"
  // share a token set).
  ["Free T4", "Thyroxine, Free (Free T4)"],
  ["Free T3", "Triiodothyronine, Free (Free T3)"],
  ["Total T4", "Thyroxine, Total (Total T4)"],
  ["Total T3", "Triiodothyronine, Total (Total T3)"],
  // The ANA screen, for the same reason (its "(ANA IFA)" parenthetical is spaced).
  [
    "ANA Screen, IFA",
    "Antinuclear Antibody Screen, Indirect Immunofluorescence Assay (ANA IFA)",
  ],
  // NOT aliased, on purpose:
  //  • bare "ANA" — the screen is run by INDIRECT IMMUNOFLUORESCENCE here, and EIA /
  //    multiplex ANA screens are a different method with different operating
  //    characteristics. Routing an unqualified "ANA" onto the IFA entry would merge
  //    two assays, which the discipline above forbids; an EIA screen should coin its
  //    own entry rather than inherit IFA's identity.
  //  • bare "pH" — specimen-ambiguous (an arterial-blood-gas pH is not urine pH); the
  //    §2 trap. Needs a specimen qualifier to resolve.
  //  • ALL THREE race/ethnicity-branched eGFR variants — "eGFR, African American",
  //    "eGFR, Non-African-American" and "eGFR, Thai" (#2300). Each equation gives a
  //    DIFFERENT number, so a report listing several would collapse distinct values
  //    onto one date. The NON-African-American branch belongs here with the other two
  //    and is the easy one to get wrong: it is the other side of a RACE-ADJUSTED
  //    equation, not a race-free result, so routing it to the race-free eGFR entry
  //    would quietly file a race-adjusted number as the race-free one. Leaving all three
  //    unresolved is also what lets the race-free CKD-EPI 2021 derivation
  //    (lib/derived-biomarkers.ts) fill that draw's eGFR instead, which it does.
  //  • "Atypical Lymphocytes" / "Band Neutrophils" — NOT aliased onto
  //    "Lymphocytes, Relative" / "Neutrophils, Relative" (#2300). A differential reports them ALONGSIDE the parent
  //    fraction, so an alias would land two distinct same-date percentages on one
  //    series and silently drop one. Each has its OWN canonical entry instead.

  // NB: a "Full Name (ABBR)" entry does NOT need its bare abbreviation or bare full
  // name listed here — buildCanonicalIndex auto-derives both (see FULL_ABBR_RE). Only
  // WORD synonyms of such an entry (SGPT→ALT, Bicarbonate→Carbon Dioxide) need a
  // curated route, since those aren't derivable from the name.
];

// Build a normalized-key -> canonical-spelling lookup from a vocabulary list.
// On key collision the first entry wins (vocabulary is passed in the caller's
// preferred order — seeded/curated names sort ahead of ai-coined ones). Curated
// CANONICAL_ALIASES are layered on AFTER the real entries, and only for a target
// name present in this vocabulary: a real entry always wins a key collision, so
// an alias can only ADD a route to an existing analyte, never hijack a distinct one.
export function buildCanonicalIndex(vocabulary: string[]): Map<string, string> {
  const index = canonicalEntryIndex(vocabulary);
  // THE BLOCK LIVES HERE, and only here: canonicalAliasRoutes() computes every
  // route the curated table + the auto-derivation WOULD install, and this loop
  // drops the ones whose key a real entry already claimed. Keeping the two apart
  // is what lets lib/canonical-alias-merge.ts ask the question #2306 needed asked
  // — "which routes is this vocabulary blocking?" — instead of re-deriving the
  // alias set a second time and drifting from it.
  for (const [key, target] of canonicalAliasRoutes(vocabulary))
    if (!index.has(key)) index.set(key, target);
  return index;
}

// The vocabulary's OWN entries as a normalized-key -> spelling map. On key collision
// the first entry wins (the vocabulary arrives in the caller's preferred order —
// getCanonicalVocabulary sorts seeded/curated names ahead of ai-coined ones), so this
// map answers "which spelling of this key does the vocabulary consider canonical?".
export function canonicalEntryIndex(
  vocabulary: readonly string[]
): Map<string, string> {
  const index = new Map<string, string>();
  for (const name of vocabulary) {
    const key = normalizeCanonicalKey(name);
    if (key && !index.has(key)) index.set(key, name);
  }
  return index;
}

// Every alias route this vocabulary defines — curated CANONICAL_ALIASES plus the
// auto-derived "Full Name (ABBR)" ones — keyed by normalized alias key, valued by
// the TARGET's own vocabulary spelling. Routes with no target in the vocabulary are
// omitted (an alias can only ADD a route to an analyte that exists).
//
// Deliberately does NOT apply the "a real entry wins a key collision" block:
// buildCanonicalIndex applies it, and the merge pass (lib/canonical-alias-merge.ts)
// needs the UNBLOCKED set to see which routes an ai-coined vocabulary row is
// shadowing. Route order still matters and is preserved: derived routes are laid
// down first and a curated route may resolve its target THROUGH one of them
// (SGPT → ALT → "Alanine Aminotransferase (ALT)"), first route wins a key.
//
// Auto-derived aliases for a "Full Name (ABBR)" entry exist because its combined-token
// key matches NEITHER the bare full name NOR the bare abbreviation alone (an extractor
// emits one or the other), so every such entry would otherwise need two hand-written
// CANONICAL_ALIASES — an easy-to-half-do footgun. Derived here instead:
//   • the bare full name (strip the trailing parenthetical) — always safe.
//   • the bare abbreviation — ONLY when the parenthetical LOOKS like an acronym
//     (no spaces, ≥2 uppercase or a digit), so a word-parenthetical ("(Bicarbonate)",
//     "(Retinol)") or a value ("(50 g)") is NOT mistaken for an abbreviation. Those
//     word-synonyms keep their explicit curated alias.
export function canonicalAliasRoutes(
  vocabulary: readonly string[]
): Map<string, string> {
  const entries = canonicalEntryIndex(vocabulary);
  const routes = new Map<string, string>();
  // A target is resolved against the real entries FIRST (so a route never points at
  // another route's alias when a real entry owns that key), then against the routes
  // laid down so far.
  const resolve = (key: string) => entries.get(key) ?? routes.get(key);
  const addRoute = (alias: string, canonical: string) => {
    const key = normalizeCanonicalKey(alias);
    if (key && !routes.has(key)) routes.set(key, canonical);
  };
  for (const name of vocabulary) {
    const m = FULL_ABBR_RE.exec(name);
    if (!m) continue;
    const [, full, abbr] = m;
    // Resolve to the entry's OWN spelling (case/whitespace-normalized) so the alias
    // targets the real vocabulary name, not the raw regex capture.
    const canonical = entries.get(normalizeCanonicalKey(name));
    if (!canonical) continue;
    addRoute(full, canonical);
    if (looksLikeAbbreviation(abbr)) addRoute(abbr, canonical);
  }
  for (const [alias, canonical] of CANONICAL_ALIASES) {
    const aliasKey = normalizeCanonicalKey(alias);
    if (!aliasKey || routes.has(aliasKey)) continue;
    const target = resolve(normalizeCanonicalKey(canonical));
    if (target) routes.set(aliasKey, target);
  }
  return routes;
}

// A canonical name written "Full Name (ABBR)" — captures the full name and the
// parenthetical. Only the LAST parenthetical (so "Carbon Dioxide (Bicarbonate) (CO2)"
// yields full="Carbon Dioxide (Bicarbonate)", abbr="CO2").
const FULL_ABBR_RE = /^(.+) \(([^()]+)\)$/;

// Whether a parenthetical is an ACRONYM (register it as an alias) vs a word or a
// value (leave to a curated alias): no internal space, and either ≥2 uppercase
// letters or a digit — matches RDW / MCV / hs-CRP / CO2 / IGF-1, rejects
// "Bicarbonate" / "Retinol" / "50 g".
//
// Exported since #2365: the body-metric home derivation asks the same question of a
// metric's short LABEL ("BMI", "RHR" are the analyte's name; "Body Temp", "Avg HR"
// are chart chrome), and a second realization of "is this an acronym?" is exactly the
// drift this module exists to prevent.
export function looksLikeAbbreviation(s: string): boolean {
  if (/\s/.test(s)) return false;
  const uppers = (s.match(/[A-Z]/g) ?? []).length;
  return uppers >= 2 || /\d/.test(s);
}

/**
 * The two OTHER spellings a name written "Full Name (ACRONYM)" is known by — the bare
 * full name and the bare acronym — or `[]` when the name is not written that way.
 *
 * For an ARBITRARY name, not a vocabulary entry (#2365: is an imported
 * "Body Mass Index (BMI)" the quantity the metric registry calls "Body Mass Index"?).
 * Hence the one deliberate difference from `canonicalAliasRoutes`, which routes the
 * bare full name for a WORD parenthetical too: that liberty is safe for a curated
 * entry, which is the authority on its own spelling, and unsafe here, because a word
 * parenthetical is usually a QUALIFIER that changes the quantity — dropping it would
 * turn "Blood Pressure Systolic (Peak Exercise)" into resting blood pressure. The
 * acronym gate is shared, so the two can never disagree about what an ACRONYM is.
 */
export function acronymNameForms(name: string): string[] {
  const m = FULL_ABBR_RE.exec(name.trim());
  if (!m) return [];
  const [, full, abbr] = m;
  return looksLikeAbbreviation(abbr) ? [full, abbr] : [];
}

// The curated alias routes, exposed for the vocabulary-integrity test (it pins
// that every target is a real dataset entry and no alias shadows a distinct one).
export function canonicalAliases(): readonly [string, string][] {
  return CANONICAL_ALIASES;
}

// --- What a biomarker picker SEARCHES on (#2382) ----------------------------
//
// The app-wide combobox matcher is a greedy leftmost SUBSEQUENCE walk that never
// backtracks, so for "Prostate-Specific Antigen (PSA)" the query `psa` is consumed
// scattered inside "Prostate-Specific" and the walk never reaches the literal
// "(PSA)" at the end — typing an analyte's own abbreviation did not offer it at
// all. #2335's `Long Name (ABBR)` convention puts the abbreviation exactly where
// that matcher is structurally incapable of seeing it, so searching the
// abbreviation as its OWN key is not a nicety: it is the only way the abbreviation
// becomes reachable.
//
// One source, consumed by every biomarker picker (#1675, #221): the acronym forms
// the name states about itself, plus the curated CANONICAL_ALIASES that route onto
// it — which is why `A1c` → `Hemoglobin A1c` has been in the vocabulary all along
// yet contributed nothing to search.
//
// The reverse index is built once and the per-name answer memoized on top of it: a
// picker asks this per option per keystroke over ~300 analytes, and re-scanning the
// alias table each time would be ~100k key normalizations a keystroke. Both caches
// are pure functions of module constants, so neither can go stale.
let aliasesByCanonicalKey: Map<string, string[]> | null = null;

function canonicalAliasIndex(): Map<string, string[]> {
  if (aliasesByCanonicalKey) return aliasesByCanonicalKey;
  const index = new Map<string, string[]>();
  for (const [alias, canonical] of CANONICAL_ALIASES) {
    const key = normalizeCanonicalKey(canonical);
    const list = index.get(key);
    if (list) list.push(alias);
    else index.set(key, [alias]);
  }
  aliasesByCanonicalKey = index;
  return index;
}

const searchTermsCache = new Map<string, readonly string[]>();

/**
 * The hidden spellings a biomarker picker should match a query against, for the
 * analyte a row is LABELLED with. Never includes the visible name itself — the
 * matcher always scores that — and answers `[]` for a label that names no analyte
 * (a metric row, a "— none —" row), so a mixed picker can pass it unconditionally.
 */
export function biomarkerSearchTerms(name: string): readonly string[] {
  const cached = searchTermsCache.get(name);
  if (cached) return cached;
  const terms = new Set(acronymNameForms(name));
  const aliases = canonicalAliasIndex().get(normalizeCanonicalKey(name)) ?? [];
  for (const alias of aliases) terms.add(alias);
  terms.delete(name);
  const result: readonly string[] = [...terms];
  searchTermsCache.set(name, result);
  return result;
}

// --- Deliberately uncurated analytes (#2313) --------------------------------
//
// CANONICAL_ALIASES declares the names we DO route. This declares the other half:
// names we have decided NOT to curate, and why. That decision already existed —
// it is the "NOT aliased, on purpose" prose above — but only as a source comment,
// so every surface that meets one of these names has to guess. The import
// debugger guessed wrong in the way that costs somebody something: it counted a
// settled question as outstanding work and offered a "Report unresolved analyte"
// link that files a public duplicate of a decision this repo already made.
//
// Two rules from elsewhere in the codebase, applied here:
//
//   • MetricKnowledge's `{ source: "none"; reason: string }` — the reason is
//     MANDATORY, because saying it out loud is the point. A reader who sees an
//     eGFR variant listed as "unresolved" reasonably concludes their kidney
//     function is untracked. It isn't; it is tracked better. Only the reason can
//     say so, and a declaration without one would silently inherit "unjudged".
//   • FreshnessState's `not-applicable`, which must never fold into `due`. A
//     deliberately-uncurated analyte is not a to-do, and counting it as one
//     overstates the work outstanding.
//
// Keyed by normalizeCanonicalKey, exactly like the aliases, so spelling, casing
// and word-order variants of a declared name collapse onto one declaration.
//
// This registry is NOT the debugger's: it answers "has this repo decided not to
// curate this analyte?", which is a question about the analyte. Any surface that
// would otherwise present one of these names as an open gap reads it through
// `uncuratedAnalyte` — no per-surface copy of the list, and no per-surface
// opinion about what the decision means.
export type UncuratedAnalyte =
  // The quantity IS tracked — under a different identity. `instead` names the
  // canonical entry that carries it, so a surface can point at the real series
  // rather than leaving the reader to deduce that one exists. The completeness
  // guard pins that the target is a real curated entry: a dangling `instead`
  // promises a series that doesn't exist.
  | { kind: "covered-elsewhere"; instead: string; reason: string }
  // Not a thing this app models as a biomarker at all.
  | { kind: "out-of-scope"; reason: string };

// The three race/ethnicity-branched eGFR equations share ONE declaration: they are
// the same decision, made once. The reason is written FOR A USER, not for a
// maintainer — it is the sentence that turns "your kidney function is unresolved"
// into "your kidney function is measured a better way".
const EGFR_RACE_BRANCHED: UncuratedAnalyte = {
  kind: "covered-elsewhere",
  // The CURATED name, not the bare spelling (#2335 renamed it). `instead` is the
  // one field here that must resolve against the dataset — the completeness guard
  // checks it, and the debugger LINKS to it — so it cannot ride the retired-spelling
  // alias the way an incoming document may. A bare "eGFR" would have dangled.
  instead: "Estimated Glomerular Filtration Rate (eGFR)",
  reason:
    "Race- and ethnicity-adjusted eGFR equations return different values for the same draw, so they cannot share one series. Allos derives the race-free CKD-EPI 2021 value from your creatinine instead — that is the eGFR you see.",
};

const TOXICOLOGY_SCREEN: UncuratedAnalyte = {
  kind: "out-of-scope",
  reason:
    "Toxicology screens aren't biomarkers with reference bands. The result is imported and visible on the document, but it isn't curated as a trendable analyte.",
};

// A DEXA scan's own decomposition (#2319) — the largest single family of
// uncatalogued items in a real profile, on the order of fifty distinct labels from
// one machine. One scan prints a fat percentage, a bone mineral density and a
// compartment mass for every region it segments the body into; those rows are the
// SCAN's output, not fifty analytes anybody draws independently. There is no
// population reference band for left-arm fat percentage and there never will be, so
// "curating" them would mean inventing ranges — and until this declaration existed,
// every one of them was presented as something the user might track or ask to have
// catalogued, which is a standing invitation to request work that must never happen.
//
// `out-of-scope`, not `covered-elsewhere`: the whole-body totals ARE curated
// ("Body Fat Percentage", "Bone Mineral Density T-Score"), but a region is not its
// total, so pointing a reader at the total would claim their left arm is tracked
// when it isn't. Nothing here is a to-do; the rows are imported and stay visible on
// the scan's own document.
const DEXA_DECOMPOSITION: UncuratedAnalyte = {
  kind: "out-of-scope",
  reason:
    "A DEXA scan's per-region decomposition. These are outputs of one scan rather than independent analytes, and no population reference range exists for them.",
};

// The regions a DEXA report segments for FAT distribution. Android/Gynoid are the
// abdominal and hip depots; Subtotal is whole-body-minus-head. "Total" is absent on
// purpose — the whole-body number IS the curated "Body Fat Percentage".
const DEXA_FAT_REGIONS = [
  "Left Arm",
  "Right Arm",
  "Arms",
  "Left Leg",
  "Right Leg",
  "Legs",
  "Trunk",
  "Head",
  "Android",
  "Gynoid",
  "Subtotal",
];

// The skeletal sites a DEXA report prints a density and a mineral content for.
// "Total" is absent for the same reason as above: whole-body bone density is what
// the curated T-score expresses, and a site is not the skeleton.
const DEXA_BONE_REGIONS = [
  "Left Arm",
  "Right Arm",
  "Arms",
  "Left Ribs",
  "Right Ribs",
  "Ribs",
  "Thoracic Spine",
  "Lumbar Spine",
  "Spine",
  "Left Pelvis",
  "Right Pelvis",
  "Pelvis",
  "Left Leg",
  "Right Leg",
  "Legs",
  "Trunk",
  "Head",
  "Subtotal",
];

// The compartment-mass grid: a region × a tissue compartment, in grams. Reports
// print the unit inside the name as often as not, and normalizeCanonicalKey keeps
// "(g)" as a token, so both spellings are declared rather than guessed at.
const DEXA_MASS_REGIONS = ["Trunk", "Head", "Android", "Gynoid", "Subtotal"];
const DEXA_MASS_COMPARTMENTS = ["Fat", "Lean", "Total"];

// The scan-level rows that aren't per-region: whole-scan mass compartments and the
// derived depot ratios. Same decision, same reason — each is arithmetic over one
// scan's segments, and none has a population band of its own.
//
// "Fat Mass Index" and "Lean Mass Index" USED to be listed here and are not any more
// (#2322). They failed this declaration's own test: they are not arithmetic over a
// scan's SEGMENTS but over the whole body and the subject's HEIGHT, which is what
// makes them comparable between people — and both have published population
// references (Schutz 2002 / NHANES DXA, Kelly 2009), which "no population reference
// range exists for them" flatly denied. The dataset was already carrying the proof:
// "Appendicular Lean Mass Index" has been a curated kg/m2 entry all along. They are
// curated entries now, so the completeness guard would fail if either name were left
// declared here as well.
const DEXA_SCAN_LEVEL = [
  "Total Mass",
  "Total Fat Mass",
  "Total Lean Mass",
  "Bone Mineral Content, Total",
  "Bone Mineral Density Z-Score",
  "Android/Gynoid Ratio",
  "Trunk to Legs Fat Ratio",
];

// Expanded rather than hand-listed: the family is a cross product, and writing ~80
// literal rows is how one region quietly goes missing. The expansion is still just
// `[name, declaration]` pairs in UNCURATED_ANALYTES, so the completeness guard walks
// every generated name exactly as it walks a hand-written one.
function dexaDecompositionNames(): string[] {
  const names: string[] = [];
  for (const region of DEXA_FAT_REGIONS)
    names.push(`Body Fat Percentage, ${region}`);
  for (const region of DEXA_BONE_REGIONS) {
    names.push(`Bone Mineral Density, ${region}`);
    names.push(`Bone Mineral Content, ${region}`);
  }
  for (const region of DEXA_MASS_REGIONS)
    for (const compartment of DEXA_MASS_COMPARTMENTS)
      names.push(`${region} ${compartment} Mass`);
  names.push(...DEXA_SCAN_LEVEL);
  // The gram-suffixed print form of every mass row. A ratio, an index and a
  // percentage are not masses, so they get no "(g)" twin.
  const withUnits = [
    ...names,
    ...names.filter((n) => n.endsWith(" Mass")).map((n) => `${n} (g)`),
  ];
  // De-duped by the key the registry is keyed on, so an overlap between the cross
  // product and the scan-level list can never mint two rows for one decision.
  const byKey = new Map(
    withUnits.map((n) => [normalizeCanonicalKey(n), n] as const)
  );
  return [...byKey.values()];
}

// The stress test's own vitals (#2322 Group 1). A treadmill report prints a blood
// pressure and a heart rate twice — once at rest before the test, once at peak
// effort — and both halves arrive with a "Stress Test" prefix in exactly the units
// the curated vitals already use. Curating either half would FORK the blood-pressure
// and heart-rate series, which is the trap `Neutrophils Relative` fell into, so
// neither is curated. But the two halves are declined for OPPOSITE reasons, and
// collapsing them into one declaration is what would make the promise false.
//
// The RESTING half genuinely IS the resting series: the prefix names the VISIT, not
// a different measurement, so it points at the entry that carries it.
const STRESS_TEST_RESTING_BP_REASON =
  "A blood pressure taken at rest before a stress test is an ordinary resting blood pressure — the “stress test” label names the appointment, not a different measurement. Allos files it with the rest of your blood pressure readings, so it trends there rather than starting a second series.";

const STRESS_TEST_RESTING_SYSTOLIC: UncuratedAnalyte = {
  kind: "covered-elsewhere",
  instead: "Blood Pressure Systolic",
  reason: STRESS_TEST_RESTING_BP_REASON,
};

const STRESS_TEST_RESTING_DIASTOLIC: UncuratedAnalyte = {
  kind: "covered-elsewhere",
  instead: "Blood Pressure Diastolic",
  reason: STRESS_TEST_RESTING_BP_REASON,
};

// The PEAK half is NOT the resting series, and pointing it at one would be a false
// promise — the specific failure `instead` is guarded against. A peak-exercise blood
// pressure belongs beside no resting reading, and the highest heart rate you reached
// on a treadmill is the opposite of a resting heart rate. Whether peak-exercise
// vitals deserve a series of their own is a design question about what the app
// models, not a name the catalog can settle, so they are `out-of-scope` — the shape
// that says "nothing to point at" instead of inventing a target.
const STRESS_TEST_PEAK_VITALS: UncuratedAnalyte = {
  kind: "out-of-scope",
  reason:
    "A peak-exercise reading — the highest value reached during the test — is a different measurement from the resting blood pressure and heart rate Allos trends, so it is deliberately not filed with them. Exercise-peak vitals aren't tracked as their own series today; the value is imported and stays visible on the stress-test report.",
};

const UNCURATED_ANALYTES: [string, UncuratedAnalyte][] = [
  ["eGFR, African American", EGFR_RACE_BRANCHED],
  ["eGFR, Non-African-American", EGFR_RACE_BRANCHED],
  ["eGFR, Thai", EGFR_RACE_BRANCHED],
  ["Beta Adrenergic Blocker Screen", TOXICOLOGY_SCREEN],
  ["Diuretic Screen, Urine", TOXICOLOGY_SCREEN],
  ["Stress Test Resting Blood Pressure Systolic", STRESS_TEST_RESTING_SYSTOLIC],
  [
    "Stress Test Resting Blood Pressure Diastolic",
    STRESS_TEST_RESTING_DIASTOLIC,
  ],
  ["Stress Test Maximum Blood Pressure Systolic", STRESS_TEST_PEAK_VITALS],
  ["Stress Test Maximum Blood Pressure Diastolic", STRESS_TEST_PEAK_VITALS],
  ["Stress Test Maximum Heart Rate", STRESS_TEST_PEAK_VITALS],
  ...dexaDecompositionNames().map((name): [string, UncuratedAnalyte] => [
    name,
    DEXA_DECOMPOSITION,
  ]),
];

const UNCURATED_BY_KEY = new Map<string, UncuratedAnalyte>(
  UNCURATED_ANALYTES.map(([name, declaration]) => [
    normalizeCanonicalKey(name),
    declaration,
  ])
);

// THE lookup. "Have we decided not to curate this analyte?" — null means no such
// decision exists, which is genuinely-not-curated-yet and stays actionable.
export function uncuratedAnalyte(
  name: string | null | undefined
): UncuratedAnalyte | null {
  const key = name ? normalizeCanonicalKey(name) : "";
  return (key && UNCURATED_BY_KEY.get(key)) || null;
}

// The declarations with their declared spellings, for the completeness guard
// (mirrors canonicalAliases() — same shape, same purpose).
export function uncuratedAnalytes(): readonly (readonly [
  string,
  UncuratedAnalyte,
])[] {
  return UNCURATED_ANALYTES;
}

// Snap a model-produced canonical name onto a known vocabulary entry when they
// describe the same analyte; otherwise return the name unchanged (so genuinely
// new analytes still coin a new canonical name, as intended). Pass a prebuilt
// index when snapping many names against the same vocabulary.
export function snapCanonicalName(
  name: string,
  vocabulary: string[] | Map<string, string>
): string {
  const index = Array.isArray(vocabulary)
    ? buildCanonicalIndex(vocabulary)
    : vocabulary;
  return index.get(normalizeCanonicalKey(name)) ?? name;
}

// Batch-aware snap for an import's record loop: like snapCanonicalName, but a
// vocabulary MISS claims the name's key in the caller-local index, so a same-key
// spelling LATER in the same batch collapses onto the batch's first occurrence.
// Without this, one import carrying both "Rubella Antibody IgG" and "Rubella
// Antibody (IgG)" (an XDM whose documents spell one analyte two ways) snapped
// each against the pre-import vocabulary only — both spellings survived onto
// rows, both registered as vocabulary entries, the analyte's series split, and
// the NEXT snap resolved the now-colliding key to an arbitrary alphabetical
// winner (so a byte-identical reprocess renamed canonicals). Callers pass a
// fresh buildCanonicalIndex() per batch; the mutation never outlives the batch.
export function snapCanonicalNameIntoBatch(
  name: string,
  index: Map<string, string>
): string {
  const key = normalizeCanonicalKey(name);
  const hit = index.get(key);
  if (hit) return hit;
  if (key) index.set(key, name);
  return name;
}

// Claim a FINAL canonical name's key in a caller-local batch index without
// re-snapping — for the AI path, whose unit-aware arbitration
// (unitAwareCanonical) can re-resolve the snapped name AFTER the snap, so the
// claim must happen on the post-arbitration result rather than inside the snap.
export function claimCanonicalKey(
  name: string,
  index: Map<string, string>
): void {
  const key = normalizeCanonicalKey(name);
  if (key && !index.has(key)) index.set(key, name);
}

// Garbage / placeholder canonical_names the AI extractor sometimes emits instead of
// a real analyte identity — "Comment(s)" is a recurring dumping-ground (a urine pH
// and a WBC row both came back as "Comment(S)" in real extractions, #918). Using it
// as a name would pollute the vocabulary AND mis-group unrelated rows onto one
// pseudo-analyte, so the caller ignores it and falls back to the printed name.
const GARBAGE_CANONICAL =
  /^(comment\(s\)|comments?|see\s*note|note\s*\d*|results?|interpretation|not\s*applicable|n\/?a)$/i;
export function isGarbageCanonical(name: string | null | undefined): boolean {
  return !!name && GARBAGE_CANONICAL.test(name.trim());
}

// --- Vitamin D isoform disambiguation --------------------------------------
//
// Circulating vitamin D is measured as two distinct 25-hydroxy metabolites:
// D2 (ergocalciferol, dietary/supplemental) and D3 (cholecalciferol, made in
// skin). A panel that reports them separately is reporting two different
// analytes. But the extractor is told to reuse the single "Vitamin D,
// 25-Hydroxy" vocabulary entry, and in doing so tends to strip the D2/D3
// suffix off canonical_name — collapsing both rows onto one biomarker series.
// The verbatim lab name keeps the suffix, so we recover the isoform from there
// and re-attach it to a generic vitamin-D canonical name.

// The vitamin-D isoform a name refers to: "2" for D2/ergocalciferol, "3" for
// D3/cholecalciferol, or null for a generic/total vitamin D (or anything
// unrelated). The bare "D2"/"D3" form only counts inside an explicit vitamin-D
// context so an unrelated "D2" token (e.g. the allergen "Dermatophagoides
// (D2)") isn't misread as an isoform.
export function vitaminDIsoform(name: string): "2" | "3" | null {
  const s = name.toLowerCase();
  if (/\bergocalciferol\b/.test(s)) return "2";
  if (/\bcholecalciferol\b/.test(s)) return "3";
  if (!/\bvit(?:amin)?\.?\s*d/.test(s)) return null;
  const m = /\bd[\s-]*([23])\b/.exec(s);
  return m ? (m[1] as "2" | "3") : null;
}

// Keys of the generic vitamin-D canonical names the model collapses D2 and D3
// onto, mapped to the isoform-specific spelling to substitute in.
const GENERIC_VITAMIN_D: [string, (iso: "2" | "3") => string][] = [
  [
    normalizeCanonicalKey("Vitamin D, 25-Hydroxy"),
    (iso) => `Vitamin D${iso}, 25-Hydroxy`,
  ],
  [normalizeCanonicalKey("Vitamin D"), (iso) => `Vitamin D${iso}`],
  [normalizeCanonicalKey("Vitamin D, Total"), (iso) => `Vitamin D${iso}`],
];

// The retest FAMILY key for the storage-form (25-hydroxy) vitamin-D metabolites,
// or null for anything else. Circulating total 25-OH vitamin D = D2 + D3, and
// most panels report only the total; a lab that additionally breaks out D2 and
// D3 is still measuring the same vitamin-D status. So for the "labs to redraw"
// retest signal these variants — total, generic "Vitamin D", and the D2/D3
// isoforms — are ONE analyte family: a fresh reading of any member satisfies the
// retest for all of them, so an old D2/D3 breakdown isn't flagged overdue when a
// recent total exists (the reported bug). Deliberately EXCLUDED, because they are
// genuinely distinct tests: the ACTIVE 1,25-dihydroxy metabolite (calcitriol),
// and the vitamin-D binding protein / receptor. Keyed off the same vitamin-D
// context rule as vitaminDIsoform (so a bare "D2"/"D3" only counts in context).
export const VITAMIN_D_25OH_FAMILY = "vitamin-d-25-hydroxy";

export function vitaminDRetestFamily(
  name: string | null | undefined
): string | null {
  if (!name) return null;
  const s = name.toLowerCase();
  const isVitaminD =
    /\bvit(?:amin)?\.?\s*d[23]?\b/.test(s) ||
    /\bergocalciferol\b/.test(s) ||
    /\bcholecalciferol\b/.test(s);
  if (!isVitaminD) return null;
  // Distinct analytes that share the "vitamin D" words but aren't the storage
  // form — never fold them into the family.
  if (
    /1[\s,]*25/.test(s) ||
    /\bdihydroxy\b/.test(s) ||
    /\bcalcitriol\b/.test(s) ||
    /\bbinding\b/.test(s) ||
    /\breceptor\b/.test(s)
  )
    return null;
  return VITAMIN_D_25OH_FAMILY;
}

// Given the model's canonical name and the verbatim lab name for the same row,
// return a canonical name that preserves the vitamin-D isoform. When the lab
// name pins down D2 or D3 but the canonical name is a generic vitamin-D entry,
// re-attach the isoform so the two metabolites stay on separate series. Any
// other canonical name — already isoform-specific, or not vitamin D at all — is
// returned unchanged.
export function distinguishVitaminDIsoform(
  canonicalName: string,
  sourceName: string
): string {
  const iso = vitaminDIsoform(sourceName);
  if (!iso) return canonicalName;
  if (vitaminDIsoform(canonicalName)) return canonicalName; // already specific
  const key = normalizeCanonicalKey(canonicalName);
  const generic = GENERIC_VITAMIN_D.find(([k]) => k === key);
  return generic ? generic[1](iso) : canonicalName;
}

// --- Biomarker identity families (#482) ------------------------------------
//
// GENERALIZES #481's vitaminDRetestFamily from the retest generator to the whole
// identity layer. A "family" is several stored biomarker names that answer ONE
// clinical question and so must resolve to ONE identity on EVERY surface — the
// cross-source dedup partition, the chart/detail series, the starred tile, the
// is_latest/current marker, AND the retest clock — so all of them agree what
// "Vitamin D" (or "A1c") is. It is the #481 alias table with a grouping column:
// each family carries the FINITE set of member canonical/raw spellings (the SQL
// preimage the #394 IN(...) pattern needs, since SQL can't call this JS) plus an
// optional freeform JS matcher (a regex) for names the extractor never snapped.
//
// EXCLUSION DISCIPLINE (#481 scope 3, verified against the FIT-vs-colonoscopy
// false-all-clear audit): ONLY names that are the SAME measurement join a family.
// Distinct assays (CRP vs hs-CRP), fractions (Free vs Total), specimens (serum vs
// RBC folate), and metabolites (25-OH storage form vs 1,25-dihydroxy calcitriol)
// are DELIBERATELY kept apart — each keeps its own identity — because a wrong
// grouping grants a wrong retest pass. Over-collapsing is the failure mode, so a
// new family is added only for names that are literally interchangeable readings.
export interface BiomarkerFamily {
  // The stable family key (unprefixed). biomarkerFamily() returns `family:<key>`.
  key: string;
  // The family's ANCHOR spelling: the canonical dataset name that answers the
  // family's question, and the one a surface should NAME the family by. Which
  // member happens to be a profile's newest reading is an accident of how a lab
  // ordered its lines, so a label, a copy line, or a curated-rule lookup keyed on
  // that member drifts row by row — the A1c family reads "Estimated Average
  // Glucose" whenever the eAG line lands with the higher id, and the diabetes risk
  // rule (which targets "hemoglobin a1c") then fails to tighten the cadence
  // (#1394/#1395). Resolve through biomarkerFamilyAnchor() instead. Must be a real
  // canonical dataset name that is itself a member of this family (pinned by test).
  anchor: string;
  // Lowercased member spellings — the family's enumerated vocabulary. A stored row
  // whose display name (canonical-or-raw) lowercases into this set is a family
  // member. Still the finite preimage (#394) the PANEL taxonomy realizes in SQL
  // (lib/biomarker-panels.panelMemberSpellings) and the corpus the JS↔SQL parity
  // tests pin — but no longer the family KEY's only SQL realization (see `match`).
  members: string[];
  // Freeform matcher for spellings an enumeration can't list (e.g.
  // "25-OH Vitamin D3 (Cholecalciferol)", an AI-coined A1c name that escaped
  // snapCanonicalName). This is NOT JS-only: the SQL family key calls
  // biomarkerFamily() through the `biomarker_family()` user function
  // (lib/sql-functions.ts), so the dedup / is_latest partitions honour the regex
  // exactly like the star, retest, and dismissal surfaces do (#1401). Keep it as
  // tight as `members` — a name it accepts is folded into the family EVERYWHERE.
  match?: (lowerName: string) => boolean;
}

// Hemoglobin A1c and its re-expression as estimated average glucose (eAG) are the
// SAME measurement — eAG just maps the A1c percentage onto an average glucose
// number (mg/dL) — exactly the D2/D3 case: one measurement, two names. This never
// fires on a bare fasting/random "Glucose": the "estimated average"/"eAG"
// qualifier (or an A1c/glyc-hemoglobin spelling) is what identifies it.
function isA1cFamily(lower: string): boolean {
  if (/\beag\b/.test(lower)) return true;
  if (/estimated average glucose/.test(lower)) return true;
  if (/\bh?b?a1c\b/.test(lower)) return true; // a1c, hba1c, hb a1c, hemoglobin a1c
  if (/\bglyc(?:ated|osylated|o)\s*h?a?emoglobin\b/.test(lower)) return true;
  return false;
}

export const HEMOGLOBIN_A1C_FAMILY = "hemoglobin-a1c";

// Audiogram pure-tone thresholds (#713) are DELIBERATELY NOT a biomarker family. Each
// per-ear, per-frequency threshold ("Hearing Threshold, Right Ear 4 kHz") is a DISTINCT
// measurement, not the same reading under two names — so folding them into one family
// would over-collapse exactly the way the exclusion discipline above warns against: the
// family key drives the cross-source dedup partition AND the is_latest/current marker,
// so a normal 1 kHz (or a normal LEFT ear) reading would mark the whole "hearing" group
// current/OK and HIDE a flagged 4 kHz (or right-ear) threshold — a wrong all-clear on a
// safety-relevant flag, and same-value ears on one date would even dedup to one row,
// dropping an ear. So every audiogram analyte keeps its OWN singleton identity: each
// ear/frequency stays a separate trendable series that flags independently. (The #713
// issue framed "two ears = one hearing question" as a family — but that premise breaks
// the dedup/latest mechanism; the safe realization is separate identities, argued in the
// PR.) A future per-audiogram summary (a pure-tone average) could carry the "one
// number" role without collapsing the underlying series.

// The registered identity families. Kept small and well-justified (each entry
// risks collapsing two distinct analytes — see the exclusion discipline above).
export const BIOMARKER_FAMILIES: readonly BiomarkerFamily[] = [
  {
    key: VITAMIN_D_25OH_FAMILY,
    anchor: "Vitamin D, 25-Hydroxy",
    // IDENTITY scope (#1193): the TOTAL 25-OH storage marker's spellings ONLY. The
    // D2/D3 fractions are DELIBERATELY EXCLUDED here (they were folded in by #482 —
    // an over-collapse: the family key drives the cross-source dedup partition, the
    // is_latest/current marker, the chart series, and the star, so folding a D3
    // fraction into the total's identity would dedup a D3 (45) against a total (50)
    // on one date and mark the whole group current off whichever is newest — the
    // exact FIT-vs-colonoscopy failure mode the exclusion discipline warns against).
    // Each fraction now keeps its OWN trendable identity and flags independently (a
    // low D2 must never inherit the total's 30-100 sufficiency band). The BROADER
    // total+D2+D3 RETEST clock (#481) lives apart in biomarkerRetestIdentity, the
    // audiogram #713 pattern: each real series keeps its own identity, a broader key
    // carries only the shared "one clock" role.
    members: [
      "vitamin d, 25-hydroxy",
      "vitamin d, total",
      "vitamin d",
      "25-oh vitamin d",
      "25-hydroxy vitamin d",
      "25-hydroxyvitamin d",
    ],
    // The total 25-OH spellings the SQL preimage can't enumerate — but NOT the D2/D3
    // isoforms (vitaminDIsoform pins those out) and NOT the 1,25/binding/receptor
    // analytes (vitaminDRetestFamily already excludes them).
    match: (s) =>
      vitaminDRetestFamily(s) === VITAMIN_D_25OH_FAMILY &&
      vitaminDIsoform(s) === null,
  },
  {
    key: HEMOGLOBIN_A1C_FAMILY,
    anchor: "Hemoglobin A1c",
    members: [
      "hemoglobin a1c",
      "hba1c",
      "a1c",
      "hgb a1c",
      "glycated hemoglobin",
      "glycosylated hemoglobin",
      "glycohemoglobin",
      "estimated average glucose",
      "eag",
    ],
    match: isA1cFamily,
  },
];

// The identity of a biomarker name: its `family:<key>` when the name belongs to a
// registered family, else the trimmed name itself (its own singleton identity).
// This is the ONE grouping every biomarker surface keys on so they can't disagree
// about what "Vitamin D" is — including the SQL surfaces, which call THIS function
// through the `biomarker_family()` user function (lib/sql-functions.ts) rather than
// re-realizing it as an enumerated CASE that could only see `members` (#1401).
// Returns "" for empty input. Non-family names are returned trimmed-but-unchanged
// (only case is folded downstream), so a JS-derived key and the SQL key agree under
// a COLLATE NOCASE compare.
export function biomarkerFamily(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  for (const fam of BIOMARKER_FAMILIES) {
    if (fam.members.includes(lower) || fam.match?.(lower)) {
      return `family:${fam.key}`;
    }
  }
  return trimmed;
}

const FAMILY_BY_IDENTITY: ReadonlyMap<string, BiomarkerFamily> = new Map(
  BIOMARKER_FAMILIES.map((f) => [`family:${f.key}` as string, f])
);

// The name to LABEL a biomarker identity by: its family's anchor spelling when the
// name belongs to a registered family, else the trimmed name itself. Use this
// wherever a surface names, or looks a curated rule up by, the analyte a group of
// readings stands for — a title, a copy line, a risk-rule match — so the answer
// doesn't drift with which member happens to be the newest reading (#1394/#1395).
//
// Deliberately keyed on the IDENTITY family (biomarkerFamily), NOT the wider retest
// identity: a vitamin-D D2/D3 fraction shares the total's redraw CLOCK but is its
// own series with its own band, so it keeps its own name and its own link. The A1c
// ↔ eAG family is one identity, so an eAG-representative nudge correctly names (and
// matches curated rules as) "Hemoglobin A1c". Returns "" for empty input.
export function biomarkerFamilyAnchor(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "";
  return FAMILY_BY_IDENTITY.get(biomarkerFamily(trimmed))?.anchor ?? trimmed;
}

// The RETEST-clock grouping key (#1193). BROADER than biomarkerFamily's identity
// scope for vitamin D ONLY: the 25-OH storage-form metabolites (total + D2 + D3)
// share ONE retest clock — a fresh reading of ANY member satisfies the redraw for
// all, so an old D2/D3 breakdown isn't flagged overdue when a recent total exists
// (the #481 behavior #482 subsumed and #1193 restores). Every OTHER analyte uses
// its biomarkerFamily identity unchanged (A1c ↔ eAG still share one clock; every
// singleton stays its own). This is the ONLY place vitamin D's retest breadth
// diverges from its narrowed series/dedup/star identity — the retest generator, the
// retest-worthiness gate, and the retest dismissal key all route through here, while
// the identity surfaces route through biomarkerFamily. Returns the SAME
// `family:vitamin-d-25-hydroxy` string biomarkerFamily gives the total, so a retest
// key stays byte-stable across which member is newest.
export function biomarkerRetestIdentity(
  name: string | null | undefined
): string {
  if (vitaminDRetestFamily(name) === VITAMIN_D_25OH_FAMILY) {
    return `family:${VITAMIN_D_25OH_FAMILY}`;
  }
  return biomarkerFamily(name);
}

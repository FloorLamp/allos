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
// entry written "Full Name (ABBREV)" needs BOTH the bare abbreviation AND the bare
// full name aliased, since its combined-token key matches neither alone.
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
  ["Estimated GFR", "eGFR"],
  ["GFR, Estimated", "eGFR"],
  ["Glomerular Filtration Rate, Estimated", "eGFR"],
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
  // Iron
  ["Total Iron Binding Capacity", "Total Iron-Binding Capacity (TIBC)"],
  // CBC differential — ABSOLUTE counts (cells/uL). The model prefixes "Absolute"
  // where the vocabulary either suffixes ", Absolute" (neutrophils) or uses the bare
  // name (the others — whose "%" form is the ", Relative" entry). Routing the wrong
  // way would drop a cells/uL value onto a "%" series (#549/#482), so each targets
  // the cells/uL entry, checked against its unit (#918). Strongest signal was
  // "Absolute Neutrophil Count", which missed in three separate extractions.
  ["Absolute Neutrophil Count", "Neutrophils, Absolute"],
  ["Absolute Neutrophils", "Neutrophils, Absolute"],
  // Lymphocytes were the ONE cell line the curated "Absolute X Count" set skipped
  // (#1195) — the ", Absolute" entry exists but the prefixed print form orphaned.
  // Route it to the cells/uL entry like its neutrophil sibling above.
  ["Absolute Lymphocyte Count", "Lymphocytes, Absolute"],
  ["Absolute Lymphocytes", "Lymphocytes, Absolute"],
  ["Absolute Monocyte Count", "Monocytes"],
  ["Absolute Monocytes", "Monocytes"],
  ["Absolute Eosinophil Count", "Eosinophils"],
  ["Absolute Eosinophils", "Eosinophils"],
  ["Absolute Basophil Count", "Basophils"],
  ["Absolute Basophils", "Basophils"],
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
  // Drift a FRESH re-extraction surfaced (#918): the model, given the same
  // vocabulary, still coined off-list names. The neutrophil %-form is bare
  // "Neutrophils" (no "Relative" suffix, unlike mono/eos/baso); the CBC counts often
  // print as bare abbreviations; specific gravity is always a urine test.
  ["Neutrophils, Relative", "Neutrophils"],
  ["Neutrophils Relative", "Neutrophils"],
  ["WBC", "White Blood Cell Count"],
  ["RBC", "Red Blood Cell Count"],
  ["Specific Gravity", "Urine Specific Gravity"],
  // Newly curated gaps (#918): the abbreviation/short forms onto the "Full (ABBREV)"
  // canonical entries the model already emits in long form.
  ["AFP", "Alpha-Fetoprotein (AFP)"],
  ["Alpha-Fetoprotein", "Alpha-Fetoprotein (AFP)"],
  ["CEA", "Carcinoembryonic Antigen (CEA)"],
  ["Carcinoembryonic Antigen", "Carcinoembryonic Antigen (CEA)"],
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
  // NOT aliased, on purpose:
  //  • bare "pH" — specimen-ambiguous (an arterial-blood-gas pH is not urine pH); the
  //    §2 trap. Needs a specimen qualifier to resolve.
  //  • "eGFR, African American" / "eGFR, Thai" — race/ethnicity-specific eGFR
  //    equations give DIFFERENT numbers; a report listing two would collapse two
  //    distinct values onto one date. Left surfaced rather than mis-grouped.

  // Bare-abbreviation → "Full Name (ABBR)" consolidation. The canonical entries
  // were renamed to the spelled-out form so the passport list reads consistently;
  // these route the standalone acronym (what an extractor or a legacy row emits)
  // onto the new name. A stored row keyed by the old bare abbreviation is rewritten
  // by migration 103; this covers fresh imports and any un-migrated caller.
  ["ALT", "Alanine Aminotransferase (ALT)"],
  ["AST", "Aspartate Aminotransferase (AST)"],
  ["GGT", "Gamma-Glutamyl Transferase (GGT)"],
  ["BUN", "Blood Urea Nitrogen (BUN)"],
  ["TSH", "Thyroid-Stimulating Hormone (TSH)"],
  ["hs-CRP", "High-Sensitivity C-Reactive Protein (hs-CRP)"],
  ["PSA", "Prostate-Specific Antigen (PSA)"],
  ["ApoB", "Apolipoprotein B (ApoB)"],
  ["TIBC", "Total Iron-Binding Capacity (TIBC)"],
  ["IGF-1", "Insulin-Like Growth Factor 1 (IGF-1)"],
  ["MCV", "Mean Corpuscular Volume (MCV)"],
  ["MCH", "Mean Corpuscular Hemoglobin (MCH)"],
  ["MCHC", "Mean Corpuscular Hemoglobin Concentration (MCHC)"],
  ["MPV", "Mean Platelet Volume (MPV)"],
  ["RDW", "Red Cell Distribution Width (RDW)"],
];

// Build a normalized-key -> canonical-spelling lookup from a vocabulary list.
// On key collision the first entry wins (vocabulary is passed in the caller's
// preferred order — seeded/curated names sort ahead of ai-coined ones). Curated
// CANONICAL_ALIASES are layered on AFTER the real entries, and only for a target
// name present in this vocabulary: a real entry always wins a key collision, so
// an alias can only ADD a route to an existing analyte, never hijack a distinct one.
export function buildCanonicalIndex(vocabulary: string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const name of vocabulary) {
    const key = normalizeCanonicalKey(name);
    if (key && !index.has(key)) index.set(key, name);
  }
  for (const [alias, canonical] of CANONICAL_ALIASES) {
    const aliasKey = normalizeCanonicalKey(alias);
    if (!aliasKey || index.has(aliasKey)) continue;
    const target = index.get(normalizeCanonicalKey(canonical));
    if (target) index.set(aliasKey, target);
  }
  return index;
}

// The curated alias routes, exposed for the vocabulary-integrity test (it pins
// that every target is a real dataset entry and no alias shadows a distinct one).
export function canonicalAliases(): readonly [string, string][] {
  return CANONICAL_ALIASES;
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
  // Lowercased member spellings — the finite SQL preimage. A stored row whose
  // display name (canonical-or-raw) lowercases into this set is a family member.
  members: string[];
  // Optional JS-only matcher for freeform spellings the SQL preimage can't list
  // (e.g. "25-OH Vitamin D3 (Cholecalciferol)"). SQL surfaces rely on the finite
  // member list; the retest generator (pure JS) gets the full regex coverage.
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
// about what "Vitamin D" is. Returns "" for empty input. Non-family names are
// returned unchanged (only case is folded downstream) so the JS result and the
// SQL biomarkerFamilyKey() CASE-ELSE (which returns the raw display name) agree
// under a COLLATE NOCASE compare.
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

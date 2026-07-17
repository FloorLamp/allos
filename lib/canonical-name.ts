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
  ["Alanine Aminotransferase", "ALT"],
  ["Alanine Transaminase", "ALT"],
  ["SGPT", "ALT"],
  ["Aspartate Aminotransferase", "AST"],
  ["Aspartate Transaminase", "AST"],
  ["SGOT", "AST"],
  ["Gamma-Glutamyl Transferase", "GGT"],
  ["Gamma-Glutamyl Transpeptidase", "GGT"],
  ["Gamma GT", "GGT"],
  ["GGTP", "GGT"],
  // Renal
  ["Urea Nitrogen", "BUN"],
  ["Blood Urea Nitrogen", "BUN"],
  ["Estimated GFR", "eGFR"],
  ["GFR, Estimated", "eGFR"],
  ["Glomerular Filtration Rate, Estimated", "eGFR"],
  // Thyroid
  ["Thyroid Stimulating Hormone", "TSH"],
  ["Thyrotropin", "TSH"],
  // Inflammation (high-sensitivity ONLY — plain CRP is a distinct assay)
  ["hsCRP", "hs-CRP"],
  ["High Sensitivity CRP", "hs-CRP"],
  ["High-Sensitivity C-Reactive Protein", "hs-CRP"],
  ["C-Reactive Protein, High Sensitivity", "hs-CRP"],
  ["Cardio CRP", "hs-CRP"],
  // Prostate (unqualified PSA = total; the Free % entry stays distinct)
  ["Prostate Specific Antigen", "PSA"],
  ["Prostate-Specific Antigen", "PSA"],
  ["Prostate Specific Antigen, Total", "PSA"],
  ["PSA, Total", "PSA"],
  // Lipids / apolipoprotein
  ["Apolipoprotein B", "ApoB"],
  ["Apo B", "ApoB"],
  ["Apolipoprotein B-100", "ApoB"],
  // Iron
  ["Total Iron Binding Capacity", "TIBC"],
  // Vitamins / cofactors
  ["B12", "Vitamin B12"],
  ["Vitamin B-12", "Vitamin B12"],
  ["Cobalamin", "Vitamin B12"],
  ["Cyanocobalamin", "Vitamin B12"],
  ["Folic Acid", "Folate"],
  ["Vitamin B9", "Folate"],
  ["Retinol", "Vitamin A (Retinol)"],
  ["Vitamin A", "Vitamin A (Retinol)"],
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
  ["IGF-I", "IGF-1"],
  ["Insulin-like Growth Factor 1", "IGF-1"],
  ["Insulin-Like Growth Factor-1", "IGF-1"],
  ["Somatomedin C", "IGF-1"],
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

// The registered identity families. Kept small and well-justified (each entry
// risks collapsing two distinct analytes — see the exclusion discipline above).
export const BIOMARKER_FAMILIES: readonly BiomarkerFamily[] = [
  {
    key: VITAMIN_D_25OH_FAMILY,
    members: [
      "vitamin d, 25-hydroxy",
      "vitamin d, total",
      "vitamin d",
      "vitamin d2, 25-hydroxy",
      "vitamin d3, 25-hydroxy",
      "vitamin d2",
      "vitamin d3",
      "25-oh vitamin d",
      "25-hydroxy vitamin d",
      "25-hydroxyvitamin d",
    ],
    match: (s) => vitaminDRetestFamily(s) === VITAMIN_D_25OH_FAMILY,
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

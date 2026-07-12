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

// Build a normalized-key -> canonical-spelling lookup from a vocabulary list.
// On key collision the first entry wins (vocabulary is passed in the caller's
// preferred order — seeded/curated names sort ahead of ai-coined ones).
export function buildCanonicalIndex(vocabulary: string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const name of vocabulary) {
    const key = normalizeCanonicalKey(name);
    if (key && !index.has(key)) index.set(key, name);
  }
  return index;
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

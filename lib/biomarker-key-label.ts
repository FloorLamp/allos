// How to NAME a biomarker when all you hold is a stored key (#2578 defect 3).
//
// The suppression bus stores an analyte's identity, lowercased, as the tail of a
// dedupe key: `biomarker-flag:<identity>` (the #482/#564 FLAG identity) and
// `biomarker:<identity>` (the #1193 RETEST identity). Neither tail is a display
// name, and both used to be rendered by title-casing whatever the tail happened to
// be — which produced "Flagged result — Family:vitamin-d-25-hydroxy" on the live
// Upcoming page, plus the milder "Ldl Cholesterol".
//
// One question, asked in one place, answered in three steps:
//
//   1. A `family:<key>` tail is a FAMILY IDENTITY, not a name. Resolve it through the
//      family's declared `anchor` spelling ("Vitamin D, 25-Hydroxy") — the same
//      spelling every other surface names that family by (#1394/#1395).
//   2. Otherwise the tail is a lowercased analyte name whose casing is gone. The
//      curated canonical dataset knows the real spelling for the names it ships, so
//      recover it there: "ldl cholesterol" → "LDL Cholesterol".
//   3. Otherwise title-case it, the honest approximation the resolver always used.
//
// Step 2 covers the CURATED vocabulary only, and deliberately. An ai-coined spelling
// ("Body Mass Index (BMI)") lives in the profile's `canonical_biomarkers` rows, not in
// the shipped dataset, and this resolver is PURE by design — the suppression-display
// coverage guard tests it with no database. Reaching into per-profile vocabulary to
// recover the casing of a dismissed row's label is not worth threading a DB read
// through a label formatter; such a name falls to step 3 and reads as it always did.

import {
  biomarkerIdentityAnchor,
  normalizeCanonicalKey,
} from "./canonical-name";
import canonicalSeed from "./canonical-biomarkers.json";

// normalized key -> the dataset's own spelling. Built once from the shipped seed,
// which is the same source lib/import-shape.ts reads for its curated-vocabulary test.
const SEED_SPELLING_BY_KEY: ReadonlyMap<string, string> = (() => {
  const index = new Map<string, string>();
  // First entry wins a key collision, the same rule canonicalEntryIndex applies to a
  // profile's vocabulary — dataset order is the dataset's own preference.
  for (const b of (canonicalSeed as { biomarkers?: { name: string }[] })
    .biomarkers ?? []) {
    const key = normalizeCanonicalKey(b.name);
    if (key && !index.has(key)) index.set(key, b.name);
  }
  return index;
})();

// Capitalize each word so a lowercased subject reads as a name ("bench press" →
// "Bench Press"). The last resort: the original casing is genuinely gone.
export function titleizeKeyTail(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// The display name for a stored biomarker key tail. "" for an empty tail, so a
// caller can fall back to a subject-less label.
export function biomarkerKeyLabel(tail: string): string {
  const trimmed = tail.trim();
  if (!trimmed) return "";
  return (
    biomarkerIdentityAnchor(trimmed) ??
    SEED_SPELLING_BY_KEY.get(normalizeCanonicalKey(trimmed)) ??
    titleizeKeyTail(trimmed)
  );
}

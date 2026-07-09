import { IMMUNITY_ANTIBODY_MARKERS } from "./immunization-catalog";
import { normalizeCanonicalKey } from "./canonical-name";

// Each catalog antibody-marker name reduced to its token set, plus the set of
// distinctive (disease-naming) tokens that identify a titer row. Matching a
// stored biomarker name by "all of a marker's tokens are present" (rather than
// exact spelling) means lab variants like "Hepatitis B Surface Ab, Quantitative"
// or the comma-inverted "Surface Antibody, Hepatitis B" still credit the series,
// which an exact COLLATE NOCASE compare would miss. Generic tokens shared by
// every titer ("antibody"/"igg"/…) are dropped from the distinctive set so the
// SQL prefilter keys on a disease name, not on "antibody".
const TITER_GENERIC_TOKENS = new Set([
  "ab",
  "anti",
  "antibody",
  "igg",
  "igm",
  "iga",
  "titer",
  "titre",
  "surface",
  "total",
  "quant",
  "quantitative",
  "serum",
  "level",
  "immunity",
  "status",
]);

export const TITER_MARKER_TOKENS: string[][] = IMMUNITY_ANTIBODY_MARKERS.map(
  (m) => normalizeCanonicalKey(m).split(" ").filter(Boolean)
);

export const TITER_DISTINCTIVE_TOKENS: string[] = Array.from(
  new Set(
    TITER_MARKER_TOKENS.flatMap((toks) =>
      toks.filter((t) => t.length >= 3 && !TITER_GENERIC_TOKENS.has(t))
    )
  )
);

// True when every token of some catalog marker is present in the record's token
// set (order- and punctuation-independent). Extra qualifier tokens on the record
// ("quantitative", "igg") don't block the match.
export function matchesImmunityMarker(recordTokens: Set<string>): boolean {
  return TITER_MARKER_TOKENS.some((toks) =>
    toks.every((t) => recordTokens.has(t))
  );
}

// Reduce a biomarker name to its normalized token set — the input to
// matchesImmunityMarker. Punctuation and casing are folded so "Surface Antibody,
// Hepatitis B" and "hepatitis b surface ab" produce the same set.
export function markerNameTokens(name: string): Set<string> {
  return new Set(normalizeCanonicalKey(name).split(" ").filter(Boolean));
}

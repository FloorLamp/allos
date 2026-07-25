import { canonicalResolver } from "../../canonical-resolve";
import { db } from "../../db";
import type { CanonicalBiomarker } from "../../types";

// Full reference-dataset entry for a canonical name. Alias-aware so callers and
// legacy stored rows resolve through the same canonical vocabulary.
export function getCanonicalBiomarker(
  name: string
): CanonicalBiomarker | undefined {
  const stmt = db.prepare(
    "SELECT * FROM canonical_biomarkers WHERE name = ? COLLATE NOCASE"
  );
  const exact = stmt.get(name) as CanonicalBiomarker | undefined;
  if (exact) return exact;

  const snapped = canonicalResolver()(name);
  return snapped !== name
    ? (stmt.get(snapped) as CanonicalBiomarker | undefined)
    : undefined;
}

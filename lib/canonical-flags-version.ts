import crypto from "node:crypto";
import canonicalSeed from "./canonical-biomarkers.json";

// Bump when reconciledFlag's derivation LOGIC changes (e.g. how it maps a value
// to high/low/non-optimal), so existing records are re-flagged on the next boot
// even when the canonical dataset itself is unchanged.
// v2: seedCanonicalBiomarkers now promotes AI-discovered rows to curated ranges
// when the JSON lists them, and count/enzyme unit equivalence was fixed — both
// change which readings convert and flag, so force one re-reconcile.
// v3: age-banded reference ranges (ranges_by_age) — flags are now derived against
// the subject's age on the record's collection date, so every stored record must
// re-reconcile once against its age band.
// v4: reproductive-status ranges (ranges_by_status) — for female physiology, an
// explicit menopausal status now overrides the age proxy in referenceRange, so
// hormone records for a profile with a status set must re-reconcile once.
export const FLAG_LOGIC_VERSION = 4;

// The canonical fields that can change a record's derived flag: the reference and
// optimal ranges (incl. sex-specific and age-banded variants), the unit +
// conversions (which govern how a reading is compared), and the direction.
// Anything else (notes, category) is ignored so a cosmetic edit doesn't trigger a
// needless re-scan. `ranges_by_age` is a nested array; it's hashed by value
// (JSON.stringify), so any change to a band flows into the signature.
const FLAG_RELEVANT_FIELDS = [
  "name",
  "unit",
  "direction",
  "ref_low",
  "ref_high",
  "ref_low_male",
  "ref_high_male",
  "ref_low_female",
  "ref_high_female",
  "optimal_low",
  "optimal_high",
  "optimal_low_male",
  "optimal_high_male",
  "optimal_low_female",
  "optimal_high_female",
  "ranges_by_age",
  // Reproductive-status reference overrides (JSON object). Hashed by value like
  // ranges_by_age, so adding/editing a status range flows into the signature and
  // re-reconciles stored flags on the next boot.
  "ranges_by_status",
  "conversions",
] as const;

type RangeRow = Record<string, unknown>;

// A deterministic signature of the canonical dataset's flag-relevant fields plus
// the logic version. Stored in settings; the flag-reconcile migration re-runs
// whenever it changes. Rows are sorted by name and only relevant fields hashed,
// so the signature is stable across boots and insensitive to key order or
// cosmetic edits.
export function canonicalFlagsSignature(
  biomarkers: RangeRow[] = (canonicalSeed as { biomarkers?: RangeRow[] })
    .biomarkers ?? [],
  logicVersion: number = FLAG_LOGIC_VERSION
): string {
  const rows = biomarkers
    .map((b) =>
      FLAG_RELEVANT_FIELDS.map((f) => (b[f] === undefined ? null : b[f]))
    )
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const payload = JSON.stringify({ v: logicVersion, rows });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

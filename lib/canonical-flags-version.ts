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
// v5: qualitative-result classifier (#549) — the flag reconcile now revisits
// QUALITATIVE (value_num IS NULL) rows the numeric pass always skipped, promoting a
// durable-immunity titer to "immune" (#544) and clearing a blunt "abnormal" on a
// context-neutral attribute like a blood type (#548 §1). Existing stored rows must
// re-reconcile once so the boot pass corrects flags frozen by the extractor's guess.
// v6: qualitative bad-polarity promotion (#629) — qualitativeFlagResolution now sets
// "abnormal" on a bad-polarity positive (positive HBsAg/HCV/HIV, positive culture) the
// extractor left null/normal, instead of leaving it displayed as "Normal". Existing
// unflagged infection-positive rows must re-reconcile once so they reach the attention
// hero.
// v7: screening/risk class (#687) — classifyQualitativeResult now resolves a
// prenatal/genetic screen (NIPT trisomy) to a low/high-risk verdict, so a HIGH-risk
// screen the extractor left null/normal is promoted to "abnormal" (like an infection-
// positive) and a LOW-risk screen's blunt "abnormal" is cleared. Existing stored
// screen rows must re-reconcile once so the boot pass corrects those frozen flags.
// v8: cycle-phase reference ranges (ranges_by_cycle_phase, #718) — for female
// physiology, the cycle phase on a record's collection date (derived from the logged
// cycle history) now overrides the coarse status/age proxy in referenceRange for the
// phase-dependent hormones (FSH/LH/estradiol/progesterone). A stored flag can change
// meaning — a mid-luteal progesterone flagged "high" under the coarse envelope is
// normal against its luteal range — so a profile WITH cycle data must re-reconcile
// its hormone records once. (A profile with NO cycle data derives no phase and
// re-reconciles to the byte-identical prior flag, so this is a no-op for them.)
// v9: UCUM bracket/annotation stripping in unit matching (#1018) — sameUnit /
// convertToCanonical now recognize the spellings documents actually ship
// ("mm[Hg]" ≡ mmHg, "[degF]" ≡ degF, "{beats}/min" ≡ /min), so imported rows
// whose flags were never derived (conversion returned null at write time) become
// judgeable. Every stored record must re-reconcile once so an imported 158
// mm[Hg] blood pressure finally gets its "high" flag — this same pass also
// covers the Body Temperature rows migration 074 converted to canonical °F.
export const FLAG_LOGIC_VERSION = 9;

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
  // Cycle-phase reference overrides (JSON object, #718). Hashed by value like
  // ranges_by_status, so adding/editing a phase range flows into the signature and
  // re-reconciles the affected profiles' hormone flags on the next boot.
  "ranges_by_cycle_phase",
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

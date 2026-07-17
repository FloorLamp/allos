// Single-reading fever red flags, loaded onto the curated-dataset framework (issue
// #859 item 3, #860 Track B). Copies the dri.ts/screenings.ts shape: import the
// envelope JSON, validate it once with loadDataset(), build a key-keyed matcher for
// the framework linter, and expose the DOMAIN accessor detectTempRedFlag() the toast
// + the care-tier finding builder both consume. Age bands live ON the entries (the
// dri precedent). Pure — no DB, no network.
//
// REFUSAL POSTURE (#798/#805): a reading that crosses no entry resolves to null (no
// note, ever). Each entry renders the SOURCE's own instruction verbatim — never a
// computed judgment, never a symptom combination (the #805 non-goal). The infant band
// consults age ONLY as the source publishes it; an unknown age never triggers it.

import rawTempRedFlags from "./data/temperature-red-flags.json";
import { loadDataset } from "./loader";
import { createMatcher, fieldStrategy } from "./matcher";

// One age-banded single-reading red-flag rule.
export interface TempRedFlagEntry {
  // Stable machine identity ("infant_fever", "hyperpyrexia").
  key: string;
  label: string;
  // The reading (canonical °F) at or above which the rule fires.
  minTempF: number;
  // The band's exclusive upper age bound in months — the rule fires only when the
  // profile's age is KNOWN and strictly below this. null = any age (no age gate).
  maxAgeMonths: number | null;
  // The source's own instruction line, rendered verbatim (never generated).
  line: string;
  source: string;
}

// The validated dataset (envelope + guarantees). Throws at module load if the
// committed JSON ever violates the contract — a loud, early failure.
export const tempRedFlagsDataset =
  loadDataset<TempRedFlagEntry>(rawTempRedFlags);

// Identity strategy: the rule `key` field, case-folded (for the framework linter).
export const tempRedFlagKeyStrategy = fieldStrategy("key");

// Key-keyed matcher (the framework refusal gate: an unknown key resolves to null).
const matcher = createMatcher(tempRedFlagsDataset, tempRedFlagKeyStrategy);

// The red-flag rules in curated order — most-specific (infant) first, so a reading
// that crosses more than one returns the infant band.
export const TEMP_RED_FLAG_ENTRIES: TempRedFlagEntry[] =
  tempRedFlagsDataset.entries;

// The rule by key, or null when the dataset doesn't cover it (framework accessor).
export function tempRedFlagForKey(key: string): TempRedFlagEntry | null {
  return matcher.match(key);
}

// The single-reading red flag a temperature reading crosses, or null (the DOMAIN
// accessor). `degF` is the canonical reading; `ageMonths` is the profile's whole-month
// age, or null when unknown. Returns the FIRST matching entry in curated order (infant
// band before hyperpyrexia), so a young infant with a very high fever renders the
// infant instruction. Pure — the caller renders `entry.line` + `entry.source`, never a
// computed judgment.
export function detectTempRedFlag(
  degF: number,
  ageMonths: number | null
): TempRedFlagEntry | null {
  for (const e of TEMP_RED_FLAG_ENTRIES) {
    if (degF < e.minTempF) continue;
    if (e.maxAgeMonths != null) {
      // Age-gated band: fires only when the age is known and strictly below the bound.
      if (ageMonths == null || ageMonths >= e.maxAgeMonths) continue;
    }
    return e;
  }
  return null;
}

// The OTC PRN dosing-defaults dataset, loaded onto the curated-dataset framework
// (issue #860 Track B, wave 2). Copies the temperature-red-flags.ts / icd10-common.ts
// shape: import the envelope JSON (hand-authored + human-reviewable), validate it once
// with loadDataset(), and expose the ingredient entries the PRN matcher consumes.
// Identity is the ingredient `slug` (fieldStrategy "slug") — the stable machine id; the
// DOMAIN matcher (lib/prn-defaults.ts) resolves a live item by RxCUI + name, which the
// framework's exact-key strategies can't replicate, so that logic stays there (the
// drug-interactions precedent). The registry lists this for the linter. Pure.
//
// LIABILITY POSTURE (#798): every value is a public OTC Drug Facts label figure; the
// pediatric bands REPRODUCE the label chart (no mg/kg computation); age gates are the
// label's own "ask a doctor" refusals; aspirin has NO pediatric entry (Reye's).

import rawPrn from "./data/prn-defaults.json";
import { loadDataset } from "./loader";
import { fieldStrategy } from "./matcher";

// One weight band from an OTC pediatric Drug Facts chart: an inclusive LOWER weight
// bound (pounds) and the label's mg for that band. Bands are ordered ascending.
export interface PediatricBand {
  minLbs: number;
  mg: number;
}

// A common product formulation carrying its concentration (mg per mL). `slug` is the
// formulation's stable machine identifier (the form's picker value).
export interface PrnFormulation {
  slug: string;
  label: string;
  mgPerMl: number;
}

export interface PrnAdultDefaults {
  minIntervalHours: number;
  maxDailyCount: number;
  maxDailyMg: number;
  doseMgLow: number;
  doseMgHigh: number;
}

export interface PrnPediatricDefaults {
  // Hard age gate (label's own): below this age the lookup refuses with ageGateText.
  minAgeMonths: number;
  ageGateText: string;
  bands: PediatricBand[];
  formulations: PrnFormulation[];
  // The CHILD label's redose interval / daily-max, when the pediatric label DIFFERS
  // from the adult figure (#851 item 12). Absent ⇒ no pediatric redose prefill.
  minIntervalHours?: number;
  maxDailyCount?: number;
}

export interface PrnDefaultEntry {
  // Stable machine identifier for the ingredient ("ibuprofen", …) — the identity KEY.
  slug: string;
  label: string;
  rxcuis: string[];
  synonyms: string[];
  adult: PrnAdultDefaults;
  // ABSENT for ingredients with no OTC pediatric weight-band table (aspirin — Reye's;
  // naproxen — under 12; diphenhydramine — age-dosed, not weight-banded).
  pediatric?: PrnPediatricDefaults;
  source: string;
}

// The validated dataset (envelope + guarantees). Throws at module load if the committed
// JSON ever violates the contract — a loud, early failure.
export const prnDefaultsDataset = loadDataset<PrnDefaultEntry>(rawPrn);

// Identity strategy: the ingredient `slug`, case-folded. For the framework linter.
export const prnDefaultSlugStrategy = fieldStrategy("slug");

// Every PRN ingredient entry in curated order (the DOMAIN matcher iterates these).
export const PRN_DEFAULT_ENTRIES: PrnDefaultEntry[] =
  prnDefaultsDataset.entries;

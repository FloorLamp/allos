// Read-time computation of DERIVED clinical indices (issue #40) as virtual
// biomarker records. This is the DB-facing seam over the pure lib/derived-biomarkers
// math: it reads the stored component series (through the already profile-scoped
// getBiomarkerSeries), resolves demographics from settings, computes the indices,
// and shapes each result as a read-only MedicalRecord the biomarkers table, the
// biomarker detail page, and the Trends surfaces render like any other analyte.
//
// No raw SQL lives here — every read goes through an already-scoped query
// (getAllBiomarkerSeries / getBiomarkerSeries / getCanonicalBiomarker) or
// lib/settings — so the profile-scoping guard is unaffected. Nothing is written;
// the records are ephemeral.

import {
  getAllBiomarkerSeries,
  getBiomarkerSeries,
  getCanonicalBiomarker,
  getUsedCanonicalNames,
} from "./medical";
import { canonicalGroupKey, groupByCanonicalName } from "../biomarker-group";
import { cache } from "../request-cache";
import {
  getUserSex,
  getUserAgeOn,
  getUserReproductiveStatus,
} from "../settings";
import { reconciledFlag } from "../reference-range";
import {
  computeDerivedReadings,
  derivedInputCanonicalNames,
  DERIVED_NAMES,
  type ComponentReading,
  type DerivedName,
  type DerivedReading,
} from "../derived-biomarkers";
import { PHENOAGE_INPUT_NAMES } from "../bio-age";
import type { MedicalRecord } from "../types";

// A virtual (unstored) record synthesized from a computed derived reading. Same
// shape as a stored MedicalRecord (so every consumer treats it uniformly) but with
// `derived` set, a synthetic negative id, and the substituted formula string.
function toVirtualRecord(
  reading: DerivedReading,
  index: number,
  flag: MedicalRecord["flag"]
): MedicalRecord {
  return {
    // Synthetic, stable, and negative so it can never collide with a real row's
    // positive id (used only as a React key / grouping id — never for a write).
    id: -1 - index,
    date: reading.date,
    category: "lab",
    name: reading.name,
    value: String(reading.value),
    unit: reading.unit,
    reference_range: null,
    notes: null,
    created_at: "",
    document_id: null,
    panel: null,
    flag,
    value_num: reading.value,
    canonical_name: reading.name,
    provider_id: null,
    provider_name: null,
    derived: true,
    derived_formula: reading.formula,
  };
}

// Compute every derivable index for a profile, returned as read-only virtual
// records (oldest-first within each index, in DERIVED_NAMES order). Flags are
// derived from the canonical ranges exactly like stored readings (reconciledFlag),
// so a derived value badges high/low/non-optimal consistently. A draw that already
// has a STORED reading of the same derived analyte is skipped, so a lab that
// reports e.g. Non-HDL or eGFR directly is never shadowed by a computed duplicate.
export function getDerivedBiomarkerReadings(
  profileId: number
): MedicalRecord[] {
  // One deduped read of every analyte's series, grouped in JS (lib/biomarker-
  // group) — a per-analyte getBiomarkerSeries here would re-run the dedup window
  // over the profile's whole lab history once per input AND per derived name,
  // O(analytes × records) per request (#105/#386). Mirrors buildTrajectoryFindings.
  const grouped = groupByCanonicalName(getAllBiomarkerSeries(profileId));

  // Load each component series once, reduced to exact numeric readings — an
  // arithmetic index can't consume a bounded/qualitative value. Keyed by the exact
  // input canonical name (computeDerivedReadings looks up by spec.canonical).
  const seriesByCanonical = new Map<string, ComponentReading[]>();
  for (const canonical of derivedInputCanonicalNames()) {
    const rows = (grouped.get(canonicalGroupKey(canonical)) ?? [])
      .filter((r) => r.value_num != null)
      .map((r) => ({
        date: r.date,
        value: r.value_num as number,
        unit: r.unit,
      }));
    seriesByCanonical.set(canonical, rows);
  }

  // Dates already covered by a stored reading of each derived analyte — skip them.
  const storedDatesByName: Partial<Record<DerivedName, Set<string>>> = {};
  for (const name of DERIVED_NAMES) {
    const dates = new Set(
      (grouped.get(canonicalGroupKey(name)) ?? []).map((r) => r.date)
    );
    if (dates.size) storedDatesByName[name] = dates;
  }

  const sex = getUserSex(profileId);
  const status = getUserReproductiveStatus(profileId);
  const readings = computeDerivedReadings(
    seriesByCanonical,
    { sex, ageOn: (date) => getUserAgeOn(profileId, date) },
    { storedDatesByName }
  );

  // Cache canonical entries so each analyte's ranges are looked up once for flags.
  const cbCache = new Map<string, ReturnType<typeof getCanonicalBiomarker>>();
  const cbFor = (name: string) => {
    if (!cbCache.has(name)) cbCache.set(name, getCanonicalBiomarker(name));
    return cbCache.get(name);
  };

  return readings.map((reading, i) => {
    const cb = cbFor(reading.name);
    const age = getUserAgeOn(profileId, reading.date);
    // reconciledFlag over a null "current" flag yields the flag the ranges imply
    // (high/low/non-optimal) or null/undefined when in-band — collapse both to null.
    const flag =
      reconciledFlag(null, reading.value, reading.unit, cb, sex, age, status) ??
      null;
    return toVirtualRecord(reading, i, flag);
  });
}

// The derived analytes that actually have ≥1 computed reading for this profile —
// the names the Trends digest/compare and the biomarkers table should include
// alongside the stored analytes.
export function getDerivedCanonicalNames(profileId: number): string[] {
  const present = new Set(
    getDerivedBiomarkerReadings(profileId).map((r) => r.name)
  );
  // Keep DERIVED_NAMES order for stable output.
  return DERIVED_NAMES.filter((n) => present.has(n));
}

// The computed series for ONE derived analyte (oldest-first), or [] when the name
// isn't a derived index or has no computable readings. Used by the biomarker detail
// page + Trends series builder to chart a derived analyte.
export function getDerivedBiomarkerSeriesFor(
  profileId: number,
  canonical: string
): MedicalRecord[] {
  if (!(DERIVED_NAMES as readonly string[]).includes(canonical)) return [];
  return getDerivedBiomarkerReadings(profileId).filter(
    (r) => r.name === canonical
  );
}

// Stored ∪ derived canonical names in use, de-duplicated case-insensitively —
// the analyte universe for the Trends digest/compare pickers so derived indices
// appear like normal analytes.
export function getUsedCanonicalNamesWithDerived(profileId: number): string[] {
  const stored = getUsedCanonicalNames(profileId);
  const seen = new Set(stored.map((n) => n.toLowerCase()));
  const merged = [...stored];
  for (const n of getDerivedCanonicalNames(profileId)) {
    if (!seen.has(n.toLowerCase())) merged.push(n);
  }
  return merged;
}

// Stored series for a canonical analyte UNIONed with any derived readings for it
// (derived only on draws the stored series doesn't already cover — the deriver
// already skips stored dates). Oldest-first. This lets a derived analyte's detail
// page + Trends chart render even though nothing is stored, while a lab that begins
// reporting the analyte directly seamlessly takes over those draws.
export function getBiomarkerSeriesWithDerived(
  profileId: number,
  canonical: string
): MedicalRecord[] {
  const stored = getBiomarkerSeries(profileId, canonical);
  const derived = getDerivedBiomarkerSeriesFor(profileId, canonical);
  if (derived.length === 0) return stored;
  return [...stored, ...derived].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id
  );
}

// One complete PhenoAge draw, shaped for the biological-age hero (issue #209): the
// estimated biological age, the chronological age on that draw date, and the nine
// canonical-unit inputs it was built from (each linking to its own series).
export interface BioAgeDraw {
  date: string;
  bioAge: number;
  chronoAge: number | null;
  inputs: { name: string; value: number; unit: string }[];
}

// The biological-age (PhenoAge) reading data for a profile: every complete draw
// (oldest-first) plus WHICH of the nine inputs the profile has any usable reading of
// — the latter drives the partial-panel checklist CTA when no draw is complete. This
// is the DB seam over the pure lib/bio-age + lib/derived-biomarkers math; nothing is
// written, and every read goes through an already profile-scoped query, so the
// profile-scoping guard is unaffected.
// cache(): the dashboard renders the bio-age hero AND the healthspan pillars, each
// calling this once per render — and internally it reads ~10 PhenoAge input series,
// each a full dedup scan (#386). Single primitive arg, so cache() collapses the two
// render calls (and their ~10 scans) to one per profile per request.
export const getBioAgeReadings = cache(function getBioAgeReadings(
  profileId: number
): {
  draws: BioAgeDraw[];
  presentInputs: string[];
} {
  // Load only the nine PhenoAge input series (profile-scoped), reduced to exact
  // numeric readings, and note which inputs the profile has at all.
  const seriesByCanonical = new Map<string, ComponentReading[]>();
  const present = new Set<string>();
  for (const canonical of PHENOAGE_INPUT_NAMES) {
    const rows = getBiomarkerSeries(profileId, canonical)
      .filter((r) => r.value_num != null)
      .map((r) => ({
        date: r.date,
        value: r.value_num as number,
        unit: r.unit,
      }));
    seriesByCanonical.set(canonical, rows);
    if (rows.length > 0) present.add(canonical);
  }

  // A lab that reports PhenoAge directly wins its draw (parity with the derived
  // table): skip those dates so a computed value never shadows a stored one.
  const storedDates = new Set(
    getBiomarkerSeries(profileId, "PhenoAge").map((r) => r.date)
  );
  const storedDatesByName: Partial<Record<DerivedName, Set<string>>> =
    storedDates.size ? { PhenoAge: storedDates } : {};

  const readings = computeDerivedReadings(
    seriesByCanonical,
    {
      sex: getUserSex(profileId),
      ageOn: (date) => getUserAgeOn(profileId, date),
    },
    { storedDatesByName }
  );

  const draws: BioAgeDraw[] = readings
    .filter((r) => r.name === "PhenoAge")
    .map((r) => ({
      date: r.date,
      bioAge: r.value,
      chronoAge: getUserAgeOn(profileId, r.date),
      inputs: r.inputs,
    }));

  const presentInputs = PHENOAGE_INPUT_NAMES.filter((n) => present.has(n));
  return { draws, presentInputs };
});

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
  getBiomarkerSeriesFor,
  getCanonicalBiomarker,
  getUsedCanonicalNames,
} from "./medical";
import { canonicalGroupKey, groupByCanonicalName } from "../biomarker-group";
import { canonicalResolver } from "../canonical-resolve";
import { cache } from "../request-cache";
import {
  getUserSex,
  getUserAgeOn,
  getUserReproductiveStatus,
} from "../settings";
import { reconciledFlag, plottableReadingValue } from "../reference-range";
import {
  computeDerivedReadings,
  derivedInputCanonicalNames,
  derivedInputSlots,
  DERIVED_NAMES,
  type ComponentReading,
  type DerivedName,
  type DerivedReading,
} from "../derived-biomarkers";
import { PHENOAGE_INPUT_NAMES } from "../bio-age";
import type { MedicalRecord } from "../types";

// The numeric an arithmetic index can consume from a stored reading, WITH its
// censoring marker: the exact value_num when present, else the DETECTION LIMIT of a
// bounded below/above-detection reading ("<0.2" → 0.2 with bound "<", ">10" → 10 with
// bound ">") — the standard left-censored-lab substitution, and the same rule the
// charts already follow (plottableReadingValue). Without it an undetectable hs-CRP
// (the good, low-inflammation case) carries no value_num and silently drops the WHOLE
// PhenoAge draw, even though every other input is present; the same fate awaits any
// censored derived-index component. Null for a purely qualitative reading (nothing
// usable).
//
// The `bound` is carried, not dropped: the convention is substitute the limit, KEEP
// the marker, show it. A chart can say it with a hollow dot; a single derived number
// can only say it by carrying the marker through to the reading (#2334), so the
// deriver marks the result and names the input it rests on.
function componentNumeric(r: {
  value_num: number | null;
  value: string | null;
}): { value: number; bound?: "<" | ">" } | null {
  const p = plottableReadingValue(r.value_num, r.value);
  return p ? { value: p.value, bound: p.bound } : null;
}

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
// The SINGLE derived-index computation for a profile (#221 — one question, one
// computation). Both consumers — the derived-table readings AND the bio-age hero —
// go through here, so they can never disagree about a PhenoAge (or any derived)
// value: same resolved-and-grouped component series, same computeDerivedReadings
// call. cache()'d, so the ~O(N log N) grouped scan + the compute run at most ONCE
// per profile per request no matter how many surfaces read it.
//
// Alias-aware, like the flag path: a component's derived INPUT is declared under the
// canonical spelling ("Mean Corpuscular Volume (MCV)"), but a stored row may still
// carry a legacy/abbreviation name ("MCV", pre-migration-103). Each row's
// canonical_name is snapped through the shared resolver before grouping so it lands
// in the group the input spec keys on — else a component would be silently missed.
const getDerivedComputation = cache(function getDerivedComputation(
  profileId: number
): {
  readings: DerivedReading[];
  // The input canonical names the profile has ≥1 usable numeric reading of.
  presentInputs: Set<string>;
  sex: ReturnType<typeof getUserSex>;
  status: ReturnType<typeof getUserReproductiveStatus>;
} {
  const resolve = canonicalResolver();
  const grouped = groupByCanonicalName(
    getAllBiomarkerSeries(profileId).map((r) => ({
      ...r,
      canonical_name:
        r.canonical_name != null ? resolve(r.canonical_name) : r.canonical_name,
    }))
  );

  // Load each component series once, reduced to the numerics an arithmetic index can
  // consume (a censored reading contributes its limit plus the marker; a purely
  // qualitative one contributes nothing). Keyed by the exact canonical name — one
  // entry per ACCEPTED spelling, since computeDerivedReadings looks each up by name.
  const seriesByCanonical = new Map<string, ComponentReading[]>();
  for (const canonical of derivedInputCanonicalNames()) {
    const rows = (grouped.get(canonicalGroupKey(canonical)) ?? [])
      .map((r) => ({ r, v: componentNumeric(r) }))
      .filter(
        (
          x
        ): x is { r: MedicalRecord; v: { value: number; bound?: "<" | ">" } } =>
          x.v != null
      )
      .map(({ r, v }) => ({
        date: r.date,
        value: v.value,
        unit: r.unit,
        ...(v.bound ? { bound: v.bound } : {}),
      }));
    seriesByCanonical.set(canonical, rows);
  }

  // An input SLOT is present when ANY name it accepts has a usable reading — the
  // completeness checklist asks for one glucose, not one per spelling.
  const presentInputs = new Set<string>();
  for (const slot of derivedInputSlots()) {
    if (slot.accepts.some((n) => (seriesByCanonical.get(n) ?? []).length > 0))
      presentInputs.add(slot.key);
  }

  // Dates already covered by a stored reading of each derived analyte — skip them
  // (a lab reporting the index directly wins its draw over a computed one).
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
  return { readings, presentInputs, sex, status };
});

export function getDerivedBiomarkerReadings(
  profileId: number
): MedicalRecord[] {
  const { readings, sex, status } = getDerivedComputation(profileId);

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
  return getBiomarkerSeriesWithDerivedFor(profileId, [canonical]).get(
    canonical
  )!;
}

// getBiomarkerSeriesWithDerived for SEVERAL analytes in ONE pass (#1961), keyed by
// the exact requested name. The single-analyte function above is now a one-element
// call of this one, so the batched and unbatched answers are the same code, not two
// implementations that agree today.
//
// Two reads are hoisted out of the per-analyte loop: the stored series (one
// getBiomarkerSeriesFor query for the whole batch instead of one per analyte) and
// the derived computation (one grouped pass shared by every requested analyte —
// getDerivedComputation's cache() is inert outside a server request, so the sidecar
// scripts and the DB test tier were re-running it per analyte).
//
// The derived pass is still SKIPPED entirely unless some requested name is a derived
// index, matching getDerivedBiomarkerSeriesFor's early return: a batch of ordinary
// stored analytes must not start paying for a computation it never asked for.
export function getBiomarkerSeriesWithDerivedFor(
  profileId: number,
  canonicals: readonly string[]
): Map<string, MedicalRecord[]> {
  const names = [...new Set(canonicals)];
  const stored = getBiomarkerSeriesFor(profileId, names);
  const wantsDerived = names.some((n) =>
    (DERIVED_NAMES as readonly string[]).includes(n)
  );
  const derivedAll = wantsDerived ? getDerivedBiomarkerReadings(profileId) : [];

  const out = new Map<string, MedicalRecord[]>();
  for (const name of names) {
    const rows = stored.get(name) ?? [];
    const derived = derivedAll.filter((r) => r.name === name);
    out.set(
      name,
      derived.length === 0
        ? rows
        : [...rows, ...derived].sort((a, b) =>
            a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id
          )
    );
  }
  return out;
}

// One complete PhenoAge draw, shaped for the biological-age hero (issue #209): the
// estimated biological age, the chronological age on that draw date, and the nine
// canonical-unit inputs it was built from (each linking to its own series).
export interface BioAgeDraw {
  date: string;
  bioAge: number;
  chronoAge: number | null;
  // The nine canonical-unit inputs. `name` is the canonical entry the value actually
  // came from (which glucose spelling the draw carried), and `bound` marks a value
  // substituted at a detection limit.
  inputs: { name: string; value: number; unit: string; bound?: "<" | ">" }[];
  // Set when the draw rests on ≥1 censored input — the hero says so and names it,
  // because the headline number itself cannot show a "<".
  censored?: DerivedReading["censored"];
}

// The biological-age (PhenoAge) reading data for a profile: every complete draw
// (oldest-first) plus WHICH of the nine inputs the profile has any usable reading of
// — the latter drives the partial-panel checklist CTA when no draw is complete. This
// is the DB seam over the pure lib/bio-age + lib/derived-biomarkers math; nothing is
// written, and every read goes through an already profile-scoped query, so the
// profile-scoping guard is unaffected.
// The hero reads the SAME getDerivedComputation the derived table does (#221), so
// the two PhenoAge numbers can never diverge, and the shared cache() collapses the
// heavy grouped scan + compute across every surface that reads either.
export function getBioAgeReadings(profileId: number): {
  draws: BioAgeDraw[];
  presentInputs: string[];
} {
  const { readings, presentInputs } = getDerivedComputation(profileId);
  const draws: BioAgeDraw[] = readings
    .filter((r) => r.name === "PhenoAge")
    .map((r) => ({
      date: r.date,
      bioAge: r.value,
      chronoAge: getUserAgeOn(profileId, r.date),
      inputs: r.inputs,
      ...(r.censored ? { censored: r.censored } : {}),
    }));
  // The nine PhenoAge inputs the profile has any usable reading of (drives the
  // partial-panel checklist CTA) — filtered from the shared present-input set.
  return {
    draws,
    presentInputs: PHENOAGE_INPUT_NAMES.filter((n) => presentInputs.has(n)),
  };
}

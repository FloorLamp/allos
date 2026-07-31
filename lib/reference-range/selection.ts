import type {
  AgeBandedRange,
  BiomarkerDirection,
  CanonicalBiomarker,
  CyclePhaseRanges,
  MedicalFlag,
  ReproductiveStatus,
  ReproductiveStatusRange,
  ReproductiveStatusRanges,
  Sex,
} from "../types";
import type { CyclePhase } from "../cycle";
import { convertToCanonical } from "../unit-conversions";
import { qualitativeClassForLoinc } from "../biomarker-loinc";

// The identity of the age band a range came from, returned by referenceRange /
// optimalBand for labeling ("range for age 6–12"). Null when the adult (top-level)
// fields were used. Half-open [min_age, max_age) — see AgeBandedRange.
export interface AgeBandLabel {
  min_age: number;
  max_age: number | null;
}

// Optional carrier for the age-banded overrides. Kept as `unknown` because it
// arrives either already parsed (typed rows) or as JSON text (a raw SELECT), and
// selectAgeBand coerces both — callers never hand-shape it.
type AgeBandCarrier = { ranges_by_age?: unknown };

// Optional carrier for the reproductive-status overrides. `unknown` for the same
// reason as AgeBandCarrier — the value is a parsed object (typed rows) or JSON text
// (a raw SELECT), and selectStatusRange coerces both.
type StatusCarrier = { ranges_by_status?: unknown };

// Optional carrier for the cycle-phase overrides (issue #718). Same `unknown` reason
// as StatusCarrier — a parsed object (typed rows) or JSON text (raw SELECT), coerced
// by selectCyclePhaseRange.
type CyclePhaseCarrier = { ranges_by_cycle_phase?: unknown };

// The fields needed to resolve a biomarker's optimal band, including the
// sex-specific overrides and the (optional) age-banded overrides.
export type OptimalFields = Pick<
  CanonicalBiomarker,
  | "optimal_low"
  | "optimal_high"
  | "optimal_low_male"
  | "optimal_high_male"
  | "optimal_low_female"
  | "optimal_high_female"
> &
  AgeBandCarrier;

// The fields needed to resolve a biomarker's reference range. The generic
// ref_low/high are always present; the sex-specific overrides are optional so
// callers with a partial shape (e.g. tests) still type-check.
export type ReferenceFields = Pick<CanonicalBiomarker, "ref_low" | "ref_high"> &
  Partial<
    Pick<
      CanonicalBiomarker,
      "ref_low_male" | "ref_high_male" | "ref_low_female" | "ref_high_female"
    >
  > &
  AgeBandCarrier &
  StatusCarrier &
  CyclePhaseCarrier;

// Coerce the ranges_by_age field to an array. It arrives already parsed (typed
// CanonicalBiomarker rows) or, straight from a raw SQLite SELECT, as a JSON string
// (the column stores JSON text). Anything unrecognized → null, so callers simply
// fall back to the adult fields.
function coerceAgeBands(v: unknown): AgeBandedRange[] | null {
  if (v == null) return null;
  let arr: unknown = v;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    try {
      arr = JSON.parse(s);
    } catch {
      return null;
    }
  }
  return Array.isArray(arr) ? (arr as AgeBandedRange[]) : null;
}

// Select the age band matching `age` (whole years) from a biomarker's
// ranges_by_age. Bands are half-open [min_age, max_age); max_age null is
// open-ended at the top. Returns null when there are no bands, no age, or no band
// matches — the caller then falls back to the adult top-level fields. Pure and
// order-independent as long as bands don't overlap (the first match wins).
export function selectAgeBand(
  ranges: unknown,
  age: number | null | undefined
): AgeBandedRange | null {
  if (age == null) return null;
  const bands = coerceAgeBands(ranges);
  if (!bands) return null;
  for (const b of bands) {
    if (!b || typeof b.min_age !== "number") continue;
    if (age >= b.min_age && (b.max_age == null || age < b.max_age)) return b;
  }
  return null;
}

// Coerce the ranges_by_status field to a status→range map. It arrives already
// parsed (typed CanonicalBiomarker rows) or, from a raw SQLite SELECT, as a JSON
// string. Anything that isn't a plain object → null, so callers fall back to the
// age band / adult fields.
function coerceStatusRanges(v: unknown): ReproductiveStatusRanges | null {
  if (v == null) return null;
  let obj: unknown = v;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
  }
  return obj && typeof obj === "object" && !Array.isArray(obj)
    ? (obj as ReproductiveStatusRanges)
    : null;
}

// The reproductive-status reference override for a subject, or null. FEMALE
// physiology ONLY — for male or unset sex this returns null, so a male profile's
// ranges are never touched by the status. Resolves only when the status is set AND
// the analyte carries a range for it. This is the HIGHEST-precedence axis in
// referenceRange (above the age band): an explicit menopausal status is a stronger
// signal than the age-51 proxy. Status is a CURRENT profile attribute (no
// per-record history), so it applies to all of that profile's hormone records —
// the same simplification as the stored-age fallback.
export function selectStatusRange(
  ranges: unknown,
  sex: Sex | null | undefined,
  status: ReproductiveStatus | null | undefined
): ReproductiveStatusRange | null {
  if (sex !== "female" || !status) return null;
  const map = coerceStatusRanges(ranges);
  if (!map) return null;
  const r = map[status];
  return r && typeof r === "object" ? r : null;
}

// Coerce the ranges_by_cycle_phase field to a phase→range map. Same shape/handling as
// coerceStatusRanges (parsed object OR raw JSON string) — null on anything else.
function coerceCyclePhaseRanges(v: unknown): CyclePhaseRanges | null {
  if (v == null) return null;
  let obj: unknown = v;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
  }
  return obj && typeof obj === "object" && !Array.isArray(obj)
    ? (obj as CyclePhaseRanges)
    : null;
}

// Map the DERIVED cycle phase (menstrual/follicular/luteal — lib/cycle) onto the
// hormone-range key (issue #718). The derived model is deliberately NON-PREDICTIVE:
// there is NO distinct "ovulatory" phase, so the ~1–2-day ovulatory window — and its
// mid-cycle hormone SURGE (the LH surge, the estradiol peak, the FSH bump) — falls
// INSIDE the derived follicular span. Two consequences, both encoded here:
//   • a MENSTRUAL date reads the follicular range — menses IS early follicular, when
//     these hormones sit at their follicular baseline;
//   • a follicular date reads the follicular range, which the curated data defines as
//     a follicular→ovulatory ENVELOPE (open low, ceiling = the mid-cycle peak) so the
//     physiological surge is never false-flagged "high". The trade — a genuinely-high
//     isolated follicular value near the envelope ceiling won't flag — is accepted, the
//     same "false positive is worse than a missed catch" stance the coarse envelopes
//     already take; the distinctive gain is the LUTEAL range (progesterone especially).
// Only luteal maps to the luteal range — the one phase the derivation resolves
// unambiguously (retrospectively, from the following period).
type CyclePhaseRangeKey = "follicular" | "luteal";

function cyclePhaseRangeKey(phase: CyclePhase): CyclePhaseRangeKey {
  return phase === "luteal" ? "luteal" : "follicular";
}

// The cycle-phase reference override for a subject on a collection date, or null.
// FEMALE physiology ONLY (like selectStatusRange) — a male/unset sex never resolves.
// Resolves only when a phase is supplied (the gather layer derived it from the logged
// cycle history for the record's date) AND the analyte carries a range for that phase.
// This is the HIGHEST-precedence axis in referenceRange (above the coarse
// reproductive-status proxy): a logged period covering the collection date is DIRECT
// evidence of which phase the subject was in, strictly more specific than the
// menopausal-status or age proxy. When no phase is supplied (no cycle data covers the
// date) this returns null and referenceRange falls back to the existing behavior.
export function selectCyclePhaseRange(
  ranges: unknown,
  sex: Sex | null | undefined,
  phase: CyclePhase | null | undefined
): ReproductiveStatusRange | null {
  if (sex !== "female" || !phase) return null;
  const map = coerceCyclePhaseRanges(ranges);
  if (!map) return null;
  const r = map[cyclePhaseRangeKey(phase)];
  return r && typeof r === "object" ? r : null;
}

// A human label for which band applied, e.g. "age 6–12", "age <2", "age 65+".
// Null for the adult band (no label needed). Given the half-open [min, max)
// convention, "age 6–12" covers ages 6 through 11.
export function ageBandLabel(
  band: AgeBandLabel | null | undefined
): string | null {
  if (!band) return null;
  const { min_age, max_age } = band;
  if (max_age == null) return `age ${min_age}+`;
  if (min_age <= 0) return `age <${max_age}`;
  return `age ${min_age}–${max_age}`;
}

// Resolve a biomarker's effective reference range for a given sex, age, and (for
// female physiology) reproductive status, mirroring optimalBand. Precedence:
// explicit reproductive-status range (only when sex is female and the entry has
// one) → age band → sex-adult → adult. The status range REPLACES everything else;
// otherwise, when an age band matches (see selectAgeBand) its fields replace the
// adult top-level fields, then the sex-specific override within that band (or the
// adult fields) wins when present for the sex, else the generic ref_low/high
// applies. When status is unset the behavior is UNCHANGED (the age-proxy fallback,
// e.g. the FSH 51+ band). `bySex` reports whether a sex-specific override was used;
// `band` names the age band (null = adult fields or a status range).
export function referenceRange(
  cb: ReferenceFields | null | undefined,
  sex?: Sex | null,
  age?: number | null,
  status?: ReproductiveStatus | null,
  cyclePhase?: CyclePhase | null
): {
  low: number | null;
  high: number | null;
  bySex: boolean;
  band: AgeBandLabel | null;
} {
  if (!cb) return { low: null, high: null, bySex: false, band: null };
  // Cycle phase is the HIGHEST-precedence axis (female physiology only) — above the
  // coarse reproductive-status proxy AND the age band (issue #718) — because a logged
  // period covering the collection date is direct evidence of the actual phase, so a
  // mid-luteal progesterone reads its luteal range instead of false-flagging "high"
  // against the follicular/coarse range. Null cyclePhase (no cycle data covers the
  // date) → this is skipped and the behavior below is byte-identical to before.
  const phaseRange = selectCyclePhaseRange(
    cb.ranges_by_cycle_phase,
    sex,
    cyclePhase
  );
  if (phaseRange)
    return {
      low: phaseRange.ref_low ?? null,
      high: phaseRange.ref_high ?? null,
      bySex: true,
      band: null,
    };
  // Reproductive status is the next axis (female physiology only) — above the age
  // band — so a genuinely post-menopausal high hormone flags.
  const statusRange = selectStatusRange(cb.ranges_by_status, sex, status);
  if (statusRange)
    return {
      low: statusRange.ref_low ?? null,
      high: statusRange.ref_high ?? null,
      bySex: true,
      band: null,
    };
  const ageBand = selectAgeBand(cb.ranges_by_age, age);
  const src = ageBand ?? cb;
  const band: AgeBandLabel | null = ageBand
    ? { min_age: ageBand.min_age, max_age: ageBand.max_age }
    : null;
  if (sex === "male" && (src.ref_low_male != null || src.ref_high_male != null))
    return {
      low: src.ref_low_male ?? null,
      high: src.ref_high_male ?? null,
      bySex: true,
      band,
    };
  if (
    sex === "female" &&
    (src.ref_low_female != null || src.ref_high_female != null)
  )
    return {
      low: src.ref_low_female ?? null,
      high: src.ref_high_female ?? null,
      bySex: true,
      band,
    };
  return {
    low: src.ref_low ?? null,
    high: src.ref_high ?? null,
    bySex: false,
    band,
  };
}

// Resolve a biomarker's effective optimal band for a given sex and age. Age band
// (when it matches) replaces the adult fields, then the sex-specific override
// within it wins when present for that sex; otherwise the generic optimal_low/high
// applies (also the fallback when sex is unknown). `bySex` reports whether a
// sex-specific override was used; `band` names the age band (null = adult fields).
export function optimalBand(
  cb: OptimalFields | null | undefined,
  sex?: Sex | null,
  age?: number | null
): {
  low: number | null;
  high: number | null;
  bySex: boolean;
  band: AgeBandLabel | null;
} {
  if (!cb) return { low: null, high: null, bySex: false, band: null };
  const ageBand = selectAgeBand(cb.ranges_by_age, age);
  const src = ageBand ?? cb;
  const band: AgeBandLabel | null = ageBand
    ? { min_age: ageBand.min_age, max_age: ageBand.max_age }
    : null;
  if (
    sex === "male" &&
    (src.optimal_low_male != null || src.optimal_high_male != null)
  )
    return {
      low: src.optimal_low_male ?? null,
      high: src.optimal_high_male ?? null,
      bySex: true,
      band,
    };
  if (
    sex === "female" &&
    (src.optimal_low_female != null || src.optimal_high_female != null)
  )
    return {
      low: src.optimal_low_female ?? null,
      high: src.optimal_high_female ?? null,
      bySex: true,
      band,
    };
  return {
    low: src.optimal_low ?? null,
    high: src.optimal_high ?? null,
    bySex: false,
    band,
  };
}

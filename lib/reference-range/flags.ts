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
import {
  optimalBand,
  referenceRange,
  type OptimalFields,
  type ReferenceFields,
} from "./selection";
import {
  optimalStatus,
  parseReferenceRange,
  referenceStatus,
  type CanonicalRanges,
} from "./parsing";
// ---------------------------------------------------------------------------
// Unit-mislabel plausibility cross-check (issue #761). A lab report that
// MISLABELS a unit — the string parses cleanly but is factually wrong (MCHC "33
// g/L" that is really g/dL) — converts faithfully into a confident, spuriously-
// extreme flag (3.3 g/dL → "low"). This is the parse-but-WRONG sibling of #759
// (parse failures). The single unused signal that catches it is the report's own
// STATED reference range: a correctly-labeled lab's printed range roughly agrees
// with our canonical range; a clean power-of-ten disagreement is the fingerprint
// of a mislabeled unit. Pure, parse-on-read — no schema change.
// ---------------------------------------------------------------------------

export interface UnitMislabel {
  // The power-of-ten factor the reading is off by (10 / 100 / 1000), i.e. the
  // canonical range is `factor`× the stated range as-converted by the stated unit.
  factor: number;
  // The proposed correction: the reading's own numeric value, relabeled to the
  // canonical unit (the dominant real-world target — "33 g/L" → "33 g/dL").
  corrected: { unit: string; value: number };
}

// Each shared bound's ratio (canonical ÷ stated-as-converted) must round to the
// SAME power of ten within this log-tolerance. ±0.10 in log10 ≈ ±26% — generous
// for real cohort-range noise around a true 10×, yet tight enough to REJECT a
// non-decimal disagreement (a 5×/7× cohort difference is not a clean power of ten
// and yields no signal, per the conservative "false positive is worse than a
// missed catch" discipline).
const POWER_OF_TEN_LOG_TOL = 0.1;

// Classify a single ratio as a clean power-of-ten factor (10 / 100 / 1000 or their
// reciprocals), or null when it is ~1 (no mismatch), beyond 1000×, or a messy
// non-decimal near-miss. The tolerance keeps genuinely-different cohort ranges
// (off by a fraction, not a decade) from reading as a mislabel.
function powerOfTenFactor(ratio: number): number | null {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return null;
  const l = Math.log10(ratio);
  const k = Math.round(l);
  if (k === 0 || Math.abs(k) > 3) return null; // ~1× (agreement) or beyond 1000×
  if (Math.abs(l - k) > POWER_OF_TEN_LOG_TOL) return null; // messy near-miss
  return Math.pow(10, k);
}

// The single power-of-ten factor every ratio agrees on, or null when the list is
// empty, any ratio is not a clean power of ten, or the ratios disagree on the
// decade (a mixed/near-miss disagreement — no signal).
function cleanPowerOfTen(ratios: number[]): number | null {
  if (ratios.length === 0) return null;
  let f: number | null = null;
  for (const r of ratios) {
    const p = powerOfTenFactor(r);
    if (p == null) return null;
    if (f == null) f = p;
    else if (f !== p) return null;
  }
  return f;
}

// Detect a probable power-of-ten unit MISLABEL for one numeric reading, off the
// report's stated reference range (issue #761). Returns the proposed correction, or
// null when there is no clean evidence. Conservative and evidence-gated — it fires
// ONLY when ALL hold:
//   1. the reading has a stated unit + a parseable stated range, and the canonical
//      entry has a unit + a resolved reference range (else: no signal);
//   2. the stated range, converted BY THE STATED UNIT into canonical space, is off
//      from the canonical range by a CLEAN power of ten on every shared bound
//      (a messy/non-decimal disagreement could be a different lab's cohort → null);
//   3. the value, as-labeled by the stated unit, is currently OUT of the canonical
//      range (there is an actual false flag to prevent);
//   4. the value, relabeled to the canonical unit, lands back IN range (the
//      correction is corroborated by the reading itself);
//   5. the value's own scale jump (canonical ÷ stated) is the SAME power of ten as
//      the range's — the two independent signals agree.
// Only the canonical unit is proposed as the correction target (the dominant case:
// the report's numbers are right, the label is a decade-off sibling of the
// canonical unit); a true unit that is itself non-canonical is left as no-signal.
export function detectUnitMislabel(
  reference: string | null | undefined,
  unit: string | null | undefined,
  valueNum: number | null | undefined,
  cb: CanonicalRanges | null | undefined,
  sex?: Sex | null,
  age?: number | null,
  status?: ReproductiveStatus | null,
  cyclePhase?: CyclePhase | null
): UnitMislabel | null {
  const canonUnit = cb?.unit ?? null;
  if (!canonUnit || !unit || valueNum == null) return null;

  const parsed = parseReferenceRange(reference);
  if (!parsed || (parsed.low == null && parsed.high == null)) return null;

  const rr = referenceRange(cb, sex, age, status, cyclePhase);
  if (rr.low == null && rr.high == null) return null;

  // The value + stated range bounds, converted by the STATED (suspect) unit.
  const vStated = convertToCanonical(valueNum, unit, cb);
  if (vStated == null || vStated === 0) return null;
  const sLow =
    parsed.low != null ? convertToCanonical(parsed.low, unit, cb) : null;
  const sHigh =
    parsed.high != null ? convertToCanonical(parsed.high, unit, cb) : null;

  // Range evidence: canonical ÷ stated-as-converted, per shared bound.
  const ratios: number[] = [];
  if (sLow != null && sLow !== 0 && rr.low != null) ratios.push(rr.low / sLow);
  if (sHigh != null && sHigh !== 0 && rr.high != null)
    ratios.push(rr.high / sHigh);
  const factor = cleanPowerOfTen(ratios);
  if (factor == null) return null;

  // The as-labeled value must be OUT of range (a real false flag), and the value
  // relabeled to the canonical unit must land IN range (correction corroborated).
  if (referenceStatus(vStated, rr.low, rr.high) === "in") return null;
  const vCanon = convertToCanonical(valueNum, canonUnit, cb);
  if (vCanon == null) return null;
  // Corroborate against the canonical range OR the report's OWN stated range (its
  // numbers ARE in the corrected/canonical unit once we believe the label is wrong
  // by `factor`). The report's range is the actual evidence here, and a lab's cited
  // range is often wider than our tight canonical band — so a value normal-per-report
  // but a hair outside the canonical range (e.g. MCHC 35.8 vs canonical 35.4, stated
  // 31–37) must still corroborate, or the detector misses its own motivating case
  // (#761 / found in a real export). Both gates already sit behind the clean ×10
  // range mismatch above, so this only widens a signal that's already evidence-gated.
  const inCanonical = referenceStatus(vCanon, rr.low, rr.high) === "in";
  const inStated = referenceStatus(vCanon, parsed.low, parsed.high) === "in";
  if (!inCanonical && !inStated) return null;

  // The value's own scale jump must be the SAME clean power of ten as the range's.
  if (vStated === 0) return null;
  if (cleanPowerOfTen([vCanon / vStated]) !== factor) return null;

  return { factor, corrected: { unit: canonUnit, value: valueNum } };
}

export function reconciledFlag(
  currentFlag: MedicalFlag | string | null | undefined,
  valueNum: number | null | undefined,
  unit: string | null | undefined,
  cb: CanonicalRanges | null | undefined,
  sex?: Sex | null,
  age?: number | null,
  status?: ReproductiveStatus | null,
  // The reading's stored free-text reference range (issue #761). When it reveals a
  // probable power-of-ten unit mislabel, reconciledFlag declines to DERIVE an
  // out-of-range flag from the faithfully-converted-but-wrong value — the same
  // "can't validate → don't assert" stance it takes when convertToCanonical returns
  // null — so the alarming false flag never shows, even before any user correction.
  reference?: string | null,
  // The subject's cycle phase on the record's collection date (issue #718), derived
  // by the gather layer from the logged cycle history. When set (and the analyte
  // carries phase ranges), referenceRange picks the phase-specific range. Null (no
  // cycle data covers the date) → unchanged behavior.
  cyclePhase?: CyclePhase | null
): MedicalFlag | null | undefined {
  const f = currentFlag ?? null;
  if (f === "abnormal") return undefined;
  if (valueNum == null || !cb) return undefined;
  const v = convertToCanonical(valueNum, unit, cb);
  if (v == null) return undefined; // can't convert to the canonical unit — can't judge

  // A probable unit mislabel (#761): the converted value is faithful but the unit
  // is wrong, so any flag derived from it would be a fabricated abnormality. Leave
  // the stored flag unchanged (don't assert) until the user approves the fix.
  if (
    detectUnitMislabel(
      reference,
      unit,
      valueNum,
      cb,
      sex,
      age,
      status,
      cyclePhase
    )
  )
    return undefined;

  const rr = referenceRange(cb, sex, age, status, cyclePhase);
  const ref = referenceStatus(v, rr.low, rr.high);
  if (ref === "above" || ref === "below") {
    const target = ref === "above" ? "high" : "low";
    return f === target ? undefined : target;
  }
  if (ref === "in") {
    const opt = optimalStatus(v, cb, sex, age);
    if (opt === "above" || opt === "below") {
      const target = opt === "above" ? "non-optimal-high" : "non-optimal-low";
      return f === target ? undefined : target;
    }
    // Optimal (or no optimal band): should carry no derived flag.
    return f === null || f === "normal" ? undefined : null;
  }

  // ref "unknown" — no reference bounds. Don't override a lab clinical flag we
  // can't validate; otherwise derive non-optimal from the optimal band.
  if (f === "high" || f === "low") return undefined;
  const opt = optimalStatus(v, cb, sex, age);
  if (opt === "above" || opt === "below") {
    const target = opt === "above" ? "non-optimal-high" : "non-optimal-low";
    return f === target ? undefined : target;
  }
  if (opt === "optimal") return isNonOptimal(f) ? null : undefined;
  return undefined;
}

// Any of the non-optimal flag variants (directionless legacy + directional).
// The stored flag drives both the amber color and the arrow, so display code
// checks this rather than a bare string equality.
export function isNonOptimal(flag: string | null | undefined): boolean {
  return (
    flag === "non-optimal" ||
    flag === "non-optimal-high" ||
    flag === "non-optimal-low"
  );
}

// ---------------------------------------------------------------------------
// Canonical flag classification (issue #306). A stored biomarker flag partitions
// into three display tiers — out-of-range (clinical, red/"bad"), non-optimal
// (amber/"warn"), and everything else (neutral/"default"). This predicate + the
// label + the tone below are the ONE source of truth; every surface (dashboard
// hero, Recent-labs widget, timeline, biomarker cells, attention strip,
// supplement suggestions) routes through them instead of re-deriving the same
// three-way split by hand. Re-tiering a flag (or adding one) is a single edit here.
// ---------------------------------------------------------------------------

// The out-of-range (clinical) predicate: a lab flagged the value outside its
// standard reference range in either direction, or qualitatively abnormal. This
// is the red/"bad" tier — distinct from isNonOptimal, which is inside the
// reference range but outside our tighter optimal band (amber/"warn").
export function isOutOfRange(flag: string | null | undefined): boolean {
  return flag === "high" || flag === "low" || flag === "abnormal";
}

// Whether a flag reads as "Normal" — null/empty or any value the label/tone layer
// treats as unflagged (i.e. NOT one of the recognized non-normal flags). The inverse
// of "already-flagged", so a qualitative bad-polarity resolution (#629) only promotes
// a row that would otherwise display "Normal", never one the extractor already flagged
// (out-of-range, non-optimal, or immune).
export function isNormalFlag(flag: string | null | undefined): boolean {
  return !(isOutOfRange(flag) || isNonOptimal(flag) || flag === "immune");
}

// The shared color tier for a flag. Out-of-range takes precedence over
// non-optimal; anything unrecognized/normal/null is neutral. Components map this
// tone onto their own Tailwind classes (the class strings stay local; the tier
// decision is shared). A subset of TimelineEvent["tone"], so it slots into
// timeline events directly.
export type FlagTone = "bad" | "warn" | "default";

export function flagTone(flag: string | null | undefined): FlagTone {
  if (isOutOfRange(flag)) return "bad";
  if (isNonOptimal(flag)) return "warn";
  return "default";
}

// The single human label for a flag. Every recognized MedicalFlag maps here; the
// one deliberate fallback for an unrecognized / normal / null flag is "Normal"
// (its tone is "default" — we never label a value we didn't actually flag as
// "Non-optimal"). This replaces the two drifted flagLabel copies whose catch-alls
// disagreed ("Non-optimal" vs "Normal"); "Normal" is the tone-consistent choice.
export function flagLabel(flag: string | null | undefined): string {
  switch (flag) {
    case "high":
      return "High";
    case "low":
      return "Low";
    case "abnormal":
      return "Abnormal";
    case "immune":
      return "Immune";
    case "non-optimal-high":
      return "Above optimal";
    case "non-optimal-low":
      return "Below optimal";
    case "non-optimal":
      return "Non-optimal";
    default:
      return "Normal";
  }
}

// Full status of a value for a badge: out of range (red) takes precedence over
// non-optimal (amber), which takes precedence over optimal (green). Pass a value
// already converted to the canonical unit.
export type RangeBadge =
  "optimal" | "above-optimal" | "below-optimal" | "high" | "low" | "unknown";

export function rangeBadge(
  value: number | null | undefined,
  cb: CanonicalRanges | null | undefined,
  sex?: Sex | null,
  age?: number | null,
  status?: ReproductiveStatus | null,
  cyclePhase?: CyclePhase | null
): RangeBadge {
  if (value == null || !cb) return "unknown";
  const rr = referenceRange(cb, sex, age, status, cyclePhase);
  const ref = referenceStatus(value, rr.low, rr.high);
  if (ref === "above") return "high";
  if (ref === "below") return "low";
  const opt = optimalStatus(value, cb, sex, age);
  if (opt === "above") return "above-optimal";
  if (opt === "below") return "below-optimal";
  if (opt === "optimal") return "optimal";
  return ref === "in" ? "optimal" : "unknown";
}

export const RANGE_BADGE_META: Record<
  RangeBadge,
  { label: string; chip: string }
> = {
  optimal: {
    label: "Optimal",
    chip: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  },
  "above-optimal": {
    label: "Above optimal",
    chip: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  },
  "below-optimal": {
    label: "Below optimal",
    chip: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  },
  high: {
    label: "Above range",
    chip: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  },
  low: {
    label: "Below range",
    chip: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  },
  unknown: {
    label: "—",
    chip: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  },
};

// The fallback retest cadence: a biomarker with no curated per-analyte interval
// should be retested at least once a year, so a reading older than this is
// "stale". Per-analyte overrides (e.g. HbA1c quarterly, TSH every 6 months) live
// in the canonical dataset's `retest_days` and are selected by retestIntervalDays.
// Genomics results don't change, so they never go stale.

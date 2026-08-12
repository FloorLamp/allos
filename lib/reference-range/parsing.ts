import type {
  AgeBandedRange,
  BiomarkerDirection,
  CanonicalResultDefinition,
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
  type OptimalFields,
  type ReferenceFields,
} from "./selection";
export interface ParsedRange {
  low?: number;
  high?: number;
}

// Best-effort parser for the common lab reference-range string formats:
//   "<200" / "≤200" / "< 200"   → { high: 200 }
//   ">40" / "≥40"               → { low: 40 }
//   "50-180" / "50 – 180"       → { low: 50, high: 180 }
// Returns null when nothing numeric can be extracted (e.g. "NEGATIVE"), so
// callers can simply omit the band.
export function parseReferenceRange(
  s: string | null | undefined
): ParsedRange | null {
  if (!s) return null;
  const str = s.trim();
  if (!str) return null;

  // One-sided: < ≤ > ≥ followed by a number.
  const oneSided = /^([<≤>≥])\s*=?\s*(-?\d+(?:\.\d+)?)/.exec(str);
  if (oneSided) {
    const n = Number(oneSided[2]);
    if (!Number.isFinite(n)) return null;
    return oneSided[1] === "<" || oneSided[1] === "≤"
      ? { high: n }
      : { low: n };
  }

  // Two-sided: "A - B" with a hyphen, en dash, em dash, or "to".
  const twoSided =
    /^(-?\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(-?\d+(?:\.\d+)?)/i.exec(str);
  if (twoSided) {
    const lo = Number(twoSided[1]);
    const hi = Number(twoSided[2]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    return lo <= hi ? { low: lo, high: hi } : { low: hi, high: lo };
  }

  return null;
}

// A value that's inexact but bounded, parsed from a reading string for charting:
//   "<0.10" / "≤0.10" → { value: 0.10, bound: "<" }   (below the limit)
//   ">5"   / "≥40"    → { value: 5,    bound: ">" }    (above the limit)
//   "4.2"             → { value: 4.2 }                 (exact)
// Anchored so embedded/qualitative strings ("1:160", "Pattern A", "12 mg/dL")
// don't parse. Used to plot censored lab values at their detection limit.
export interface LooseValue {
  value: number;
  bound?: "<" | ">";
}

export function parseLooseValue(
  s: string | null | undefined
): LooseValue | null {
  if (!s) return null;
  const str = s.trim();
  const bounded = /^([<≤>≥])\s*=?\s*(-?\d+(?:\.\d+)?)$/.exec(str);
  if (bounded) {
    const n = Number(bounded[2]);
    if (!Number.isFinite(n)) return null;
    return {
      value: n,
      bound: bounded[1] === "<" || bounded[1] === "≤" ? "<" : ">",
    };
  }
  const plain = /^-?\d+(?:\.\d+)?$/.exec(str);
  if (plain) return { value: Number(str) };
  return null;
}

// A numeric recovered from a value string parseLooseValue deliberately rejects —
// the whole-string anchor there is the strict "numeric intent" contract other
// callers rely on, so this is a SEPARATE, chart-only recovery (issue #542):
//   "58 mIU/mL"  → { value: 58 }              (extraction left the unit embedded)
//   "12.3 mg/dL" → { value: 12.3 }
//   "1:160"      → { value: 160, titer: true } (titer reciprocal — higher = more
//                                               antibody; the plottable magnitude)
// Returns null when there is no leading number ("positive", "Pattern A", "").
export interface LeadingNumeric {
  value: number;
  // Parsed from a "1:N" dilution ratio; `value` is the reciprocal N.
  titer?: boolean;
}

export function parseLeadingNumeric(
  s: string | null | undefined
): LeadingNumeric | null {
  if (!s) return null;
  const str = s.trim();
  if (!str) return null;
  // Titer ratio "1:160" → the reciprocal (160), before the generic leading-number
  // rule (which would otherwise read the leading "1").
  const titer = /^1\s*:\s*(\d+(?:\.\d+)?)$/.exec(str);
  if (titer) {
    const n = Number(titer[1]);
    return Number.isFinite(n) ? { value: n, titer: true } : null;
  }
  // A bare Snellen-style fraction "20/20" / "6/6" (visual acuity, #698) has NO single
  // plottable magnitude — its numerator is a fixed test distance (20 or 6), so
  // recovering the leading "20" would chart every acuity at the same value. Treat it
  // as qualitative (null) so acuity renders as a dated timeline, not a flat, misleading
  // numeric axis. Checked before the leading-number rule, which would otherwise read
  // the numerator. (A genuine ratio analyte is stored pre-divided as one number, never
  // as an "N/M" string, so nothing legitimate parses through here.)
  if (/^\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?$/.test(str)) return null;
  // A leading number FOLLOWED BY a unit/text token. The lookahead keeps the number
  // from being split by backtracking (so a bare "58" — where the only trailing char
  // is another digit — does NOT match and is left to parseLooseValue's strict path).
  const lead = /^(-?\d+(?:\.\d+)?)(?=[^\d.]|\s)\s*\S/.exec(str);
  if (lead) {
    const n = Number(lead[1]);
    return Number.isFinite(n) ? { value: n } : null;
  }
  return null;
}

// The number a reading contributes to a numeric chart — the ONE computation both
// the chart points and the status badge derive from (issue #542): the exact
// value_num, else a bare/bounded numeric string (parseLooseValue), else a leading
// numeric recovered from a unit-suffixed or titer value (parseLeadingNumeric).
// Null → the reading is purely qualitative (nothing to plot).
export interface PlottableValue {
  value: number;
  bound?: "<" | ">";
  titer?: boolean;
}

export function plottableReadingValue(
  valueNum: number | null | undefined,
  value: string | null | undefined
): PlottableValue | null {
  if (valueNum != null && Number.isFinite(valueNum)) return { value: valueNum };
  const loose = parseLooseValue(value);
  if (loose) return { value: loose.value, bound: loose.bound };
  const lead = parseLeadingNumeric(value);
  if (lead) return { value: lead.value, titer: lead.titer };
  return null;
}

export type RangeStatus = "below" | "above" | "in" | "unknown";

// Where a value sits relative to a plain [low, high] range (null bound = open).
// "unknown" when there are no bounds to judge against.
export function referenceStatus(
  value: number,
  low: number | null | undefined,
  high: number | null | undefined
): RangeStatus {
  if (low == null && high == null) return "unknown";
  if (low != null && value < low) return "below";
  if (high != null && value > high) return "above";
  return "in";
}

export type OptimalStatus = "optimal" | "above" | "below" | "unknown";

// Judge a numeric value against a biomarker's optimal band, honoring direction:
//   higher_better → only an optimal_low matters; below it is "below".
//   lower_better  → only an optimal_high matters; above it is "above".
//   in_range      → outside [optimal_low, optimal_high] is below/above.
// Returns "unknown" when there's no optimal bound to judge against.
export function optimalStatus(
  value: number | null | undefined,
  cb:
    | (OptimalFields & Pick<CanonicalResultDefinition, "direction">)
    | null
    | undefined,
  sex?: Sex | null,
  age?: number | null
): OptimalStatus {
  if (value == null || !cb) return "unknown";
  const { low: optimal_low, high: optimal_high } = optimalBand(cb, sex, age);
  const dir: BiomarkerDirection = cb.direction ?? "in_range";

  if (dir === "higher_better") {
    if (optimal_low == null) return "unknown";
    return value >= optimal_low ? "optimal" : "below";
  }
  if (dir === "lower_better") {
    if (optimal_high == null) return "unknown";
    return value <= optimal_high ? "optimal" : "above";
  }
  // in_range
  if (optimal_low == null && optimal_high == null) return "unknown";
  if (optimal_low != null && value < optimal_low) return "below";
  if (optimal_high != null && value > optimal_high) return "above";
  return "optimal";
}

// "non-optimal" is a DERIVED flag: it must always agree with the live optimal
// computation, never contradict it. Given a record's current flag + value, this
// returns the flag the optimal band implies:
//   "non-optimal"  → value is outside the optimal band; set it
//   null           → value is optimal but the row is stale-flagged non-optimal; clear it
//   undefined      → no change (clinical flag present, or status unknowable)
// It never overrides a clinical flag (high/low/abnormal), and only judges when
// the value converts to the canonical unit and an optimal bound exists.
export type CanonicalRanges = Pick<
  CanonicalResultDefinition,
  "name" | "unit" | "direction"
> &
  ReferenceFields &
  OptimalFields;

// The flag our canonical ranges imply for a record, given its current flag:
//   "high"/"low"  → outside our standard REFERENCE range (out of range)
//   "non-optimal" → inside the reference range but outside the OPTIMAL band
//   null          → in the optimal band (clear any derived flag)
//   undefined     → leave the flag unchanged
// Our reference range is authoritative when we have one: it can both RELAX an
// over-strict lab flag (HbA1c 4.9% flagged LOW but in our range → optimal) and
// catch a value the lab didn't flag (Vitamin D 19.8 below our 30 → low). Where
// we have no reference range, we don't override a lab clinical flag, but still
// derive non-optimal from the optimal band. 'abnormal' (qualitative) is left as-is.

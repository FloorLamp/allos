import type {
  AgeBandedRange,
  BiomarkerDirection,
  CanonicalBiomarker,
  MedicalFlag,
  ReproductiveStatus,
  ReproductiveStatusRange,
  ReproductiveStatusRanges,
  Sex,
} from "./types";
import { convertToCanonical } from "./unit-conversions";

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

// The fields needed to resolve a biomarker's optimal band, including the
// sex-specific overrides and the (optional) age-banded overrides.
type OptimalFields = Pick<
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
type ReferenceFields = Pick<CanonicalBiomarker, "ref_low" | "ref_high"> &
  Partial<
    Pick<
      CanonicalBiomarker,
      "ref_low_male" | "ref_high_male" | "ref_low_female" | "ref_high_female"
    >
  > &
  AgeBandCarrier &
  StatusCarrier;

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
  status?: ReproductiveStatus | null
): {
  low: number | null;
  high: number | null;
  bySex: boolean;
  band: AgeBandLabel | null;
} {
  if (!cb) return { low: null, high: null, bySex: false, band: null };
  // Reproductive status is the highest-precedence axis (female physiology only) —
  // above the age band — so a genuinely post-menopausal high hormone flags.
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
    (OptimalFields & Pick<CanonicalBiomarker, "direction">) | null | undefined,
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
type CanonicalRanges = Pick<CanonicalBiomarker, "name" | "unit" | "direction"> &
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
export function reconciledFlag(
  currentFlag: MedicalFlag | string | null | undefined,
  valueNum: number | null | undefined,
  unit: string | null | undefined,
  cb: CanonicalRanges | null | undefined,
  sex?: Sex | null,
  age?: number | null,
  status?: ReproductiveStatus | null
): MedicalFlag | null | undefined {
  const f = currentFlag ?? null;
  if (f === "abnormal") return undefined;
  if (valueNum == null || !cb) return undefined;
  const v = convertToCanonical(valueNum, unit, cb);
  if (v == null) return undefined; // can't convert to the canonical unit — can't judge

  const rr = referenceRange(cb, sex, age, status);
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
  status?: ReproductiveStatus | null
): RangeBadge {
  if (value == null || !cb) return "unknown";
  const rr = referenceRange(cb, sex, age, status);
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
export const STALE_AFTER_DAYS = 365;
// Back-compat alias; the same value read as a default rather than the sole rule.
export const DEFAULT_RETEST_DAYS = STALE_AFTER_DAYS;

// The recommended retest interval (days) for a biomarker: its curated
// `retest_days` when present and positive, else the flat DEFAULT_RETEST_DAYS. Pure
// selection — the caller supplies the analyte's retest_days (from the canonical
// dataset via lib/biomarker-retest); a null/undefined/non-positive value falls
// back so an uncurated analyte behaves exactly as the old flat 365-day rule.
export function retestIntervalDays(
  retestDays: number | null | undefined
): number {
  return retestDays != null && retestDays > 0
    ? retestDays
    : DEFAULT_RETEST_DAYS;
}

// Whole days between two YYYY-MM-DD dates (toISO - fromISO), or 0 if unparseable.
export function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

// Whether a biomarker's latest reading is past its retest window. `retestDays` is
// the analyte's curated cadence (null → the flat DEFAULT_RETEST_DAYS), so e.g. a
// quarterly HbA1c goes stale at 90 days while an uncurated lab still goes stale at
// 365. Genomics never go stale (genetics don't change). Boundary: stale strictly
// AFTER the window (age > interval), matching the original > comparison.
export function isBiomarkerStale(
  latestDate: string | null | undefined,
  category: string | null | undefined,
  today: string,
  retestDays?: number | null
): boolean {
  if (!latestDate) return false;
  if (category === "genomics") return false; // genetics don't change
  return daysBetween(latestDate, today) > retestIntervalDays(retestDays);
}

// Approximate, human-friendly age for a span of days ("8 months", "1.4 years").
export function humanizeAge(days: number): string {
  if (days < 45) return `${days} day${days === 1 ? "" : "s"}`;
  const months = Math.round(days / 30.44);
  if (months < 18) return `${months} month${months === 1 ? "" : "s"}`;
  const years = days / 365.25;
  return `${years.toFixed(years < 10 ? 1 : 0)} years`;
}

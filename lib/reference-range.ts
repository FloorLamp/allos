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

// The retest AGE CEILING (issue #546): a reading older than this is stale BASELINE
// data ("last measured 12 years ago"), not "due for a redraw" — nudging it as an
// urgency-banded action item is dishonest. Past the ceiling a stale reading drops out
// of the retest nudge entirely (a distinct "historical" state), regardless of its
// analyte's cadence. Set well beyond the longest curated cadence (Lp(a)'s 5-year
// clock) so a normal recurring analyte never trips it — only genuinely ancient
// one-offs do.
export const RETEST_AGE_CEILING_DAYS = 3650; // ~10 years

// Whether a reading is beyond the retest age ceiling (issue #546) — so old it's
// historical baseline rather than "retest overdue". Pure; the caller supplies the
// reading's effective date and today.
export function isBeyondRetestHorizon(
  latestDate: string | null | undefined,
  today: string,
  ceilingDays: number = RETEST_AGE_CEILING_DAYS
): boolean {
  if (!latestDate) return false;
  return daysBetween(latestDate, today) > ceilingDays;
}

// Whole days between two YYYY-MM-DD dates (toISO - fromISO), or 0 if unparseable.
export function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

// --- Durable-immunity antibody titers (issue #516) --------------------------
//
// A documented POSITIVE/immune antibody titer for a vaccine-preventable disease is
// durable evidence of immunity — conceptually like genomics, it isn't a value you
// re-draw on a yearly clock (hepatitis A/B immunity is durable for decades). So an
// immune-positive titer should never nag "retest overdue" on the flat 365-day clock.
// Only the vaccine-preventable durable-immunity titers named in the issue qualify —
// hepatitis A immunity, hepatitis B SURFACE antibody (vaccine immunity), and the MMR +
// varicella IgGs. Infection/exposure markers are DELIBERATELY excluded: hep B surface
// ANTIGEN (active infection) and core antibody (past infection), and hep C / HIV
// antibodies (a positive is disease, not immunity) all keep the normal clock.
export function isDurableImmunityTiter(
  name: string | null | undefined
): boolean {
  const s = (name ?? "").trim().toLowerCase();
  if (!s) return false;
  // Exclude infection/antigen markers first — these are NOT vaccine-immunity titers.
  if (
    /antigen|hbsag|core antibody|core ab|anti-?hbc|hbcab|hepatitis c|\bhcv\b|\bhiv\b/.test(
      s
    )
  )
    return false;
  // Hepatitis A immunity (IgG / total antibody).
  if (
    /hepatitis a\b/.test(s) &&
    /\b(ig[gm]|ab|antibody|immunity|total)\b/.test(s)
  )
    return true;
  if (/\bhav\s*(ab|igg|antibody)\b/.test(s)) return true;
  // Hepatitis B SURFACE antibody (anti-HBs) — vaccine immunity (antigen excluded above).
  if (/hepatitis b surface a|hbs\s*ab|anti-?hbs|hbsab/.test(s)) return true;
  // Measles / Rubeola, Mumps, Rubella IgG.
  if (
    /\b(measles|rubeola|mumps|rubella)\b/.test(s) &&
    /\b(ig[gm]|ab|antibody|immunity|titer|titre)\b/.test(s)
  )
    return true;
  // MMR combined titer.
  if (/\bmmr\b/.test(s) && /\b(titer|titre|igg|immunity|antibody)\b/.test(s))
    return true;
  // Varicella / VZV / chickenpox IgG.
  if (
    /varicella|\bvzv\b|chicken\s?pox/.test(s) &&
    /\b(ig[gm]|ab|antibody|immunity|titer|titre)\b/.test(s)
  )
    return true;
  return false;
}

// The immunity-result fields the durability decision reads: the derived flag, the
// stored value (numeric OR qualitative "Immune"/"Positive"), the freeform notes
// (where a qualitative interpretation is sometimes recorded), and the reference range
// (to judge a numeric titer against its positivity threshold).
export interface ImmunityResult {
  name?: string | null;
  flag?: string | null;
  value?: string | null;
  notes?: string | null;
  reference?: string | null;
}

// Qualitative result vocabulary. A negative/equivocal titer legitimately warrants
// follow-up, so it is NOT durable — the negative check runs first because "non-immune"
// / "non-reactive" contain the positive words.
const NEGATIVE_TITER =
  /\b(non[-\s]?immune|not immune|negative|non[-\s]?reactive|not detected|undetected|equivocal|indeterminate|borderline|non[-\s]?protective|susceptible|below|deficient)\b/i;
const POSITIVE_TITER =
  /\b(immune|positive|reactive|detected|present|adequate|protective)\b/i;

// Whether an immunity titer reading is IMMUNE-POSITIVE — the condition on which
// durability turns (issue #516). Conservative: it returns true only on an AFFIRMATIVE
// positivity signal, so an ambiguous/uninterpretable reading keeps the normal retest
// clock rather than being silently exempted. Signals, in order:
//   1. a deficient standard flag (low / abnormal / non-optimal-low)      → NOT positive
//   2. a negative qualitative result in flag/value/notes                 → NOT positive
//   3. a positive qualitative result in flag/value/notes                 → positive
//   4. an in-range standard flag (normal / high / non-optimal-high)      → positive
//   5. a numeric value at/above its reference threshold (referenceStatus
//      "in"/"above"; "below" = deficient)                                → positive/NOT
//   6. no positivity signal at all                                       → NOT positive
export function isImmunePositiveResult(r: ImmunityResult): boolean {
  const flag = (r.flag ?? "").trim().toLowerCase();
  const value = r.value ?? "";
  const notes = r.notes ?? "";

  // 1 — a standard reference/optimal flag saying the value is deficient.
  if (flag === "low" || flag === "abnormal" || flag === "non-optimal-low")
    return false;
  // 2 — an explicit negative/equivocal qualitative result anywhere.
  if (
    NEGATIVE_TITER.test(flag) ||
    NEGATIVE_TITER.test(value) ||
    NEGATIVE_TITER.test(notes)
  )
    return false;
  // 3 — an explicit positive/immune qualitative result anywhere.
  if (
    POSITIVE_TITER.test(flag) ||
    POSITIVE_TITER.test(value) ||
    POSITIVE_TITER.test(notes)
  )
    return true;
  // 4 — an in-range standard flag (a titer inside its lab range is immune).
  if (flag === "normal" || flag === "high" || flag === "non-optimal-high")
    return true;
  // 5 — a numeric titer judged against a parseable reference threshold.
  const num = Number(String(value).trim());
  const ref = parseReferenceRange(r.reference);
  if (Number.isFinite(num) && ref && (ref.low != null || ref.high != null)) {
    return referenceStatus(num, ref.low, ref.high) !== "below";
  }
  // 6 — nothing affirmative → keep the clock.
  return false;
}

// Whether an immunity titer is BOTH a durable-immunity analyte AND immune-positive —
// the combined condition under which #516 exempts it from staleness. Keyed on
// immune-positive (not just the analyte name) so a negative/equivocal titer keeps its
// retest clock; the at-risk-group revaccination nuance lives in the risk layer
// (lib/risk-stratification.ts), which tightens the clock on the non-exempt readings.
// A positive result satisfies its #482 biomarker family the way a fresh reading does.
export function isDurableImmunePositive(r: ImmunityResult): boolean {
  return isDurableImmunityTiter(r.name) && isImmunePositiveResult(r);
}

// ---------------------------------------------------------------------------
// Qualitative-result classifier (issue #549). The QUALITATIVE mirror of the
// numeric path's parseLooseValue (extract a number) + reconciledFlag (judge it
// against curated ranges). Non-numeric lab values ("Positive", "Reactive", "A+",
// "YELLOW", "e3/e3") have NO shared choke-point, so the extractor's one-shot
// abnormal/normal guess — never reconciled afterward (reconciledFlag bails on both
// `flag === "abnormal"` and `value_num == null`) — drives every surface, wrongly.
// classifyQualitativeResult is that missing choke-point: given the analyte name and
// the reading's value/notes/reference it resolves what the value MEANS, so the flag
// chip, the staleness clock, the notification digest, and the chart timeline agree.
//
// Exclusion discipline — the mirror of the #482 "distinct assays stay apart"
// identity-family rule: the SAME word "positive" means opposite things by class, so
// the CLASS is resolved from the NAME and the PRESENCE from the value/notes vocab —
//   • infection-positive (HBsAg, anti-HBc, HCV, HIV, culture growth) → polarity BAD
//   • immune-positive     (durable-immunity titers, #516)            → polarity GOOD
//   • attribute-positive  (blood type, genotype, urinalysis color…)  → polarity NEUTRAL
// Returns null when neither the name nor the value is recognized — exactly like
// parseLooseValue returning null on a non-numeric string — so callers leave the
// existing extractor/numeric behavior UNTOUCHED rather than guessing (never quiet an
// unrecognized result). It reuses the #516 seeds (isDurableImmunityTiter /
// isImmunePositiveResult / the POSITIVE/NEGATIVE vocab) rather than forking them.
// ---------------------------------------------------------------------------

export type QualitativePresence = "positive" | "negative" | "neutral";

// Infection / active-disease markers — a POSITIVE here is genuinely bad and MUST keep
// flagging (never quieted). Mirrors the exclusion set isDurableImmunityTiter uses to
// hold antigen/infection markers OUT of the immunity family.
const INFECTION_MARKER =
  /antigen|hbsag|core antibody|core ab|anti-?hbc|hbcab|hepatitis c|\bhcv\b|\bhiv\b|\brpr\b|treponema|syphilis|\bvdrl\b|chlamydia|gonorrh|\bculture\b/i;

// Immutable identity attributes — a value that never changes and is never "abnormal":
// blood group/type, Rh factor, and genotype/allele strings (#548 §2).
const IMMUTABLE_ATTRIBUTE =
  /blood\s*(?:type|group)|\babo\b|rh\s*type|rh\s*factor|rh\s*\(?d\)?\b|\bgenotype\b|\ballele\b|\bhaplotype\b/i;

// Context-neutral (but mutable) descriptive attributes — urinalysis color/appearance/
// clarity and morphology "pattern" — neither good nor bad, so never "abnormal" (#548 §1).
const NEUTRAL_ATTRIBUTE =
  /\bcolou?r\b|appearance|clarity|\bpattern\b|morphology/i;

// A culture that GREW something is positive; "no growth" is negative. Small extra
// vocab beyond the titer words, only meaningful on a culture/infection result.
const CULTURE_NEGATIVE = /\bno growth\b|\bnone\b/i;
const CULTURE_POSITIVE = /\bgrowth\b/i;

// The presence a qualitative value asserts, from the reading's value + notes, using
// the SAME #516 vocabulary (NEGATIVE checked first — "non-reactive"/"non-immune"
// contain the positive words). Neutral when nothing recognized is said.
export function qualitativePresence(
  ...texts: Array<string | null | undefined>
): QualitativePresence {
  const s = texts.filter(Boolean).join(" ").trim();
  if (!s) return "neutral";
  if (NEGATIVE_TITER.test(s) || CULTURE_NEGATIVE.test(s)) return "negative";
  if (POSITIVE_TITER.test(s) || CULTURE_POSITIVE.test(s)) return "positive";
  return "neutral";
}

export interface QualitativeClassification {
  presence: QualitativePresence;
  // Clinical sense of the presence FOR THIS ANALYTE CLASS: good (reassuring, e.g. an
  // immunity titer that's positive or an infection marker that's negative), bad (an
  // infection marker that's positive), or neutral (an identity/descriptive attribute).
  polarity: "good" | "bad" | "neutral";
  // The value never meaningfully changes (blood type, genotype) → exempt from retest,
  // like genomics + durable immunity already are (#548 §2).
  immutable: boolean;
}

export function classifyQualitativeResult(
  name: string | null | undefined,
  value?: string | null,
  notes?: string | null,
  reference?: string | null
): QualitativeClassification | null {
  const n = (name ?? "").trim().toLowerCase();
  if (!n) return null;
  const presence = qualitativePresence(value, notes);

  // 1. Immutable identity attributes (blood type, genotype) — never abnormal, never stale.
  if (IMMUTABLE_ATTRIBUTE.test(n))
    return { presence, polarity: "neutral", immutable: true };

  // 2. Infection / active-disease markers — positive is BAD (keep flagging), negative
  //    is reassuring. An ambiguous reading yields null (don't fabricate a verdict).
  if (INFECTION_MARKER.test(n) && !isDurableImmunityTiter(name)) {
    if (presence === "positive")
      return { presence, polarity: "bad", immutable: false };
    if (presence === "negative")
      return { presence, polarity: "good", immutable: false };
    return null;
  }

  // 3. Durable-immunity titers (#516) — an immune-POSITIVE titer is GOOD. Judged from
  //    the value/notes/reference (NOT any stored flag — the blunt "abnormal" is exactly
  //    what we're reconsidering). A negative/equivocal titer keeps its own flag + clock.
  if (isDurableImmunityTiter(name)) {
    if (isImmunePositiveResult({ name, value, notes, reference }))
      return { presence: "positive", polarity: "good", immutable: false };
    return null;
  }

  // 4. Context-neutral descriptive attributes (urinalysis color, morphology pattern).
  if (NEUTRAL_ATTRIBUTE.test(n))
    return { presence, polarity: "neutral", immutable: false };

  // 5. Unrecognized analyte — no confident qualitative interpretation (leave as-is).
  return null;
}

// The stored flag a qualitative reading should carry, given its classifier verdict
// and current flag (issue #549, routing #544 + #548 §1). The qualitative counterpart
// of reconciledFlag: "immune" for a good durable-immunity titer, null (clear to
// normal) for a neutral attribute or good non-immunity result that a blunt "abnormal"
// mis-flagged, and undefined (leave unchanged) for a bad-polarity infection marker or
// an unrecognized value. Never touches a flag it can't confidently reclassify.
export function qualitativeFlagResolution(
  name: string | null | undefined,
  value: string | null | undefined,
  notes: string | null | undefined,
  reference: string | null | undefined,
  currentFlag: string | null | undefined
): "immune" | null | undefined {
  const c = classifyQualitativeResult(name, value, notes, reference);
  if (!c) return undefined; // unrecognized → leave the extractor/existing flag
  if (c.polarity === "bad") return undefined; // infection-positive stays flagged
  if (c.polarity === "good" && isDurableImmunityTiter(name))
    return currentFlag === "immune" ? undefined : "immune";
  // Neutral attribute, or good non-immunity: never "abnormal". Clear an out-of-range
  // flag the extractor guessed; leave an already-neutral flag alone.
  return isOutOfRange(currentFlag) ? null : undefined;
}

// Whether a biomarker's latest reading is past its retest window. `retestDays` is
// the analyte's curated cadence (null → the flat DEFAULT_RETEST_DAYS), so e.g. a
// quarterly HbA1c goes stale at 90 days while an uncurated lab still goes stale at
// 365. Genomics never go stale (genetics don't change). An immune-POSITIVE durable-
// immunity titer never goes stale either (issue #516), and — via the shared
// qualitative classifier (#549) — neither does an IMMUTABLE-attribute result (blood
// type, genotype), the same "the value can't change" exemption (#548 §2). Both use
// the optional `immunity` context (the reading's name/flag/value/notes/reference).
// Boundary: stale strictly AFTER the window (age > interval), matching the original.
export function isBiomarkerStale(
  latestDate: string | null | undefined,
  category: string | null | undefined,
  today: string,
  retestDays?: number | null,
  immunity?: ImmunityResult
): boolean {
  if (!latestDate) return false;
  if (category === "genomics") return false; // genetics don't change
  if (immunity) {
    if (isDurableImmunePositive(immunity)) return false; // durable immunity (#516)
    const c = classifyQualitativeResult(
      immunity.name,
      immunity.value,
      immunity.notes,
      immunity.reference
    );
    if (c?.immutable) return false; // immutable attribute — never stale (#548 §2)
  }
  return daysBetween(latestDate, today) > retestIntervalDays(retestDays);
}

// ---------------------------------------------------------------------------
// Biomarker axis-domain policy (issue #311). "Given a biomarker value/series plus
// its reference and optimal band bounds, what numeric [lo, hi] should the axis
// span?" was computed twice, inline, in two client charts (BiomarkerScale's dot
// scale and BiomarkerChartInner's recharts Y domain) — with drifted padding
// constants (12% vs 8%). This is the ONE source of truth; both components are now
// pixel-mappers over its result. Pure math, so it's client-safe.
// ---------------------------------------------------------------------------

// The reference/optimal band bounds an axis must contain (any may be absent).
export interface AxisBounds {
  refLow?: number | null;
  refHigh?: number | null;
  optimalLow?: number | null;
  optimalHigh?: number | null;
}

export interface AxisDomainOpts {
  // Fraction of the span added as breathing room on each side (default 8%).
  padFraction?: number;
  // For wide spans, snap the domain outward to whole numbers so recharts picks
  // clean integer ticks; small-span analytes (HbA1c) keep their decimals.
  snapWideToIntegers?: boolean;
}

// Default breathing room: the time-series chart's historical 8%.
export const DEFAULT_AXIS_PAD_FRACTION = 0.08;
// The single-value dot scale opts into a touch more room (its lone marker should
// never sit flush against an edge) — now an explicit option, not a magic number.
export const SCALE_AXIS_PAD_FRACTION = 0.12;
// A span at or above this many units counts as "wide" for integer snapping.
export const WIDE_SPAN_THRESHOLD = 3;

// Compute the axis domain that comfortably contains every real mark (the
// value(s) plus any band bounds), with padding so nothing sits flush against an
// edge. Edge cases, unified across both charts:
//   - no finite marks at all               → a safe [0, 1] window
//   - flat series / single point (lo===hi) → open a ±1 window so the mark shows
//   - every real mark non-negative         → clamp the floor to 0 (biomarker
//                                             concentrations can't go below 0; the
//                                             padding/expansion must not pull the
//                                             axis under it). The decision uses the
//                                             PRE-expansion minimum, so a flat
//                                             series at 0 still clamps (this fixes
//                                             the trend chart, which previously
//                                             tested the post-expansion min).
//   - snapWideToIntegers + wide span       → floor/ceil the padded bounds to ints.
// `wide` reports whether integer snapping was applied (the caller uses it to set
// recharts `allowDecimals`).
export function biomarkerAxisDomain(
  values: Array<number | null | undefined>,
  bounds: AxisBounds,
  opts: AxisDomainOpts = {}
): { lo: number; hi: number; wide: boolean } {
  const {
    padFraction = DEFAULT_AXIS_PAD_FRACTION,
    snapWideToIntegers = false,
  } = opts;

  const marks: number[] = [];
  for (const v of values) if (v != null && Number.isFinite(v)) marks.push(v);
  for (const b of [
    bounds.refLow,
    bounds.refHigh,
    bounds.optimalLow,
    bounds.optimalHigh,
  ])
    if (b != null && Number.isFinite(b)) marks.push(b);

  if (marks.length === 0) return { lo: 0, hi: 1, wide: false };

  const minMark = Math.min(...marks);
  let min = minMark;
  let max = Math.max(...marks);
  if (min === max) {
    // Flat series / single point — open a small symmetric window so it shows.
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const pad = span * padFraction;
  const wide = snapWideToIntegers && span >= WIDE_SPAN_THRESHOLD;
  let lo = wide ? Math.floor(min - pad) : min - pad;
  const hi = wide ? Math.ceil(max + pad) : max + pad;
  // Every real mark non-negative → don't let padding pull the axis below 0.
  if (minMark >= 0) lo = Math.max(0, lo);
  return { lo, hi, wide };
}

// Approximate, human-friendly age for a span of days ("8 months", "1.4 years").
export function humanizeAge(days: number): string {
  if (days < 45) return `${days} day${days === 1 ? "" : "s"}`;
  const months = Math.round(days / 30.44);
  if (months < 18) return `${months} month${months === 1 ? "" : "s"}`;
  const years = days / 365.25;
  return `${years.toFixed(years < 10 ? 1 : 0)} years`;
}

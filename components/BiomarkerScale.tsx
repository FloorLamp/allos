import type { StarredBiomarker } from "@/lib/queries";
import type { ReproductiveStatus, Sex } from "@/lib/types";
import {
  rangeBadge,
  parseLooseValue,
  optimalBand,
  referenceRange,
  ageBandLabel,
} from "@/lib/reference-range";
import { convertToCanonical } from "@/lib/unit-conversions";
import { MedicalValue } from "./ui";

// Compact dot color matching the value's range badge: red out of range, amber
// outside the optimal band, green optimal, grey when unjudgeable. The border
// variant is used for inexact-but-bounded readings, drawn as a hollow dot.
const MARKER_COLOR: Record<string, string> = {
  high: "bg-rose-500",
  low: "bg-rose-500",
  "above-optimal": "bg-amber-500",
  "below-optimal": "bg-amber-500",
  optimal: "bg-emerald-500",
  unknown: "bg-slate-400",
};
const MARKER_BORDER: Record<string, string> = {
  high: "border-rose-500",
  low: "border-rose-500",
  "above-optimal": "border-amber-500",
  "below-optimal": "border-amber-500",
  optimal: "border-emerald-500",
  unknown: "border-slate-400",
};

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  return String(r);
}

// Bottom region of a starred-biomarker tile. For a numeric value with known
// reference/optimal ranges it draws a horizontal scale: the reference band, the
// optimal band, and a marker for the latest value. For a qualitative value (or
// one we can't scale) it shows the value in a large font instead, keeping every
// tile the same height.
export default function BiomarkerScale({
  b,
  sex,
  age,
  status,
}: {
  b: StarredBiomarker;
  sex?: Sex | null;
  // The subject's age on the latest reading's date, so an age-banded biomarker
  // scales against the band that applied to the reading (not today's age).
  age?: number | null;
  // The profile's current reproductive status (female physiology only); overrides
  // the age proxy for the reproductive-hormone ranges.
  status?: ReproductiveStatus | null;
}) {
  const cb = b.canonical;
  // Effective reference range and optimal band for the user's sex + age
  // (age band, then sex-specific override, else generic).
  const rb = referenceRange(cb, sex, age, status);
  const ob = optimalBand(cb, sex, age);
  const bandLabel = ageBandLabel(rb.band);
  // Exact value, or an inexact-but-bounded reading ("<0.10") placed at its limit
  // and drawn as a hollow marker.
  const loose =
    b.latest_value_num != null
      ? { value: b.latest_value_num, bound: undefined }
      : parseLooseValue(b.latest_value);
  const value = loose
    ? convertToCanonical(loose.value, b.latest_unit, cb)
    : null;
  const bounded = !!loose?.bound;
  const hasBounds =
    !!cb &&
    (rb.low != null || rb.high != null || ob.low != null || ob.high != null);

  // Qualitative (no numeric value) or nothing to scale against → big value.
  if (value == null || !cb || !hasBounds) {
    return (
      <div className="flex min-h-[64px] flex-col justify-center">
        <div className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          <MedicalValue
            value={b.latest_value}
            unit={b.latest_unit}
            flag={b.latest_flag}
          />
        </div>
      </div>
    );
  }

  // Domain spans every known bound and the value, with a little padding so the
  // marker never sits flush against an edge.
  const marks = [rb.low, rb.high, ob.low, ob.high, value].filter(
    (n): n is number => n != null
  );
  const minMark = Math.min(...marks);
  let lo = minMark;
  let hi = Math.max(...marks);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.12;
  lo -= pad;
  hi += pad;
  // Biomarker concentrations can't be negative — keep the scale from padding
  // below 0 (e.g. a toxin whose optimal band sits at 0).
  if (minMark >= 0) lo = Math.max(0, lo);
  const pct = (x: number) => clamp(((x - lo) / (hi - lo)) * 100, 0, 100);

  const hasRef = rb.low != null || rb.high != null;
  const refStart = pct(rb.low ?? lo);
  const refEnd = pct(rb.high ?? hi);
  const hasOpt = ob.low != null || ob.high != null;
  const optStart = pct(ob.low ?? lo);
  const optEnd = pct(ob.high ?? hi);

  const badge = rangeBadge(value, cb, sex, age, status);
  const marker = bounded
    ? `border-2 bg-white dark:bg-ink-900 ${MARKER_BORDER[badge] ?? MARKER_BORDER.unknown}`
    : `ring-2 ring-white dark:ring-slate-900 ${MARKER_COLOR[badge] ?? MARKER_COLOR.unknown}`;

  return (
    <div className="flex min-h-[64px] flex-col justify-center">
      <div className="text-lg font-semibold text-slate-900 dark:text-slate-100">
        <MedicalValue
          value={b.latest_value}
          unit={b.latest_unit}
          flag={b.latest_flag}
        />
      </div>

      <div className="relative mt-3 h-2 rounded-full bg-slate-100 dark:bg-ink-800">
        {hasRef && (
          <div
            className="absolute inset-y-0 rounded-full bg-slate-200 dark:bg-ink-700"
            style={{ left: `${refStart}%`, width: `${refEnd - refStart}%` }}
          />
        )}
        {hasOpt && (
          <div
            className="absolute inset-y-0 rounded-full bg-emerald-300"
            style={{ left: `${optStart}%`, width: `${optEnd - optStart}%` }}
          />
        )}
        <div
          className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ${marker}`}
          style={{ left: `${pct(value)}%` }}
        />
      </div>

      <div className="mt-1 flex justify-between text-[10px] text-slate-400 dark:text-slate-500">
        <span>{rb.low != null ? fmt(rb.low) : ""}</span>
        <span>{rb.high != null ? fmt(rb.high) : ""}</span>
      </div>

      {bandLabel && (
        <div className="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">
          range for {bandLabel}
        </div>
      )}
    </div>
  );
}

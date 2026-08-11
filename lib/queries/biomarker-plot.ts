// ONE biomarker's plottable series — the numeric points in the unit they will be
// labelled with, plus the effective reference range.
//
// Extracted from lib/trends-series.ts (#1853) so it is a LEAF both the chart layer
// and the goal layer can depend on. It was already the single answer to "what does
// this analyte's series look like" for the Trends tiles, Compare overlays and the
// digest; a biomarker GOAL asks exactly the same question ("is my LDL under 100
// yet?") and must not get a second one (#221). Keeping it inside trends-series would
// have meant either a cycle (queries → trends-series → queries) or a copy, and a copy
// is how a goal card and the chart it sits next to start disagreeing about whether a
// reading was mg/dL or mmol/L.
//
// Imports the specific query modules rather than the ../queries barrel, so nothing
// here can pull the barrel back into a module the barrel itself re-exports.

import { getBiomarkerSeriesWithDerivedFor } from "./derived";
import { getCanonicalBiomarker } from "./medical";
import {
  getProfileSex,
  getProfileReproductiveStatus,
  profileAgeResolver,
} from "../settings";
import {
  referenceRange,
  parseReferenceRange,
  parseLooseValue,
} from "../reference-range";
import { convertToCanonical, sameUnit } from "../unit-conversions";
import type { MedicalRecord } from "../types";

export interface BiomarkerPlot {
  // The family's readings, oldest→newest (the detail page's table).
  rows: MedicalRecord[];
  // The plottable numeric points, in `unit`.
  points: { date: string; value: number }[];
  // The unit `points` are expressed in, or null when the analyte has neither a
  // canonical unit nor a unit on its latest reading.
  unit: string | null;
  // The effective reference range in `unit`, or null when there is none.
  rng: { low: number | null; high: number | null } | null;
}

// One biomarker's FULL (un-windowed) plot. Mirrors the biomarker detail page's
// charting: chart in the canonical unit when the biomarker has one (converting every
// convertible reading and carrying the effective reference range), else fall back to
// the latest reading's unit and its parsed lab range. Censored readings ("<0.10") are
// plotted at their limit.
//
// Readings are gathered by getBiomarkerSeriesWithDerived, which matches on the #482
// FAMILY identity — so a request for any family member returns the whole family's
// readings, and a goal anchored on "Hemoglobin A1c" is advanced by the eAG
// re-expression of the same draw.
//
// Returns null when the analyte has no readings at all for this profile.
export function biomarkerPlot(
  profileId: number,
  canonical: string
): BiomarkerPlot | null {
  return biomarkerPlots(profileId, [canonical]).get(canonical) ?? null;
}

// The SAME plots for SEVERAL analytes in ONE pass (#1961), keyed by the exact
// requested name (null for a name with no readings, exactly as biomarkerPlot
// returns). `biomarkerPlot` is a one-element call of this, so the batched and
// unbatched answers are one computation, not two that agree today.
//
// Every per-analyte read that ISN'T per-analyte is hoisted out of the loop: the
// series (one query for the whole batch, see getBiomarkerSeriesFor) and the three
// demographic reads, which describe the PROFILE and were re-read per call. They stay
// LAZY so a batch whose analytes all have zero readings still issues none of them —
// the unbatched path returned null before reading any.
//
// The canonical-biomarker lookup stays per analyte: it is what makes two members of
// one family (A1c and its eAG re-expression) plot in DIFFERENT units, so collapsing
// it to the family would change rendered numbers.
export function biomarkerPlots(
  profileId: number,
  canonicals: readonly string[]
): Map<string, BiomarkerPlot | null> {
  const out = new Map<string, BiomarkerPlot | null>();
  const names = [...new Set(canonicals)];
  if (names.length === 0) return out;

  const seriesByName = getBiomarkerSeriesWithDerivedFor(profileId, names);

  const sex = once(() => getProfileSex(profileId));
  const status = once(() => getProfileReproductiveStatus(profileId));
  const ageResolver = once(() => profileAgeResolver(profileId));

  for (const canonical of names) {
    out.set(
      canonical,
      shapePlot(seriesByName.get(canonical) ?? [], canonical, {
        sex,
        status,
        ageOn: (on) => ageResolver()(on),
      })
    );
  }
  return out;
}

// Run `fn` at most once, memoizing whatever it returned — including null, which a
// nullish-coalescing memo would re-read every time (an unset sex is the common case).
function once<T>(fn: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = fn();
      done = true;
    }
    return value;
  };
}

// The plot shaping itself — one analyte's family series (stored ∪ derived) turned
// into points/unit/range. Split out only so the single and batched entry points run
// the identical body; the demographics arrive as thunks so a series-less analyte
// costs nothing.
function shapePlot(
  series: MedicalRecord[],
  canonical: string,
  demographics: {
    sex: () => ReturnType<typeof getProfileSex>;
    status: () => ReturnType<typeof getProfileReproductiveStatus>;
    ageOn: (on: string | null) => number | null;
  }
): BiomarkerPlot | null {
  if (series.length === 0) return null;
  const cb = getCanonicalBiomarker(canonical);
  const sex = demographics.sex();
  const latestDate = series[series.length - 1]?.date ?? null;
  const age = demographics.ageOn(latestDate);
  const status = demographics.status();

  // exact value_num, or an inexact-but-bounded reading plotted at its limit.
  const plottable = series.flatMap((r) => {
    const p =
      r.value_num != null ? { value: r.value_num } : parseLooseValue(r.value);
    return p ? [{ r, value: p.value }] : [];
  });

  let unit: string | null;
  let points: { date: string; value: number }[];
  let rng: { low: number | null; high: number | null } | null = null;

  if (cb && cb.unit) {
    unit = cb.unit;
    points = plottable
      .map((x) => ({
        date: x.r.date,
        value: convertToCanonical(x.value, x.r.unit, cb),
      }))
      .filter((x): x is { date: string; value: number } => x.value != null);
    const ref = referenceRange(cb, sex, age, status);
    if (ref.low != null || ref.high != null) {
      rng = { low: ref.low, high: ref.high };
    }
  } else {
    const latestUnit = plottable.length
      ? (plottable[plottable.length - 1].r.unit ?? null)
      : null;
    unit = latestUnit;
    points = plottable
      .filter((x) => sameUnit(x.r.unit, latestUnit))
      .map((x) => ({ date: x.r.date, value: x.value }));
    const parsed = parseReferenceRange(
      series[series.length - 1].reference_range
    );
    if (parsed) rng = { low: parsed.low ?? null, high: parsed.high ?? null };
  }

  return { rows: series, points, unit, rng };
}

// The unit a biomarker TARGET must be captured in for this profile: the unit the
// analyte's own plot is labelled with, falling back to the canonical unit when the
// profile has no readings yet (a goal may legitimately be set before the first draw).
// Null when neither is known — the caller then stores whatever unit the user typed
// and the progress reader compares with sameUnit's permissive null handling.
export function biomarkerTargetUnit(
  profileId: number,
  canonical: string
): string | null {
  const plot = biomarkerPlot(profileId, canonical);
  if (plot?.unit) return plot.unit;
  return getCanonicalBiomarker(canonical)?.unit ?? null;
}

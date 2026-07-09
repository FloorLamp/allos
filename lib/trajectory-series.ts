// Server-side assembly for the biomarker trajectory rules (issue #41). Turns each
// of a profile's in-use biomarkers into a TrajectoryInput — the full canonical-unit
// history plus the effective reference/optimal bands (sex/age/status resolved), the
// analyte's retest cadence, and its curated velocity threshold — and runs the pure
// lib/biomarker-trajectory engine over them.
//
// Every read goes through an already PROFILE-SCOPED query (getUsedCanonicalNames /
// getBiomarkerSeries / getCanonicalBiomarker) or the per-profile settings helpers,
// so no owned SQL is added here and the profile-scoping guard is unaffected. The
// series is the WHOLE history (not windowed to the Trends date control): a
// trajectory is a property of the analyte over time, independent of the chart's
// current zoom.

import {
  getUsedCanonicalNames,
  getBiomarkerSeries,
  getCanonicalBiomarker,
} from "./queries";
import {
  getUserSex,
  getUserAgeOn,
  getUserReproductiveStatus,
} from "./settings";
import {
  referenceRange,
  optimalBand,
  parseReferenceRange,
  parseLooseValue,
  retestIntervalDays,
} from "./reference-range";
import { convertToCanonical, sameUnit } from "./unit-conversions";
import { retestDaysForBiomarker } from "./biomarker-retest";
import { velocityPerYearForBiomarker } from "./biomarker-velocity";
import {
  trajectoryFindings,
  type TrajectoryInput,
  type TrajectoryFinding,
} from "./biomarker-trajectory";
import type { BiomarkerDirection } from "./types";

// Build the TrajectoryInput for one canonical biomarker, mirroring
// buildBiomarkerSeries' charting choice: canonical unit + effective ranges when the
// analyte has a canonical entry, else the latest reading's unit and its parsed lab
// range (no optimal band). Returns null when there aren't enough numeric readings.
export function buildTrajectoryInput(
  profileId: number,
  canonical: string,
  today: string
): TrajectoryInput | null {
  const series = getBiomarkerSeries(profileId, canonical);
  if (series.length === 0) return null;
  const cb = getCanonicalBiomarker(canonical);
  const sex = getUserSex(profileId);
  const latestDate = series[series.length - 1]?.date ?? null;
  const age = getUserAgeOn(profileId, latestDate);
  const status = getUserReproductiveStatus(profileId);

  // Exact value_num, or an inexact-but-bounded reading plotted at its limit.
  const plottable = series.flatMap((r) => {
    const p =
      r.value_num != null ? { value: r.value_num } : parseLooseValue(r.value);
    return p ? [{ r, value: p.value }] : [];
  });
  if (plottable.length === 0) return null;

  let unit: string | null;
  let points: { date: string; value: number }[];
  let reference: { low: number | null; high: number | null } | null = null;
  let optimal: { low: number | null; high: number | null } | null = null;
  let direction: BiomarkerDirection = "in_range";

  if (cb && cb.unit) {
    unit = cb.unit;
    direction = cb.direction ?? "in_range";
    points = plottable
      .map((x) => ({
        date: x.r.date,
        value: convertToCanonical(x.value, x.r.unit, cb),
      }))
      .filter((x): x is { date: string; value: number } => x.value != null);
    const ref = referenceRange(cb, sex, age, status);
    if (ref.low != null || ref.high != null)
      reference = { low: ref.low, high: ref.high };
    const opt = optimalBand(cb, sex, age);
    if (opt.low != null || opt.high != null)
      optimal = { low: opt.low, high: opt.high };
  } else {
    const latestUnit = plottable[plottable.length - 1].r.unit ?? null;
    unit = latestUnit;
    points = plottable
      .filter((x) => sameUnit(x.r.unit, latestUnit))
      .map((x) => ({ date: x.r.date, value: x.value }));
    const parsed = parseReferenceRange(
      series[series.length - 1].reference_range
    );
    if (parsed)
      reference = { low: parsed.low ?? null, high: parsed.high ?? null };
  }

  if (points.length === 0) return null;

  return {
    analyte: canonical,
    unit,
    points,
    reference,
    optimal,
    direction,
    retestDays: retestIntervalDays(retestDaysForBiomarker(canonical)),
    velocityPerYear: velocityPerYearForBiomarker(canonical),
    today,
    href: `/biomarkers/view?name=${encodeURIComponent(canonical)}`,
  };
}

// Every trajectory finding for a profile: build an input per in-use biomarker and
// run the pure engine. Not suppression-filtered — the caller applies the shared
// findings-bus filter (getFindingSuppressions + activeByKey) so an expired
// dismissal reveals a finding exactly as on the other surfaces.
export function buildTrajectoryFindings(
  profileId: number,
  today: string
): TrajectoryFinding[] {
  const inputs: TrajectoryInput[] = [];
  for (const name of getUsedCanonicalNames(profileId)) {
    const input = buildTrajectoryInput(profileId, name, today);
    if (input) inputs.push(input);
  }
  return trajectoryFindings(inputs);
}

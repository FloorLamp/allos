// The PURE decision for the OVEREXPOSURE care-tier finding (issue #1172). The care half
// of the two-sided UV-dose model: when a day's cumulative erythemal dose from outdoor
// daylight time crosses the skin-type-adjusted burn (MED) threshold, surface an
// actionable heads-up ("high UV during your 90 min out — ~X min to burn for your skin
// type"). Care tier (#449) — it reaches Upcoming + the non-hideable dashboard hero,
// distinct from the calm/observational sufficiency signal. STAYS SILENT without a skin
// type (the overexposure threshold is undefined then — degrade gracefully, never guess).
//
// Pure (no DB/clock): it formats a UvDoseResult (the ONE computation, lib/uv-dose) that
// the DB read layer (lib/queries/weather → getUvDoseForDay) already produced. The
// Upcoming generator (lib/queries/upcoming/generators → uvOverexposureItems) assembles
// the DB inputs and formats this into an UpcomingItem.

import type { UvDoseResult } from "./uv-dose";

// dedupeKey namespace for the shared findings-suppression bus — "dismiss once, silence
// everywhere". Keyed by the DATE so a dismissal silences that day's warning and a new
// day's overexposure surfaces fresh.
export const UV_EXPOSURE_PREFIX = "uv-exposure:";

export function uvOverexposureSignalKey(date: string): string {
  return `${UV_EXPOSURE_PREFIX}overexposure:${date}`;
}

export interface UvOverexposureObservation {
  dedupeKey: string;
  title: string;
  detail: string;
}

// Decide whether the day's outdoor UV dose warrants an overexposure warning. Emits ONLY
// when: the dose has real UV (uvSource !== "none"), a skin type is set (overexposed is
// non-null), and the cumulative dose crossed the MED (overexposed === true). Returns
// null otherwise — including silently for a missing skin type. Pure.
export function decideUvOverexposure(
  date: string,
  dose: UvDoseResult
): UvOverexposureObservation | null {
  if (dose.uvSource === "none") return null;
  if (dose.overexposed !== true) return null;

  const minutes = dose.outdoorMinutes;
  const burn =
    dose.minutesToBurn != null
      ? `about ${dose.minutesToBurn} min at that peak would reach a burn for your skin type`
      : "you crossed a burn-level dose for your skin type";
  const peak =
    dose.peakUvIndex != null && dose.peakUvIndex > 0
      ? ` (peak UV ${Math.round(dose.peakUvIndex)})`
      : "";
  return {
    dedupeKey: uvOverexposureSignalKey(date),
    title: "High UV dose from today's outdoor time",
    detail:
      `Your ${minutes} min of outdoor daylight${peak} added up to a high cumulative ` +
      `UV dose — ${burn}. Consider shade, cover, or sunscreen next time out.`,
  };
}

// The DB gather for today's reported burden (issue #1300). The threshold + copy are pure
// (lib/reported-burden.ts); this reads the profile-scoped self-reports — today's logged
// symptom severities + the Energy tap — and, only when symptoms are present, the Period
// context (framing-only #1298). No `.prepare` here: every read delegates to an already
// profile-scoped reader, so the scoping guard is unaffected.

import { getSymptomsOnDate } from "./symptoms";
import { getMoodOnDate } from "./mood";
import { resolveDerivedSituations } from "./derived-situations";
import { computeReportedBurden, type ReportedBurden } from "../reported-burden";

// Compute the profile's reported burden for `todayStr` (its local calendar day). The
// coaching gather's first consumer (#221); a future digest burden line reads the same fn.
export function getReportedBurden(
  profileId: number,
  todayStr: string
): ReportedBurden {
  const symptoms = getSymptomsOnDate(profileId, todayStr).map((s) => ({
    symptom: s.symptom,
    severity: s.severity,
  }));
  const energy = getMoodOnDate(profileId, todayStr)?.energy ?? null;
  // Period framing only matters when symptoms fired the tilt (periodFramed needs a symptom
  // burden), so the cycle/derived read is skipped entirely on the common no-symptom day.
  const periodContext =
    symptoms.length > 0
      ? (resolveDerivedSituations(profileId, todayStr).period?.on ?? false)
      : false;
  return computeReportedBurden({ symptoms, energy, periodContext });
}

// Mobility read layer (issue #840): the day's mobility session (for the tap-the-moves
// bar) and the recent recovery sessions (for the coverage strip + region habit counting).
// Every statement filters by profile_id (the scoping rule). Reads only — the write core
// is lib/mobility-log-write.ts.

import { db } from "../db";
import { parseComponents } from "../types";
import {
  readMobilitySession,
  type MobilitySession,
} from "../mobility-log-write";
import {
  mobilityCoverageStrip,
  type MobilityCoverageRow,
  type MobilitySessionInput,
} from "../mobility-coverage";
import { fitnessPercentile } from "../fitness-norms";
import { getUserSex, getUserAge } from "../settings";
import { getInjuryConstraints } from "../injuries";
import {
  mobilitySuggestions,
  type MobilitySuggestion,
} from "../mobility-suggest";
import type { MuscleRegion } from "../lifts";
import { getLatestMedicalRecordByCanonical } from "./medical";
import { getFrequencyTargets } from "./training";

// The day's mobility session (its logged move slugs + optional duration), or an empty
// session when none exists yet.
export function getMobilitySession(
  profileId: number,
  date: string
): MobilitySession {
  return readMobilitySession(profileId, date);
}

// Recent recovery sessions as coverage inputs (date + move slugs); the caller applies the
// exact rolling window (mobilityCoverageStrip). The 400-row cap bounds the scan for a
// long history. Profile-scoped.
export function getRecentMobilitySessions(
  profileId: number
): MobilitySessionInput[] {
  const rows = db
    .prepare(
      `SELECT date, components FROM activities
         WHERE profile_id = ? AND type = 'recovery'
         ORDER BY date DESC LIMIT 400`
    )
    .all(profileId) as { date: string; components: string | null }[];
  return rows.map((r) => ({
    date: r.date,
    moves: parseComponents(r.components)
      .filter((c) => c?.type === "recovery" && typeof c.name === "string")
      .map((c) => c.name),
  }));
}

// The mobility region-coverage strip for the trailing window (Training overview, #840
// point 3). A SEPARATE view from strength trained-coverage (#482).
export function getMobilityCoverage(
  profileId: number,
  today: string,
  windowDays = 7
): MobilityCoverageRow[] {
  return mobilityCoverageStrip(
    getRecentMobilitySessions(profileId),
    today,
    windowDays
  );
}

// The ONE gather for mobility deficit→habit suggestions (#840 phase 2): reads the latest
// sit-and-reach / single-leg balance percentiles (#834), the profile's RECOVERING injuries
// (#838), and the mobility_region targets already set, then runs the pure suggestion engine
// (mobilitySuggestions). BOTH the coaching finding builder and the Training-overview
// one-tap accept affordance read THIS (one question, one computation) — never a second
// gather. Returns raw suggestions; the caller applies the dismissal filter.
export function getMobilitySuggestions(
  profileId: number
): MobilitySuggestion[] {
  const sex = getUserSex(profileId);
  const age = getUserAge(profileId);
  const sitReach = getLatestMedicalRecordByCanonical(
    profileId,
    "Sit-and-Reach"
  );
  const balance = getLatestMedicalRecordByCanonical(
    profileId,
    "Single-Leg Balance"
  );
  const recoveringRegions = Array.from(
    new Set(
      getInjuryConstraints(profileId)
        .filter((c) => c.status === "recovering")
        .flatMap((c) => c.regions)
    )
  );
  const existingTargetRegions = new Set(
    getFrequencyTargets(profileId)
      .filter((t) => t.scope_kind === "mobility_region")
      .map((t) => t.scope_value as MuscleRegion)
  );
  return mobilitySuggestions({
    sitReachPercentile:
      fitnessPercentile("Sit-and-Reach", sitReach?.value_num, sex, age)
        ?.percentile ?? null,
    balancePercentile:
      fitnessPercentile("Single-Leg Balance", balance?.value_num, sex, age)
        ?.percentile ?? null,
    recoveringRegions,
    existingTargetRegions,
  });
}

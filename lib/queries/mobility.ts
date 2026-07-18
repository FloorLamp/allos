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

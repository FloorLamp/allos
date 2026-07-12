// Read/derive layer for the equipment registry (issue #343). Equipment moved out
// of Settings into its own /equipment index + /equipment/[id] detail; the usage
// payoff (sessions, last used, Σ volume, Σ distance) is surfaced by ONE
// profile-scoped read here, feeding BOTH the index badges and the detail page —
// same computation, two formatters ("one question, one computation").
//
// Gear links at two levels: the per-SET strength implement
// (exercise_sets.equipment_id) and the session-level activity link
// (activities.equipment_id — issue #342). A row's "sessions" is the count of
// DISTINCT activities that used it at either level, so a bar used across three
// sets of one workout counts once. Volume comes from the set link (Σ weight×reps,
// both sides); distance/mileage from the session link (Σ distance_km) — the
// shoes/bikes payoff. Every statement filters profile_id (exercise_sets reaches it
// via the JOIN to activities).

import { db } from "../db";

export interface EquipmentUsage {
  equipmentId: number;
  // Distinct activities that used this gear (set-level OR session-level).
  sessions: number;
  // Most recent activity date that used it (YYYY-MM-DD), or null if never used.
  lastUsed: string | null;
  // Σ external load moved on sets performed with this implement (kg, both sides).
  totalVolumeKg: number;
  // Σ distance across sessions performed with this gear (km) — shoes/bikes.
  totalDistanceKm: number;
}

interface UsageRow {
  eid: number;
  aid: number;
  date: string;
  vol: number;
  dist: number;
}

// Gather every (equipment, activity) usage row for a profile — one from the
// set-level implement link, one from the session-level gear link — then fold them
// into a per-equipment summary in JS (distinct-activity counting can't be done in
// one grouped SQL across the two sources without double-counting).
function usageRows(profileId: number): UsageRow[] {
  const setRows = db
    .prepare(
      `SELECT s.equipment_id AS eid, a.id AS aid, a.date AS date,
              (COALESCE(s.weight_kg, 0) * COALESCE(s.reps, 0)
               + COALESCE(s.weight_kg_right, 0) * COALESCE(s.reps_right, 0)) AS vol,
              0 AS dist
         FROM exercise_sets s
         JOIN activities a ON a.id = s.activity_id
        WHERE a.profile_id = ? AND s.equipment_id IS NOT NULL`
    )
    .all(profileId) as UsageRow[];
  const actRows = db
    .prepare(
      `SELECT a.equipment_id AS eid, a.id AS aid, a.date AS date,
              0 AS vol, COALESCE(a.distance_km, 0) AS dist
         FROM activities a
        WHERE a.profile_id = ? AND a.equipment_id IS NOT NULL`
    )
    .all(profileId) as UsageRow[];
  return [...setRows, ...actRows];
}

interface UsageAccum {
  activityIds: Set<number>;
  lastUsed: string | null;
  totalVolumeKg: number;
  totalDistanceKm: number;
}

function foldUsage(rows: UsageRow[]): Map<number, EquipmentUsage> {
  const acc = new Map<number, UsageAccum>();
  for (const r of rows) {
    let a = acc.get(r.eid);
    if (!a)
      acc.set(
        r.eid,
        (a = {
          activityIds: new Set(),
          lastUsed: null,
          totalVolumeKg: 0,
          totalDistanceKm: 0,
        })
      );
    a.activityIds.add(r.aid);
    a.totalVolumeKg += r.vol;
    a.totalDistanceKm += r.dist;
    if (a.lastUsed == null || r.date > a.lastUsed) a.lastUsed = r.date;
  }
  const out = new Map<number, EquipmentUsage>();
  for (const [eid, a] of acc)
    out.set(eid, {
      equipmentId: eid,
      sessions: a.activityIds.size,
      lastUsed: a.lastUsed,
      totalVolumeKg: a.totalVolumeKg,
      totalDistanceKm: a.totalDistanceKm,
    });
  return out;
}

// Per-equipment usage summary for the whole profile, keyed by equipment id. A row
// with no usage is simply absent from the map (callers treat a miss as an empty
// summary). Feeds the /equipment index badges and the detail page alike.
export function getEquipmentUsage(
  profileId: number
): Map<number, EquipmentUsage> {
  return foldUsage(usageRows(profileId));
}

// One equipment row's usage summary (or null when it has none). A thin selector
// over the same computation so the detail page and the index never disagree.
export function getEquipmentUsageById(
  profileId: number,
  id: number
): EquipmentUsage | null {
  return getEquipmentUsage(profileId).get(id) ?? null;
}

// One point on the detail page's trend chart: a session that used the gear, with
// its date and the value that matters for its kind (volume for a strength
// implement, distance for a bike/shoes). Ordered oldest→newest. Profile-scoped via
// the JOIN to activities and the session-level filter.
export interface EquipmentSessionPoint {
  activityId: number;
  date: string;
  title: string;
  volumeKg: number;
  distanceKm: number;
}

export function getEquipmentSessions(
  profileId: number,
  id: number
): EquipmentSessionPoint[] {
  const setRows = db
    .prepare(
      `SELECT a.id AS aid, a.date AS date, a.title AS title,
              (COALESCE(s.weight_kg, 0) * COALESCE(s.reps, 0)
               + COALESCE(s.weight_kg_right, 0) * COALESCE(s.reps_right, 0)) AS vol
         FROM exercise_sets s
         JOIN activities a ON a.id = s.activity_id
        WHERE a.profile_id = ? AND s.equipment_id = ?`
    )
    .all(profileId, id) as {
    aid: number;
    date: string;
    title: string;
    vol: number;
  }[];
  const actRows = db
    .prepare(
      `SELECT a.id AS aid, a.date AS date, a.title AS title,
              COALESCE(a.distance_km, 0) AS dist
         FROM activities a
        WHERE a.profile_id = ? AND a.equipment_id = ?`
    )
    .all(profileId, id) as {
    aid: number;
    date: string;
    title: string;
    dist: number;
  }[];

  const byActivity = new Map<number, EquipmentSessionPoint>();
  const point = (aid: number, date: string, title: string) => {
    let p = byActivity.get(aid);
    if (!p)
      byActivity.set(
        aid,
        (p = { activityId: aid, date, title, volumeKg: 0, distanceKm: 0 })
      );
    return p;
  };
  for (const r of setRows) point(r.aid, r.date, r.title).volumeKg += r.vol;
  for (const r of actRows) point(r.aid, r.date, r.title).distanceKm += r.dist;

  return [...byActivity.values()].sort((a, b) =>
    a.date === b.date
      ? a.activityId - b.activityId
      : a.date.localeCompare(b.date)
  );
}

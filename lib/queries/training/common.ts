import { shiftDateStr } from "../../date";
import { db, today } from "../../db";
import { decayedWeight } from "../../decay";
import { RECENT_WINDOW_DAYS } from "../../exercise-window";
import { getWeekMode, getWeekStart } from "../../settings";
import { weekWindow } from "../../week-window";
import type { ActivityComponent } from "../../types";
import { parseComponents } from "../../types";
import { cache } from "../../request-cache";

// Re-export the shared request-scoped cache() shim (lib/request-cache) so the
// training submodules keep importing `cache` from this common module unchanged.
export { cache };

// Window for the "recent" scans that back the activity picker's suggestions and
// the editor's per-exercise history. Both only need recent data — a name or a
// session older than a year is irrelevant to what to suggest next — so bounding
// the underlying full-table scans to the last 12 months is semantically invisible
// while turning an all-history scan into a small windowed one. RECENT_WINDOW_DAYS
// lives in lib/exercise-window.ts (pure) so it's the single boundary the seed-
// freshness gate (isSeedFresh) shares with this windowed scan (#331).
export function recentWindowStart(profileId: number): string {
  return shiftDateStr(today(profileId), -RECENT_WINDOW_DAYS);
}

// Inclusive start date (YYYY-MM-DD) of a profile's "this week" window: either the
// current calendar week (from the configured week-start day) or a rolling 7-day
// window, per the profile's week_mode. Delegates to the shared `weekWindow`
// computation (lib/week-window.ts) so the weekly-routine counters, the journal
// week summary, and the weekly recap all agree on which days count (issue #223).
export function weekWindowStart(profileId: number): string {
  return weekWindow(
    today(profileId),
    getWeekMode(profileId),
    getWeekStart(profileId)
  ).start;
}

// All dated weights ascending, for bodyweightAsOf lookups. Weightless
// body-metrics rows (HR/body-fat only) are excluded — no bodyweight.
// cache(): both getStrengthByExercise and getRecentExerciseHistory load this, so a
// page rendering both (journal, strength) would otherwise scan the weight history
// twice — cache() collapses it to one scan per profile per request.
export const loadWeightsAsc = cache(function loadWeightsAsc(
  profileId: number
): { date: string; weight_kg: number }[] {
  return db
    .prepare(
      "SELECT date, weight_kg FROM body_metrics WHERE profile_id = ? AND weight_kg IS NOT NULL ORDER BY date ASC"
    )
    .all(profileId) as { date: string; weight_kg: number }[];
});

// One logged cardio/sport effort, identified by its canonical activity name.
// The name comes from the activity's structured component (e.g. "Running"); the
// freeform activity title ("Morning run", "5k run") is NOT used for grouping, so
// the same activity combines across differently-titled sessions. Activities with
// no matching component (legacy/imported rows) fall back to the title + the
// row's own distance/duration.
interface EffortEntry {
  activityId: number;
  date: string;
  name: string;
  distanceKm: number;
  durationMin: number;
  intensity: string | null; // from the activity row (shared by its components)
}

// cache(): a single page can aggregate the same (profile, type) efforts 3–4 times
// per request (getCardioByActivity + getCardioVolumeByWeek + getCardioIntensityMix
// on the training page; + getSportByActivity/journal), each a full activities scan
// with per-row JSON.parse. cache() computes it once per (profile, type[, since])
// per request. Pass `since` (YYYY-MM-DD) to bound the scan — used only by the
// suggestion path, which needs recent names, not all history; the stats
// aggregators call with no `since` so they still see the full record.
export const effortEntries = cache(function effortEntries(
  profileId: number,
  targetType: "cardio" | "sport",
  since?: string
): EffortEntry[] {
  const args: (string | number)[] = since
    ? [profileId, targetType, since]
    : [profileId, targetType];
  const rows = db
    .prepare(
      `SELECT id, date, type, title, distance_km, duration_min, intensity, components
       FROM activities
       WHERE profile_id = ? AND (type = ? OR components IS NOT NULL)${
         since ? " AND date >= ?" : ""
       }
       ORDER BY date ASC, id ASC`
    )
    .all(...args) as {
    id: number;
    date: string;
    type: string;
    title: string;
    distance_km: number | null;
    duration_min: number | null;
    intensity: string | null;
    components: string | null;
  }[];

  const out: EffortEntry[] = [];
  for (const r of rows) {
    const comps: ActivityComponent[] = parseComponents(r.components);
    const matching = comps.filter(
      (c) =>
        c?.type === targetType && typeof c.name === "string" && c.name.trim()
    );
    if (matching.length) {
      for (const c of matching) {
        out.push({
          activityId: r.id,
          date: r.date,
          name: c.name.trim(),
          distanceKm: c.distance_km ?? 0,
          durationMin: c.duration_min ?? 0,
          intensity: r.intensity,
        });
      }
    } else if (r.type === targetType && r.title.trim()) {
      out.push({
        activityId: r.id,
        date: r.date,
        name: r.title.trim(),
        distanceKm: r.distance_km ?? 0,
        durationMin: r.duration_min ?? 0,
        intensity: r.intensity,
      });
    }
  }
  return out;
});

// Previously-logged cardio/sport activity names (canonical, from components),
// with recency-decayed usage weights — for the activity picker's frequency-
// ranked suggestions (issue #195: a recent activity outranks a stale one).
// Bounded to the recent window: suggestions rank by recent usage, so a name not
// logged in the last 12 months needn't be offered as a prior custom name.
export function effortNameCounts(
  profileId: number,
  targetType: "cardio" | "sport"
): { name: string; c: number }[] {
  const t = today(profileId);
  const counts = new Map<string, { name: string; c: number }>();
  for (const e of effortEntries(
    profileId,
    targetType,
    recentWindowStart(profileId)
  )) {
    const key = e.name.toLowerCase();
    const w = decayedWeight(e.date, t);
    const prev = counts.get(key);
    if (prev) prev.c += w;
    else counts.set(key, { name: e.name, c: w });
  }
  return [...counts.values()];
}

// Distinct, readable colors assigned to cardio activities in the weekly chart.
export const CARDIO_PALETTE = [
  "#0ea5e9",
  "#16a34a",
  "#a855f7",
  "#f97316",
  "#ef4444",
  "#14b8a6",
  "#eab308",
  "#6366f1",
];

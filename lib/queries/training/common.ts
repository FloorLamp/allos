import { soleComponentDuration } from "../../activity-meta";
import { shiftDateStr } from "../../date";
import { db, today } from "../../db";
import { decayedWeight } from "../../decay";
import { RECENT_WINDOW_DAYS } from "../../exercise-window";
import type { ActivityComponent } from "../../types";
import { parseComponents } from "../../types";
import { cache } from "../../request-cache";
import { activityDetailHref } from "../../ride-detail";
import type { AppRoute } from "../../hrefs";

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
  href: AppRoute;
  date: string;
  name: string;
  distanceKm: number;
  durationMin: number;
  intensity: string | null; // from the activity row (shared by its components)
  avgHr: number | null;
  elevationM: number | null;
  avgPowerW: number | null;
  weightedAvgPowerW: number | null;
  avgCadence: number | null;
  relativeEffort: number | null;
  kilojoules: number | null;
}

// cache(): a single page can aggregate the same (profile, type) efforts 3–4 times
// per request (getCardioByActivity + getCardioVolumeByWeek + getCardioIntensityMix
// on the training page; + getSportByActivity/journal), each a full activities scan
// with per-row JSON.parse. cache() computes it once per (profile, type[, since])
// per request. Pass `since` (YYYY-MM-DD) to bound the scan — used by the
// suggestion path, which needs recent names rather than all history, and by the
// Trends → Fitness lens (#1492), which bounds BOTH ends to the hub's shared window
// (`until`). Omitting both still sees the full record, so the /training stats
// aggregators are unchanged.
export const effortEntries = cache(function effortEntries(
  profileId: number,
  targetType: "cardio" | "sport",
  since?: string,
  until?: string
): EffortEntry[] {
  const args: (string | number)[] = [profileId, targetType];
  if (since) args.push(since);
  if (until) args.push(until);
  const rows = db
    .prepare(
      `SELECT id, date, type, title, distance_km, duration_min, intensity, components,
              avg_hr, elevation_m, avg_power_w, weighted_avg_power_w,
              avg_cadence, relative_effort, kilojoules
       FROM activities
       WHERE profile_id = ? AND (type = ? OR components IS NOT NULL)${
         since ? " AND date >= ?" : ""
       }${until ? " AND date <= ?" : ""}
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
    avg_hr: number | null;
    elevation_m: number | null;
    avg_power_w: number | null;
    weighted_avg_power_w: number | null;
    avg_cadence: number | null;
    relative_effort: number | null;
    kilojoules: number | null;
  }[];

  const out: EffortEntry[] = [];
  for (const r of rows) {
    const comps: ActivityComponent[] = parseComponents(r.components);
    const matching = comps.filter(
      (c) =>
        c?.type === targetType && typeof c.name === "string" && c.name.trim()
    );
    if (matching.length) {
      // Heal clock-only sessions (#791): a sole cardio/sport component logged
      // with Start/End times but no typed Duration stored null on the component,
      // even though the parent row carries the clock-derived minutes. When it's
      // the activity's ONLY component, fall back to that parent duration_min; the
      // sole-component guard (comps.length === 1) keeps a mixed strength+sport
      // session from attributing the strength minutes to its sport leg.
      const isSoleComponent = comps.length === 1;
      for (const c of matching) {
        out.push({
          activityId: r.id,
          href: activityDetailHref(r),
          date: r.date,
          name: c.name.trim(),
          distanceKm: c.distance_km ?? 0,
          durationMin:
            soleComponentDuration({
              componentDurationMin: c.duration_min ?? null,
              isSoleComponent,
              isStrength: false,
              sessionDurationMin: r.duration_min ?? null,
            }) ?? 0,
          intensity: r.intensity,
          avgHr: r.avg_hr,
          elevationM: r.elevation_m,
          avgPowerW: r.avg_power_w,
          weightedAvgPowerW: r.weighted_avg_power_w,
          avgCadence: r.avg_cadence,
          relativeEffort: r.relative_effort,
          kilojoules: r.kilojoules,
        });
      }
    } else if (r.type === targetType && r.title.trim()) {
      out.push({
        activityId: r.id,
        href: activityDetailHref(r),
        date: r.date,
        name: r.title.trim(),
        distanceKm: r.distance_km ?? 0,
        durationMin: r.duration_min ?? 0,
        intensity: r.intensity,
        avgHr: r.avg_hr,
        elevationM: r.elevation_m,
        avgPowerW: r.avg_power_w,
        weightedAvgPowerW: r.weighted_avg_power_w,
        avgCadence: r.avg_cadence,
        relativeEffort: r.relative_effort,
        kilojoules: r.kilojoules,
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

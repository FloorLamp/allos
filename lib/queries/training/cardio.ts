import { speedKmh } from "../../coaching";
import { startOfWeekStr } from "../../date";
import { formatMinutes } from "../../duration";
import { formatLongDate } from "../../format-date";
import type { DistanceUnit } from "../../settings";
import { getWeekStart } from "../../settings";
import { assignHashedColors } from "../../trend-colors";
import { fmtDistance } from "../../units";
import { weeklyChartWeeks } from "../../weekly-fill";
import { CARDIO_PALETTE, cache, effortEntries } from "./common";

// One summarized recent cardio session for the cardio detail panel. `text` is
// preformatted (units applied server-side) so the client panel needs no units.
export interface CardioSessionSummary {
  date: string;
  href: string;
  text: string;
}

// Per-cardio-activity stats for the Training page's Cardio section: totals,
// records (longest distance, fastest avg speed, longest duration) with the date
// each was set, a per-session trend, and the last few sessions. Aggregates
// top-level `cardio` activity rows (mirrors getStrengthByExercise).
export interface CardioStat {
  activity: string;
  sessions: number;
  totalDistanceKm: number;
  totalDurationMin: number;
  longestDistanceKm: number;
  longestDistanceDate: string;
  longestDurationMin: number;
  longestDurationDate: string;
  fastestKmh: number; // 0 when no distance-and-duration session exists
  fastestKmhDate: string;
  hasDistance: boolean;
  lastDate: string;
  lastActivityId: number;
  // One point per session (date ascending) for the trend chart.
  trend: {
    activityId: number;
    date: string;
    distanceKm: number;
    durationMin: number;
    speedKmh: number | null;
  }[];
  recent: CardioSessionSummary[];
}

// cache(): like getStrengthByExercise, a single Training render aggregates every
// cardio effort several times (Overview, Analyze, Cardio, Log) and the dashboard
// coaching context reads it again. All callers pass the same (profile, unit) and
// omit recentLimit, so the request-scoped key is stable. Safe: pure read.
export const getCardioByActivity = cache(function getCardioByActivity(
  profileId: number,
  unit: DistanceUnit,
  recentLimit = 10
): CardioStat[] {
  interface Acc extends Omit<CardioStat, "activity"> {
    activity: string;
  }
  const map = new Map<string, Acc>();
  for (const e of effortEntries(profileId, "cardio")) {
    const key = e.name.toLowerCase();
    let cur = map.get(key);
    if (!cur) {
      cur = {
        activity: e.name,
        sessions: 0,
        totalDistanceKm: 0,
        totalDurationMin: 0,
        longestDistanceKm: 0,
        longestDistanceDate: e.date,
        longestDurationMin: 0,
        longestDurationDate: e.date,
        fastestKmh: 0,
        fastestKmhDate: e.date,
        hasDistance: false,
        lastDate: e.date,
        lastActivityId: e.activityId,
        trend: [],
        recent: [],
      };
      map.set(key, cur);
    }
    cur.sessions += 1;
    const dist = e.distanceKm;
    const dur = e.durationMin;
    cur.totalDistanceKm += dist;
    cur.totalDurationMin += dur;
    if (dist > 0) cur.hasDistance = true;
    if (dist > cur.longestDistanceKm) {
      cur.longestDistanceKm = dist;
      cur.longestDistanceDate = e.date;
    }
    if (dur > cur.longestDurationMin) {
      cur.longestDurationMin = dur;
      cur.longestDurationDate = e.date;
    }
    const spd = speedKmh(dist, dur);
    if (spd != null && spd > cur.fastestKmh) {
      cur.fastestKmh = spd;
      cur.fastestKmhDate = e.date;
    }
    if (e.date >= cur.lastDate) {
      cur.lastDate = e.date;
      cur.lastActivityId = e.activityId;
    }
    cur.trend.push({
      activityId: e.activityId,
      date: e.date,
      distanceKm: dist,
      durationMin: dur,
      speedKmh: spd,
    });
    // Newest-first recent list (entries are ascending, so prepend).
    cur.recent.unshift({
      date: formatLongDate(e.date),
      href: `/training?tab=log#activity-${e.activityId}`,
      text:
        dist > 0
          ? `${fmtDistance(dist, unit)} · ${formatMinutes(dur || null)}`
          : formatMinutes(dur || null),
    });
  }

  return [...map.values()]
    .map((c) => ({ ...c, recent: c.recent.slice(0, recentLimit) }))
    .sort(
      (a, b) => b.sessions - a.sessions || (a.activity < b.activity ? -1 : 1)
    );
});

export interface CardioWeeklyVolume {
  data: Record<string, number | string>[];
  series: { key: string; label: string; color: string }[];
}

// Weekly cardio training time (minutes), stacked by activity, over the last
// `weeks` weeks that have data. Duration is the universal metric — every cardio
// effort has it (unlike distance), so HIIT/rowing-without-distance are included.
export function getCardioVolumeByWeek(
  profileId: number,
  weeks = 12
): CardioWeeklyVolume {
  const weekStart = getWeekStart(profileId);
  const byWeek = new Map<string, Map<string, number>>();
  const activityTotals = new Map<string, number>();
  for (const e of effortEntries(profileId, "cardio")) {
    const wk = startOfWeekStr(e.date, weekStart);
    let m = byWeek.get(wk);
    if (!m) byWeek.set(wk, (m = new Map()));
    m.set(e.name, (m.get(e.name) ?? 0) + e.durationMin);
    activityTotals.set(
      e.name,
      (activityTotals.get(e.name) ?? 0) + e.durationMin
    );
  }
  // Color follows the ACTIVITY NAME (a stable hash), NOT its volume rank (issue
  // #406): after a long ride pushes Cycling ahead of Running, Running must keep its
  // color, not inherit the color of whatever now sits at its old rank. Rank is used
  // only for legend/stack ORDER. Colors de-collide within the visible set.
  const colors = assignHashedColors([...activityTotals.keys()], CARDIO_PALETTE);
  const series = [...activityTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => ({
      key: name,
      label: name,
      color: colors.get(name) ?? CARDIO_PALETTE[0],
    }));
  // Zero-fill the week range so training GAPS render as empty bars instead of
  // compressing away (issue #406) — a category BarChart can't otherwise show that
  // months of zero-minute weeks separate two bars.
  const data = weeklyChartWeeks([...byWeek.keys()], weeks).map((wk) => {
    // Full week-start date (the profile's configured first weekday);
    // StackedBarCard compacts the axis to MM-DD and expands the tooltip to a
    // long date.
    const row: Record<string, number | string> = { date: wk };
    const m = byWeek.get(wk);
    for (const s of series) row[s.key] = Math.round(m?.get(s.key) ?? 0);
    return row;
  });
  return { data, series };
}

export interface IntensityBucket {
  intensity: string; // "Easy" | "Moderate" | "Hard" | "Unspecified"
  minutes: number;
  sessions: number;
}

// Cardio time + session counts grouped by intensity, for the intensity-mix bar.
export function getCardioIntensityMix(profileId: number): IntensityBucket[] {
  const order = ["easy", "moderate", "hard"];
  const buckets = new Map<string, { minutes: number; sessions: number }>();
  for (const e of effortEntries(profileId, "cardio")) {
    const key = (e.intensity ?? "").trim().toLowerCase();
    const norm = order.includes(key) ? key : "unspecified";
    const b = buckets.get(norm) ?? { minutes: 0, sessions: 0 };
    b.minutes += e.durationMin;
    b.sessions += 1;
    buckets.set(norm, b);
  }
  const cap = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);
  return [...order, "unspecified"]
    .filter((k) => buckets.has(k))
    .map((k) => ({
      intensity: cap(k),
      minutes: Math.round(buckets.get(k)!.minutes),
      sessions: buckets.get(k)!.sessions,
    }));
}

// Per-sport stats for the Training page's Sport explorer + journal detail.
// Sports are duration-only (no distance/speed); tolerates a null duration
// (counts the session, sums/maxes the known durations).
export interface SportStat {
  sport: string;
  sessions: number;
  totalDurationMin: number;
  longestDurationMin: number;
  longestDurationDate: string;
  lastDate: string;
  lastActivityId: number;
  // One point per session (date ascending) for the duration trend chart.
  trend: {
    activityId: number;
    date: string;
    durationMin: number;
    intensity: string | null;
  }[];
  recent: CardioSessionSummary[];
}

export function getSportByActivity(
  profileId: number,
  recentLimit = 10
): SportStat[] {
  const map = new Map<string, SportStat>();
  for (const e of effortEntries(profileId, "sport")) {
    const key = e.name.toLowerCase();
    let cur = map.get(key);
    if (!cur) {
      cur = {
        sport: e.name,
        sessions: 0,
        totalDurationMin: 0,
        longestDurationMin: 0,
        longestDurationDate: e.date,
        lastDate: e.date,
        lastActivityId: e.activityId,
        trend: [],
        recent: [],
      };
      map.set(key, cur);
    }
    cur.sessions += 1;
    const dur = e.durationMin;
    cur.totalDurationMin += dur;
    if (dur > cur.longestDurationMin) {
      cur.longestDurationMin = dur;
      cur.longestDurationDate = e.date;
    }
    if (e.date >= cur.lastDate) {
      cur.lastDate = e.date;
      cur.lastActivityId = e.activityId;
    }
    cur.trend.push({
      activityId: e.activityId,
      date: e.date,
      durationMin: dur,
      intensity: e.intensity,
    });
    // Newest-first recent list (entries are ascending, so prepend).
    cur.recent.unshift({
      date: formatLongDate(e.date),
      href: `/training?tab=log#activity-${e.activityId}`,
      text: formatMinutes(dur || null),
    });
  }

  return [...map.values()]
    .map((s) => ({ ...s, recent: s.recent.slice(0, recentLimit) }))
    .sort((a, b) => b.sessions - a.sessions || (a.sport < b.sport ? -1 : 1));
}

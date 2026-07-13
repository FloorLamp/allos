// Training coaching — cardio: speed derivation and cardio personal records.
// Pure and client-safe — no DB/network.
import { within, byDateDesc } from "./common";

// ---- Cardio ----

// Average speed in km/h, or null when distance or duration is missing/zero
// (can't derive a speed). Unit-agnostic, for comparison and ranking.
export function speedKmh(
  km: number | null | undefined,
  durationMin: number | null | undefined
): number | null {
  if (km == null || durationMin == null || km <= 0 || durationMin <= 0)
    return null;
  return km / (durationMin / 60);
}

// Per-cardio-activity stats this module needs for PR detection.
export interface CardioSummary {
  activity: string;
  sessions: number;
  hasDistance: boolean; // any session logged a distance (else duration-only)
  longestDistanceKm: number;
  longestDistanceDate: string;
  fastestKmh: number; // 0 when no distance-and-duration session exists
  fastestKmhDate: string;
  longestDurationMin: number;
  longestDurationDate: string;
}

export interface CardioPR {
  activity: string;
  kind: "distance" | "speed" | "duration";
  date: string;
  distanceKm: number;
  durationMin: number;
  speedKmh: number;
}

// Cardio records set within the last `withinDays`, newest first. Distance and
// speed PRs only apply when the activity has distance data; every cardio gets a
// duration PR. First-ever sessions are excluded.
export function recentCardioPRs(
  stats: CardioSummary[],
  today: string,
  withinDays = 30
): CardioPR[] {
  const prs: CardioPR[] = [];
  for (const s of stats) {
    if (s.sessions < 2) continue;
    if (
      s.hasDistance &&
      s.longestDistanceKm > 0 &&
      within(s.longestDistanceDate, today, withinDays)
    ) {
      prs.push({
        activity: s.activity,
        kind: "distance",
        date: s.longestDistanceDate,
        distanceKm: s.longestDistanceKm,
        durationMin: 0,
        speedKmh: 0,
      });
    }
    if (
      s.hasDistance &&
      s.fastestKmh > 0 &&
      within(s.fastestKmhDate, today, withinDays)
    ) {
      prs.push({
        activity: s.activity,
        kind: "speed",
        date: s.fastestKmhDate,
        distanceKm: 0,
        durationMin: 0,
        speedKmh: s.fastestKmh,
      });
    }
    if (
      s.longestDurationMin > 0 &&
      within(s.longestDurationDate, today, withinDays)
    ) {
      prs.push({
        activity: s.activity,
        kind: "duration",
        date: s.longestDurationDate,
        distanceKm: 0,
        durationMin: s.longestDurationMin,
        speedKmh: 0,
      });
    }
  }
  return prs.sort(byDateDesc);
}

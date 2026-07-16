// Historical-duration comparison for an OPEN illness episode (issue #856 item 10). A
// CALM, coaching-tier context line — "day 5; your last 3 illnesses ran 4–6 days" — shown
// only on the open-episode page. NOT a notification and NOT the dashboard hero (the
// findings two-tier discipline #449: this is observational context, never a push). It
// formats over the SAME per-episode assembly (durations come from the stored rows via
// summarizeEpisodesForProfile), so there is no second duration engine. Auth-blind,
// profileId-first.
//
// The household-overlap half of item 10 is already served by the existing sick-household
// card (#837, grants-scoped); this module owns the duration-comparison half.

import { today } from "./db";
import { daysBetweenDateStr } from "./date";
import { getEpisodeRow } from "./illness-episode-store";
import { summarizeEpisodesForProfile } from "./illness-episode-summary";

export interface EpisodeComparison {
  currentDay: number; // day N of the open episode (start day = 1)
  priorCount: number; // how many prior CLOSED episodes fed the range
  minDays: number;
  maxDays: number;
  medianDays: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// Comparison for the open episode `episodeId`, or null when it isn't open, has no known
// start, or there are no prior closed episodes to compare against.
export function episodeComparisonFor(
  profileId: number,
  episodeId: number
): EpisodeComparison | null {
  const row = getEpisodeRow(profileId, episodeId);
  if (!row || row.ended_at != null || !row.started_at) return null;

  const currentDay = Math.max(
    1,
    (daysBetweenDateStr(row.started_at, today(profileId)) ?? 0) + 1
  );

  // Prior CLOSED episodes with a known day-count, excluding this one.
  const priorDurations = summarizeEpisodesForProfile(profileId)
    .filter((e) => e.id !== episodeId && !e.ongoing && e.dayCount != null)
    .map((e) => e.dayCount as number);
  if (priorDurations.length === 0) return null;

  return {
    currentDay,
    priorCount: priorDurations.length,
    minDays: Math.min(...priorDurations),
    maxDays: Math.max(...priorDurations),
    medianDays: median(priorDurations),
  };
}

// The calm one-liner the card renders (pure formatter over the comparison).
export function episodeComparisonLine(c: EpisodeComparison): string {
  const range =
    c.minDays === c.maxDays
      ? `${c.minDays} day${c.minDays === 1 ? "" : "s"}`
      : `${c.minDays}–${c.maxDays} days`;
  const n =
    c.priorCount === 1
      ? "your last illness ran"
      : `your last ${c.priorCount} illnesses ran`;
  return `Day ${c.currentDay} — ${n} ${range}.`;
}

// Stale-open illness-episode detection — PURE (issue #859 item 1). No DB/network, so
// it's unit-tested in lib/__tests__ and shared by the hero/card nudge + the DB gather
// (lib/stale-episode-data.ts). This is a SUGGEST-ONLY signal (never a Finding, never
// auto-closes — the #560 suggest-only bridge discipline): everything now hangs off an
// "open" episode (the hero cockpit, coaching suppression, household lines, episode
// durations), so a forgotten-open episode quietly rots the whole surface. After N
// quiet days (no symptom / temperature / administration logged) the caregiver is
// OFFERED a one-tap BACKDATED end as of the last activity day — they decide.

import { daysBetweenDateStr } from "./date";
import type { AssembledEpisode } from "./illness-episode-format";

// The default number of consecutive quiet days before the nudge appears.
export const DEFAULT_STALE_QUIET_DAYS = 3;

export interface StaleEpisodeState {
  // The last day ANY signal (symptom / temperature / administration) was logged in the
  // episode, or the episode's first day when nothing was ever logged. This is the
  // date the backdated end would use (the episode was last "alive" then).
  lastActivityDate: string | null;
  // Whole days since the last activity, as of the episode's asOf. Null when neither a
  // last-activity nor an asOf date is known.
  quietDays: number | null;
  // Whether the episode is stale: open + quiet for at least the threshold.
  isStale: boolean;
}

// The latest date any signal was logged in the assembled episode. The assembly's
// series are one-per-day; we scan all three ingredient kinds and take the max date.
function lastSignalDate(ep: AssembledEpisode): string | null {
  let max: string | null = null;
  const consider = (d: string) => {
    if (max == null || d > max) max = d;
  };
  for (const s of ep.symptoms) for (const p of s.points) consider(p.date);
  for (const t of ep.temperatures) consider(t.date);
  for (const m of ep.medications)
    for (const a of m.administrations) consider(a.date);
  return max;
}

// Whether an OPEN episode has gone quiet for `quietThresholdDays` (default 3). A
// closed episode is never stale (it already has an end). Pure.
export function computeStaleEpisode(
  ep: AssembledEpisode,
  quietThresholdDays: number = DEFAULT_STALE_QUIET_DAYS
): StaleEpisodeState {
  // Fall back to the episode's first day when nothing was ever logged, so a bare
  // opened-but-never-used episode still ages toward the nudge.
  const lastActivityDate = lastSignalDate(ep) ?? ep.firstDay;
  const quietDays =
    lastActivityDate != null
      ? daysBetweenDateStr(lastActivityDate, ep.asOf)
      : null;
  const isStale =
    ep.ongoing && quietDays != null && quietDays >= quietThresholdDays;
  return { lastActivityDate, quietDays, isStale };
}

// The DB gather + acked-marker store behind the stale-open-episode nudge (issue #859
// item 1). Auth-blind (profileId-first, never imports lib/auth) — the Server Action
// owns the gate. The nudge is SUGGEST-ONLY and NEVER auto-closes (#560): it surfaces
// on the hero cockpit + episode page, and the caregiver taps to backdate-end.
//
// The per-episode ACK marker keeps the nudge from nagging daily: once the caregiver
// dismisses it ("keep the episode open") the episode id is remembered, so the same
// open episode never re-prompts. Ids never recycle (AUTOINCREMENT), so an acked id is
// permanently silenced — exactly the intent. Stored as a small JSON array in a single
// profile setting (no schema change, bounded by the profile's episode count).

import { getProfileSetting, setProfileSetting } from "./settings";
import { openEpisodeForProfile } from "./illness-episode";
import { computeStaleEpisode } from "./stale-episode";

const ACK_KEY = "stale_nudge_acked";

// The set of episode ids the caregiver has dismissed the stale nudge for.
export function getStaleNudgeAcked(profileId: number): Set<number> {
  const raw = getProfileSetting(profileId, ACK_KEY);
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is number => typeof x === "number"));
  } catch {
    return new Set();
  }
}

// Remember that the stale nudge for this episode was dismissed. Idempotent.
export function ackStaleNudge(profileId: number, episodeId: number): void {
  const acked = getStaleNudgeAcked(profileId);
  if (acked.has(episodeId)) return;
  acked.add(episodeId);
  setProfileSetting(profileId, ACK_KEY, JSON.stringify([...acked].sort()));
}

export interface StaleEpisodeNudge {
  episodeId: number;
  situation: string;
  lastActivityDate: string;
  quietDays: number;
}

// The stale-episode nudge for a profile's current open episode, or null when there's
// no open episode, it isn't stale yet, or its nudge was already dismissed. `nowAsOf`
// is unused directly (the assembly resolves asOf in the profile timezone) but the
// `quietThresholdDays` is injectable for tests.
export function staleEpisodeNudgeFor(
  profileId: number,
  quietThresholdDays?: number
): StaleEpisodeNudge | null {
  const ep = openEpisodeForProfile(profileId);
  if (!ep || ep.id == null) return null;
  if (getStaleNudgeAcked(profileId).has(ep.id)) return null;
  const state = computeStaleEpisode(ep, quietThresholdDays);
  if (
    !state.isStale ||
    state.lastActivityDate == null ||
    state.quietDays == null
  ) {
    return null;
  }
  return {
    episodeId: ep.id,
    situation: ep.situation,
    lastActivityDate: state.lastActivityDate,
    quietDays: state.quietDays,
  };
}

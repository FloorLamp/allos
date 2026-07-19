// The merged cross-profile household visit + illness-episode history (issue #1009).
//
// ONE gather, one computation (#221): every accessible profile's PAST visits
// (encounters) and illness episodes are read through the SAME per-profile query
// functions the per-person Visits / Illness-episodes pages already use — no new
// cross-profile SQL — then merged into ONE date-ordered, person-tagged stream. The
// merged household view, the per-person filtered view, AND the episode-page
// household-context card are all FORMATTERS over this result, never a second engine.
//
// Auth-blind, profileId-LIST-first: every function here takes the ALREADY-RESOLVED
// set of profile ids (the viewing login's accessible set — the same access basis as
// the household strip / family calendar). The AUTH decision (which profiles the login
// may see) stays at the page/action layer via getAccessibleProfiles; this module
// never imports lib/auth. Because it composes the existing profile-scoped readers
// (getEncounters, summarizeEpisodesForProfile) it introduces no un-scoped SQL, so the
// profile-scoping rule holds without a new allowlist entry.

import { today } from "./db";
import { daysBetweenDateStr } from "./date";
import { getEncounters } from "./queries/medical";
import { summarizeEpisodesForProfile } from "./illness-episode-summary";
import {
  getEpisodeRowForDate,
  mostRecentClosedEpisodeRow,
} from "./illness-episode-store";
import type { EpisodeIndexEntry } from "./illness-episode-summary";
import type { Encounter } from "./types";

// ── The merged-stream item shapes ─────────────────────────────────────────────

export interface HouseholdVisitItem {
  kind: "visit";
  profileId: number;
  encounterId: number;
  date: string; // the visit date (encounters always carry one)
  endDate: string | null;
  type: string | null;
  reason: string | null;
  providerName: string | null;
  locationName: string | null;
}

export interface HouseholdEpisodeItem {
  kind: "episode";
  profileId: number;
  episodeId: number;
  situation: string;
  start: string | null; // inclusive first active day (null = before the log)
  end: string | null; // EXCLUSIVE end (null = ongoing)
  firstDay: string | null;
  lastActiveDay: string | null;
  ongoing: boolean;
  dayCount: number | null;
  maxTempF: number | null;
  symptomLabels: string[];
}

export type HouseholdHistoryItem = HouseholdVisitItem | HouseholdEpisodeItem;

// The chronological sort key for an item: a visit sorts by its date; an episode by
// its first active day (falling back to its stored start, then last active day) so an
// episode with an unknown start still lands near its data.
export function historyItemSortDate(item: HouseholdHistoryItem): string {
  if (item.kind === "visit") return item.date;
  return item.firstDay ?? item.start ?? item.lastActiveDay ?? "";
}

// A pure, stable merge: most-recent first (descending by sort date), ties broken
// deterministically (visits before episodes on the same day, then by id) so the
// stream never reorders between renders. Does NOT mutate the input.
export function mergeHouseholdHistory(
  items: HouseholdHistoryItem[]
): HouseholdHistoryItem[] {
  return [...items].sort((a, b) => {
    const da = historyItemSortDate(a);
    const db = historyItemSortDate(b);
    if (da !== db) return da < db ? 1 : -1; // descending (newest first)
    if (a.kind !== b.kind) return a.kind === "visit" ? -1 : 1;
    const ia = a.kind === "visit" ? a.encounterId : a.episodeId;
    const ib = b.kind === "visit" ? b.encounterId : b.episodeId;
    return ib - ia; // newer row (higher id) first
  });
}

function visitItem(profileId: number, e: Encounter): HouseholdVisitItem {
  return {
    kind: "visit",
    profileId,
    encounterId: e.id,
    date: e.date,
    endDate: e.end_date,
    type: e.type,
    reason: e.reason,
    providerName: e.provider_name,
    locationName: e.location_name,
  };
}

function episodeItem(
  profileId: number,
  e: EpisodeIndexEntry
): HouseholdEpisodeItem {
  return {
    kind: "episode",
    profileId,
    episodeId: e.id,
    situation: e.situation,
    start: e.start,
    end: e.end,
    firstDay: e.firstDay,
    lastActiveDay: e.lastActiveDay,
    ongoing: e.ongoing,
    dayCount: e.dayCount,
    maxTempF: e.maxTempF,
    symptomLabels: e.symptomLabels,
  };
}

// THE gather (Ask 1). Every past encounter + illness episode across the resolved
// profile set, merged into one person-tagged stream. Bounded work — a household is a
// handful of profiles, each a few profile-scoped reads (the same cost shape as the
// household dashboard's per-profile loop). The per-person filtered view is just this
// list filtered by `profileId` in the formatter (one computation).
export function gatherHouseholdHistory(
  profileIds: number[]
): HouseholdHistoryItem[] {
  const items: HouseholdHistoryItem[] = [];
  for (const pid of profileIds) {
    for (const e of getEncounters(pid)) items.push(visitItem(pid, e));
    for (const e of summarizeEpisodesForProfile(pid)) {
      items.push(episodeItem(pid, e));
    }
  }
  return mergeHouseholdHistory(items);
}

// ── Ask 2: contextual-promotion predicate ─────────────────────────────────────

// "Recently sick" window — how many days after an illness episode closes the
// household history stays promoted. Reuses the episode framework's recency notion
// (the ease-back ramp / stale window are the short-form cousins); a two-week window
// keeps "what's been going around the house" contextually useful without nagging once
// the house has clearly recovered. Documented + injectable so tests pin the boundary.
export const HOUSEHOLD_RECENTLY_SICK_DAYS = 14;

// PURE recency check for one profile: is it currently sick (an episode covers today),
// or did its most recent episode close within `windowDays` of today? Split out so the
// boundary is unit-testable without a DB.
export function isRecentlySickOn(
  hasOpenToday: boolean,
  closedEndDate: string | null,
  todayStr: string,
  windowDays: number = HOUSEHOLD_RECENTLY_SICK_DAYS
): boolean {
  if (hasOpenToday) return true;
  if (!closedEndDate) return false;
  const ago = daysBetweenDateStr(closedEndDate, todayStr);
  return ago != null && ago >= 0 && ago <= windowDays;
}

// The DB gather behind Ask 2 (dashboard promotion). True when ANY profile in the set
// is currently sick (an episode row covers that profile's today) or recently recovered
// (its most-recently-closed episode ended within the window). Reuses the SAME episode
// rows every illness surface reads — never a second "who's sick" derivation. Each
// profile's "today" is resolved in its own timezone via today(pid).
export function isHouseholdRecentlySick(
  profileIds: number[],
  windowDays: number = HOUSEHOLD_RECENTLY_SICK_DAYS
): boolean {
  for (const pid of profileIds) {
    const day = today(pid);
    const hasOpenToday = getEpisodeRowForDate(pid, day) != null;
    const closed = mostRecentClosedEpisodeRow(pid);
    if (
      isRecentlySickOn(hasOpenToday, closed?.ended_at ?? null, day, windowDays)
    ) {
      return true;
    }
  }
  return false;
}

// ── Ask 3: episode-page household-context computation ─────────────────────────

// How close (in days) another member's episode may sit to the focal episode's window
// and still count as "closely precede/follow". An overlap is always included; a gap up
// to this many days reads as adjacent context.
export const EPISODE_ADJACENCY_DAYS = 7;

export interface HouseholdEpisodeContext {
  profileId: number;
  episodeId: number;
  situation: string;
  firstDay: string | null;
  lastActiveDay: string | null;
  ongoing: boolean;
  // "overlap" — the windows share ≥1 day; "before" — the other episode ended before
  // the focal one started; "after" — it started after the focal one's last active day.
  relation: "overlap" | "before" | "after";
  // Overlap length (relation === "overlap") or the gap in days (before/after). A dated
  // FACT only — never a causality claim (#1009 scope line: "overlapped", never "caught
  // it from").
  days: number;
}

// Inclusive-day overlap between two [start, end] windows, or 0 when they don't touch.
function overlapDays(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string
): number {
  const start = aStart > bStart ? aStart : bStart;
  const end = aEnd < bEnd ? aEnd : bEnd;
  if (start > end) return 0;
  return (daysBetweenDateStr(start, end) ?? 0) + 1;
}

// PURE: for a focal episode's window, the other members' episodes that overlap or
// closely precede/follow it, most-relevant first (overlaps by longest overlap, then
// adjacent episodes by smallest gap). Candidates must be from OTHER profiles (the
// caller passes only other members' episodes) and carry a concrete [firstDay,
// lastActiveDay] window; anything without one, or beyond the adjacency window, is
// dropped. Returns [] when nothing qualifies (the card then renders nothing).
export function computeHouseholdEpisodeContext(
  focal: { firstDay: string | null; lastActiveDay: string | null },
  candidates: HouseholdEpisodeItem[],
  adjacencyDays: number = EPISODE_ADJACENCY_DAYS
): HouseholdEpisodeContext[] {
  const fStart = focal.firstDay;
  const fEnd = focal.lastActiveDay;
  if (!fStart || !fEnd) return [];

  const out: HouseholdEpisodeContext[] = [];
  for (const c of candidates) {
    const cStart = c.firstDay;
    const cEnd = c.lastActiveDay;
    if (!cStart || !cEnd) continue;

    const overlap = overlapDays(fStart, fEnd, cStart, cEnd);
    if (overlap > 0) {
      out.push({
        profileId: c.profileId,
        episodeId: c.episodeId,
        situation: c.situation,
        firstDay: c.firstDay,
        lastActiveDay: c.lastActiveDay,
        ongoing: c.ongoing,
        relation: "overlap",
        days: overlap,
      });
      continue;
    }
    // No overlap: measure the gap on whichever side it sits.
    if (cEnd < fStart) {
      const gap = (daysBetweenDateStr(cEnd, fStart) ?? 0) - 1;
      if (gap <= adjacencyDays) {
        out.push({
          profileId: c.profileId,
          episodeId: c.episodeId,
          situation: c.situation,
          firstDay: c.firstDay,
          lastActiveDay: c.lastActiveDay,
          ongoing: c.ongoing,
          relation: "before",
          days: Math.max(0, gap),
        });
      }
    } else if (cStart > fEnd) {
      const gap = (daysBetweenDateStr(fEnd, cStart) ?? 0) - 1;
      if (gap <= adjacencyDays) {
        out.push({
          profileId: c.profileId,
          episodeId: c.episodeId,
          situation: c.situation,
          firstDay: c.firstDay,
          lastActiveDay: c.lastActiveDay,
          ongoing: c.ongoing,
          relation: "after",
          days: Math.max(0, gap),
        });
      }
    }
  }

  // Overlaps first (longest overlap first), then adjacent episodes by smallest gap;
  // ties broken by most-recent last active day, then id, for a stable order.
  const rank = (r: HouseholdEpisodeContext["relation"]) =>
    r === "overlap" ? 0 : 1;
  return out.sort((a, b) => {
    if (rank(a.relation) !== rank(b.relation))
      return rank(a.relation) - rank(b.relation);
    if (a.relation === "overlap") {
      if (a.days !== b.days) return b.days - a.days; // longest overlap first
    } else if (a.days !== b.days) {
      return a.days - b.days; // smallest gap first
    }
    const aEnd = a.lastActiveDay ?? "";
    const bEnd = b.lastActiveDay ?? "";
    if (aEnd !== bEnd) return aEnd < bEnd ? 1 : -1;
    return b.episodeId - a.episodeId;
  });
}

// The DB gather behind the episode-page card (Ask 3). Reads the OTHER accessible
// members' episodes (via the SAME summarize used by the merged view) and runs the pure
// overlap computation against the focal episode's window. `otherProfileIds` is already
// the viewing login's accessible set minus the focal profile — so the card is
// grant-scoped exactly like the merged view, and an ungranted member never appears.
export function gatherHouseholdEpisodeContext(
  focalProfileId: number,
  focal: { firstDay: string | null; lastActiveDay: string | null },
  otherProfileIds: number[],
  adjacencyDays: number = EPISODE_ADJACENCY_DAYS
): HouseholdEpisodeContext[] {
  const candidates: HouseholdEpisodeItem[] = [];
  for (const pid of otherProfileIds) {
    if (pid === focalProfileId) continue;
    for (const e of summarizeEpisodesForProfile(pid)) {
      candidates.push(episodeItem(pid, e));
    }
  }
  return computeHouseholdEpisodeContext(focal, candidates, adjacencyDays);
}

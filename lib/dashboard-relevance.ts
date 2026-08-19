// Atomic dashboard placement (#3077 / #3096).
//
// Candidates are facts, never cards. This module owns only deterministic
// placement; it imports no DB, auth, clock, or React code.

import { DEFAULT_INTAKE_REMINDER_MINUTES } from "./notifications/schedule";
import {
  resolveStandingMembers,
  type StandingFamilyKey,
  type StandingSectionKey,
} from "./dashboard-standing";

export type DashboardSubject =
  | { scope: "profile"; profileId: number }
  | { scope: "household" }
  | { scope: "login" };

export type DashboardTiming =
  | { kind: "always" }
  | {
      kind: "local-time";
      opensAt: number;
      closesAt: number;
      wrapsMidnight: boolean;
    }
  | {
      kind: "local-time-windows";
      windows: readonly {
        opensAt: number;
        closesAt: number;
        wrapsMidnight: boolean;
      }[];
    }
  | { kind: "since-event"; ageMinutes: number; maxMinutes: number }
  | { kind: "local-days"; ageDays: number; maxDays: number }
  | { kind: "until-signal"; active: boolean };

export type DashboardTimingDisposition =
  | { kind: "active" }
  | { kind: "future-today"; opensAt: number }
  | { kind: "expired" };

// The owner-ratified reading-promotion registry (#3077 / #3137). A reading may
// carry `changed` only when it names one of these existing semantic signals.
// Raw numeric deltas deliberately have no representation here.
export type DashboardReadingPromotion =
  | "clinical-non-notable-to-notable"
  | "weekly-target-transition"
  | "outcome-goal-transition"
  | "training-best"
  | "sleep-arrived"
  | "nap-ended";

export type DashboardCandidateKind =
  "action" | "reading" | "statement" | "state";
export type DashboardObligation = "must" | "should" | "may";
export type DashboardRelevancePolicy =
  | {
      kind: "profile-data";
      presence: "never" | "current" | "dormant";
      engagement: "unknown" | "manual" | "external";
    }
  | { kind: "event" }
  | { kind: "setup" }
  | { kind: "state" };

export interface DashboardRankReasons {
  safety: boolean;
  owed: boolean;
  windowOpen: boolean;
  changed: boolean;
}

export type DashboardEpisodeMemberRole =
  "state" | "must" | "should" | "reading";

// Typed membership for one open illness cockpit (#3138). `groupKey` remains the
// generic presentation identity used by the rest of the dashboard; this metadata is
// the only authority the ranker uses to recognize and order illness members. In
// particular, candidate-id spelling and input adjacency carry no policy.
export interface DashboardEpisodeGroup {
  kind: "illness-episode";
  groupKey: string;
  episodeKey: string;
  profileId: number;
  episodeOrder: number;
  memberRole: DashboardEpisodeMemberRole;
  memberOrder: number;
}

export const NO_DASHBOARD_RANK_REASONS: DashboardRankReasons = {
  safety: false,
  owed: false,
  windowOpen: false,
  changed: false,
};

export interface DashboardCandidateBase {
  candidateId: string;
  factKey: string;
  groupKey: string | null;
  episodeGroup?: DashboardEpisodeGroup;
  subject: DashboardSubject;
  applicable: boolean;
  relevance: DashboardRelevancePolicy;
  timing: DashboardTiming;
  rankReasons: DashboardRankReasons;
  readingPromotion?: DashboardReadingPromotion;
  standingEligible?: boolean;
  sourceOrder: number;
}

export type DashboardCandidate =
  | (DashboardCandidateBase & {
      kind: "action";
      obligation: DashboardObligation;
    })
  | (DashboardCandidateBase & { kind: "reading" })
  | (DashboardCandidateBase & { kind: "statement" })
  | (DashboardCandidateBase & { kind: "state" });

export type DashboardLane = "now" | "standing" | "everything";

export interface DashboardPlacement {
  candidate: DashboardCandidate;
  lane: DashboardLane;
  laneOrder: number;
  timingDisposition: DashboardTimingDisposition;
  standingFamilyKey?: StandingFamilyKey;
  standingSection?: StandingSectionKey;
}

export const NOW_CANDIDATE_CAP = 2;
export const WAKE_WINDOW_MIN = 180;
export const MEAL_WINDOW_MIN = 60;
export const DEFAULT_WAKE_MINUTES = DEFAULT_INTAKE_REMINDER_MINUTES.Morning;

export interface DashboardPlacementSignals {
  activeProfileId: number;
  minutesOfDay: number;
}

function minuteInWindow(
  minute: number,
  window: { opensAt: number; closesAt: number; wrapsMidnight: boolean }
): boolean {
  return window.wrapsMidnight
    ? minute >= window.opensAt || minute <= window.closesAt
    : minute >= window.opensAt && minute <= window.closesAt;
}

export function resolveDashboardTiming(
  timing: DashboardTiming,
  minutesOfDay: number
): DashboardTimingDisposition {
  switch (timing.kind) {
    case "always":
      return { kind: "active" };
    case "local-time": {
      if (minuteInWindow(minutesOfDay, timing)) return { kind: "active" };
      if (minutesOfDay < timing.opensAt)
        return { kind: "future-today", opensAt: timing.opensAt };
      return { kind: "expired" };
    }
    case "local-time-windows": {
      if (timing.windows.some((window) => minuteInWindow(minutesOfDay, window)))
        return { kind: "active" };
      const laterOpening = timing.windows
        .map((window) => window.opensAt)
        .filter((opensAt) => opensAt > minutesOfDay)
        .sort((a, b) => a - b)[0];
      return laterOpening == null
        ? { kind: "expired" }
        : { kind: "future-today", opensAt: laterOpening };
    }
    case "since-event":
      return timing.ageMinutes >= 0 && timing.ageMinutes <= timing.maxMinutes
        ? { kind: "active" }
        : { kind: "expired" };
    case "local-days":
      return timing.ageDays >= 0 && timing.ageDays <= timing.maxDays
        ? { kind: "active" }
        : { kind: "expired" };
    case "until-signal":
      return timing.active ? { kind: "active" } : { kind: "expired" };
  }
}

function normalizedLocalWindow(opensAt: number, closesAt: number) {
  const normalize = (minute: number) => ((minute % 1440) + 1440) % 1440;
  const opening = normalize(opensAt);
  const closing = normalize(closesAt);
  return {
    opensAt: opening,
    closesAt: closing,
    wrapsMidnight:
      Math.floor(opensAt / 1440) !== Math.floor(closesAt / 1440) ||
      closing < opening,
  };
}

export function localTimeWindow(
  opensAt: number,
  closesAt: number
): DashboardTiming {
  return { kind: "local-time", ...normalizedLocalWindow(opensAt, closesAt) };
}

export function mealTimeWindows(anchors: readonly number[]): DashboardTiming {
  return {
    kind: "local-time-windows",
    windows: anchors.map((anchor) =>
      normalizedLocalWindow(anchor - MEAL_WINDOW_MIN, anchor + MEAL_WINDOW_MIN)
    ),
  };
}

function compareOrdinal(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function nowScore(candidate: DashboardCandidate): number | null {
  const reasons = candidate.rankReasons;
  if (reasons.safety) return 5_000;
  if (candidate.kind === "action") {
    if (candidate.obligation === "may") return reasons.changed ? 2_000 : null;
    const obligation = candidate.obligation === "must" ? 200 : 100;
    if (reasons.owed) return 4_000 + obligation;
    if (reasons.windowOpen) return 2_000 + obligation;
  }
  if (reasons.changed) return 3_000;
  return null;
}

function compareSource(a: DashboardCandidate, b: DashboardCandidate): number {
  return (
    a.sourceOrder - b.sourceOrder ||
    compareOrdinal(a.candidateId, b.candidateId)
  );
}

function validateCandidates(candidates: readonly DashboardCandidate[]): void {
  const candidateIds = new Set<string>();
  const episodeGroups = new Map<
    string,
    Pick<DashboardEpisodeGroup, "episodeKey" | "profileId" | "episodeOrder">
  >();
  for (const candidate of candidates) {
    if (candidateIds.has(candidate.candidateId)) {
      throw new Error(
        `Duplicate dashboard candidateId: ${candidate.candidateId}`
      );
    }
    candidateIds.add(candidate.candidateId);
    const episode = candidate.episodeGroup;
    if (episode) {
      if (
        candidate.groupKey !== episode.groupKey ||
        candidate.subject.scope !== "profile" ||
        candidate.subject.profileId !== episode.profileId
      ) {
        throw new Error(
          `Invalid dashboard episode membership: ${candidate.candidateId}`
        );
      }
      const roleMatchesKind =
        (episode.memberRole === "state" && candidate.kind === "state") ||
        (episode.memberRole === "reading" && candidate.kind === "reading") ||
        (episode.memberRole === "must" &&
          candidate.kind === "action" &&
          candidate.obligation === "must") ||
        (episode.memberRole === "should" &&
          candidate.kind === "action" &&
          candidate.obligation === "should");
      if (!roleMatchesKind) {
        throw new Error(
          `Dashboard episode role mismatch: ${candidate.candidateId}`
        );
      }
      const existing = episodeGroups.get(episode.groupKey);
      if (
        existing &&
        (existing.episodeKey !== episode.episodeKey ||
          existing.profileId !== episode.profileId ||
          existing.episodeOrder !== episode.episodeOrder)
      ) {
        throw new Error(
          `Inconsistent dashboard episode group: ${episode.groupKey}`
        );
      }
      episodeGroups.set(episode.groupKey, episode);
    }
    if (candidate.kind === "reading") {
      if (
        candidate.rankReasons.changed !==
        (candidate.readingPromotion != null)
      )
        throw new Error(
          `Dashboard reading promotion mismatch: ${candidate.candidateId}`
        );
    } else if (candidate.readingPromotion != null) {
      throw new Error(
        `Non-reading dashboard promotion: ${candidate.candidateId}`
      );
    }
  }
}

function compareEpisodeGroup(
  a: DashboardEpisodeGroup,
  b: DashboardEpisodeGroup,
  activeProfileId: number
): number {
  return (
    Number(b.profileId === activeProfileId) -
      Number(a.profileId === activeProfileId) ||
    a.profileId - b.profileId ||
    a.episodeOrder - b.episodeOrder ||
    compareOrdinal(a.episodeKey, b.episodeKey)
  );
}

const EPISODE_ROLE_ORDER: Record<DashboardEpisodeMemberRole, number> = {
  state: 0,
  must: 1,
  should: 2,
  reading: 3,
};

function eligibleEpisodeMember(candidate: DashboardCandidate): boolean {
  const role = candidate.episodeGroup?.memberRole;
  if (!role) return false;
  if (role === "state" || role === "reading") return true;
  return candidate.kind === "action" && candidate.rankReasons.owed;
}

// Now + Standing + Everything is an exact once-by-factKey partition. Now has
// structural layers: uncapped safety, whole authorized illness groups, then the
// ordinary capped rank. Episode grouping is placement only; it never grants access or
// changes a member's safety, obligation, timing, or applicability.
export function rankDashboardCandidates(
  candidates: readonly DashboardCandidate[],
  signals: DashboardPlacementSignals
): DashboardPlacement[] {
  // Identity belongs to the gathered manifest, not only the visible partition.
  // Validate before applicability so a latent duplicate cannot become live later
  // when profile state, access, or life-stage applicability changes.
  validateCandidates(candidates);
  const applicable = candidates
    .filter((candidate) => candidate.applicable)
    .map((candidate) => ({
      candidate,
      timingDisposition: resolveDashboardTiming(
        candidate.timing,
        signals.minutesOfDay
      ),
    }));
  const live = applicable.filter(
    ({ candidate, timingDisposition }) =>
      candidate.rankReasons.safety || timingDisposition.kind !== "expired"
  );

  const active = live.filter(
    ({ timingDisposition }) => timingDisposition.kind === "active"
  );
  const safety = live
    .filter(({ candidate }) => candidate.rankReasons.safety)
    .sort(({ candidate: a }, { candidate: b }) => compareSource(a, b));
  const safetyFacts = new Set<string>();
  const selectedSafety = safety.filter(({ candidate }) => {
    if (safetyFacts.has(candidate.factKey)) return false;
    safetyFacts.add(candidate.factKey);
    return true;
  });

  const episodeGroups = new Map<
    string,
    {
      metadata: DashboardEpisodeGroup;
      members: typeof active;
      hasState: boolean;
    }
  >();
  for (const entry of active) {
    const metadata = entry.candidate.episodeGroup;
    if (!metadata) continue;
    const group = episodeGroups.get(metadata.groupKey) ?? {
      metadata,
      members: [],
      hasState: false,
    };
    group.members.push(entry);
    group.hasState ||= metadata.memberRole === "state";
    episodeGroups.set(metadata.groupKey, group);
  }
  const episodeFacts = new Set(safetyFacts);
  const selectedEpisodes = [...episodeGroups.values()]
    .filter((group) => group.hasState)
    .sort((a, b) =>
      compareEpisodeGroup(a.metadata, b.metadata, signals.activeProfileId)
    )
    .flatMap((group) =>
      group.members
        .filter(({ candidate }) => eligibleEpisodeMember(candidate))
        .sort(({ candidate: a }, { candidate: b }) => {
          const am = a.episodeGroup!;
          const bm = b.episodeGroup!;
          return (
            EPISODE_ROLE_ORDER[am.memberRole] -
              EPISODE_ROLE_ORDER[bm.memberRole] ||
            am.memberOrder - bm.memberOrder ||
            compareSource(a, b)
          );
        })
        .filter(({ candidate }) => {
          if (episodeFacts.has(candidate.factKey)) return false;
          episodeFacts.add(candidate.factKey);
          return true;
        })
    );

  const rankedOrdinary = active
    .filter(
      ({ candidate }) =>
        !candidate.rankReasons.safety &&
        !episodeFacts.has(candidate.factKey) &&
        !selectedEpisodes.some(
          (entry) => entry.candidate.candidateId === candidate.candidateId
        )
    )
    .map(({ candidate, timingDisposition }) => ({
      candidate,
      timingDisposition,
      score: nowScore(candidate),
    }))
    .filter(
      (
        entry
      ): entry is {
        candidate: DashboardCandidate;
        timingDisposition: DashboardTimingDisposition;
        score: number;
      } => entry.score !== null
    )
    .sort(
      (a, b) => b.score - a.score || compareSource(a.candidate, b.candidate)
    );
  const ordinaryFacts = new Set(episodeFacts);
  const uniqueOrdinary = rankedOrdinary.filter(({ candidate }) => {
    if (ordinaryFacts.has(candidate.factKey)) return false;
    ordinaryFacts.add(candidate.factKey);
    return true;
  });
  const selectedNow = [
    ...selectedSafety,
    ...selectedEpisodes,
    ...uniqueOrdinary.slice(0, NOW_CANDIDATE_CAP),
  ];
  const nowIds = new Set(
    selectedNow.map((entry) => entry.candidate.candidateId)
  );
  const nowFacts = new Set(selectedNow.map((entry) => entry.candidate.factKey));
  const nowOrder = new Map(
    selectedNow.map((entry, index) => [entry.candidate.candidateId, index])
  );

  const remaining = live.filter(
    ({ candidate }) =>
      !nowIds.has(candidate.candidateId) && !nowFacts.has(candidate.factKey)
  );
  const standing = resolveStandingMembers(
    remaining
      .filter(({ timingDisposition }) => timingDisposition.kind === "active")
      .map(({ candidate }) => candidate),
    signals.activeProfileId
  );
  const dispositionByCandidateId = new Map(
    live.map(({ candidate, timingDisposition }) => [
      candidate.candidateId,
      timingDisposition,
    ])
  );
  const everythingFacts = new Set<string>();
  const everything = remaining
    .filter(
      ({ candidate }) =>
        !standing.memberIds.has(candidate.candidateId) &&
        !standing.factKeys.has(candidate.factKey)
    )
    .sort(({ candidate: a }, { candidate: b }) => {
      const kinds: Record<DashboardCandidateKind, number> = {
        action: 0,
        statement: 1,
        state: 2,
        reading: 3,
      };
      return kinds[a.kind] - kinds[b.kind] || compareSource(a, b);
    })
    .filter(({ candidate }) => {
      if (everythingFacts.has(candidate.factKey)) return false;
      everythingFacts.add(candidate.factKey);
      return true;
    });

  return [
    ...selectedNow.map(({ candidate, timingDisposition }) => ({
      candidate,
      lane: "now" as const,
      laneOrder: nowOrder.get(candidate.candidateId)!,
      timingDisposition,
    })),
    ...standing.members.map(({ candidate, family }, laneOrder) => ({
      candidate,
      lane: "standing" as const,
      laneOrder,
      timingDisposition: dispositionByCandidateId.get(candidate.candidateId)!,
      standingFamilyKey: family.key,
      standingSection: family.section,
    })),
    ...everything.map(({ candidate, timingDisposition }, laneOrder) => ({
      candidate,
      lane: "everything" as const,
      laneOrder,
      timingDisposition,
    })),
  ];
}

export function placementsInLane(
  placements: readonly DashboardPlacement[],
  lane: DashboardLane
): DashboardPlacement[] {
  return placements
    .filter((placement) => placement.lane === lane)
    .sort((a, b) => a.laneOrder - b.laneOrder);
}

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
  // An active illness is the ordinary Now state that gives the dashboard its
  // immediate care context. It follows uncapped safety facts but cannot be
  // displaced by the two-action ordinary cap.
  if (
    candidate.kind === "state" &&
    candidate.candidateId.startsWith("illness.state:")
  )
    return 4_500;
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
  for (const candidate of candidates) {
    if (candidateIds.has(candidate.candidateId)) {
      throw new Error(
        `Duplicate dashboard candidateId: ${candidate.candidateId}`
      );
    }
    candidateIds.add(candidate.candidateId);
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

// Now + Standing + Everything is an exact once-by-factKey partition.
// Safety is uncapped; the ordinary Now cap applies after safety is removed.
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

  const rankedNow = live
    .filter(
      ({ candidate, timingDisposition }) =>
        candidate.rankReasons.safety || timingDisposition.kind === "active"
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
      (a, b) =>
        Number(b.candidate.rankReasons.safety) -
          Number(a.candidate.rankReasons.safety) ||
        b.score - a.score ||
        compareSource(a.candidate, b.candidate)
    );
  const rankedNowFacts = new Set<string>();
  const uniqueRankedNow = rankedNow.filter(({ candidate }) => {
    if (rankedNowFacts.has(candidate.factKey)) return false;
    rankedNowFacts.add(candidate.factKey);
    return true;
  });
  const selectedNow = [
    ...uniqueRankedNow.filter((entry) => entry.candidate.rankReasons.safety),
    ...uniqueRankedNow
      .filter((entry) => !entry.candidate.rankReasons.safety)
      .slice(0, NOW_CANDIDATE_CAP),
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

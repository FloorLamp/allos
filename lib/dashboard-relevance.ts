// Atomic dashboard placement (#3077 / #3096).
//
// Candidates are facts, never cards. This module owns only deterministic
// placement; it imports no DB, auth, clock, or React code.

import { DEFAULT_INTAKE_REMINDER_MINUTES } from "./notifications/schedule";

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

export type DashboardCandidateKind =
  "action" | "reading" | "statement" | "state";
export type DashboardObligation = "must" | "should" | "may";
export type DashboardDefaultPlacement = "standing" | "everything";

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
  defaultPlacement: DashboardDefaultPlacement;
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

export function dashboardTimingActive(
  timing: DashboardTiming,
  minutesOfDay: number
): boolean {
  switch (timing.kind) {
    case "always":
      return true;
    case "local-time":
      return minuteInWindow(minutesOfDay, timing);
    case "local-time-windows":
      return timing.windows.some((window) =>
        minuteInWindow(minutesOfDay, window)
      );
    case "since-event":
      return timing.ageMinutes >= 0 && timing.ageMinutes <= timing.maxMinutes;
    case "local-days":
      return timing.ageDays >= 0 && timing.ageDays <= timing.maxDays;
    case "until-signal":
      return timing.active;
  }
}

export function localTimeWindow(
  opensAt: number,
  closesAt: number
): DashboardTiming {
  return {
    kind: "local-time",
    opensAt: Math.max(0, opensAt),
    closesAt: Math.min(1439, closesAt),
    wrapsMidnight: false,
  };
}

export function mealTimeWindows(anchors: readonly number[]): DashboardTiming {
  return {
    kind: "local-time-windows",
    windows: anchors.map((anchor) => ({
      opensAt: Math.max(0, anchor - MEAL_WINDOW_MIN),
      closesAt: Math.min(1439, anchor + MEAL_WINDOW_MIN),
      wrapsMidnight: false,
    })),
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

function isActingProfileReading(
  candidate: DashboardCandidate,
  activeProfileId: number
): boolean {
  return (
    candidate.kind === "reading" &&
    candidate.relevance.kind === "profile-data" &&
    candidate.defaultPlacement === "standing" &&
    candidate.subject.scope === "profile" &&
    candidate.subject.profileId === activeProfileId
  );
}

function compareSource(a: DashboardCandidate, b: DashboardCandidate): number {
  return (
    a.sourceOrder - b.sourceOrder ||
    compareOrdinal(a.candidateId, b.candidateId)
  );
}

function validateCandidates(candidates: readonly DashboardCandidate[]): void {
  const candidateIds = new Set<string>();
  const factKeys = new Set<string>();
  for (const candidate of candidates) {
    if (candidateIds.has(candidate.candidateId)) {
      throw new Error(
        `Duplicate dashboard candidateId: ${candidate.candidateId}`
      );
    }
    if (factKeys.has(candidate.factKey)) {
      throw new Error(`Duplicate live dashboard factKey: ${candidate.factKey}`);
    }
    candidateIds.add(candidate.candidateId);
    factKeys.add(candidate.factKey);
  }
}

// Now + Standing + Everything is an exact partition of applicable candidates.
// Safety is uncapped; the ordinary Now cap applies after safety is removed.
export function rankDashboardCandidates(
  candidates: readonly DashboardCandidate[],
  signals: DashboardPlacementSignals
): DashboardPlacement[] {
  const applicable = candidates.filter((candidate) => candidate.applicable);
  validateCandidates(applicable);

  const rankedNow = applicable
    .filter(
      (candidate) =>
        candidate.rankReasons.safety ||
        dashboardTimingActive(candidate.timing, signals.minutesOfDay)
    )
    .map((candidate) => ({ candidate, score: nowScore(candidate) }))
    .filter(
      (entry): entry is { candidate: DashboardCandidate; score: number } =>
        entry.score !== null
    )
    .sort(
      (a, b) =>
        Number(b.candidate.rankReasons.safety) -
          Number(a.candidate.rankReasons.safety) ||
        b.score - a.score ||
        compareSource(a.candidate, b.candidate)
    );
  const selectedNow = [
    ...rankedNow.filter((entry) => entry.candidate.rankReasons.safety),
    ...rankedNow
      .filter((entry) => !entry.candidate.rankReasons.safety)
      .slice(0, NOW_CANDIDATE_CAP),
  ];
  const nowIds = new Set(
    selectedNow.map((entry) => entry.candidate.candidateId)
  );
  const nowOrder = new Map(
    selectedNow.map((entry, index) => [entry.candidate.candidateId, index])
  );

  const remaining = applicable.filter(
    (candidate) => !nowIds.has(candidate.candidateId)
  );
  const standing = remaining
    .filter((candidate) =>
      isActingProfileReading(candidate, signals.activeProfileId)
    )
    .sort(compareSource);
  const standingIds = new Set(
    standing.map((candidate) => candidate.candidateId)
  );
  const everything = remaining
    .filter((candidate) => !standingIds.has(candidate.candidateId))
    .sort((a, b) => {
      const kinds: Record<DashboardCandidateKind, number> = {
        action: 0,
        statement: 1,
        state: 2,
        reading: 3,
      };
      return kinds[a.kind] - kinds[b.kind] || compareSource(a, b);
    });

  return [
    ...selectedNow.map(({ candidate }) => ({
      candidate,
      lane: "now" as const,
      laneOrder: nowOrder.get(candidate.candidateId)!,
    })),
    ...standing.map((candidate, laneOrder) => ({
      candidate,
      lane: "standing" as const,
      laneOrder,
    })),
    ...everything.map((candidate, laneOrder) => ({
      candidate,
      lane: "everything" as const,
      laneOrder,
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

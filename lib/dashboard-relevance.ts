// Dashboard placement substrate (#3077 / #3080).
//
// This module answers one question: where does each already-built dashboard
// surface render? It owns no JSX, DB read, clock, authorization, or health
// derivation. The page gathers facts and constructs each node once; this pure
// ranker returns references to those nodes in one deterministic manifest.

import { DEFAULT_INTAKE_REMINDER_MINUTES } from "./notifications/schedule";

export const DASHBOARD_ZONES = ["priority", "now", "pre-grid", "grid"] as const;
export type DashboardZone = (typeof DASHBOARD_ZONES)[number];

export type DashboardSubject =
  | { scope: "profile"; profileId: number }
  | { scope: "household" }
  | { scope: "login" };

// Declarative time shapes already used by today's surfaces. The caller resolves
// ages and active signals once. Keeping the variants here prevents the eventual
// atom registry from degrading into arbitrary callbacks or local Date reads.
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

export type DashboardObligation = "must" | "should" | "may";

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

export const NOW_CARD_IDS = [
  "session-recap",
  "sleep-last-night",
  "naps-today",
  "nutrition-today",
  "symptom-log",
] as const;
export type NowCardId = (typeof NOW_CARD_IDS)[number];

export function isNowCardId(id: string): id is NowCardId {
  return NOW_CARD_IDS.some((candidate) => candidate === id);
}

export const NOW_STRIP_CAP = 2;
export const WAKE_WINDOW_MIN = 180;
export const MEAL_WINDOW_MIN = 60;
export const DEFAULT_WAKE_MINUTES = DEFAULT_INTAKE_REMINDER_MINUTES.Morning;

export interface NowSignals {
  minutesOfDay: number;
  wakeMinutes: number | null;
  freshSleepSummary: boolean;
  sleepWaiting: boolean;
  napEndedMinAgo: number | null;
  workoutFinishedMinAgo: number | null;
  mealAnchors: readonly number[];
  eveningAnchor: number | null;
  checkInDone: boolean;
  eligible: readonly NowCardId[];
}

export type DashboardNowSignals = Omit<NowSignals, "eligible">;

export interface RankableDashboardSurface {
  placementId: string;
  nodeKey: string;
  groupKey: string | null;
  subject: DashboardSubject;
  // Saved hide/applicability and momentary availability stay distinct. A hidden
  // surface remains in the manifest for Customize, while an unavailable one
  // keeps its saved preference without leaving an empty normal-mode slot.
  visible: boolean;
  available: boolean;
  // Empty/dormant onboarding lines can be visible and available at home without
  // being suitable for the Now strip.
  promotable: boolean;
  obligation?: DashboardObligation;
  rankReasons: DashboardRankReasons;
  timing: DashboardTiming;
  currentPlacement: DashboardZone;
  currentOrder: number;
}

export type DashboardPlacementVisibility = "visible" | "hidden" | "unavailable";

export interface DashboardPlacement extends RankableDashboardSurface {
  zone: DashboardZone;
  zoneOrder: number;
  visibility: DashboardPlacementVisibility;
}

export interface DashboardPlacementSignals {
  now: DashboardNowSignals;
}

// Every phase-1 surface outside the customizable registry. Grid widget ids are
// supplied by DASHBOARD_WIDGETS and checked beside this census in the scan test.
export const DASHBOARD_STATIC_SURFACE_IDS = [
  "illness-hero",
  "needs-attention",
  "recently-resolved",
  "stream-lifecycle-offers",
  "session-recap",
  "onboarding-resume",
  "onboarding-checklist",
  "household-strip",
] as const;

// These are current render surfaces that contain more than one independently
// relevant fact. They are adapters in phase 1, never falsely typed as atoms.
export const DASHBOARD_COMPOSITE_ADAPTER_IDS = [
  "illness-hero",
  "needs-attention",
  "symptom-log",
  "nutrition-today",
  "goals-habits",
  "coaching",
  "coaching-observations",
  "onboarding-resume",
  "onboarding-checklist",
  "household-strip",
] as const;

const ZONE_ORDER: Record<DashboardZone, number> = {
  priority: 0,
  now: 1,
  "pre-grid": 2,
  grid: 3,
};

const NOW_TIER: Record<NowCardId, number> = {
  "session-recap": 400,
  "sleep-last-night": 300,
  "naps-today": 300,
  "symptom-log": 200,
  "nutrition-today": 100,
};

function nearestDistance(
  minutes: number,
  anchors: readonly number[]
): number | null {
  let best: number | null = null;
  for (const anchor of anchors) {
    const distance = Math.abs(minutes - anchor);
    if (best === null || distance < best) best = distance;
  }
  return best;
}

function sameDayLocalTimeWindow(
  opensAt: number,
  closesAt: number
): Extract<DashboardTiming, { kind: "local-time" }> {
  return {
    kind: "local-time",
    opensAt: Math.max(0, opensAt),
    closesAt: Math.min(1439, closesAt),
    wrapsMidnight: false,
  };
}

export function timingForNowCard(
  id: NowCardId,
  signals: DashboardNowSignals
): DashboardTiming {
  switch (id) {
    case "session-recap":
      return {
        kind: "since-event",
        ageMinutes: signals.workoutFinishedMinAgo ?? -1,
        maxMinutes: 60,
      };
    case "sleep-last-night": {
      const wake = signals.wakeMinutes ?? DEFAULT_WAKE_MINUTES;
      return sameDayLocalTimeWindow(wake, wake + WAKE_WINDOW_MIN);
    }
    case "naps-today":
      return {
        kind: "since-event",
        ageMinutes: signals.napEndedMinAgo ?? -1,
        maxMinutes: WAKE_WINDOW_MIN,
      };
    case "symptom-log":
      return signals.eveningAnchor == null
        ? { kind: "until-signal", active: false }
        : sameDayLocalTimeWindow(signals.eveningAnchor, 1439);
    case "nutrition-today":
      return {
        kind: "local-time-windows",
        windows: signals.mealAnchors.map((anchor) => {
          const window = sameDayLocalTimeWindow(
            anchor - MEAL_WINDOW_MIN,
            anchor + MEAL_WINDOW_MIN
          );
          return {
            opensAt: window.opensAt,
            closesAt: window.closesAt,
            wrapsMidnight: window.wrapsMidnight,
          };
        }),
      };
  }
}

function minuteInWindow(
  minute: number,
  window: {
    opensAt: number;
    closesAt: number;
    wrapsMidnight: boolean;
  }
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

function scoreNowCard(id: NowCardId, signals: NowSignals): number | null {
  if (
    !dashboardTimingActive(timingForNowCard(id, signals), signals.minutesOfDay)
  ) {
    return null;
  }
  switch (id) {
    case "session-recap": {
      return NOW_TIER[id] - signals.workoutFinishedMinAgo!;
    }
    case "sleep-last-night": {
      if (!signals.freshSleepSummary && !signals.sleepWaiting) return null;
      const wake = signals.wakeMinutes ?? DEFAULT_WAKE_MINUTES;
      const since = signals.minutesOfDay - wake;
      return NOW_TIER[id] - since / 2;
    }
    case "naps-today": {
      return NOW_TIER[id] - signals.napEndedMinAgo! / 2;
    }
    case "symptom-log": {
      if (signals.checkInDone || signals.eveningAnchor === null) return null;
      return (
        NOW_TIER[id] + (signals.minutesOfDay - signals.eveningAnchor) / 100
      );
    }
    case "nutrition-today": {
      const distance = nearestDistance(
        signals.minutesOfDay,
        signals.mealAnchors
      );
      if (distance === null) return null;
      return NOW_TIER[id] - distance / 2;
    }
  }
}

function reasonForNowCard(id: NowCardId): keyof DashboardRankReasons {
  switch (id) {
    case "session-recap":
    case "naps-today":
      return "changed";
    case "symptom-log":
      return "owed";
    case "sleep-last-night":
    case "nutrition-today":
      return "windowOpen";
  }
}

// Compatibility entry point for #1413 callers. The decision lives here so all
// dashboard placement has one owner; lib/now-strip.ts only re-exports it.
export function rankNowCards(signals: NowSignals): NowCardId[] {
  const eligible = new Set(signals.eligible);
  return NOW_CARD_IDS.filter((id) => eligible.has(id))
    .map((id, index) => ({ id, index, score: scoreNowCard(id, signals) }))
    .filter(
      (
        candidate
      ): candidate is {
        id: NowCardId;
        index: number;
        score: number;
      } => candidate.score !== null
    )
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, NOW_STRIP_CAP)
    .map((candidate) => candidate.id);
}

function visibilityOf(
  surface: RankableDashboardSurface
): DashboardPlacementVisibility {
  if (!surface.visible) return "hidden";
  if (!surface.available) return "unavailable";
  return "visible";
}

function declaredNowScore(surface: RankableDashboardSurface): number | null {
  if (surface.currentPlacement === "priority") return null;
  const reasons = surface.rankReasons;
  if (reasons.safety) return 4_000;
  if (surface.obligation !== "may" && reasons.owed) return 3_000;
  if (reasons.changed) return 2_000;
  // Owner ruling: a may action does not reach Now merely because its window is
  // open. It needs a separate explicit future context signal.
  if (surface.obligation !== "may" && reasons.windowOpen) return 1_000;
  return null;
}

function mayAllowsReason(
  surface: RankableDashboardSurface,
  reason: keyof DashboardRankReasons
): boolean {
  return (
    surface.obligation !== "may" ||
    (reason !== "owed" && reason !== "windowOpen")
  );
}

function effectiveRankReasons(
  surface: RankableDashboardSurface
): DashboardRankReasons {
  return surface.obligation === "may" && surface.rankReasons.owed
    ? { ...surface.rankReasons, owed: false }
    : surface.rankReasons;
}

function compareHome(
  a: RankableDashboardSurface,
  b: RankableDashboardSurface
): number {
  return (
    ZONE_ORDER[a.currentPlacement] - ZONE_ORDER[b.currentPlacement] ||
    a.currentOrder - b.currentOrder ||
    a.placementId.localeCompare(b.placementId)
  );
}

// One deterministic placement manifest. Each input appears exactly once; a Now
// promotion changes its zone but retains nodeKey, so the page cannot render a
// second copy of the fact.
export function rankDashboard(
  surfaces: readonly RankableDashboardSurface[],
  signals: DashboardPlacementSignals
): DashboardPlacement[] {
  const ids = new Set<string>();
  for (const surface of surfaces) {
    if (ids.has(surface.placementId)) {
      throw new Error(
        "Duplicate dashboard placementId: " + surface.placementId
      );
    }
    ids.add(surface.placementId);
  }

  const visiblePromotable = surfaces.filter(
    (surface) =>
      visibilityOf(surface) === "visible" &&
      (surface.rankReasons.safety ||
        (surface.promotable &&
          dashboardTimingActive(surface.timing, signals.now.minutesOfDay)))
  );
  const nowById = new Map<
    string,
    {
      score: number;
      safety: boolean;
      order: number;
      reason?: keyof DashboardRankReasons;
    }
  >();

  const nowSurfaceByCard = new Map<NowCardId, RankableDashboardSurface>();
  for (const surface of visiblePromotable) {
    if (isNowCardId(surface.placementId)) {
      nowSurfaceByCard.set(surface.placementId, surface);
    }
  }
  const eligible = NOW_CARD_IDS.filter((id) => nowSurfaceByCard.has(id));
  const nowSignals: NowSignals = { ...signals.now, eligible };
  for (const id of eligible) {
    const surface = nowSurfaceByCard.get(id)!;
    const score = scoreNowCard(id, nowSignals);
    const reason = reasonForNowCard(id);
    if (score !== null && mayAllowsReason(surface, reason)) {
      nowById.set(surface.placementId, {
        score,
        safety: surface.rankReasons.safety,
        order: NOW_CARD_IDS.indexOf(id),
        reason,
      });
    }
  }

  for (const surface of visiblePromotable) {
    const score = declaredNowScore(surface);
    if (score !== null) {
      nowById.set(surface.placementId, {
        score,
        safety: surface.rankReasons.safety,
        order: surface.currentOrder,
      });
    }
  }

  const rankedNow = [...nowById.entries()].sort(
    ([idA, a], [idB, b]) =>
      Number(b.safety) - Number(a.safety) ||
      b.score - a.score ||
      a.order - b.order ||
      idA.localeCompare(idB)
  );
  const safetyNow = rankedNow.filter(([, rank]) => rank.safety);
  const ordinaryNow = rankedNow
    .filter(([, rank]) => !rank.safety)
    .slice(0, NOW_STRIP_CAP);
  const promotedOrder = new Map(
    [...safetyNow, ...ordinaryNow].map(([id], index) => [id, index])
  );
  const promotedRank = new Map([...safetyNow, ...ordinaryNow]);

  return [...surfaces]
    .sort(compareHome)
    .map((surface): DashboardPlacement => {
      const zoneOrder = promotedOrder.get(surface.placementId);
      const promoted = zoneOrder !== undefined;
      const rankReasons = effectiveRankReasons(surface);
      const promotedReason = promotedRank.get(surface.placementId)?.reason;
      return {
        ...surface,
        rankReasons:
          promoted && promotedReason
            ? { ...rankReasons, [promotedReason]: true }
            : rankReasons,
        zone: promoted ? "now" : surface.currentPlacement,
        zoneOrder: promoted ? zoneOrder : surface.currentOrder,
        visibility: visibilityOf(surface),
      };
    })
    .sort(compareDashboardPlacements);
}

export function compareDashboardPlacements(
  a: DashboardPlacement,
  b: DashboardPlacement
): number {
  return (
    ZONE_ORDER[a.zone] - ZONE_ORDER[b.zone] ||
    a.zoneOrder - b.zoneOrder ||
    a.placementId.localeCompare(b.placementId)
  );
}

export function visibleDashboardPlacements(
  placements: readonly DashboardPlacement[],
  zone: DashboardZone
): DashboardPlacement[] {
  return placements.filter(
    (placement) => placement.zone === zone && placement.visibility === "visible"
  );
}

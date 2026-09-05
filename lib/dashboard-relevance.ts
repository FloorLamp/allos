// Atomic dashboard placement (#3077 / #3096).
//
// Candidates are facts, never cards. This module owns only deterministic
// placement; it imports no DB, auth, clock, or React code.

import { DEFAULT_INTAKE_REMINDER_MINUTES } from "./notifications/schedule";
import {
  resolveStandingMembers,
  standingFamilyForCandidate,
  STANDING_READING_ORDER,
  type StandingRenderedBand,
  type StandingFamilyKey,
  type StandingSectionKey,
} from "./dashboard-standing";
import { groupUpcoming, type UpcomingItem } from "./upcoming";
import { dashboardAttentionCandidateId } from "./dashboard-attention-identity";
import type { AppRoute } from "./hrefs";
import { nowReasonScore } from "./dashboard-rank-precedence";
import { groupRankedBySubject } from "./rank-core";

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
  // Explicitly authorized illness context that remains useful after an episode
  // closes. Apart from open `episodeGroup` context, this is the only cross-profile
  // exception to active-profile/login-setup scope; a candidate id grants nothing.
  dashboardScope?: "illness-context";
  // THE PAGE THIS CANDIDATE IS ONLY A LINK TO, when the nav already carries that
  // page (owner ruling #3366). Declaring it is a claim about the candidate's whole
  // content — it reports no value and hosts no control, so on the dashboard it is a
  // second spelling of a nav row. Show everything renders one deduplicated door to
  // the page instead of the candidate, which keeps the destination one tap from the
  // tail while the tail stops restating the sidebar.
  //
  // It never changes CANDIDACY: the ranker still places the candidate in the
  // exact-once partition, and safety still overrides (`everythingAdmitted`).
  navDuplicateOf?: AppRoute;
}

export type DashboardCandidate =
  | (DashboardCandidateBase & {
      kind: "action";
      obligation: DashboardObligation;
    })
  | (DashboardCandidateBase & { kind: "reading" })
  | (DashboardCandidateBase & { kind: "statement" })
  | (DashboardCandidateBase & { kind: "state" });

export type DashboardLane = "now" | "standing" | "ahead" | "everything";
export type DashboardNowLayer = "safety" | "illness" | "ordinary";
export type DashboardAheadBucket = "later-today" | "horizon";
export type DashboardEverythingGroup =
  "act" | "read" | "understand" | "setup" | "active-states";

interface DashboardPlacementBase {
  candidate: DashboardCandidate;
  laneOrder: number;
  timingDisposition: DashboardTimingDisposition;
}

export type DashboardPlacement =
  | (DashboardPlacementBase & {
      lane: "now";
      nowLayer: DashboardNowLayer;
      /**
       * WHOSE CLUSTER THIS ROW SITS IN (#4752 item 6), or null when Now holds one
       * subject and therefore renders no labels. The grouping is placement only: it
       * gathers rows that already ranked, and a group's seat is its best member's.
       */
      nowSubject: string | null;
    })
  | (DashboardPlacementBase & {
      lane: "standing";
      standingFamilyKey: StandingFamilyKey;
      standingSection: StandingSectionKey;
      standingBand: StandingRenderedBand;
    })
  | (DashboardPlacementBase & {
      lane: "ahead";
      aheadBucket: "later-today";
      memberOrder: number;
      opensAt: number;
    })
  | (DashboardPlacementBase & {
      lane: "ahead";
      aheadBucket: "horizon";
      memberOrder: number;
      upcomingKey: string;
      upcomingBand: "week" | "later";
    })
  | (DashboardPlacementBase & {
      lane: "everything";
      everythingGroup: DashboardEverythingGroup;
      memberOrder: number;
      /**
       * Whether the tail RENDERS this placement (#3366). The lane itself stays the
       * complete exact-once remainder — this mark is what the canvas consumes, so
       * "the ranker can never silently hide a candidate" is a property the test
       * tier can state instead of one the reader has to scroll past.
       */
      admitted: boolean;
    });

export const NOW_CANDIDATE_CAP = 2;
export const WAKE_WINDOW_MIN = 180;
export const MEAL_WINDOW_MIN = 60;
export const DEFAULT_WAKE_MINUTES = DEFAULT_INTAKE_REMINDER_MINUTES.Morning;

export interface DashboardPlacementSignals {
  activeProfileId: number;
  minutesOfDay: number;
  today: string;
  upcoming: readonly UpcomingItem[];
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
  return nowReasonScore(candidate);
}

// WHOSE ROW THIS IS, for Now's subject grouping (#4752 item 6). A household- or
// login-scoped row is the VIEWER's — no other name above it would be true — so it
// clusters with the active profile's own rows, and only a genuinely cross-profile
// candidate can open a second group.
function nowSubjectKey(
  candidate: DashboardCandidate,
  activeProfileId: number
): string {
  return candidate.subject.scope === "profile"
    ? String(candidate.subject.profileId)
    : String(activeProfileId);
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

function inDashboardScope(
  candidate: DashboardCandidate,
  activeProfileId: number
): boolean {
  if (candidate.episodeGroup) return true;
  if (candidate.dashboardScope === "illness-context") return true;
  if (candidate.subject.scope === "profile")
    return candidate.subject.profileId === activeProfileId;
  return (
    candidate.subject.scope === "login" && candidate.relevance.kind === "setup"
  );
}

function everythingGroup(
  candidate: DashboardCandidate
): DashboardEverythingGroup {
  if (
    candidate.relevance.kind === "setup" ||
    (candidate.relevance.kind === "profile-data" &&
      candidate.relevance.presence === "never")
  )
    return "setup";
  // AN ACT IS AN ACT AT ANY PRESENCE (#4841 item 3). Dormancy describes the DATA —
  // the quantity has gone quiet — and a dormant reading is a report, so it reads.
  // A dormant candidate that carries a WRITE is not: "No blood pressure recorded
  // since Mar 2022" is a prompt to take one, and grouping it under Read filed the
  // prompt as a report whose only door was the history of the missing thing. The
  // kind decides, and the presence still decides everything else it decided before.
  if (candidate.kind === "action") return "act";
  if (
    candidate.relevance.kind === "profile-data" &&
    candidate.relevance.presence === "dormant"
  )
    return "read";
  if (candidate.kind === "reading") return "read";
  if (candidate.kind === "statement") return "understand";
  return "active-states";
}

const EVERYTHING_GROUP_ORDER: readonly DashboardEverythingGroup[] = [
  "act",
  "read",
  "understand",
  "setup",
  "active-states",
];

// WHAT THE TAIL RENDERS (owner ruling #3366, 2026-08-29). The tail stays
// EXHAUSTIVE: the scroll it was filed about is fixed by #3365's grammar, not by
// admission, so this is not a relevance model and there is no live-signal filter
// here. Exactly one thing drops — a candidate whose only role is a link to a page
// the nav already carries — and it drops to a door on that page rather than out of
// the app.
//
// Safety is unrankable-away here as everywhere, and it is the Now lane above that
// enforces it: every flagged candidate is taken into the uncapped safety layer before
// this lane exists, so a flag can never arrive at this question. No clause repeats it.
function everythingAdmitted(candidate: DashboardCandidate): boolean {
  return candidate.navDuplicateOf == null;
}

function compareEverything(
  a: DashboardCandidate,
  b: DashboardCandidate,
  group: DashboardEverythingGroup
): number {
  if (group === "act") {
    const obligationOrder: Record<DashboardObligation, number> = {
      must: 0,
      should: 1,
      may: 2,
    };
    if (a.kind === "action" && b.kind === "action")
      return (
        obligationOrder[a.obligation] - obligationOrder[b.obligation] ||
        compareSource(a, b)
      );
  }
  if (group === "read") {
    const af = standingFamilyForCandidate(a);
    const bf = standingFamilyForCandidate(b);
    const ai = af
      ? STANDING_READING_ORDER.indexOf(af)
      : Number.MAX_SAFE_INTEGER;
    const bi = bf
      ? STANDING_READING_ORDER.indexOf(bf)
      : Number.MAX_SAFE_INTEGER;
    return ai - bi || compareSource(a, b);
  }
  return compareSource(a, b);
}

// Now + Standing + Ahead + Show everything is an exact once-by-factKey partition
// of the dashboard census. Now has
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
    .filter(
      (candidate) =>
        candidate.applicable &&
        inDashboardScope(candidate, signals.activeProfileId)
    )
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
  // Which of a fact's tied candidates renders (#3201). Exact-once-by-factKey and
  // the seat the fact earned are both unchanged; only the OCCUPANT is decided
  // here, by usefulness rather than by gather order. A marker that has just
  // become notable mints a reading and the attention finding that flagged it on
  // one factKey, and "Ferritin 18 ng/mL" says everything "Ferritin flagged" does
  // plus the value; sourceOrder used to settle it, and sourceOrder is an
  // implementation detail of gather sequence carrying no claim about usefulness.
  // Score still leads, so a finding that outranks its reading keeps the seat, and
  // a fact with no reading keeps whatever candidate it had.
  const factOccupant = new Map<string, (typeof rankedOrdinary)[number]>();
  for (const entry of rankedOrdinary) {
    const held = factOccupant.get(entry.candidate.factKey);
    // A reading only reaches this lane through the promotion registry, so
    // "reading" here already means a value that earned Now on its own.
    if (
      held === undefined ||
      (held.score === entry.score &&
        entry.candidate.kind === "reading" &&
        held.candidate.kind !== "reading")
    )
      factOccupant.set(entry.candidate.factKey, entry);
  }
  const uniqueOrdinary = rankedOrdinary
    .filter(({ candidate }) => {
      if (ordinaryFacts.has(candidate.factKey)) return false;
      ordinaryFacts.add(candidate.factKey);
      return true;
    })
    .map(({ candidate }) => factOccupant.get(candidate.factKey)!);
  const selectedNow = [
    ...selectedSafety.map((entry) => ({
      ...entry,
      nowLayer: "safety" as const,
    })),
    ...selectedEpisodes.map((entry) => ({
      ...entry,
      nowLayer: "illness" as const,
    })),
    ...uniqueOrdinary.slice(0, NOW_CANDIDATE_CAP).map((entry) => ({
      ...entry,
      nowLayer: "ordinary" as const,
    })),
  ];
  const nowIds = new Set(
    selectedNow.map((entry) => entry.candidate.candidateId)
  );
  const nowFacts = new Set(selectedNow.map((entry) => entry.candidate.factKey));
  // THE SUBJECT GROUPING (#4752 item 6). Now's layers already decided WHO leads;
  // this gathers each subject's rows together without letting a subject overtake
  // one that outranked it, so a caregiver's own Omega-3 stops reading as debris
  // under a child's illness cockpit. One subject → no groups and no labels.
  const nowGroups = groupRankedBySubject(selectedNow, (entry) =>
    nowSubjectKey(entry.candidate, signals.activeProfileId)
  );
  const groupedNow = nowGroups
    ? nowGroups.flatMap((group) =>
        group.members.map((entry) => ({ ...entry, nowSubject: group.subject }))
      )
    : selectedNow.map((entry) => ({ ...entry, nowSubject: null }));
  const nowOrder = new Map(
    groupedNow.map((entry, index) => [entry.candidate.candidateId, index])
  );

  const remainingAfterNow = live.filter(
    ({ candidate }) =>
      !nowIds.has(candidate.candidateId) && !nowFacts.has(candidate.factKey)
  );
  const standing = resolveStandingMembers(
    remainingAfterNow
      .filter(({ timingDisposition }) => timingDisposition.kind === "active")
      .map(({ candidate }) => candidate),
    signals.activeProfileId
  );
  const remainingAfterStanding = remainingAfterNow.filter(
    ({ candidate }) =>
      !standing.memberIds.has(candidate.candidateId) &&
      !standing.factKeys.has(candidate.factKey)
  );

  const laterTodayFacts = new Set<string>();
  const laterToday = remainingAfterStanding
    .filter(
      ({ candidate, timingDisposition }) =>
        candidate.subject.scope === "profile" &&
        candidate.subject.profileId === signals.activeProfileId &&
        candidate.kind === "action" &&
        candidate.obligation !== "may" &&
        candidate.rankReasons.owed &&
        !candidate.rankReasons.safety &&
        candidate.relevance.kind !== "setup" &&
        timingDisposition.kind === "future-today"
    )
    .sort((a, b) => {
      const ad = a.timingDisposition as Extract<
        DashboardTimingDisposition,
        { kind: "future-today" }
      >;
      const bd = b.timingDisposition as Extract<
        DashboardTimingDisposition,
        { kind: "future-today" }
      >;
      return (
        ad.opensAt - bd.opensAt ||
        (a.candidate.kind === "action" &&
        b.candidate.kind === "action" &&
        a.candidate.obligation !== b.candidate.obligation
          ? a.candidate.obligation === "must"
            ? -1
            : 1
          : 0) ||
        compareOrdinal(a.candidate.candidateId, b.candidate.candidateId)
      );
    })
    .filter(({ candidate }) => {
      if (laterTodayFacts.has(candidate.factKey)) return false;
      laterTodayFacts.add(candidate.factKey);
      return true;
    });
  const aheadFacts = new Set(
    laterToday.map(({ candidate }) => candidate.factKey)
  );
  const remainingByAttentionId = new Map(
    remainingAfterStanding
      .filter(({ candidate }) => !aheadFacts.has(candidate.factKey))
      .map((entry) => [entry.candidate.candidateId, entry])
  );
  const horizon = groupUpcoming(
    signals.upcoming.filter((item) => item.signalGroup == null),
    signals.today
  ).flatMap((group) => {
    if (group.band !== "week" && group.band !== "later") return [];
    return group.items.flatMap((item) => {
      const entry = remainingByAttentionId.get(
        dashboardAttentionCandidateId(item.key)
      );
      if (!entry || aheadFacts.has(entry.candidate.factKey)) return [];
      aheadFacts.add(entry.candidate.factKey);
      return [
        {
          ...entry,
          item,
          band: group.band as "week" | "later",
        },
      ];
    });
  });
  const aheadIds = new Set([
    ...laterToday.map(({ candidate }) => candidate.candidateId),
    ...horizon.map(({ candidate }) => candidate.candidateId),
  ]);
  const remaining = remainingAfterStanding.filter(
    ({ candidate }) =>
      !aheadIds.has(candidate.candidateId) && !aheadFacts.has(candidate.factKey)
  );
  const dispositionByCandidateId = new Map(
    live.map(({ candidate, timingDisposition }) => [
      candidate.candidateId,
      timingDisposition,
    ])
  );
  const everythingEntries = remaining.filter(
    ({ candidate }) =>
      !standing.memberIds.has(candidate.candidateId) &&
      !standing.factKeys.has(candidate.factKey) &&
      // Owner ruling (#3186): a capped Standing family renders its capped
      // members and nothing else. The tail beyond the cap is not a dashboard
      // fact in any lane — the family's own page owns the rest of the census.
      // It still surfaces when it earns Now on its own: an active promotion
      // (a marker that just became notable) or a safety flag, which is what
      // keeps this from hiding the readings someone most needs to see.
      (!standing.cappedOverflowIds.has(candidate.candidateId) ||
        candidate.rankReasons.changed ||
        candidate.rankReasons.safety)
  );
  const orderedEverything = EVERYTHING_GROUP_ORDER.flatMap((group) =>
    everythingEntries
      .filter(({ candidate }) => everythingGroup(candidate) === group)
      .sort(({ candidate: a }, { candidate: b }) =>
        compareEverything(a, b, group)
      )
      .map((entry) => ({ ...entry, group }))
  );
  const everythingFacts = new Set<string>();
  const uniqueEverything = orderedEverything.filter(({ candidate }) => {
    if (everythingFacts.has(candidate.factKey)) return false;
    everythingFacts.add(candidate.factKey);
    return true;
  });
  const everything = EVERYTHING_GROUP_ORDER.flatMap((group) =>
    uniqueEverything
      .filter((entry) => entry.group === group)
      .map((entry, memberOrder) => ({ ...entry, memberOrder }))
  );

  return [
    ...groupedNow.map(
      ({ candidate, timingDisposition, nowLayer, nowSubject }) => ({
        candidate,
        lane: "now" as const,
        laneOrder: nowOrder.get(candidate.candidateId)!,
        timingDisposition,
        nowLayer,
        nowSubject,
      })
    ),
    ...standing.members.map(({ candidate, family, band }, laneOrder) => ({
      candidate,
      lane: "standing" as const,
      laneOrder,
      timingDisposition: dispositionByCandidateId.get(candidate.candidateId)!,
      standingFamilyKey: family.key,
      standingSection: family.section,
      standingBand: band,
    })),
    ...laterToday.map(({ candidate, timingDisposition }, memberOrder) => ({
      candidate,
      lane: "ahead" as const,
      laneOrder: memberOrder,
      timingDisposition,
      aheadBucket: "later-today" as const,
      memberOrder,
      opensAt: (
        timingDisposition as Extract<
          DashboardTimingDisposition,
          { kind: "future-today" }
        >
      ).opensAt,
    })),
    ...horizon.map(
      ({ candidate, timingDisposition, item, band }, memberOrder) => ({
        candidate,
        lane: "ahead" as const,
        laneOrder: laterToday.length + memberOrder,
        timingDisposition,
        aheadBucket: "horizon" as const,
        memberOrder,
        upcomingKey: item.key,
        upcomingBand: band,
      })
    ),
    ...everything.map(
      ({ candidate, timingDisposition, group, memberOrder }, laneOrder) => ({
        candidate,
        lane: "everything" as const,
        laneOrder,
        timingDisposition,
        everythingGroup: group,
        memberOrder,
        admitted: everythingAdmitted(candidate),
      })
    ),
  ];
}

// The ranker's illness layer is the sole authority for which whole episode groups
// render and in what order. Safety members may carry episode metadata too, but remain
// independent safety cards and therefore never contribute a group key here.
export function orderedIllnessGroupKeys(
  placements: readonly DashboardPlacement[]
): string[] {
  const seen = new Set<string>();
  return placementsInLane(placements, "now").flatMap((placement) => {
    const groupKey = placement.candidate.episodeGroup?.groupKey;
    if (placement.nowLayer !== "illness" || !groupKey || seen.has(groupKey))
      return [];
    seen.add(groupKey);
    return [groupKey];
  });
}

export function placementsInLane<Lane extends DashboardLane>(
  placements: readonly DashboardPlacement[],
  lane: Lane
): Extract<DashboardPlacement, { lane: Lane }>[] {
  return placements
    .filter(
      (placement): placement is Extract<DashboardPlacement, { lane: Lane }> =>
        placement.lane === lane
    )
    .sort((a, b) => a.laneOrder - b.laneOrder);
}

// WHAT SHOW EVERYTHING DRAWS, AND WHERE THE REST LIVES (#3366/#4076).
//
// The lane itself stays the complete exact-once remainder; this drops the members
// whose whole content is a page the app's own nav already names.
//
// THE TAIL NO LONGER DRAWS A DOOR FOR THEM (#4076, owner: "utterly useless") — a
// list of page names beside a sidebar of the same page names told nobody anything.
// The exact-once guarantee did not move with it: every drop must still name a page
// the app has a name for, and that is asserted at the manifest tier, against the real
// personas, where it can actually go red. A non-admitted placement that names no page
// is RENDERED rather than dropped, because completeness is the contract and showing
// is the only safe direction to fail.
export function everythingTail(
  placements: readonly DashboardPlacement[]
): Extract<DashboardPlacement, { lane: "everything" }>[] {
  return placementsInLane(placements, "everything").filter(
    (placement) =>
      placement.admitted || placement.candidate.navDuplicateOf == null
  );
}

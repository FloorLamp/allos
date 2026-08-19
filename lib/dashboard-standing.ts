import type { DashboardCandidate } from "./dashboard-relevance";

export type StandingSectionKey = "today" | "body" | "longer-view";

export type StandingFamilyKey =
  | "last-night-sleep"
  | "steps-today"
  | "protein-today"
  | "nap-total"
  | "cycle-phase"
  | "weight"
  | "blood-pressure"
  | "resting-heart-rate"
  | "healthspan-pillars"
  | "clinical-results"
  | "outcome-goals"
  | "weekly-targets";

export interface StandingReadingFamily {
  key: StandingFamilyKey;
  section: StandingSectionKey;
  label: string;
  composition: "single" | "composed" | "members";
  matches: (candidate: DashboardCandidate) => boolean;
  memberOrder:
    | { kind: "identity"; prefixes: readonly string[] }
    | {
        kind: "source";
        authority:
          | "buildPillars"
          | "recentLabHighlights"
          | "outcome-goal-source"
          | "summarizeDashboardHabits";
      };
  cap?: number;
}

const idStartsWith =
  (...prefixes: readonly string[]) =>
  (candidate: DashboardCandidate): boolean =>
    prefixes.some((prefix) => candidate.candidateId.startsWith(prefix));

// The clinical family's cap, named so the dashboard gather can stop minting the
// readings this registry would never seat (#3186). The registry is the single
// definition site: a gather that hard-codes six drifts the first time the cap moves.
export const CLINICAL_RESULTS_CAP = 6;

// The rows of a capped family a gather should still mint, in the family's own
// order: the ones the registry can seat, PLUS any row whose promotion is live.
// The union is what keeps the cap safe. A member that has just changed is a Now
// fact wherever it sits in the family's order, so a plain `slice(0, cap)` would
// silently drop exactly the reading someone most needs to see — with the cap
// already full of notable markers, the one that JUST became notable is the one
// outside it.
export function cappedFamilyGather<Row>(
  rows: readonly Row[],
  cap: number,
  promoted: (row: Row) => boolean
): Row[] {
  return rows.filter((row, index) => index < cap || promoted(row));
}

// The fixed dashboard instrument cluster. Declaration order is render order.
// This is intentionally the sole list of Standing families: a newly gathered
// reading remains in Show everything until this closed registry explicitly claims it.
export const STANDING_READING_ORDER: readonly StandingReadingFamily[] = [
  {
    key: "last-night-sleep",
    section: "today",
    label: "Last-night sleep",
    composition: "composed",
    matches: idStartsWith(
      "sleep.duration:",
      "sleep.bed-time:",
      "sleep.wake-time:",
      "sleep.bootstrap",
      "sleep.dormant"
    ),
    memberOrder: {
      kind: "identity",
      prefixes: [
        "sleep.duration:",
        "sleep.bed-time:",
        "sleep.wake-time:",
        "sleep.bootstrap",
        "sleep.dormant",
      ],
    },
  },
  {
    key: "steps-today",
    section: "today",
    label: "Steps today",
    composition: "single",
    matches: idStartsWith("activity.steps:", "activity.steps-bootstrap"),
    memberOrder: {
      kind: "identity",
      prefixes: ["activity.steps:", "activity.steps-bootstrap"],
    },
  },
  {
    key: "protein-today",
    section: "today",
    label: "Protein today",
    composition: "single",
    matches: idStartsWith("nutrition.protein:", "nutrition.bootstrap"),
    memberOrder: {
      kind: "identity",
      prefixes: ["nutrition.protein:", "nutrition.bootstrap"],
    },
  },
  {
    key: "nap-total",
    section: "today",
    label: "Nap total",
    composition: "single",
    matches: idStartsWith("sleep.nap-total:"),
    memberOrder: { kind: "identity", prefixes: ["sleep.nap-total:"] },
  },
  {
    key: "cycle-phase",
    section: "today",
    label: "Cycle day / phase",
    composition: "single",
    matches: idStartsWith("cycle.phase:"),
    memberOrder: { kind: "identity", prefixes: ["cycle.phase:"] },
  },
  {
    key: "weight",
    section: "body",
    label: "Weight",
    composition: "composed",
    matches: idStartsWith(
      "weight.latest:",
      "weight.trend",
      "weight.bootstrap",
      "weight.dormant"
    ),
    memberOrder: {
      kind: "identity",
      prefixes: [
        "weight.latest:",
        "weight.trend",
        "weight.bootstrap",
        "weight.dormant",
      ],
    },
  },
  {
    key: "blood-pressure",
    section: "body",
    label: "Blood pressure",
    composition: "single",
    matches: idStartsWith("vitals.blood-pressure:"),
    memberOrder: {
      kind: "identity",
      prefixes: ["vitals.blood-pressure:"],
    },
  },
  {
    key: "resting-heart-rate",
    section: "body",
    label: "Resting heart rate",
    composition: "single",
    matches: idStartsWith("vitals.resting-heart-rate:"),
    memberOrder: {
      kind: "identity",
      prefixes: ["vitals.resting-heart-rate:"],
    },
  },
  {
    key: "healthspan-pillars",
    section: "longer-view",
    label: "Healthspan pillars",
    composition: "members",
    matches: idStartsWith("healthspan.pillar:"),
    memberOrder: { kind: "source", authority: "buildPillars" },
  },
  {
    key: "clinical-results",
    section: "longer-view",
    label: "Recent clinical results",
    composition: "members",
    matches: idStartsWith("labs.latest:", "labs.bootstrap"),
    memberOrder: { kind: "source", authority: "recentLabHighlights" },
    cap: CLINICAL_RESULTS_CAP,
  },
  {
    key: "outcome-goals",
    section: "longer-view",
    label: "Outcome goals",
    composition: "members",
    matches: idStartsWith("goal.progress:"),
    memberOrder: { kind: "source", authority: "outcome-goal-source" },
    cap: 4,
  },
  {
    key: "weekly-targets",
    section: "longer-view",
    label: "Weekly targets",
    composition: "members",
    // A met target is claimed by this family and then declines its seat
    // (`standingEligible: false`), which is what makes it a capped-family tail
    // rather than a loose fact: it celebrates the transition in Now and, once
    // that decays, /training owns it (#3186).
    matches: idStartsWith("target.weekly-progress:"),
    memberOrder: { kind: "source", authority: "summarizeDashboardHabits" },
    cap: 4,
  },
] as const;

export interface StandingMember {
  candidate: DashboardCandidate;
  family: StandingReadingFamily;
}

function identityOrder(
  candidate: DashboardCandidate,
  prefixes: readonly string[]
): number {
  const index = prefixes.findIndex((prefix) =>
    candidate.candidateId.startsWith(prefix)
  );
  return index < 0 ? prefixes.length : index;
}

function orderFamilyMembers(
  members: readonly DashboardCandidate[],
  family: StandingReadingFamily
): DashboardCandidate[] {
  if (family.memberOrder.kind === "source") {
    return members.toSorted(
      (a, b) =>
        a.sourceOrder - b.sourceOrder ||
        a.candidateId.localeCompare(b.candidateId)
    );
  }
  const prefixes = family.memberOrder.prefixes;
  return members.toSorted(
    (a, b) =>
      identityOrder(a, prefixes) - identityOrder(b, prefixes) ||
      a.sourceOrder - b.sourceOrder ||
      a.candidateId.localeCompare(b.candidateId)
  );
}

export function standingFamilyForCandidate(
  candidate: DashboardCandidate
): StandingReadingFamily | undefined {
  return STANDING_READING_ORDER.find((family) => family.matches(candidate));
}

function isStandingReadingOrReplacement(
  candidate: DashboardCandidate
): boolean {
  if (candidate.relevance.kind !== "profile-data") return false;
  return (
    candidate.kind === "reading" ||
    candidate.relevance.presence === "never" ||
    candidate.relevance.presence === "dormant"
  );
}

export function resolveStandingMembers(
  candidates: readonly DashboardCandidate[],
  activeProfileId: number
): {
  members: StandingMember[];
  memberIds: ReadonlySet<string>;
  factKeys: ReadonlySet<string>;
  cappedOverflowIds: ReadonlySet<string>;
} {
  const members: StandingMember[] = [];
  const memberIds = new Set<string>();
  const claimedFacts = new Set<string>();
  // Owner ruling (#3186): a capped family renders its capped members and nothing
  // else. What the family claims but does not seat is its tail, and the tail is
  // not a dashboard fact — the ranker keeps it out of every lane.
  const cappedOverflowIds = new Set<string>();

  for (const family of STANDING_READING_ORDER) {
    const claimed = candidates.filter(
      (candidate) =>
        !memberIds.has(candidate.candidateId) &&
        !claimedFacts.has(candidate.factKey) &&
        candidate.subject.scope === "profile" &&
        candidate.subject.profileId === activeProfileId &&
        isStandingReadingOrReplacement(candidate) &&
        family.matches(candidate)
    );
    const familyFacts = new Set<string>();
    const ordered = orderFamilyMembers(
      claimed.filter((candidate) => candidate.standingEligible !== false),
      family
    ).filter((candidate) => {
      if (familyFacts.has(candidate.factKey)) return false;
      familyFacts.add(candidate.factKey);
      return true;
    });
    const selected =
      family.cap == null ? ordered : ordered.slice(0, family.cap);
    for (const candidate of selected) {
      members.push({ candidate, family });
      memberIds.add(candidate.candidateId);
      claimedFacts.add(candidate.factKey);
    }
    if (family.cap == null) continue;
    const seated = new Set(selected.map((candidate) => candidate.candidateId));
    for (const candidate of claimed) {
      if (!seated.has(candidate.candidateId))
        cappedOverflowIds.add(candidate.candidateId);
    }
  }

  return { members, memberIds, factKeys: claimedFacts, cappedOverflowIds };
}

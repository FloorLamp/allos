import type { DashboardCandidate } from "./dashboard-relevance";
import { standingReasonClaim } from "./dashboard-rank-precedence";

export type StandingSectionKey = "today" | "body" | "longer-view";

// Standing is one RANKED surface in three bands (#3548). Membership is derived
// from the candidate model — never from a closed id list — so a new candidate with
// a rank reason lifts into the tier with no edit here.
//
// "tail" is no longer a Standing band that renders (#4232). Standing shrinks to its
// attention tier and its stable rest — always open, purely the glance surface — and a
// member whose band resolves to "tail" STOPS CLAIMING: `resolveStandingMembers` drops
// it, so the exact-once partition routes it itself. It is still named here because it
// is the verdict the registry's `quietBand` declares and the value this resolver
// computes to reach it, not because a third band draws anything.
export type StandingBandKey = "attention" | "rest" | "tail";

// The bands Standing DRAWS. "tail" is the resolver's verdict for a member that holds
// no seat at all, so it can never reach a placement — narrowing it out of the placement
// type is what makes "Standing shows attention + rest only" a type error to violate
// rather than a convention to remember.
export type StandingRenderedBand = Exclude<StandingBandKey, "tail">;

// How many never-recorded bootstrap CTAs may hold a cold-start claim at once
// (owner ruling #3548: 2-3, ordered by onboarding value). The order is
// STANDING_READING_ORDER's own declaration order, which already puts the
// integration connects (sleep, steps) ahead of the first-manual-log ones
// (protein, weight) — so the ruling's ordering needs no second list. Past the cap
// a CTA is out-ranked and folds, which is the same rule that retires one whose
// family has recorded.
export const STANDING_CTA_CLAIM_CAP = 3;

export type StandingFamilyKey =
  | "day-so-far"
  | "protein-today"
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
  // "single" folded into "composed" (#4969 item 2): a lone member was already
  // "composed" with one member and nothing enforcing the count, so the third
  // value bought no distinction a caller could act on.
  composition: "composed" | "members";
  matches: (candidate: DashboardCandidate) => boolean;
  /**
   * Where this family's members sit when they hold NO live claim (#3548, narrowed by
   * #4232). Default "rest": a daily instrument you glance by position stays where it
   * always is. "tail" is for the families whose quiet rows are a months-old record
   * rather than an instrument — the owner named quiet pillars and months-old results —
   * and since #4232 that verdict means the member does not claim Standing at all, so
   * the one bottom fold takes it.
   */
  quietBand?: StandingBandKey;
  memberOrder:
    | { kind: "identity"; prefixes: readonly string[] }
    | {
        kind: "source";
        authority:
          | "buildPillars"
          | "recentLabHighlights"
          | "outcome-goal-source"
          | "orderDashboardHabits";
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
    key: "protein-today",
    section: "today",
    label: "Protein today",
    composition: "composed",
    matches: idStartsWith("nutrition.protein:", "nutrition.bootstrap"),
    memberOrder: {
      kind: "identity",
      prefixes: ["nutrition.protein:", "nutrition.bootstrap"],
    },
  },
  {
    key: "cycle-phase",
    section: "today",
    label: "Cycle day / phase",
    composition: "composed",
    matches: idStartsWith("cycle.phase:"),
    memberOrder: { kind: "identity", prefixes: ["cycle.phase:"] },
  },
  // THE DAY SO FAR (#4969), last in Today because it is the band's only DRAWING
  // and the numbers above it are what a glance reads first. One row for the whole
  // morning read: last night's sleep (or its waiting/bootstrap/dormant/refresh
  // replacement — #2097's waiting atom belongs to this family, not to a hand-set
  // Show-everything mount), today's naps, steps and the intraday chart. A member
  // may be absent (no watch minutes yet, no wearable at all) without the family
  // disappearing — presence is "any member placed", same as every other family.
  {
    key: "day-so-far",
    section: "today",
    label: "Day so far",
    composition: "composed",
    matches: idStartsWith(
      "sleep.duration:",
      "sleep.bed-time:",
      "sleep.wake-time:",
      "sleep.waiting:",
      "sleep.refresh",
      "sleep.bootstrap",
      "sleep.dormant",
      "sleep.nap-total:",
      "activity.steps:",
      "activity.steps-bootstrap",
      "activity.intraday:"
    ),
    memberOrder: {
      kind: "identity",
      prefixes: [
        "sleep.duration:",
        "sleep.bed-time:",
        "sleep.wake-time:",
        "sleep.waiting:",
        "sleep.refresh",
        "sleep.bootstrap",
        "sleep.dormant",
        "sleep.nap-total:",
        "activity.steps:",
        "activity.steps-bootstrap",
        "activity.intraday:",
      ],
    },
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
    composition: "composed",
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
    composition: "composed",
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
    quietBand: "tail",
    matches: idStartsWith("healthspan.pillar:"),
    memberOrder: { kind: "source", authority: "buildPillars" },
  },
  {
    key: "clinical-results",
    section: "longer-view",
    label: "Recent clinical results",
    composition: "members",
    quietBand: "tail",
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
    memberOrder: { kind: "source", authority: "orderDashboardHabits" },
    cap: 4,
  },
] as const;

export interface StandingMember {
  candidate: DashboardCandidate;
  family: StandingReadingFamily;
  band: StandingBandKey;
}

export interface StandingClaimedMember extends StandingMember {
  band: StandingRenderedBand;
}

// A candidate's claim on the attention tier, read from the SAME `rankReasons`
// the Now lane reads and in the same precedence `nowScore` scores them in
// (safety > owed > changed). It is a precedence over existing reasons, not a
// second scoring model: nothing here invents a signal, and a candidate that
// declares a reason is liftable with no edit to this file.
//
// A never-recorded bootstrap CTA holds the weakest claim (0) — on an empty
// profile the tier is the getting-started list, but a behind target or a result
// that just turned notable outranks "connect a source".
const CTA_CLAIM = 0;

function reasonClaim(candidate: DashboardCandidate): number | null {
  return standingReasonClaim(candidate.rankReasons);
}

function presenceOf(
  candidate: DashboardCandidate
): "never" | "current" | "dormant" {
  return candidate.relevance.kind === "profile-data"
    ? candidate.relevance.presence
    : "current";
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

// A candidate may join a Standing family when it speaks FOR a piece of
// profile data — an ordinary reading, or a replacement standing in for one
// that is missing (`never`), gone stale (`dormant`), or momentarily unsettled
// (`current` on a non-reading kind: the sleep-waiting and stale-refresh atoms,
// #4969 — "the two sleep atoms move into a family, they do not disappear").
// `relevance.kind === "profile-data"` already says all of that: every builder
// that declares it is declaring membership in exactly this story, whatever
// its structural `kind` or presence.
function isStandingReadingOrReplacement(
  candidate: DashboardCandidate
): boolean {
  return candidate.relevance.kind === "profile-data";
}

export function resolveStandingMembers(
  candidates: readonly DashboardCandidate[],
  activeProfileId: number
): {
  members: StandingClaimedMember[];
  memberIds: ReadonlySet<string>;
  factKeys: ReadonlySet<string>;
  cappedOverflowIds: ReadonlySet<string>;
} {
  const members: StandingMember[] = [];
  const composedClaims = new Map<StandingFamilyKey, number>();
  const memberIds = new Set<string>();
  // Cold-start CTAs are ranked across the whole surface, not per family, because
  // the cap the owner set is a cap on the getting-started LIST — and the list only
  // exists while there is nothing else. The two owner texts meet here: on an empty
  // profile "the attention tier IS the getting-started list", and on a profile that
  // records anything "a wearable-less profile's open dashboard carries no permanent
  // connect-a-source furniture". So the CTA's claim is spent by the profile having
  // live data at all, not only by its own family recording.
  const coldStart = !candidates.some(
    (candidate) =>
      candidate.kind === "reading" && presenceOf(candidate) === "current"
  );
  let ctaRank = 0;
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
    const composedClaim =
      family.composition === "composed"
        ? selected.reduce(
            (best, candidate) => Math.max(best, reasonClaim(candidate) ?? -1),
            -1
          )
        : -1;
    if (composedClaim >= 0) composedClaims.set(family.key, composedClaim);
    for (const candidate of selected) {
      const claim = composedClaims.get(family.key) ?? reasonClaim(candidate);
      const presence = presenceOf(candidate);
      const band: StandingBandKey =
        claim != null
          ? "attention"
          : presence === "never"
            ? coldStart && ctaRank++ < STANDING_CTA_CLAIM_CAP
              ? "attention"
              : "tail"
            : presence === "dormant"
              ? "tail"
              : (family.quietBand ?? "rest");
      members.push({ candidate, family, band });
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

  // The bands ARE the render order: the tier first, ranked by claim; then the
  // stable rest, in the registry's own declaration order, which is what keeps a
  // glance-by-position row byte-stable while no claim moves.
  const bandOrder: Record<StandingBandKey, number> = {
    attention: 0,
    rest: 1,
    tail: 2,
  };
  const attentionClaim = (member: StandingMember) =>
    composedClaims.get(member.family.key) ??
    reasonClaim(member.candidate) ??
    CTA_CLAIM;
  const ranked = members
    .map((member, index) => ({ member, index }))
    .sort(
      (a, b) =>
        bandOrder[a.member.band] - bandOrder[b.member.band] ||
        (b.member.band === "attention"
          ? attentionClaim(b.member) - attentionClaim(a.member)
          : 0) ||
        a.index - b.index
    )
    .map(({ member }) => member);

  // ONE FOLD (#4232). A quiet member is not claimed, so the Standing lane hands it
  // back to the exact-once partition and `everythingGroup` routes it on its own model:
  // dormancy and the two quiet families to Read, out-ranked never-recorded CTAs to
  // Setup. The loop above still walked every member — the family caps, the composed
  // claims and the cold-start ranking are all computed over the full set — because
  // what a family CLAIMS is what decides which of its rows the tier can seat, and that
  // question is unchanged. Only the seat is withdrawn.
  const claimed = ranked.filter(
    (member): member is StandingClaimedMember => member.band !== "tail"
  );
  return {
    members: claimed,
    memberIds: new Set(claimed.map((member) => member.candidate.candidateId)),
    factKeys: new Set(claimed.map((member) => member.candidate.factKey)),
    cappedOverflowIds,
  };
}

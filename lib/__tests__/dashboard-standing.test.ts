import { describe, expect, it } from "vitest";
import {
  actionCandidate,
  profileDataRelevance,
  readingCandidate,
  stateCandidate,
  statementCandidate,
} from "../dashboard-candidates";
import {
  rankDashboardCandidates,
  type DashboardCandidate,
} from "../dashboard-relevance";
import { STANDING_READING_ORDER } from "../dashboard-standing";

const profile = { scope: "profile" as const, profileId: 7 };

function reading(
  candidateId: string,
  sourceOrder: number,
  overrides: Partial<DashboardCandidate> = {}
): DashboardCandidate {
  return {
    ...readingCandidate({
      candidateId,
      factKey: `fact:${candidateId}`,
      groupKey: null,
      subject: profile,
      applicable: true,
      relevance: profileDataRelevance("current", "manual"),
      sourceOrder,
    }),
    ...overrides,
  } as DashboardCandidate;
}

function replacement(
  candidateId: string,
  presence: "never" | "dormant",
  sourceOrder: number
): DashboardCandidate {
  const base = {
    candidateId,
    factKey: `fact:${candidateId}`,
    groupKey: null,
    subject: profile,
    applicable: true,
    relevance: profileDataRelevance(presence),
    sourceOrder,
  };
  return presence === "never"
    ? actionCandidate({ ...base, obligation: "may" })
    : stateCandidate(base);
}

const rank = (candidates: readonly DashboardCandidate[]) =>
  rankDashboardCandidates(candidates, {
    activeProfileId: 7,
    minutesOfDay: 12 * 60,
  });

function standingIds(candidates: readonly DashboardCandidate[]): string[] {
  return rank(candidates)
    .filter((placement) => placement.lane === "standing")
    .map((placement) => placement.candidate.candidateId);
}

describe("fixed Standing instrument cluster", () => {
  it("declares the closed section and family order", () => {
    expect(
      STANDING_READING_ORDER.map(({ section, key, cap }) => [section, key, cap])
    ).toEqual([
      ["today", "last-night-sleep", undefined],
      ["today", "steps-today", undefined],
      ["today", "protein-today", undefined],
      ["today", "nap-total", undefined],
      ["today", "cycle-phase", undefined],
      ["body", "weight", undefined],
      ["body", "blood-pressure", undefined],
      ["body", "resting-heart-rate", undefined],
      ["longer-view", "healthspan-pillars", undefined],
      ["longer-view", "clinical-results", 6],
      ["longer-view", "outcome-goals", 4],
      ["longer-view", "weekly-targets", 4],
    ]);
  });

  it("is invariant to gather order and applies only family-local order and caps", () => {
    const candidates = [
      reading("target.weekly-progress:5", 405),
      reading("sleep.wake-time:2026-08-18", 2),
      reading("labs.latest:g", 306),
      reading("healthspan.pillar:sleep-regularity", 199),
      reading("goal.progress:5", 405),
      reading("activity.steps:2026-08-18", 12, {
        relevance: profileDataRelevance("current", "external"),
      }),
      reading("weight.trend", 101),
      reading("sleep.duration:2026-08-18", 0),
      reading("vitals.resting-heart-rate:2026-08-18", 104),
      reading("nutrition.protein:2026-08-18", 13),
      reading("cycle.phase:2026-08-18", 15),
      reading("sleep.nap-total:2026-08-18", 14),
      reading("weight.latest:2026-08-18", 100),
      reading("vitals.blood-pressure:2026-08-18", 103),
      reading("sleep.bed-time:2026-08-18", 1),
      ...[6, 1, 4, 2, 7, 3, 5].map((id, index) =>
        reading(`labs.latest:${id}`, 300 + index)
      ),
      ...[4, 2, 1, 3].map((id, index) =>
        reading(`healthspan.pillar:${id}`, 200 + index)
      ),
      ...[4, 1, 3, 2].map((id, index) =>
        reading(`goal.progress:${id}`, 400 + index)
      ),
      ...[4, 1, 3, 2].map((id, index) =>
        reading(`target.weekly-progress:${id}`, 400 + index)
      ),
    ];
    const expected = standingIds(candidates);
    expect(standingIds(candidates.toReversed())).toEqual(expected);
    expect(expected.slice(0, 11)).toEqual([
      "sleep.duration:2026-08-18",
      "sleep.bed-time:2026-08-18",
      "sleep.wake-time:2026-08-18",
      "activity.steps:2026-08-18",
      "nutrition.protein:2026-08-18",
      "sleep.nap-total:2026-08-18",
      "cycle.phase:2026-08-18",
      "weight.latest:2026-08-18",
      "weight.trend",
      "vitals.blood-pressure:2026-08-18",
      "vitals.resting-heart-rate:2026-08-18",
    ]);
    expect(expected.filter((id) => id.startsWith("labs.latest:"))).toHaveLength(
      6
    );
    expect(
      expected.filter((id) => id.startsWith("goal.progress:"))
    ).toHaveLength(4);
    expect(
      expected.filter((id) => id.startsWith("target.weekly-progress:"))
    ).toHaveLength(4);

    const everythingIds = rank(candidates)
      .filter((placement) => placement.lane === "everything")
      .map((placement) => placement.candidate.candidateId);
    expect(everythingIds).toEqual(
      expect.arrayContaining([
        "labs.latest:g",
        "goal.progress:5",
        "target.weekly-progress:5",
      ])
    );
  });

  it("keeps family replacements in place and removes not-applicable families", () => {
    const placements = rank([
      replacement("sleep.bootstrap", "never", 40),
      replacement("weight.dormant", "dormant", 2),
      replacement("labs.bootstrap", "never", 1),
      { ...reading("cycle.phase:today", 0), applicable: false },
    ]).filter((placement) => placement.lane === "standing");
    expect(
      placements.map(({ candidate, standingFamilyKey }) => [
        candidate.candidateId,
        standingFamilyKey,
      ])
    ).toEqual([
      ["sleep.bootstrap", "last-night-sleep"],
      ["weight.dormant", "weight"],
      ["labs.bootstrap", "clinical-results"],
    ]);
  });

  it("leaves unclaimed kinds, shared actions, individual naps, and regularity out", () => {
    const candidates = [
      actionCandidate({
        candidateId: "activity.steps:action-lookalike",
        factKey: "vitals.manual-log-offer:today",
        groupKey: "vitals.latest",
        subject: profile,
        applicable: true,
        relevance: { kind: "event" },
        obligation: "may",
        sourceOrder: 0,
      }),
      statementCandidate({
        candidateId: "nutrition.protein:statement-lookalike",
        factKey: "appointment.next:/appointments",
        groupKey: null,
        subject: profile,
        applicable: true,
        relevance: { kind: "event" },
        sourceOrder: 1,
      }),
      stateCandidate({
        candidateId: "weight.latest:state-lookalike",
        factKey: "weight.state:today",
        groupKey: null,
        subject: profile,
        applicable: true,
        relevance: profileDataRelevance("current"),
        sourceOrder: 2,
      }),
      reading("sleep.nap:today:600", 3),
      reading("sleep.regularity:today", 4),
      reading("unregistered.reading", 5),
      reading("target.weekly-progress:complete", 6, {
        standingEligible: false,
      }),
    ];
    expect(standingIds(candidates)).toEqual([]);
    expect(
      rank(candidates).every((placement) => placement.lane === "everything")
    ).toBe(true);
  });

  it("deduplicates a fact by the first registry family and moves promotion", () => {
    const duplicateFact = "shared-fact";
    const duplicatePlacements = rank([
      reading("nutrition.protein:today", 0, { factKey: duplicateFact }),
      reading("activity.steps:today", 1, { factKey: duplicateFact }),
    ]);
    expect(duplicatePlacements).toHaveLength(1);
    expect(duplicatePlacements[0]).toMatchObject({
      lane: "standing",
      standingFamilyKey: "steps-today",
    });

    const withinFamily = rank([
      reading("labs.latest:first", 0, { factKey: duplicateFact }),
      reading("labs.latest:second", 1, { factKey: duplicateFact }),
    ]);
    expect(withinFamily).toHaveLength(1);
    expect(withinFamily[0].candidate.candidateId).toBe("labs.latest:first");

    const promoted = reading("activity.steps:today", 0, {
      rankReasons: {
        safety: false,
        owed: false,
        windowOpen: false,
        changed: true,
      },
      readingPromotion: "weekly-target-transition",
    });
    const placements = rank([promoted]);
    expect(placements).toHaveLength(1);
    expect(placements[0].lane).toBe("now");
  });

  it("scopes ordinary Standing members to the active profile", () => {
    const other = reading("activity.steps:other", 0, {
      subject: { scope: "profile", profileId: 8 },
    });
    expect(rank([other])[0].lane).toBe("everything");
  });
});

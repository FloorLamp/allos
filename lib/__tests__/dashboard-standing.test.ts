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
import {
  CLINICAL_RESULTS_CAP,
  STANDING_READING_ORDER,
} from "../dashboard-standing";

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

    // The tail each capped family did not seat is not a dashboard fact at all
    // (#3186) — no lane holds it, and its family's own page owns it.
    const placedIds = rank(candidates).map(
      (placement) => placement.candidate.candidateId
    );
    for (const tail of [
      "labs.latest:g",
      "goal.progress:5",
      "target.weekly-progress:5",
    ])
      expect(placedIds).not.toContain(tail);
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

// The owner ruling of #3186: a capped family renders its capped members and
// nothing else. The dashboard is for what is relevant; the family's own page owns
// the rest of the census. This deliberately narrows #3077's "reduce prominence,
// never access" to the uncapped facts.
describe("a capped Standing family's tail", () => {
  const changedReasons = {
    safety: false,
    owed: false,
    windowOpen: false,
    changed: true,
  };
  const cap = CLINICAL_RESULTS_CAP;

  it("never becomes a dashboard candidate in any lane", () => {
    const markers = Array.from({ length: cap + 5 }, (_, index) =>
      reading(`labs.latest:marker-${index}`, 300 + index)
    );
    const placements = rank(markers);

    expect(
      placements.map(({ candidate, lane }) => [candidate.candidateId, lane])
    ).toEqual(
      markers
        .slice(0, cap)
        .map((candidate) => [candidate.candidateId, "standing"])
    );
    // Exact-once by factKey holds over the census NET of the tail: what is placed
    // is placed once, and the tail is placed nowhere.
    const factKeys = placements.map(({ candidate }) => candidate.factKey);
    expect(new Set(factKeys).size).toBe(factKeys.length);
  });

  it("still promotes a marker that becomes notable outside the capped order", () => {
    const alreadyNotable = Array.from({ length: cap }, (_, index) =>
      reading(`labs.latest:notable-${index}`, 300 + index)
    );
    const becameNotable = reading("labs.latest:newly-notable", 300 + cap, {
      rankReasons: changedReasons,
      readingPromotion: "clinical-non-notable-to-notable",
    });
    const placements = rank([...alreadyNotable, becameNotable]);

    expect(
      placements.find(
        ({ candidate }) => candidate.candidateId === "labs.latest:newly-notable"
      )
    ).toMatchObject({
      lane: "now",
      candidate: { readingPromotion: "clinical-non-notable-to-notable" },
    });
    expect(
      placements.filter((placement) => placement.lane === "standing")
    ).toHaveLength(cap);
  });

  it("celebrates a met weekly target once and then leaves every lane", () => {
    const unmet = reading("target.weekly-progress:1", 400);
    const met = (promoted: boolean) =>
      reading("target.weekly-progress:2", 401, {
        standingEligible: false,
        ...(promoted
          ? {
              rankReasons: changedReasons,
              readingPromotion: "weekly-target-transition" as const,
            }
          : {}),
      });

    expect(
      rank([unmet, met(true)]).map(({ candidate, lane }) => [
        candidate.candidateId,
        lane,
      ])
    ).toEqual([
      ["target.weekly-progress:2", "now"],
      ["target.weekly-progress:1", "standing"],
    ]);

    expect(
      rank([unmet, met(false)]).map(({ candidate, lane }) => [
        candidate.candidateId,
        lane,
      ])
    ).toEqual([["target.weekly-progress:1", "standing"]]);
  });

  it("leaves an uncapped family's members whole", () => {
    const pillars = Array.from({ length: cap + 3 }, (_, index) =>
      reading(`healthspan.pillar:pillar-${index}`, 200 + index)
    );
    expect(rank(pillars).every(({ lane }) => lane === "standing")).toBe(true);
    expect(rank(pillars)).toHaveLength(pillars.length);
  });
});

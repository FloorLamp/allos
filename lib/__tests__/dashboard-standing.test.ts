import { describe, expect, it } from "vitest";
import {
  actionCandidate,
  careCandidates,
  profileDataRelevance,
  readingCandidate,
  stateCandidate,
  statementCandidate,
} from "../dashboard-candidates";
import {
  rankDashboardCandidates,
  type DashboardCandidate,
  type DashboardPlacement,
} from "../dashboard-relevance";
import {
  cappedFamilyGather,
  CLINICAL_RESULTS_CAP,
  STANDING_CTA_CLAIM_CAP,
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
    today: "2026-08-19",
    upcoming: [],
  });

function standingIds(candidates: readonly DashboardCandidate[]): string[] {
  return rank(candidates)
    .filter((placement) => placement.lane === "standing")
    .map((placement) => placement.candidate.candidateId);
}

function everythingIds(candidates: readonly DashboardCandidate[]): string[] {
  return rank(candidates)
    .filter((placement) => placement.lane === "everything")
    .map((placement) => placement.candidate.candidateId);
}

// WHERE A CANDIDATE LANDS, now that quiet is not a Standing band (#4232). Standing
// keeps its tier and its stable rest; a member the registry calls quiet is not
// claimed at all, so the exact-once partition routes it and the verdict a case
// asserts is a LANE plus the band or the tail group inside it. Absent ⇒ placed
// nowhere, which is its own verdict (#3186's capped tail).
function placedAs(
  candidates: readonly DashboardCandidate[],
  candidateId: string
): [DashboardPlacement["lane"], string] | undefined {
  const placement = rank(candidates).find(
    (entry) => entry.candidate.candidateId === candidateId
  );
  if (!placement) return undefined;
  return [
    placement.lane,
    placement.lane === "standing"
      ? placement.standingBand
      : placement.lane === "everything"
        ? placement.everythingGroup
        : placement.lane,
  ];
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
    expect(
      STANDING_READING_ORDER.find(({ key }) => key === "weekly-targets")
        ?.memberOrder
    ).toEqual({ kind: "source", authority: "orderDashboardHabits" });
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
    // The clinical family still SEATS six — the cap is unchanged (#3186) — but since
    // #4232 its quiet members are not claimed by Standing, so the six it seats are
    // the six the one fold draws in Read.
    expect(expected.filter((id) => id.startsWith("labs.latest:"))).toHaveLength(
      0
    );
    expect(
      everythingIds(candidates).filter((id) => id.startsWith("labs.latest:"))
    ).toHaveLength(6);
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
    // #3548: a never-recorded family's CTA holds a cold-start claim and leads the
    // attention tier; a source that recorded and went quiet folds into the tail.
    expect(
      placements.map(({ candidate, standingFamilyKey, standingBand }) => [
        candidate.candidateId,
        standingFamilyKey,
        standingBand,
      ])
    ).toEqual([
      ["sleep.bootstrap", "last-night-sleep", "attention"],
      ["labs.bootstrap", "clinical-results", "attention"],
    ]);
    // …and the quiet source is in the ONE fold, in the group its own model routes it
    // to (#4232): a dormant reading reads.
    expect(
      placedAs(
        [
          replacement("sleep.bootstrap", "never", 40),
          replacement("weight.dormant", "dormant", 2),
          replacement("labs.bootstrap", "never", 1),
          { ...reading("cycle.phase:today", 0), applicable: false },
        ],
        "weight.dormant"
      )
    ).toEqual(["everything", "read"]);
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
    expect(rank([other])).toEqual([]);
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

    // The six the family SEATS are placed — since #4232 quiet results are not claimed
    // by Standing, so their lane is the one fold — and the five past the cap are
    // placed nowhere at all, which is the ruling this case exists for.
    expect(
      placements.map(({ candidate, lane }) => [candidate.candidateId, lane])
    ).toEqual(
      markers
        .slice(0, cap)
        .map((candidate) => [candidate.candidateId, "everything"])
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
      placements.filter((placement) => placement.lane === "everything")
    ).toHaveLength(cap);
    expect(
      placements.filter((placement) => placement.lane === "standing")
    ).toHaveLength(0);
  });

  it("keeps a tail entry with a live promotion, even when Now is full", () => {
    const owed = (candidateId: string, sourceOrder: number) =>
      actionCandidate({
        candidateId,
        factKey: `fact:${candidateId}`,
        groupKey: null,
        subject: profile,
        applicable: true,
        relevance: { kind: "event" },
        obligation: "must",
        rankReasons: {
          safety: false,
          owed: true,
          windowOpen: false,
          changed: false,
        },
        sourceOrder,
      });
    const placements = rank([
      owed("intake.log:morning", 0),
      owed("intake.log:evening", 1),
      ...Array.from({ length: cap }, (_, index) =>
        reading(`labs.latest:notable-${index}`, 300 + index)
      ),
      reading("labs.latest:newly-notable", 300 + cap, {
        rankReasons: changedReasons,
        readingPromotion: "clinical-non-notable-to-notable",
      }),
    ]);

    // The ordinary Now cap is spent on the two owed actions, so the promotion
    // cannot take a Now seat — and the ruling still may not hide it.
    expect(
      placements.find(
        ({ candidate }) => candidate.candidateId === "labs.latest:newly-notable"
      )
    ).toMatchObject({ lane: "everything" });
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

  it("gathers the seats a capped family has plus its live promotions", () => {
    const markers = Array.from(
      { length: cap + 3 },
      (_, index) => `marker-${index}`
    );
    const outsideTheCap = markers[cap + 2];

    expect(
      cappedFamilyGather(markers, cap, (marker) => marker === outsideTheCap)
    ).toEqual([...markers.slice(0, cap), outsideTheCap]);
    expect(cappedFamilyGather(markers, cap, () => false)).toEqual(
      markers.slice(0, cap)
    );
  });

  it("leaves an uncapped family's members whole", () => {
    const pillars = Array.from({ length: cap + 3 }, (_, index) =>
      reading(`healthspan.pillar:pillar-${index}`, 200 + index)
    );
    expect(rank(pillars).every(({ lane }) => lane === "everything")).toBe(true);
    expect(rank(pillars)).toHaveLength(pillars.length);
  });
});

// ── The three ranked bands (#3548) ───────────────────────────────────────────
//
// Membership is derived from the candidate's OWN rank reasons and presence, never
// from a list of ids kept in step by hand: every case below reaches its band by
// declaring something the Now lane already understands.
describe("Standing's ranked bands", () => {
  const claimed = (
    candidateId: string,
    reason: "owed" | "windowOpen" | "changed",
    sourceOrder: number
  ) =>
    reading(candidateId, sourceOrder, {
      rankReasons: {
        safety: false,
        owed: reason === "owed",
        windowOpen: reason === "windowOpen",
        changed: reason === "changed",
      },
      ...(reason === "changed"
        ? { readingPromotion: "clinical-non-notable-to-notable" as const }
        : {}),
    });

  // Two owed actions fill Now's cap (2), so a reading whose promotion is live is
  // pushed down into Standing — where the tier is what keeps it visible. Without
  // them a `changed` reading cards in Now, which is #3077 and is unchanged.
  const fillNow = (): DashboardCandidate[] =>
    ["now-filler-a", "now-filler-b"].map((candidateId) =>
      actionCandidate({
        candidateId,
        factKey: `fact:${candidateId}`,
        groupKey: null,
        subject: profile,
        applicable: true,
        relevance: { kind: "event" },
        obligation: "must",
        rankReasons: {
          safety: false,
          owed: true,
          windowOpen: false,
          changed: false,
        },
        sourceOrder: 0,
      })
    );

  it("lifts a composed family whole without changing member or quiet families", () => {
    const arrivedSleep = reading("sleep.duration:2026-08-18", 0, {
      rankReasons: {
        safety: false,
        owed: false,
        windowOpen: false,
        changed: true,
      },
      readingPromotion: "sleep-arrived",
    });
    const bands = (candidates: readonly DashboardCandidate[]) =>
      rank([...fillNow(), ...candidates])
        .filter((placement) => placement.lane === "standing")
        .map(({ candidate, standingBand }) => [
          candidate.candidateId,
          standingBand,
        ]);

    expect(
      bands([
        arrivedSleep,
        reading("sleep.bed-time:2026-08-18", 1),
        reading("sleep.wake-time:2026-08-18", 2),
      ])
    ).toEqual([
      ["sleep.duration:2026-08-18", "attention"],
      ["sleep.bed-time:2026-08-18", "attention"],
      ["sleep.wake-time:2026-08-18", "attention"],
    ]);

    // A `members` family is NOT composed, so its claim stays per member: the marker
    // that turned notable holds the tier and its quiet sibling is not claimed at all.
    const withMarkers = [
      ...fillNow(),
      claimed("labs.latest:tsh", "changed", 300),
      reading("labs.latest:ldl", 301),
    ];
    expect(
      bands([
        claimed("labs.latest:tsh", "changed", 300),
        reading("labs.latest:ldl", 301),
      ])
    ).toEqual([["labs.latest:tsh", "attention"]]);
    expect(placedAs(withMarkers, "labs.latest:ldl")).toEqual([
      "everything",
      "read",
    ]);

    expect(
      bands([
        reading("sleep.duration:2026-08-18", 0),
        reading("sleep.bed-time:2026-08-18", 1),
        reading("sleep.wake-time:2026-08-18", 2),
      ])
    ).toEqual([
      ["sleep.duration:2026-08-18", "rest"],
      ["sleep.bed-time:2026-08-18", "rest"],
      ["sleep.wake-time:2026-08-18", "rest"],
    ]);
  });

  // ONE FOLD (#4232): every row that used to reach the quiet band now leaves Standing
  // entirely and is routed by the exact-once partition's own model — dormancy and the
  // two quiet families to Read, an out-ranked never-recorded CTA to Setup. The table
  // states the whole verdict (lane, then band or group) so a row that silently swaps
  // one side of it for the other cannot pass.
  it.each([
    [
      "a behind weekly target (owed)",
      claimed("target.weekly-progress:9", "owed", 900),
      ["standing", "attention"],
    ],
    [
      "a marker that just turned notable (changed)",
      claimed("labs.latest:tsh", "changed", 300),
      ["standing", "attention"],
    ],
    // THROUGH THE REAL BUILDER, not a hand-made rank reason: the claim #4232 rules
    // is worth nothing if `careCandidates.lab` stops declaring it, and a synthetic
    // candidate here could never notice.
    [
      "a result collected inside the freshness window (#4232)",
      careCandidates.lab(
        { subject: profile, sourceOrder: 302 },
        "ferritin",
        { fresh: true }
      ),
      ["standing", "attention"],
    ],
    [
      "the same result once its window lapses or it is acknowledged",
      careCandidates.lab({ subject: profile, sourceOrder: 302 }, "ferritin", {
        fresh: false,
      }),
      ["everything", "read"],
    ],
    [
      "a fresh daily instrument",
      reading("activity.steps:2026-08-19", 12),
      ["standing", "rest"],
    ],
    [
      "an on-pace weekly target",
      reading("target.weekly-progress:8", 901),
      ["standing", "rest"],
    ],
    [
      "an open window without a Standing claim (#3245)",
      claimed("activity.steps:window-open", "windowOpen", 12),
      ["standing", "rest"],
    ],
    [
      "a quiet pillar",
      reading("healthspan.pillar:sleep-regularity", 199),
      ["everything", "read"],
    ],
    [
      "a quiet clinical result",
      reading("labs.latest:ldl", 301),
      ["everything", "read"],
    ],
    [
      "a source that went dormant",
      replacement("weight.dormant", "dormant", 100),
      ["everything", "read"],
    ],
    [
      "a never-recorded family's CTA",
      replacement("sleep.bootstrap", "never", 1),
      ["standing", "attention"],
    ],
  ])("places %s in %s", (_label, candidate, where) => {
    expect(placedAs([...fillNow(), candidate], candidate.candidateId)).toEqual(
      where
    );
  });

  // …AND AN OUT-RANKED CTA IS SETUP, not Read: the partition routes on the
  // candidate's own relevance, so the two former quiet populations do not collapse
  // into one group on their way out of Standing.
  it("routes an out-ranked cold-start CTA into the fold's Setup group", () => {
    const ctas = [
      replacement("sleep.bootstrap", "never", 1),
      replacement("activity.steps-bootstrap", "never", 2),
      replacement("nutrition.bootstrap", "never", 3),
      replacement("labs.bootstrap", "never", 5),
    ];
    expect(placedAs(ctas, "labs.bootstrap")).toEqual(["everything", "setup"]);
  });

  // The tier's order IS the ranker's reason precedence — safety, then owed, then
  // changed, then a cold-start CTA. One vocabulary, no second score. A profile that
  // records anything is past cold start, so its connect-a-source lines fold.
  it("ranks the tier by claim and leaves the rest and the tail in registry order", () => {
    const placements = rank([
      ...fillNow(),
      reading("activity.steps:2026-08-19", 12),
      replacement("sleep.bootstrap", "never", 1),
      claimed("labs.latest:tsh", "changed", 300),
      reading("healthspan.pillar:vo2", 199),
      claimed("target.weekly-progress:9", "owed", 900),
      reading("weight.latest:2026-08-19", 100),
      replacement("vitals.blood-pressure:2019-01-01", "dormant", 101),
    ]).filter((placement) => placement.lane === "standing");
    expect(
      placements.map(({ candidate, standingBand }) => [
        candidate.candidateId,
        standingBand,
      ])
    ).toEqual([
      ["target.weekly-progress:9", "attention"],
      ["labs.latest:tsh", "attention"],
      ["activity.steps:2026-08-19", "rest"],
      ["weight.latest:2026-08-19", "rest"],
    ]);
  });

  // The cold-start cap is a cap on the getting-started LIST, so it counts across
  // families rather than within one. Past it a CTA is out-ranked, not retired.
  it("folds a connect-a-source line once the profile records anything", () => {
    expect(
      rank([
        replacement("sleep.bootstrap", "never", 1),
        reading("activity.steps:2026-08-19", 12),
      ])
        .filter((placement) => placement.lane === "standing")
        .map(({ candidate, standingBand }) => [
          candidate.candidateId,
          standingBand,
        ])
    ).toEqual([["activity.steps:2026-08-19", "rest"]]);
    expect(
      placedAs(
        [
          replacement("sleep.bootstrap", "never", 1),
          reading("activity.steps:2026-08-19", 12),
        ],
        "sleep.bootstrap"
      )
    ).toEqual(["everything", "setup"]);
  });

  it("caps the cold-start claim and folds the CTAs beyond it", () => {
    const ctas = [
      replacement("sleep.bootstrap", "never", 1),
      replacement("activity.steps-bootstrap", "never", 2),
      replacement("nutrition.bootstrap", "never", 3),
      replacement("weight.bootstrap", "never", 4),
      replacement("labs.bootstrap", "never", 5),
    ];
    expect(STANDING_CTA_CLAIM_CAP).toBe(3);
    expect(
      rank(ctas)
        .filter((placement) => placement.lane === "standing")
        .map(({ candidate, standingBand }) => [
          candidate.candidateId,
          standingBand,
        ])
    ).toEqual([
      ["sleep.bootstrap", "attention"],
      ["activity.steps-bootstrap", "attention"],
      ["nutrition.bootstrap", "attention"],
    ]);
    expect(everythingIds(ctas)).toEqual([
      "weight.bootstrap",
      "labs.bootstrap",
    ]);
  });

  // #3245's other half, at the tier that can see it: a behind target carries the
  // claim as a READING. `nowScore` awards `owed` to actions only, so the reading
  // states the pace in Standing and never takes a Now slot on its own.
  it("keeps a behind target's reading out of Now", () => {
    const placements = rank([claimed("target.weekly-progress:9", "owed", 900)]);
    expect(placements.map(({ lane }) => lane)).toEqual(["standing"]);
  });

  // The stable rest is byte-stable while no claim moves: the same inputs in any
  // gather order produce the same rest order (#3103's spatial memory, kept).
  it("keeps the stable rest byte-stable across gather orders", () => {
    const members = [
      reading("activity.steps:2026-08-19", 12),
      reading("nutrition.protein:2026-08-19", 13),
      reading("weight.latest:2026-08-19", 100),
      reading("target.weekly-progress:8", 901),
    ];
    const restOrder = (candidates: readonly DashboardCandidate[]) =>
      rank(candidates)
        .filter(
          (placement) =>
            placement.lane === "standing" && placement.standingBand === "rest"
        )
        .map(({ candidate }) => candidate.candidateId);
    expect(restOrder(members)).toEqual(restOrder(members.toReversed()));
    expect(restOrder(members)).toEqual([
      "activity.steps:2026-08-19",
      "nutrition.protein:2026-08-19",
      "weight.latest:2026-08-19",
      "target.weekly-progress:8",
    ]);
  });
});

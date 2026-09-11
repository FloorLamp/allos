import { describe, expect, it } from "vitest";
import {
  orderedIllnessGroupKeys,
  rankDashboardCandidates,
  type DashboardCandidate,
  type DashboardEpisodeGroup,
  type DashboardEpisodeMemberRole,
} from "../dashboard-relevance";
import {
  actionCandidate,
  profileDataRelevance,
  stateCandidate,
  readingCandidate,
} from "../dashboard-candidates";

const activeProfileId = 7;

function metadata(
  profileId: number,
  episodeKey: string,
  episodeOrder: number,
  memberRole: DashboardEpisodeMemberRole,
  memberOrder = 0
): DashboardEpisodeGroup {
  return {
    kind: "illness-episode",
    groupKey: `illness.episode:${profileId}:${episodeKey}`,
    episodeKey,
    profileId,
    episodeOrder,
    memberRole,
    memberOrder,
  };
}

function episodeMember(
  profileId: number,
  episodeKey: string,
  episodeOrder: number,
  memberRole: DashboardEpisodeMemberRole,
  memberOrder = 0,
  factKey = `illness.${memberRole}:${profileId}:${episodeKey}:${memberOrder}`
): DashboardCandidate {
  const episodeGroup = metadata(
    profileId,
    episodeKey,
    episodeOrder,
    memberRole,
    memberOrder
  );
  const common = {
    candidateId: `candidate.${memberRole}:${profileId}:${episodeKey}:${memberOrder}`,
    factKey,
    groupKey: episodeGroup.groupKey,
    episodeGroup,
    subject: { scope: "profile" as const, profileId },
    applicable: true,
    relevance: { kind: "state" as const },
    sourceOrder: 500 - profileId - episodeOrder - memberOrder,
  };
  if (memberRole === "state")
    return stateCandidate({
      ...common,
      rankReasons: {
        safety: false,
        owed: false,
        windowOpen: false,
        changed: true,
      },
    });
  if (memberRole === "reading") return readingCandidate(common);
  return actionCandidate({
    ...common,
    obligation: memberRole,
    rankReasons: {
      safety: false,
      owed: true,
      windowOpen: false,
      changed: false,
    },
  });
}

function ordinary(
  id: string,
  sourceOrder: number,
  options: { safety?: boolean; factKey?: string } = {}
): DashboardCandidate {
  return actionCandidate({
    candidateId: id,
    factKey: options.factKey ?? `fact.${id}`,
    groupKey: null,
    subject: { scope: "profile", profileId: activeProfileId },
    applicable: true,
    relevance: { kind: "event" },
    obligation: "must",
    rankReasons: {
      safety: options.safety ?? false,
      owed: true,
      windowOpen: false,
      changed: false,
    },
    sourceOrder,
  });
}

// The live-workout state row, built inline. `setupCandidates.liveWorkout` emitted
// exactly this and was deleted with the retired families (#5435 §4); the case below
// is about the RANKER's now-lane seating, not the builder, so its input is stated
// here rather than the case going with the family.
function liveWorkout(
  activityId: number,
  sourceOrder: number
): DashboardCandidate {
  return stateCandidate({
    candidateId: `workout.live:${activityId}`,
    factKey: `workout.live:${activityId}`,
    groupKey: null,
    subject: { scope: "profile", profileId: activeProfileId },
    applicable: true,
    relevance: { kind: "state" },
    sourceOrder,
    rankReasons: {
      safety: false,
      owed: false,
      windowOpen: false,
      changed: true,
    },
  });
}

const rank = (candidates: DashboardCandidate[]) =>
  rankDashboardCandidates(candidates, {
    activeProfileId,
    minutesOfDay: 12 * 60,
    today: "2026-08-19",
    upcoming: [],
  });

describe("dashboard illness ordering", () => {
  // THE LAYERS NOW RUN INSIDE A SUBJECT (#4752 item 6). Safety, then whole ordered
  // episodes, then the capped ordinary work — the layering is unchanged, but a
  // cross-profile Now gathers each subject's rows before it draws them, so the
  // viewer's own ordinary rows sit under the viewer's own episode instead of
  // trailing a household member's. Nothing is promoted: a group's seat is its best
  // member's, which is why 7 still leads 2 and 2 still leads 11.
  it("layers uncapped safety, whole ordered episodes, then capped ordinary work, grouped by subject", () => {
    const candidates = [
      episodeMember(11, "member-b", 0, "reading"),
      ordinary("ordinary-c", 93),
      episodeMember(7, "active-b", 1, "should"),
      ordinary("safe-c", 3, { safety: true }),
      episodeMember(2, "member-a", 0, "state"),
      episodeMember(7, "active-a", 0, "reading", 1),
      ordinary("ordinary-a", 91),
      episodeMember(11, "member-b", 0, "state"),
      ordinary("safe-a", 1, { safety: true }),
      episodeMember(7, "active-b", 1, "state"),
      episodeMember(7, "active-a", 0, "must"),
      ordinary("ordinary-b", 92),
      episodeMember(2, "member-a", 0, "reading"),
      ordinary("safe-b", 2, { safety: true }),
      episodeMember(7, "active-a", 0, "state"),
      episodeMember(7, "active-a", 0, "reading", 0),
      episodeMember(7, "active-a", 0, "should"),
    ];

    const now = rank(candidates)
      .filter((placement) => placement.lane === "now")
      .map((placement) => placement.candidate.candidateId);

    expect(now).toEqual([
      "safe-a",
      "safe-b",
      "safe-c",
      "candidate.state:7:active-a:0",
      "candidate.must:7:active-a:0",
      "candidate.should:7:active-a:0",
      "candidate.reading:7:active-a:0",
      "candidate.reading:7:active-a:1",
      "candidate.state:7:active-b:0",
      "candidate.should:7:active-b:0",
      "ordinary-a",
      "ordinary-b",
      "candidate.state:2:member-a:0",
      "candidate.reading:2:member-a:0",
      "candidate.state:11:member-b:0",
      "candidate.reading:11:member-b:0",
    ]);
  });

  it("keeps a live workout selected after illness groups consume no ordinary slots", () => {
    const now = rank([
      episodeMember(7, "active", 0, "state"),
      episodeMember(8, "member", 0, "state"),
      liveWorkout(42, 1),
      ordinary("dose.owed", 2),
    ])
      .filter((placement) => placement.lane === "now")
      .map((placement) => placement.candidate.candidateId);
    expect(now).toEqual([
      "candidate.state:7:active:0",
      "dose.owed",
      "workout.live:42",
      "candidate.state:8:member:0",
    ]);
  });

  // THE VITALS BOOTSTRAP DOOR'S CASE IS RETIRED WITH ITS SUBJECT (#5435 §4). It
  // asserted that `setupCandidates.vitalsBootstrap` landed in the everything lane's
  // Setup group; the builder, the lane and the group are all deleted, so there is
  // nothing left for it to assert. Recorded rather than silently dropped: whether
  // the first-run vitals OFFER should have a successor seat on Home v3 is an open
  // question for the owner, not a coverage gap this file can close.

  it("assigns a repeated fact exactly once to the earlier ordered episode", () => {
    const shared = "illness.temperature:42";
    const placements = rank([
      episodeMember(7, "later", 1, "state"),
      episodeMember(7, "later", 1, "reading", 0, shared),
      episodeMember(7, "earlier", 0, "state"),
      episodeMember(7, "earlier", 0, "reading", 0, shared),
    ]);
    expect(
      placements
        .filter((placement) => placement.candidate.factKey === shared)
        .map((placement) => placement.candidate.candidateId)
    ).toEqual(["candidate.reading:7:earlier:0"]);
  });

  it("assigns a fact shared by safety and an episode only to safety", () => {
    const shared = "illness.temperature:42";
    const placements = rank([
      episodeMember(7, "active", 0, "state"),
      episodeMember(7, "active", 0, "reading", 0, shared),
      ordinary("temperature-safety", 1, { safety: true, factKey: shared }),
    ]);
    expect(
      placements
        .filter((placement) => placement.candidate.factKey === shared)
        .map((placement) => placement.candidate.candidateId)
    ).toEqual(["temperature-safety"]);
  });

  // THE CANVAS HALF OF THIS FILE IS RETIRED WITH THE CANVAS (#5435 §4). A case here
  // rendered `DashboardPlacementCanvas` to static markup and read three orderings off
  // it — unrelated safety before episode safety before the whole-illness node, the
  // shared fact printed once, the scrubbed member absent. The component is deleted, so
  // the markup claim has no subject. Its RANKER half survives above, untouched: "assigns
  // a fact shared by safety and an episode only to safety" makes the same claim about
  // the placements themselves, which is where it was always decided.

  it("derives illness membership and order only from illness-layer placements", () => {
    const safetyState = episodeMember(7, "safety-only", 0, "state");
    safetyState.rankReasons.safety = true;
    const placements = rank([
      episodeMember(12, "later-profile", 0, "state"),
      episodeMember(7, "second", 1, "state"),
      episodeMember(7, "first", 0, "state"),
      safetyState,
    ]);
    expect(orderedIllnessGroupKeys(placements)).toEqual([
      "illness.episode:7:first",
      "illness.episode:7:second",
      "illness.episode:12:later-profile",
    ]);
  });

  it("keeps only owed episode actions and excludes unrelated optional work", () => {
    const unowedMust = {
      ...episodeMember(7, "active", 0, "must"),
      rankReasons: {
        safety: false,
        owed: false,
        windowOpen: false,
        changed: false,
      },
    };
    const unowedShould = {
      ...episodeMember(7, "active", 0, "should"),
      rankReasons: {
        safety: false,
        owed: false,
        windowOpen: false,
        changed: false,
      },
    };
    const optional = actionCandidate({
      candidateId: "unrelated.may",
      factKey: "unrelated.may",
      groupKey: null,
      subject: { scope: "profile", profileId: activeProfileId },
      applicable: true,
      relevance: { kind: "event" },
      obligation: "may",
      rankReasons: {
        safety: false,
        owed: false,
        windowOpen: false,
        changed: false,
      },
      sourceOrder: 1,
    });
    // `setupCandidates.onboardingStep` built this and went with the retired families
    // (#5435 §4); what the case needs is a SETUP-relevance candidate, which is stated
    // here rather than borrowed from a builder that no longer exists.
    const setup = actionCandidate({
      candidateId: "onboarding.step:1",
      factKey: "onboarding.setup-step:1",
      groupKey: "onboarding.setup",
      subject: { scope: "profile", profileId: activeProfileId },
      applicable: true,
      relevance: { kind: "setup" },
      obligation: "should",
      rankReasons: {
        safety: false,
        owed: false,
        windowOpen: false,
        changed: false,
      },
      sourceOrder: 2,
    });
    const resolved = {
      ...ordinary("resolved", 3),
      timing: { kind: "until-signal" as const, active: false },
    };
    const now = rank([
      episodeMember(7, "active", 0, "state"),
      unowedMust,
      unowedShould,
      optional,
      setup,
      resolved,
    ])
      .filter((placement) => placement.lane === "now")
      .map((placement) => placement.candidate.candidateId);
    expect(now).toEqual(["candidate.state:7:active:0"]);
  });

  it("leaves Standing fact order unchanged when illness groups are added", () => {
    const standing = [
      readingCandidate({
        candidateId: "activity.steps:2026-08-19",
        factKey: "activity.steps:2026-08-19",
        groupKey: null,
        subject: { scope: "profile", profileId: activeProfileId },
        applicable: true,
        relevance: profileDataRelevance("current", "external"),
        sourceOrder: 10,
      }),
      readingCandidate({
        candidateId: "weight.latest:2026-08-19",
        factKey: "weight.latest:2026-08-19",
        groupKey: null,
        subject: { scope: "profile", profileId: activeProfileId },
        applicable: true,
        relevance: profileDataRelevance("current", "manual"),
        sourceOrder: 20,
      }),
      readingCandidate({
        candidateId: "labs.latest:ldl",
        factKey: "clinical-result.latest:ldl",
        groupKey: null,
        subject: { scope: "profile", profileId: activeProfileId },
        applicable: true,
        relevance: profileDataRelevance("current", "manual"),
        sourceOrder: 30,
      }),
    ];
    const standingFacts = (candidates: DashboardCandidate[]) =>
      rank(candidates)
        .filter((placement) => placement.lane === "standing")
        .map((placement) => placement.candidate.factKey);
    expect(
      standingFacts([
        ...standing,
        episodeMember(7, "active", 0, "state"),
        episodeMember(8, "household", 0, "state"),
      ])
    ).toEqual(standingFacts(standing));
  });

  it("does not infer illness policy from candidate-id spelling", () => {
    const impostor = stateCandidate({
      candidateId: "illness.state:looks-legacy",
      factKey: "legacy-looking-state",
      groupKey: null,
      subject: { scope: "profile", profileId: 7 },
      applicable: true,
      relevance: { kind: "state" },
      sourceOrder: 1,
    });
    expect(rank([impostor])).toEqual([
      expect.objectContaining({ lane: "everything" }),
    ]);
  });

  it("rejects inconsistent typed metadata inside one group", () => {
    const state = episodeMember(7, "one", 0, "state");
    const reading = episodeMember(7, "one", 0, "reading");
    expect(() =>
      rank([
        state,
        {
          ...reading,
          episodeGroup: {
            ...reading.episodeGroup!,
            episodeKey: "different",
          },
        },
      ])
    ).toThrow(/Inconsistent dashboard episode group/);
  });

  it("requires a live state and excludes expired or inapplicable episodes", () => {
    const noState = episodeMember(2, "no-state", 0, "reading");
    const expired = {
      ...episodeMember(3, "expired", 0, "state"),
      timing: { kind: "until-signal" as const, active: false },
    };
    const inapplicable = {
      ...episodeMember(4, "inapplicable", 0, "state"),
      applicable: false,
    };
    const placements = rank([noState, expired, inapplicable]);
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({
      lane: "everything",
      candidate: { candidateId: noState.candidateId },
    });
  });
});

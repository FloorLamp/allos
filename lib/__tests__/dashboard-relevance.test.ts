import { describe, expect, it } from "vitest";
import {
  everythingTail,
  placementsInLane,
  resolveDashboardTiming,
  localTimeWindow,
  mealTimeWindows,
  rankDashboardCandidates,
  type DashboardCandidate,
  type DashboardTiming,
} from "../dashboard-relevance";
import {
  actionCandidate,
  attentionCandidates,
  engagementFromSource,
  profileDataRelevance,
  readingCandidate,
  setupCandidates,
  sleepCandidates,
  stateCandidate,
  statementCandidate,
} from "../dashboard-candidates";
import type { UpcomingItem } from "../upcoming";
import { buildAttentionModel, groupAttentionForPage } from "../attention";
import { dashboardAttentionCandidateId } from "../dashboard-attention-identity";
import { doseSortKey } from "../dose-order";
import { timeBucket } from "../intake-schedule";

const subject = { scope: "profile" as const, profileId: 7 };
let order = 0;

function reading(id: string, profileId = 7): DashboardCandidate {
  return readingCandidate({
    candidateId: id,
    factKey: `fact.${id}`,
    groupKey: null,
    subject: { scope: "profile", profileId },
    applicable: true,
    relevance: profileDataRelevance("current", "manual"),
    sourceOrder: order++,
  });
}

function action(
  id: string,
  obligation: "must" | "should" | "may",
  reasons: Partial<DashboardCandidate["rankReasons"]> = {}
): DashboardCandidate {
  return actionCandidate({
    candidateId: id,
    factKey: `fact.${id}`,
    groupKey: null,
    subject,
    applicable: true,
    relevance: { kind: "event" },
    obligation,
    rankReasons: {
      safety: false,
      owed: false,
      windowOpen: false,
      changed: false,
      ...reasons,
    },
    sourceOrder: order++,
  });
}

const rank = (candidates: DashboardCandidate[]) =>
  rankDashboardCandidates(candidates, {
    activeProfileId: 7,
    minutesOfDay: 12 * 60,
    today: "2026-08-19",
    upcoming: [],
  });

describe("atomic dashboard placement", () => {
  it("treats stored null provenance as manual engagement", () => {
    expect(engagementFromSource(null)).toBe("manual");
    expect(engagementFromSource("manual")).toBe("manual");
    expect(engagementFromSource("oura")).toBe("external");
    expect(engagementFromSource(undefined)).toBe("unknown");
  });

  it("partitions every applicable candidate exactly once", () => {
    const placements = rank([
      action("owed", "must", { owed: true }),
      reading("activity.steps:standing"),
      statementCandidate({
        candidateId: "update",
        factKey: "fact.update",
        groupKey: null,
        subject,
        applicable: true,
        relevance: { kind: "event" },
        sourceOrder: order++,
      }),
    ]);
    expect(
      placements.map((placement) => placement.candidate.candidateId)
    ).toEqual(["owed", "activity.steps:standing", "update"]);
    expect(placements.map((placement) => placement.lane)).toEqual([
      "now",
      "standing",
      "everything",
    ]);
  });

  it("keeps may actions out of Now for owed or open-window reasons", () => {
    const placements = rank([
      action("may", "may", { owed: true, windowOpen: true }),
    ]);
    expect(placements[0].lane).toBe("everything");
  });

  // #3224 — the window a `should` action declares must be a MOMENT. A weekly
  // target spelled `windowOpen` as "not met this week", which is true for seven
  // days, so its log offer occupied Now all week and "Nothing needs you." — the
  // state #3077 names the goal — was unreachable on an ordinary week.
  it("keeps a should action with no reason out of Now entirely", () => {
    const placements = rank([
      action("target.log:1", "should", { owed: false, windowOpen: false }),
    ]);
    expect(placements).toMatchObject([
      { candidate: { candidateId: "target.log:1" }, lane: "everything" },
    ]);
    expect(placements[0]).toMatchObject({ everythingGroup: "act" });
  });

  it("admits a should action whose rhythm-derived window is open", () => {
    const placements = rank([
      action("target.log:2", "should", { owed: false, windowOpen: true }),
    ]);
    expect(placements).toMatchObject([
      { candidate: { candidateId: "target.log:2" }, lane: "now" },
    ]);
  });

  it("still cards a behind-pace target on the owed path with the window shut", () => {
    const placements = rank([
      action("target.log:3", "should", { owed: true, windowOpen: false }),
    ]);
    expect(placements).toMatchObject([
      { candidate: { candidateId: "target.log:3" }, lane: "now" },
    ]);
  });

  it("leaves Now empty when every open target is on pace outside its moment", () => {
    const placements = rank([
      action("target.log:4", "should", { owed: false, windowOpen: false }),
      action("target.log:5", "should", { owed: false, windowOpen: false }),
      reading("target.weekly-progress:4"),
    ]);
    expect(placements.filter((placement) => placement.lane === "now")).toEqual(
      []
    );
  });

  it("keeps every safety candidate beyond the ordinary cap", () => {
    const placements = rank([
      action("safe-a", "must", { safety: true }),
      action("safe-b", "must", { safety: true }),
      action("safe-c", "must", { safety: true }),
      action("ordinary-a", "must", { owed: true }),
      action("ordinary-b", "should", { owed: true }),
      action("ordinary-c", "should", { owed: true }),
    ]);
    expect(
      placements.filter((placement) => placement.lane === "now")
    ).toHaveLength(5);
    expect(
      placements
        .filter((placement) => placement.lane === "now")
        .map((placement) => placement.candidate.candidateId)
    ).toEqual(["safe-a", "safe-b", "safe-c", "ordinary-a", "ordinary-b"]);
  });

  it("censuses future and setup attention facts without promoting them", () => {
    const item = (
      key: string,
      over: Partial<UpcomingItem> = {}
    ): UpcomingItem =>
      ({
        key,
        domain: "appointment",
        title: key,
        href: "/appointments",
        dueDate: "2026-09-01",
        ...over,
      }) as UpcomingItem;
    const candidates = attentionCandidates(
      subject,
      [item("future"), item("setup", { signalGroup: "setup", dueDate: null })],
      "2026-08-18"
    );
    expect(candidates).toHaveLength(2);
    expect(candidates[1].relevance).toEqual({ kind: "setup" });
    expect(rank(candidates).map((placement) => placement.lane)).toEqual([
      "everything",
      "everything",
    ]);
  });

  it("keeps ordinary household readings out of the dashboard census", () => {
    const placements = rank([
      reading("activity.steps:self"),
      reading("activity.steps:member", 8),
    ]);
    expect(placements.map((placement) => placement.lane)).toEqual(["standing"]);
  });

  it("keeps manual and external readings in the fixed Standing lane", () => {
    const manual = reading("activity.steps:manual");
    const external = {
      ...reading("nutrition.protein:external"),
      relevance: profileDataRelevance("current", "external"),
    };
    expect(rank([external, manual]).map((placement) => placement.lane)).toEqual(
      ["standing", "standing"]
    );
  });

  it("rejects duplicate presentation identity and resolves duplicate facts", () => {
    const one = reading("activity.steps:one");
    expect(() => rank([one, { ...one }])).toThrow(/candidateId/);
    const duplicateFact = {
      ...reading("nutrition.protein:two"),
      factKey: one.factKey,
    };
    expect(
      rank([duplicateFact, one]).filter(
        (placement) => placement.candidate.factKey === one.factKey
      )
    ).toHaveLength(1);
  });

  it("rejects duplicate identity even when one candidate is inapplicable", () => {
    const one = reading("activity.steps:latent");
    expect(() => rank([one, { ...one, applicable: false }])).toThrow(
      /candidateId/
    );
  });

  it("keeps read-only attention facts and carries source obligation", () => {
    const item = {
      key: "dose:42",
      domain: "dose" as const,
      title: "Dose",
      href: "/medications" as const,
      dueDate: null,
      doseId: 42,
      obligation: "should" as const,
      suppressionPolicy: "safety-ungated" as const,
    };
    const [candidate] = attentionCandidates(subject, [item], "2026-08-18");
    expect(candidate).toMatchObject({
      applicable: true,
      kind: "action",
      obligation: "should",
      rankReasons: { safety: true },
    });
  });

  it("keeps preventive affordances actionable in the placement manifest", () => {
    const item = {
      key: "visit:dental_cleaning",
      domain: "visit" as const,
      title: "Dental cleaning",
      href: "/records/history/visits" as const,
      dueDate: "2026-01-01",
      preventiveRuleKey: "dental_cleaning",
    };
    const [candidate] = attentionCandidates(subject, [item], "2026-08-18");
    expect(candidate).toMatchObject({
      kind: "action",
      obligation: "should",
      rankReasons: { owed: true },
    });
    expect(rank([candidate])[0].lane).toBe("now");
  });

  it("does not let grouping change rank", () => {
    const candidate = action("grouped", "must", { owed: true });
    const without = rank([{ ...candidate, groupKey: null }]);
    const withGroup = rank([{ ...candidate, groupKey: "semantic" }]);
    expect(withGroup.map(({ lane, laneOrder }) => [lane, laneOrder])).toEqual(
      without.map(({ lane, laneOrder }) => [lane, laneOrder])
    );
  });

  it.each<{
    label: string;
    timing: DashboardTiming;
    minute: number;
    expected: unknown;
  }>([
    {
      label: "always",
      timing: { kind: "always" },
      minute: 0,
      expected: { kind: "active" },
    },
    {
      label: "before a local opening",
      timing: {
        kind: "local-time",
        opensAt: 600,
        closesAt: 660,
        wrapsMidnight: false,
      },
      minute: 599,
      expected: { kind: "future-today", opensAt: 600 },
    },
    {
      label: "at a local opening",
      timing: {
        kind: "local-time",
        opensAt: 600,
        closesAt: 660,
        wrapsMidnight: false,
      },
      minute: 600,
      expected: { kind: "active" },
    },
    {
      label: "at an inclusive local close",
      timing: {
        kind: "local-time",
        opensAt: 600,
        closesAt: 660,
        wrapsMidnight: false,
      },
      minute: 660,
      expected: { kind: "active" },
    },
    {
      label: "after the final local close",
      timing: {
        kind: "local-time",
        opensAt: 600,
        closesAt: 660,
        wrapsMidnight: false,
      },
      minute: 661,
      expected: { kind: "expired" },
    },
    {
      label: "inside the late half of a wrapping window",
      timing: {
        kind: "local-time",
        opensAt: 1320,
        closesAt: 120,
        wrapsMidnight: true,
      },
      minute: 1380,
      expected: { kind: "active" },
    },
    {
      label: "inside the early half of a wrapping window",
      timing: {
        kind: "local-time",
        opensAt: 1320,
        closesAt: 120,
        wrapsMidnight: true,
      },
      minute: 60,
      expected: { kind: "active" },
    },
    {
      label: "in the gap before a wrapping window reopens",
      timing: {
        kind: "local-time",
        opensAt: 1320,
        closesAt: 120,
        wrapsMidnight: true,
      },
      minute: 600,
      expected: { kind: "future-today", opensAt: 1320 },
    },
    {
      label: "inside an elapsed-event boundary",
      timing: { kind: "since-event", ageMinutes: 60, maxMinutes: 60 },
      minute: 0,
      expected: { kind: "active" },
    },
    {
      label: "after an elapsed-event boundary",
      timing: { kind: "since-event", ageMinutes: 61, maxMinutes: 60 },
      minute: 0,
      expected: { kind: "expired" },
    },
    {
      label: "invalid negative event age",
      timing: { kind: "since-event", ageMinutes: -1, maxMinutes: 60 },
      minute: 0,
      expected: { kind: "expired" },
    },
    {
      label: "at a local-day boundary",
      timing: { kind: "local-days", ageDays: 7, maxDays: 7 },
      minute: 0,
      expected: { kind: "active" },
    },
    {
      label: "after a local-day boundary",
      timing: { kind: "local-days", ageDays: 8, maxDays: 7 },
      minute: 0,
      expected: { kind: "expired" },
    },
    {
      label: "closed signal",
      timing: { kind: "until-signal", active: false },
      minute: 0,
      expected: { kind: "expired" },
    },
  ])("resolves $label", ({ timing, minute, expected }) => {
    expect(resolveDashboardTiming(timing, minute)).toEqual(expected);
  });

  it("chooses the earliest later opening across multiple windows", () => {
    const timing: DashboardTiming = {
      kind: "local-time-windows",
      windows: [
        { opensAt: 1080, closesAt: 1140, wrapsMidnight: false },
        { opensAt: 720, closesAt: 780, wrapsMidnight: false },
        { opensAt: 420, closesAt: 480, wrapsMidnight: false },
      ],
    };
    expect(resolveDashboardTiming(timing, 600)).toEqual({
      kind: "future-today",
      opensAt: 720,
    });
    expect(resolveDashboardTiming(timing, 720)).toEqual({ kind: "active" });
    expect(resolveDashboardTiming(timing, 1141)).toEqual({ kind: "expired" });
  });

  it("keeps a late wake window open across midnight", () => {
    const timing = localTimeWindow(23 * 60, 26 * 60);
    expect(timing).toEqual({
      kind: "local-time",
      opensAt: 1380,
      closesAt: 120,
      wrapsMidnight: true,
    });
    expect(resolveDashboardTiming(timing, 1379)).toEqual({
      kind: "future-today",
      opensAt: 1380,
    });
    expect(resolveDashboardTiming(timing, 1380)).toEqual({ kind: "active" });
    expect(resolveDashboardTiming(timing, 120)).toEqual({ kind: "active" });
    expect(resolveDashboardTiming(timing, 121)).toEqual({
      kind: "future-today",
      opensAt: 1380,
    });
  });

  it("normalizes early and late meal anchors across midnight", () => {
    expect(localTimeWindow(-30, 30)).toEqual({
      kind: "local-time",
      opensAt: 1410,
      closesAt: 30,
      wrapsMidnight: true,
    });
    const timing = mealTimeWindows([30, 1410]);
    expect(timing).toEqual({
      kind: "local-time-windows",
      windows: [
        { opensAt: 1410, closesAt: 90, wrapsMidnight: true },
        { opensAt: 1350, closesAt: 30, wrapsMidnight: true },
      ],
    });
    const windows = (
      timing as Extract<DashboardTiming, { kind: "local-time-windows" }>
    ).windows;
    for (const [window, opening, closing] of [
      [windows[0], 1410, 90],
      [windows[1], 1350, 30],
    ] as const) {
      const one = { kind: "local-time" as const, ...window };
      expect(resolveDashboardTiming(one, opening)).toEqual({ kind: "active" });
      expect(resolveDashboardTiming(one, closing)).toEqual({ kind: "active" });
      expect(resolveDashboardTiming(one, closing + 1)).toEqual({
        kind: "future-today",
        opensAt: opening,
      });
    }
  });

  it("keeps future-today facts live and removes expired facts from every lane", () => {
    const future = {
      ...action("future", "must", { windowOpen: true }),
      timing: {
        kind: "local-time" as const,
        opensAt: 780,
        closesAt: 840,
        wrapsMidnight: false,
      },
    };
    const expired = {
      ...action("expired", "must", { owed: true }),
      timing: {
        kind: "since-event" as const,
        ageMinutes: 61,
        maxMinutes: 60,
      },
    };
    const futureReading = {
      ...reading("activity.steps:future"),
      timing: future.timing,
    };
    const placements = rank([future, futureReading, expired]);
    expect(placements).toHaveLength(2);
    expect(placements[0]).toMatchObject({
      candidate: { candidateId: "future" },
      lane: "everything",
      timingDisposition: { kind: "future-today", opensAt: 780 },
    });
    expect(placements[1]).toMatchObject({
      candidate: { candidateId: "activity.steps:future" },
      lane: "everything",
      timingDisposition: { kind: "future-today", opensAt: 780 },
    });
  });

  it("moves the same owed action from Ahead to Now at its exact opening", () => {
    const candidate = {
      ...action("boundary", "should", { owed: true }),
      timing: {
        kind: "local-time" as const,
        opensAt: 780,
        closesAt: 840,
        wrapsMidnight: false,
      },
    };
    const before = rankDashboardCandidates([candidate], {
      activeProfileId: 7,
      minutesOfDay: 779,
      today: "2026-08-19",
      upcoming: [],
    });
    const open = rankDashboardCandidates([candidate], {
      activeProfileId: 7,
      minutesOfDay: 780,
      today: "2026-08-19",
      upcoming: [],
    });
    expect(before).toMatchObject([
      {
        candidate: { candidateId: "boundary", factKey: "fact.boundary" },
        lane: "ahead",
        aheadBucket: "later-today",
        opensAt: 780,
      },
    ]);
    expect(open).toMatchObject([
      {
        candidate: { candidateId: "boundary", factKey: "fact.boundary" },
        lane: "now",
      },
    ]);
  });

  it("places a shared future-today fact only once after canonical sorting", () => {
    const timing = {
      kind: "local-time" as const,
      opensAt: 780,
      closesAt: 840,
      wrapsMidnight: false,
    };
    const must = {
      ...action("duplicate-must", "must", { owed: true }),
      factKey: "fact.shared-future",
      timing,
    };
    const should = {
      ...action("duplicate-should", "should", { owed: true }),
      factKey: "fact.shared-future",
      timing,
    };
    const placements = rankDashboardCandidates([should, must], {
      activeProfileId: 7,
      minutesOfDay: 779,
      today: "2026-08-19",
      upcoming: [],
    });
    expect(placements).toMatchObject([
      {
        lane: "ahead",
        candidate: { candidateId: "duplicate-must" },
      },
    ]);
  });

  it("does not force an opened Ahead action through a full Now cap", () => {
    const first = action("first", "must", { owed: true });
    const second = action("second", "must", { owed: true });
    const candidate = {
      ...action("boundary-full", "should", { owed: true }),
      timing: {
        kind: "local-time" as const,
        opensAt: 780,
        closesAt: 840,
        wrapsMidnight: false,
      },
    };
    const before = rankDashboardCandidates([first, second, candidate], {
      activeProfileId: 7,
      minutesOfDay: 779,
      today: "2026-08-19",
      upcoming: [],
    });
    const open = rankDashboardCandidates([first, second, candidate], {
      activeProfileId: 7,
      minutesOfDay: 780,
      today: "2026-08-19",
      upcoming: [],
    });
    expect(
      before.find(({ candidate }) => candidate.candidateId === "boundary-full")
        ?.lane
    ).toBe("ahead");
    expect(
      open.find(({ candidate }) => candidate.candidateId === "boundary-full")
    ).toMatchObject({ lane: "everything", everythingGroup: "act" });
  });

  it("projects the unchanged week/later Upcoming subset in canonical order", () => {
    const item = (
      key: string,
      dueDate: string,
      over: Partial<UpcomingItem> = {}
    ): UpcomingItem => ({
      key,
      domain: "appointment",
      title: key,
      href: "/appointments",
      dueDate,
      ...over,
    });
    const upcoming = [
      item("later", "2026-09-01"),
      item("week-second", "2026-08-23"),
      item("week-first", "2026-08-20"),
      item("signal", "2026-08-20", { signalGroup: "review" }),
      item("today", "2026-08-18"),
    ];
    const placements = rankDashboardCandidates(
      attentionCandidates(subject, upcoming, "2026-08-18"),
      {
        activeProfileId: 7,
        minutesOfDay: 720,
        today: "2026-08-18",
        upcoming,
      }
    );
    const horizon = placements.filter(
      (placement) =>
        placement.lane === "ahead" && placement.aheadBucket === "horizon"
    );
    expect(horizon.map((placement) => placement.upcomingKey)).toEqual([
      "week-first",
      "week-second",
      "later",
    ]);
    expect(horizon.map((placement) => placement.upcomingBand)).toEqual([
      "week",
      "week",
      "later",
    ]);
    expect(horizon.map(({ candidate }) => candidate.factKey)).toEqual([
      "upcoming.week-first",
      "upcoming.week-second",
      "upcoming.later",
    ]);
  });

  it("lets Standing keep a shared fact before Ahead projects the horizon", () => {
    const upcoming: UpcomingItem[] = [
      {
        key: "shared",
        domain: "appointment",
        title: "Shared",
        href: "/appointments",
        dueDate: "2026-08-20",
      },
    ];
    const [attention] = attentionCandidates(subject, upcoming, "2026-08-18");
    const standing = {
      ...reading("activity.steps:shared"),
      factKey: "upcoming.shared",
    };
    const placements = rankDashboardCandidates([attention, standing], {
      activeProfileId: 7,
      minutesOfDay: 720,
      today: "2026-08-18",
      upcoming,
    });
    expect(placements).toMatchObject([
      {
        lane: "standing",
        candidate: { candidateId: "activity.steps:shared" },
      },
    ]);
  });

  it("groups the unplaced remainder without relevance scoring", () => {
    const setup = actionCandidate({
      ...action("setup", "may"),
      relevance: { kind: "setup" },
      obligation: "may",
    });
    const dormant = {
      ...reading("unregistered-dormant"),
      relevance: profileDataRelevance("dormant", "manual"),
    };
    const statement = statementCandidate({
      candidateId: "understand",
      factKey: "fact.understand",
      groupKey: null,
      subject,
      applicable: true,
      relevance: { kind: "event" },
      sourceOrder: order++,
    });
    const state = stateCandidate({
      candidateId: "state",
      factKey: "fact.state",
      groupKey: null,
      subject,
      applicable: true,
      relevance: { kind: "state" },
      sourceOrder: order++,
    });
    const placements = rank([
      action("may", "may"),
      dormant,
      statement,
      setup,
      state,
    ]).filter((placement) => placement.lane === "everything");
    expect(
      placements.map((placement) => [
        placement.everythingGroup,
        placement.candidate.candidateId,
      ])
    ).toEqual([
      ["act", "may"],
      ["read", "unregistered-dormant"],
      ["understand", "understand"],
      ["setup", "setup"],
      ["active-states", "state"],
    ]);
  });

  it("chooses a duplicate remainder fact by canonical group, not gather order", () => {
    const act = {
      ...action("shared-act", "may"),
      factKey: "fact.shared-remainder",
    };
    const understand = statementCandidate({
      candidateId: "shared-understand",
      factKey: "fact.shared-remainder",
      groupKey: null,
      subject,
      applicable: true,
      relevance: { kind: "event" },
      sourceOrder: order++,
    });
    const signature = (input: DashboardCandidate[]) =>
      rank(input).map((placement) => ({
        id: placement.candidate.candidateId,
        lane: placement.lane,
        group:
          placement.lane === "everything"
            ? placement.everythingGroup
            : undefined,
      }));
    expect(signature([understand, act])).toEqual(signature([act, understand]));
    expect(signature([understand, act])).toEqual([
      { id: "shared-act", lane: "everything", group: "act" },
    ]);
  });

  it("preserves explicit illness context while excluding ordinary other-profile facts", () => {
    const ordinary = actionCandidate({
      ...action("other", "may"),
      subject: { scope: "profile", profileId: 8 },
      obligation: "may",
    });
    const reopen = actionCandidate({
      ...action("reopen", "may"),
      subject: { scope: "profile", profileId: 8 },
      dashboardScope: "illness-context",
      obligation: "may",
    });
    const history = actionCandidate({
      ...action("history", "may"),
      subject: { scope: "login" },
      dashboardScope: "illness-context",
      obligation: "may",
    });
    expect(
      rank([ordinary, reopen, history]).map(
        ({ candidate }) => candidate.candidateId
      )
    ).toEqual(["reopen", "history"]);
  });

  it("removes an expired finished-session recap and post-nap reading", () => {
    const ctx = { subject, sourceOrder: order++ };
    const recap = setupCandidates.sessionRecap(ctx, 12, "sets", 61);
    const nap = sleepCandidates.nap(
      { subject, sourceOrder: order++ },
      "2026-06-17",
      720,
      "manual",
      181
    );
    expect(rank([recap, nap])).toEqual([]);
  });

  it("keeps safety live even when its timing declaration is expired", () => {
    const safety = {
      ...action("safety-expired", "must", { safety: true }),
      timing: { kind: "until-signal" as const, active: false },
    };
    expect(rank([safety])[0]).toMatchObject({
      lane: "now",
      timingDisposition: { kind: "expired" },
    });
  });

  it("keeps the exact-once census stable when gather order changes", () => {
    const active = action("shuffle-active", "must", { owed: true });
    const future = {
      ...action("shuffle-future", "should", { windowOpen: true }),
      timing: {
        kind: "local-time" as const,
        opensAt: 780,
        closesAt: 840,
        wrapsMidnight: false,
      },
    };
    const expired = {
      ...reading("shuffle-expired"),
      timing: { kind: "local-days" as const, ageDays: 1, maxDays: 0 },
    };
    const candidates = [active, future, expired];
    const signature = (input: DashboardCandidate[]) =>
      rank(input).map(({ candidate, lane, timingDisposition }) => ({
        id: candidate.candidateId,
        lane,
        timingDisposition,
      }));

    expect(signature([...candidates].reverse())).toEqual(signature(candidates));
    expect(signature(candidates).map(({ id }) => id)).toEqual([
      "shuffle-active",
      "shuffle-future",
    ]);
  });

  it("rejects changed readings outside the closed promotion registry", () => {
    const unregistered = {
      ...reading("unregistered"),
      rankReasons: {
        safety: false,
        owed: false,
        windowOpen: false,
        changed: true,
      },
    };
    expect(() => rank([unregistered])).toThrow(/promotion mismatch/);
  });

  it("promotes a registered reading once and lets its safety fact win", () => {
    const promoted = {
      ...reading("labs.latest:ldl"),
      factKey: "upcoming.biomarker-flag:ldl",
      rankReasons: {
        safety: false,
        owed: false,
        windowOpen: false,
        changed: true,
      },
      readingPromotion: "clinical-non-notable-to-notable" as const,
    };
    expect(rank([promoted])).toMatchObject([
      {
        candidate: { candidateId: "labs.latest:ldl" },
        lane: "now",
      },
    ]);

    const finding = {
      ...action("flagged-ldl", "should", { safety: true }),
      factKey: promoted.factKey,
    };
    expect(rank([promoted, finding])).toMatchObject([
      {
        candidate: { candidateId: "flagged-ldl" },
        lane: "now",
      },
    ]);
  });

  // Which of a shared fact's two candidates renders (#3201). A marker that has
  // just become notable mints BOTH the reading and the attention finding that
  // flagged it, on one factKey. The reading carries the value and the finding
  // only announces it, so the reading wins — but only that; the dedup is still
  // exact-once, score still leads, and the seat belongs to the fact, not to
  // whichever candidate occupies it.
  describe("a shared fact renders its most useful candidate (#3201)", () => {
    const FLAG_FACT = "upcoming.biomarker-flag:ferritin";
    // Production gather order: attention first, labs some hundreds of
    // candidates later. That gap is exactly what used to decide this.
    const finding = (
      reasons: Partial<DashboardCandidate["rankReasons"]> = {}
    ): DashboardCandidate => ({
      ...action("attention.fact:biomarker-flag:ferritin", "should", {
        changed: true,
        ...reasons,
      }),
      factKey: FLAG_FACT,
      sourceOrder: 0,
    });
    const labReading: DashboardCandidate = {
      ...reading("labs.latest:ferritin"),
      factKey: FLAG_FACT,
      rankReasons: {
        safety: false,
        owed: false,
        windowOpen: false,
        changed: true,
      },
      readingPromotion: "clinical-non-notable-to-notable" as const,
      sourceOrder: 400,
    };
    // A second fact gathered between the two, tied on score. Now seats
    // NOW_CANDIDATE_CAP candidates, so a fact that slid to the reading's own
    // gather position would be pushed off the lane entirely.
    const neighbour: DashboardCandidate = {
      ...action("attention.fact:review:1", "should", { changed: true }),
      sourceOrder: 1,
    };

    it.each([
      {
        name: "the reading takes the seat the flag finding used to hold",
        candidates: [finding(), labReading, neighbour],
        now: ["labs.latest:ferritin", "attention.fact:review:1"],
      },
      {
        name: "a flagged marker with no reading still surfaces its finding",
        candidates: [finding(), neighbour],
        now: [
          "attention.fact:biomarker-flag:ferritin",
          "attention.fact:review:1",
        ],
      },
      {
        name: "a finding that outranks its reading on score keeps the seat",
        candidates: [finding({ owed: true }), labReading, neighbour],
        now: [
          "attention.fact:biomarker-flag:ferritin",
          "attention.fact:review:1",
        ],
      },
    ])("$name", ({ candidates, now }) => {
      const placements = rank(candidates);
      expect(
        placements
          .filter((placement) => placement.lane === "now")
          .map((placement) => placement.candidate.candidateId)
      ).toEqual(now);
      // Exact-once is untouched: the loser of a shared fact renders nowhere.
      expect(
        placements.filter(
          (placement) => placement.candidate.factKey === FLAG_FACT
        )
      ).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// The Now lane's tie-break reads the CANONICAL dose-day order (#3554).
//
// Every owed `must` dose scores identically (4_000 + 200), so the ordinary tier's
// order — and therefore which two survive NOW_CANDIDATE_CAP — is decided entirely
// by compareSource, i.e. by the attention model's own order. Before #3554 that
// order was raw generator emission (item-id order), so one item's Midday+Evening
// pair could fill both slots while another item's equally-owed Midday dose was
// absent from the lane that exists to say what needs you.
//
// VERIFIED BY SHUFFLE, NOT BY EXAMPLE. The defect IS that the rendered order
// tracks emission, so a single input asserting a single order cannot see it.
// Every permutation of the same logical set must render the SAME lane.
// ---------------------------------------------------------------------------
describe("Now lane ordering follows the dose-day order (#3554)", () => {
  const ORDER_TODAY = "2026-08-22";

  function doseItem(
    id: number,
    name: string,
    timeOfDay: string,
    obligation: "must" | "should" = "must"
  ): UpcomingItem {
    return {
      key: `dose:${id}`,
      domain: "dose",
      title: name,
      href: "/medications",
      dueDate: null,
      dueText: timeBucket(timeOfDay),
      doseId: id,
      obligation,
      // The SAME key the dose generator stamps (#297), so the fixture cannot
      // encode an order the app does not actually produce.
      sortHint: doseSortKey({ timeOfDay, obligation, stack: null, name }),
    } as UpcomingItem;
  }

  // The prod sighting: item ids ascend Omega-3 Midday (5), Vitamin D3 Midday (6),
  // Omega-3 Evening (7), but the generator groups by ITEM, emitting Omega-3's two
  // doses before Vitamin D3's one.
  const omegaMidday = doseItem(5, "Omega-3", "midday");
  const vitaminMidday = doseItem(6, "Vitamin D3 + K2", "midday");
  const omegaEvening = doseItem(7, "Omega-3", "evening");

  const permutations: UpcomingItem[][] = [
    [omegaMidday, omegaEvening, vitaminMidday], // the generator's own order
    [omegaMidday, vitaminMidday, omegaEvening],
    [omegaEvening, omegaMidday, vitaminMidday],
    [omegaEvening, vitaminMidday, omegaMidday],
    [vitaminMidday, omegaMidday, omegaEvening],
    [vitaminMidday, omegaEvening, omegaMidday],
  ];

  const model = (upcoming: UpcomingItem[]) =>
    buildAttentionModel({
      upcoming,
      flaggedBiomarkers: [],
      integrations: [],
      reviewCount: 0,
      today: ORDER_TODAY,
    });

  const placeFrom = (upcoming: UpcomingItem[]) =>
    rankDashboardCandidates(
      attentionCandidates(subject, model(upcoming), ORDER_TODAY),
      {
        activeProfileId: 7,
        minutesOfDay: 12 * 60,
        today: ORDER_TODAY,
        upcoming: [],
      }
    );

  const laneKeys = (
    placements: ReturnType<typeof placeFrom>,
    lane: "now" | "everything"
  ) =>
    placements
      .filter((placement) => placement.lane === lane)
      .map((placement) => placement.candidate.candidateId);

  it("renders the same Now lane from every generator order", () => {
    for (const permutation of permutations) {
      expect(laneKeys(placeFrom(permutation), "now")).toEqual([
        dashboardAttentionCandidateId("dose:5"),
        dashboardAttentionCandidateId("dose:6"),
      ]);
    }
  });

  it("never ranks an Evening dose ahead of a Midday one", () => {
    for (const permutation of permutations) {
      const order = model(permutation).map((item) => item.key);
      expect(order.indexOf("dose:5")).toBeLessThan(order.indexOf("dose:7"));
      expect(order.indexOf("dose:6")).toBeLessThan(order.indexOf("dose:7"));
    }
  });

  it("agrees with the Upcoming page's band order on the same fixture", () => {
    for (const permutation of permutations) {
      const items = model(permutation);
      const page = groupAttentionForPage(items, ORDER_TODAY).flatMap((group) =>
        group.items.map((item) => item.key)
      );
      expect(items.map((item) => item.key)).toEqual(page);
    }
  });

  it("orders a total rule: items alike on every key still land in one order", () => {
    // Two doses identical on date, priority, domain, sortHint AND title — the
    // comparator's last-resort key is the only thing left to separate them, and
    // without one Array.sort's stability hands the order back to the generator.
    const twin = (id: number) => doseItem(id, "Magnesium", "midday");
    const forward = model([twin(11), twin(12)]).map((item) => item.key);
    const backward = model([twin(12), twin(11)]).map((item) => item.key);
    expect(forward).toEqual(["dose:11", "dose:12"]);
    expect(backward).toEqual(forward);
  });
});

// THE TAIL'S ONE DROP (owner ruling #3366, 2026-08-29). Show everything stays
// exhaustive; a candidate whose whole content is a link to a page the nav already
// carries renders as one deduplicated door instead. The lane itself is untouched —
// the drop is a RENDERING mark, so the exact-once partition still holds over it.
describe("Show everything admission and doors (#3366)", () => {
  const navLink = (
    id: string,
    href: "/medical/episodes" | "/trends",
    reasons: Partial<DashboardCandidate["rankReasons"]> = {}
  ): DashboardCandidate =>
    actionCandidate({
      candidateId: id,
      factKey: `fact.${id}`,
      groupKey: null,
      subject,
      applicable: true,
      relevance: { kind: "event" },
      obligation: "may",
      navDuplicateOf: href,
      rankReasons: {
        safety: false,
        owed: false,
        windowOpen: false,
        changed: false,
        ...reasons,
      },
      sourceOrder: order++,
    });

  it("marks nav-duplicate links unadmitted and leaves the partition whole", () => {
    const kept = action("kept", "may");
    const placements = rank([
      kept,
      navLink("episodes-a", "/medical/episodes"),
      navLink("episodes-b", "/medical/episodes"),
      navLink("trends", "/trends"),
    ]);
    const tail = placementsInLane(placements, "everything");
    expect(tail.map((placement) => placement.candidate.candidateId)).toEqual([
      "kept",
      "episodes-a",
      "episodes-b",
      "trends",
    ]);
    expect(tail.map((placement) => placement.admitted)).toEqual([
      true,
      false,
      false,
      false,
    ]);

    // The tail DRAWS only the admitted member; the three nav duplicates are dropped.
    // Since #4076 nothing is drawn in their place — the completeness guarantee is
    // asserted at the manifest tier instead.
    expect(
      everythingTail(placements).map(
        (placement) => placement.candidate.candidateId
      )
    ).toEqual(["kept"]);
  });

  it("keeps a safety candidate out of the drop by never letting it reach the tail", () => {
    const placements = rank([
      navLink("flagged", "/medical/episodes", { safety: true }),
    ]);
    expect(placementsInLane(placements, "everything")).toEqual([]);
    expect(
      placementsInLane(placements, "now").map(
        (placement) => placement.candidate.candidateId
      )
    ).toEqual(["flagged"]);
    expect(everythingTail(placements)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  resolveDashboardTiming,
  localTimeWindow,
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

  it("keeps active illness in ordinary Now ahead of owed actions", () => {
    const illness = stateCandidate({
      candidateId: "illness.state:7:open",
      factKey: "illness.episode:7:open",
      groupKey: "illness.episode:7:open",
      subject,
      applicable: true,
      relevance: { kind: "state" },
      rankReasons: {
        safety: false,
        owed: false,
        windowOpen: false,
        changed: true,
      },
      sourceOrder: order++,
    });
    const placements = rank([
      action("owed-a", "must", { owed: true }),
      action("owed-b", "must", { owed: true }),
      illness,
    ]);
    expect(
      placements
        .filter((placement) => placement.lane === "now")
        .map((placement) => placement.candidate.candidateId)
    ).toEqual(["illness.state:7:open", "owed-a"]);
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

  it("keeps household readings out of the acting profile Standing lane", () => {
    const placements = rank([
      reading("activity.steps:self"),
      reading("activity.steps:member", 8),
    ]);
    expect(placements.map((placement) => placement.lane)).toEqual([
      "standing",
      "everything",
    ]);
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
});

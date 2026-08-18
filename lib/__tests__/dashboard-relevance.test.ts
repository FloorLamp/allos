import { describe, expect, it } from "vitest";
import {
  rankDashboardCandidates,
  type DashboardCandidate,
} from "../dashboard-relevance";
import {
  actionCandidate,
  attentionCandidates,
  profileDataRelevance,
  readingCandidate,
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
  it("partitions every applicable candidate exactly once", () => {
    const placements = rank([
      action("owed", "must", { owed: true }),
      reading("standing"),
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
    ).toEqual(["owed", "standing", "update"]);
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
    const placements = rank([reading("self"), reading("member", 8)]);
    expect(placements.map((placement) => placement.lane)).toEqual([
      "standing",
      "everything",
    ]);
  });

  it("keeps manual readings standing and sends external-only readings to Everything", () => {
    const manual = reading("manual");
    const external = {
      ...reading("external"),
      relevance: profileDataRelevance("current", "external"),
    };
    expect(rank([external, manual]).map((placement) => placement.lane)).toEqual(
      ["standing", "everything"]
    );
  });

  it("rejects duplicate presentation and fact identity", () => {
    const one = reading("one");
    expect(() => rank([one, { ...one }])).toThrow(/candidateId/);
    expect(() =>
      rank([one, { ...reading("two"), factKey: one.factKey }])
    ).toThrow(/factKey/);
  });

  it("rejects duplicate identity even when one candidate is inapplicable", () => {
    const one = reading("latent");
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
});

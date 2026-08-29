import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DashboardPlacementCanvas from "@/components/dashboard/DashboardPlacementCanvas";
import {
  actionCandidate,
  stateCandidate,
  statementCandidate,
} from "@/lib/dashboard-candidates";
import type {
  DashboardCandidate,
  DashboardPlacement,
} from "@/lib/dashboard-relevance";

const subject = { scope: "profile" as const, profileId: 1 };

function statement(id: string): DashboardCandidate {
  return statementCandidate({
    candidateId: id,
    factKey: `fact.${id}`,
    groupKey: null,
    subject,
    applicable: true,
    relevance: { kind: "event" },
    sourceOrder: 0,
  });
}

describe("dashboard placement canvas", () => {
  it("renders bucket and group order from laneOrder without a JSX ordering policy", () => {
    const horizon = statement("horizon");
    const later = actionCandidate({
      candidateId: "later",
      factKey: "fact.later",
      groupKey: null,
      subject,
      applicable: true,
      relevance: { kind: "event" },
      obligation: "should",
      sourceOrder: 0,
    });
    const laterSecond = actionCandidate({
      candidateId: "later-second",
      factKey: "fact.later-second",
      groupKey: null,
      subject,
      applicable: true,
      relevance: { kind: "event" },
      obligation: "should",
      sourceOrder: 1,
    });
    const activeState = stateCandidate({
      candidateId: "active-state",
      factKey: "fact.active-state",
      groupKey: null,
      subject,
      applicable: true,
      relevance: { kind: "state" },
      sourceOrder: 0,
    });
    const act = actionCandidate({
      candidateId: "act",
      factKey: "fact.act",
      groupKey: null,
      subject,
      applicable: true,
      relevance: { kind: "event" },
      obligation: "may",
      sourceOrder: 0,
    });
    const placements: DashboardPlacement[] = [
      {
        candidate: horizon,
        lane: "ahead",
        laneOrder: 0,
        timingDisposition: { kind: "active" },
        aheadBucket: "horizon",
        memberOrder: 0,
        upcomingKey: "horizon",
        upcomingBand: "later",
      },
      {
        candidate: later,
        lane: "ahead",
        laneOrder: 1,
        timingDisposition: { kind: "future-today", opensAt: 900 },
        aheadBucket: "later-today",
        memberOrder: 0,
        opensAt: 900,
      },
      {
        candidate: laterSecond,
        lane: "ahead",
        laneOrder: 2,
        timingDisposition: { kind: "future-today", opensAt: 960 },
        aheadBucket: "later-today",
        memberOrder: 1,
        opensAt: 960,
      },
      {
        candidate: activeState,
        lane: "everything",
        laneOrder: 0,
        timingDisposition: { kind: "active" },
        everythingGroup: "active-states",
        memberOrder: 0,
        admitted: true,
      },
      {
        candidate: act,
        lane: "everything",
        laneOrder: 1,
        timingDisposition: { kind: "active" },
        everythingGroup: "act",
        memberOrder: 0,
        admitted: true,
      },
    ];
    const nodes = new Map<string, ReactNode>([
      [activeState.candidateId, createElement("p", null, "State node")],
      [act.candidateId, createElement("p", null, "Act node")],
    ]);
    const html = renderToStaticMarkup(
      createElement(DashboardPlacementCanvas, {
        dateLabel: "August 19, 2026",
        placements,
        candidateNodes: nodes,
        candidatePages: new Map(),
        standingPresentations: new Map(),
        aheadPresentations: new Map([
          [horizon.candidateId, { label: "Horizon row" }],
          [later.candidateId, { label: "Later row" }],
          [laterSecond.candidateId, { label: "Later second row" }],
        ]),
        attentionBadgeCount: 0,
      })
    );

    expect(html.indexOf("This week and later")).toBeLessThan(
      html.indexOf("Later today")
    );
    expect(html.indexOf('aria-label="Active states"')).toBeLessThan(
      html.indexOf('aria-label="Act"')
    );
    expect(html).toContain("+1 more");
    expect(html).toContain('aria-label="+1 more in Later today"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Later second row");
    expect(html).toContain('href="/upcoming#later"');

    const weekHtml = renderToStaticMarkup(
      createElement(DashboardPlacementCanvas, {
        dateLabel: "August 19, 2026",
        placements: placements.map((placement) =>
          placement.candidate.candidateId === horizon.candidateId &&
          placement.lane === "ahead"
            ? { ...placement, upcomingBand: "week" as const }
            : placement
        ),
        candidateNodes: nodes,
        candidatePages: new Map(),
        standingPresentations: new Map(),
        aheadPresentations: new Map([
          [horizon.candidateId, { label: "Horizon row" }],
          [later.candidateId, { label: "Later row" }],
          [laterSecond.candidateId, { label: "Later second row" }],
        ]),
        attentionBadgeCount: 0,
      })
    );
    expect(weekHtml).toContain('href="/upcoming#week"');
  });

  // The tail draws what the ranker admitted and one named door for the rest (#3366).
  it("draws admitted members and one labelled door per dropped page", () => {
    const admitted = statement("admitted");
    const droppedA = statement("dropped-a");
    const droppedB = statement("dropped-b");
    const placements: DashboardPlacement[] = [admitted, droppedA, droppedB].map(
      (candidate, laneOrder) => ({
        candidate,
        lane: "everything",
        laneOrder,
        timingDisposition: { kind: "active" },
        everythingGroup: "act",
        memberOrder: laneOrder,
        admitted: candidate === admitted,
      })
    );
    const html = renderToStaticMarkup(
      createElement(DashboardPlacementCanvas, {
        dateLabel: "August 19, 2026",
        placements,
        candidateNodes: new Map<string, ReactNode>([
          [admitted.candidateId, createElement("p", null, "Admitted node")],
          [droppedA.candidateId, createElement("p", null, "Dropped A node")],
          [droppedB.candidateId, createElement("p", null, "Dropped B node")],
        ]),
        // Both dropped facts live on Trends; a fragment is a position on a page, so
        // the two owe the reader one row between them.
        candidatePages: new Map([
          [droppedA.candidateId, "/trends" as const],
          [droppedB.candidateId, "/trends#body" as const],
        ]),
        standingPresentations: new Map(),
        aheadPresentations: new Map(),
        attentionBadgeCount: 0,
      })
    );
    expect(html).toContain("Admitted node");
    expect(html).not.toContain("Dropped A node");
    expect(html).not.toContain("Dropped B node");
    expect(html.split('data-testid="dashboard-all-door"')).toHaveLength(2);
    expect(html).toContain('data-door-href="/trends"');
    expect(html).toContain("Trends");
  });

  it("renders the supplied five-group order and omits empty groups", () => {
    const groupNames = [
      "act",
      "read",
      "understand",
      "setup",
      "active-states",
    ] as const;
    const candidates = groupNames.map((group) => statement(group));
    const placements: DashboardPlacement[] = candidates.map(
      (candidate, laneOrder) => ({
        candidate,
        lane: "everything",
        laneOrder,
        timingDisposition: { kind: "active" },
        everythingGroup: groupNames[laneOrder],
        memberOrder: 0,
        admitted: true,
      })
    );
    const nodes = new Map<string, ReactNode>(
      candidates.map((candidate) => [
        candidate.candidateId,
        createElement("p", null, candidate.candidateId),
      ])
    );
    const render = (members: DashboardPlacement[]) =>
      renderToStaticMarkup(
        createElement(DashboardPlacementCanvas, {
          dateLabel: "August 19, 2026",
          placements: members,
          candidateNodes: nodes,
          candidatePages: new Map(),
          standingPresentations: new Map(),
          aheadPresentations: new Map(),
          attentionBadgeCount: 0,
        })
      );
    const all = render(placements);
    const markers = [
      'aria-label="Act"',
      'aria-label="Read"',
      'aria-label="Understand"',
      'aria-label="Setup"',
      'aria-label="Active states"',
    ];
    for (const marker of markers)
      expect(all.indexOf(marker)).toBeGreaterThan(-1);
    for (let index = 1; index < markers.length; index += 1) {
      expect(all.indexOf(markers[index - 1])).toBeLessThan(
        all.indexOf(markers[index])
      );
    }

    const withoutRead = render(
      placements.filter(
        (placement) =>
          placement.lane !== "everything" ||
          placement.everythingGroup !== "read"
      )
    );
    expect(withoutRead).not.toContain('aria-label="Read"');
    expect(render([])).not.toContain('data-testid="dashboard-all"');
  });
});

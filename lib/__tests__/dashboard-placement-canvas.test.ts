import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DashboardPlacementCanvas from "@/components/dashboard/DashboardPlacementCanvas";
import {
  actionCandidate,
  stateCandidate,
  statementCandidate,
} from "@/lib/dashboard-candidates";
import type { DashboardStandingPresentation } from "@/components/dashboard/DashboardStandingCluster";
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

// ── THE SHOW-EVERYTHING TAIL'S GRAMMAR (#3365) ─────────────────────────────────
//
// Read / Understand / Setup report, so they render as rows through the SAME renderer
// Standing uses; Act and Active states offer or run, so they keep a card. What the
// tail can never do is LOSE one: it is a fold over the ranker's placements, so every
// placement handed in comes back out exactly once whatever the fold does with it.
describe("the Show-everything tail (#3365)", () => {
  const everything = (
    candidate: DashboardCandidate,
    everythingGroup: Extract<
      DashboardPlacement,
      { lane: "everything" }
    >["everythingGroup"],
    laneOrder: number
  ): DashboardPlacement => ({
    candidate,
    lane: "everything",
    laneOrder,
    timingDisposition: { kind: "active" },
    everythingGroup,
    memberOrder: 0,
    admitted: candidate.navDuplicateOf == null,
  });

  function recapLine(index: number): DashboardCandidate {
    return statementCandidate({
      candidateId: `recap.line-${index}:2026-08-23`,
      factKey: `recap.line-${index}:2026-08-23:2026-08-29`,
      groupKey: "recap:2026-08-23:2026-08-29",
      subject,
      applicable: true,
      relevance: { kind: "event" },
      sourceOrder: index,
    });
  }

  const recapRow = (label: string, value: string) => ({
    label,
    value,
    href: "/timeline" as const,
    moment: { title: "Weekly recap · Aug 23–29", href: "/timeline" as const },
  });

  function renderTail(
    placements: DashboardPlacement[],
    presentations: [string, DashboardStandingPresentation][],
    nodes: [string, ReactNode][] = []
  ) {
    return renderToStaticMarkup(
      createElement(DashboardPlacementCanvas, {
        dateLabel: "August 29, 2026",
        placements,
        candidateNodes: new Map(nodes),
        standingPresentations: new Map(presentations),
        aheadPresentations: new Map(),
        attentionBadgeCount: 0,
      })
    );
  }

  it("folds six same-origin recap atoms into ONE block with ONE header", () => {
    const lines = [0, 1, 2, 3, 4, 5].map(recapLine);
    const html = renderTail(
      lines.map((line, index) => everything(line, "understand", index)),
      lines.map((line, index) => [
        line.candidateId,
        recapRow(`Line ${index}`, `${index}`),
      ])
    );
    // ONE header for six facts — the count, not merely the presence, because six
    // identical headers is exactly the defect this replaced.
    expect(html.split("Weekly recap · Aug 23–29").length - 1).toBe(1);
    expect(
      html.split('data-moment-key="recap:2026-08-23:2026-08-29"').length - 1
    ).toBe(1);
    // POSITIVE CONTROL: the block is there and holds all six rows, so "one header"
    // cannot be satisfied by a tail that rendered nothing.
    for (const line of lines)
      expect(html).toContain(`data-candidate-id="${line.candidateId}"`);
    expect(html.split('data-lane="everything"').length - 1).toBe(6);
    // A fold is not an owner of placement: promote one atom out and the block keeps
    // its header over the five that remain.
    const promoted = renderTail(
      lines
        .slice(1)
        .map((line, index) => everything(line, "understand", index)),
      lines.map((line, index) => [
        line.candidateId,
        recapRow(`Line ${index}`, `${index}`),
      ])
    );
    expect(promoted.split("Weekly recap · Aug 23–29").length - 1).toBe(1);
    expect(promoted.split('data-lane="everything"').length - 1).toBe(5);
    expect(promoted).not.toContain(
      `data-candidate-id="${lines[0].candidateId}"`
    );
  });

  it.each([
    ["read", true],
    ["understand", true],
    ["setup", true],
    ["act", false],
    ["active-states", false],
  ] as const)("%s renders rows: %s", (group, asRows) => {
    const candidate = statement(`${group}-entry`);
    const html = renderTail(
      [everything(candidate, group, 0)],
      [[candidate.candidateId, { label: "Latest", value: "12" }]],
      [
        [
          candidate.candidateId,
          createElement("article", { className: "card" }, "Card node"),
        ],
      ]
    );
    const groupMarkup = html.slice(
      html.indexOf(`data-testid="dashboard-everything-${group}"`)
    );
    // The group exists and holds exactly this one entry — the positive control that
    // stops "no card in here" passing on a group that was never rendered at all.
    expect(groupMarkup).toContain(
      `data-candidate-id="${candidate.candidateId}"`
    );
    expect(
      groupMarkup.split('data-testid="dashboard-candidate"').length - 1
    ).toBe(1);
    expect(groupMarkup.includes('class="card"')).toBe(!asRows);
    expect(groupMarkup.includes("Card node")).toBe(!asRows);
    expect(groupMarkup.includes("Latest")).toBe(asRows);
  });

  it("renders every everything placement exactly once, row or card", () => {
    const rows = [statement("row-a"), statement("row-b")];
    const card = statement("card-only");
    const html = renderTail(
      [
        everything(rows[0], "read", 0),
        everything(card, "understand", 1),
        everything(rows[1], "setup", 2),
      ],
      rows.map((r) => [r.candidateId, { label: r.candidateId, value: "1" }]),
      [
        [
          card.candidateId,
          createElement("article", { className: "card" }, "Hosted control"),
        ],
      ]
    );
    for (const candidate of [...rows, card])
      expect(
        html.split(`data-candidate-id="${candidate.candidateId}"`).length - 1
      ).toBe(1);
    // A statement with no row declared keeps its card: the tail never drops an entry
    // for want of a presentation.
    expect(html).toContain("Hosted control");
  });
});

// THE TAIL'S DOORS (#3366). What the ranker did not admit is not simply absent: the
// page that owns it is drawn instead, once per page and named by the app's own name
// for it, so a dropped fact is two taps away rather than unreachable.
describe("Show everything doors (#3366)", () => {
  const linkOnly = (id: string, href: "/medical/episodes" | "/trends") =>
    statementCandidate({
      candidateId: id,
      factKey: `fact.${id}`,
      groupKey: null,
      subject,
      applicable: true,
      relevance: { kind: "event" },
      navDuplicateOf: href,
      sourceOrder: 0,
    });

  const canvas = (
    placements: DashboardPlacement[],
    nodes: [string, ReactNode][]
  ) =>
    renderToStaticMarkup(
      createElement(DashboardPlacementCanvas, {
        dateLabel: "August 19, 2026",
        placements,
        candidateNodes: new Map<string, ReactNode>(nodes),
        standingPresentations: new Map(),
        aheadPresentations: new Map(),
        attentionBadgeCount: 0,
      })
    );

  const tailPlacement = (
    candidate: DashboardCandidate,
    laneOrder: number
  ): DashboardPlacement => ({
    candidate,
    lane: "everything",
    laneOrder,
    timingDisposition: { kind: "active" },
    everythingGroup: "act",
    memberOrder: laneOrder,
    admitted: candidate.navDuplicateOf == null,
  });

  it("draws admitted members and one named door per dropped page", () => {
    const admitted = statement("admitted");
    const droppedA = linkOnly("dropped-a", "/medical/episodes");
    const droppedB = linkOnly("dropped-b", "/medical/episodes");
    const droppedC = linkOnly("dropped-c", "/trends");
    const html = canvas(
      [admitted, droppedA, droppedB, droppedC].map(tailPlacement),
      [
        [admitted.candidateId, createElement("p", null, "Admitted node")],
        [droppedC.candidateId, createElement("p", null, "Dropped node")],
      ]
    );
    expect(html).toContain("Admitted node");
    expect(html).not.toContain("Dropped node");
    // Two dropped facts on one page, one row; the second page adds the second.
    expect(html.split('data-testid="dashboard-all-door"')).toHaveLength(3);
    expect(html).toContain('data-door-href="/medical/episodes"');
    expect(html).toContain("Illness episodes");
    expect(html).toContain('data-door-href="/trends"');
  });

  it("refuses a door the app has no name for", () => {
    const unnamed = statementCandidate({
      candidateId: "unnamed",
      factKey: "fact.unnamed",
      groupKey: null,
      subject,
      applicable: true,
      relevance: { kind: "event" },
      navDuplicateOf: "/appointments",
      sourceOrder: 0,
    });
    expect(() => canvas([tailPlacement(unnamed, 0)], [])).toThrow(
      "Unnamed Show everything door: /appointments"
    );
  });
});

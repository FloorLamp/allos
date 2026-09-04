import { createElement } from "react";
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
    const tailRows = new Map<string, DashboardStandingPresentation>([
      [activeState.candidateId, { label: "State row" }],
      [act.candidateId, { label: "Act row" }],
    ]);
    const html = renderToStaticMarkup(
      createElement(DashboardPlacementCanvas, {
        dateLabel: "August 19, 2026",
        placements,
        presentations: tailRows,
        aheadPresentations: new Map([
          [
            horizon.candidateId,
            { label: "Horizon row", href: "/training" as const },
          ],
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
    // AHEAD OPENS (#4232). No "+N more" control and no expanded state anywhere in
    // the zone — everything in Ahead is relevant-soon, so every member renders — and
    // the converse in the same assertion: the member that used to sit behind the fold
    // is on the page, and the bucket's own door still leads to /upcoming.
    expect(html).not.toContain("more in Later today");
    expect(html).not.toContain("aria-expanded");
    expect(html).toContain("Later row");
    expect(html).toContain("Later second row");
    expect(html).toContain('href="/upcoming#later"');
    // The bucket's door is on its HEADING. Its first row keeps its own destination
    // and the door that names it: a Training row that landed on Upcoming was the bug.
    expect(html).toMatch(/<h3[^>]*><a [^>]*href="\/upcoming#later"/);
    expect(html).toMatch(
      /<a [^>]*href="\/training"[^>]*>(?:(?!<\/a>).)*Horizon row/
    );
    expect(html).toMatch(
      /<a [^>]*href="\/training"[^>]*>(?:(?!<\/a>).)*Training</
    );

    const weekHtml = renderToStaticMarkup(
      createElement(DashboardPlacementCanvas, {
        dateLabel: "August 19, 2026",
        placements: placements.map((placement) =>
          placement.candidate.candidateId === horizon.candidateId &&
          placement.lane === "ahead"
            ? { ...placement, upcomingBand: "week" as const }
            : placement
        ),
        presentations: tailRows,
        aheadPresentations: new Map([
          [
            horizon.candidateId,
            { label: "Horizon row", href: "/training" as const },
          ],
          [later.candidateId, { label: "Later row" }],
          [laterSecond.candidateId, { label: "Later second row" }],
        ]),
        attentionBadgeCount: 0,
      })
    );
    expect(weekHtml).toMatch(/<h3[^>]*><a [^>]*href="\/upcoming#week"/);
    expect(weekHtml).toMatch(
      /<a [^>]*href="\/training"[^>]*>(?:(?!<\/a>).)*Horizon row/
    );
  });

  // ONE FOLD ON THE WHOLE PAGE, AND ITS CONVERSE (#4232, re-targeting #3934's pair).
  //
  // The removal half — no Quiet disclosure, exactly one `<details>` — is an ABSENCE,
  // and an absence passes just as happily on a page that lost the rows along with the
  // drawer. So the same render asserts where each former quiet row WENT: into the
  // Show-everything group its own model routes it to, drawn, under one moment header.
  // The two halves read the same rendered markup, so they cannot disagree about which
  // page they are looking at.
  it("draws one fold, and the former quiet rows inside it", () => {
    const steps = statement("activity.steps:d");
    const pillar = statement("healthspan.pillar:vo2");
    const lab = statement("labs.latest:ldl");
    const cta = statement("labs.bootstrap");
    const placements: DashboardPlacement[] = [
      {
        candidate: steps,
        lane: "standing",
        laneOrder: 0,
        timingDisposition: { kind: "active" },
        standingFamilyKey: "steps-today",
        standingSection: "today",
        standingBand: "rest",
      },
      ...(
        [
          [pillar, "read"],
          [lab, "read"],
          [cta, "setup"],
        ] as const
      ).map(([candidate, everythingGroup], index): DashboardPlacement => ({
        candidate: {
          ...candidate,
          groupKey: everythingGroup === "setup" ? null : `moment.${index}`,
        },
        lane: "everything",
        laneOrder: index,
        timingDisposition: { kind: "active" },
        everythingGroup,
        memberOrder: index,
        admitted: true,
      })),
    ];
    const rows = new Map<string, DashboardStandingPresentation>([
      [steps.candidateId, { label: "Steps today", value: "8,000" }],
      [
        pillar.candidateId,
        {
          label: "VO2 max",
          value: "Quiet",
          moment: { title: "Healthspan pillars" },
        },
      ],
      [
        lab.candidateId,
        {
          label: "LDL",
          value: "128 mg/dL",
          moment: { title: "Recent clinical results" },
        },
      ],
      [cta.candidateId, { label: "Clinical results", actionLabel: "Import" }],
    ]);
    const html = renderToStaticMarkup(
      createElement(DashboardPlacementCanvas, {
        dateLabel: "August 19, 2026",
        placements,
        presentations: rows,
        aheadPresentations: new Map(),
        attentionBadgeCount: 0,
      })
    );

    // The removal: no second drawer anywhere, and the surviving one is the tail's.
    expect(html.match(/<details/g)).toHaveLength(1);
    expect(html).toContain('data-testid="dashboard-all"');
    expect(html).not.toContain("dashboard-standing-tail");
    expect(html).not.toContain("Quiet (");
    expect(html).not.toContain('data-standing-band="tail"');

    // The converse: the rest row is still above the fold, and each former quiet row
    // is drawn inside the group it was routed to, under its moment header.
    const read = html.slice(
      html.indexOf('data-testid="dashboard-everything-read"')
    );
    const setup = html.slice(
      html.indexOf('data-testid="dashboard-everything-setup"')
    );
    expect(
      html
        .slice(0, html.indexOf('data-testid="dashboard-all"'))
        .includes('data-candidate-id="activity.steps:d"')
    ).toBe(true);
    expect(read).toContain('data-candidate-id="healthspan.pillar:vo2"');
    expect(read).toContain('data-candidate-id="labs.latest:ldl"');
    expect(read).toContain("Healthspan pillars");
    expect(read).toContain("Recent clinical results");
    expect(setup).toContain('data-candidate-id="labs.bootstrap"');
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
    const rows = new Map<string, DashboardStandingPresentation>(
      candidates.map((candidate) => [
        candidate.candidateId,
        { label: candidate.candidateId },
      ])
    );
    const render = (members: DashboardPlacement[]) =>
      renderToStaticMarkup(
        createElement(DashboardPlacementCanvas, {
          dateLabel: "August 19, 2026",
          placements: members,
          presentations: rows,
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

// ── THE SHOW-EVERYTHING TAIL'S GRAMMAR (#3365/#4076) ───────────────────────────
//
// EVERY group reports as rows through the SAME renderer Standing uses — Act and
// Active states included since #4076, because there is no card branch left for them
// to take. What the tail can never do is LOSE one: it is a fold over the ranker's
// placements, so every placement handed in comes back out exactly once whatever the
// fold does with it.
describe("the Show-everything tail (#3365/#4076)", () => {
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
    href: "/history" as const,
    moment: { title: "Weekly recap · Aug 23–29", href: "/history" as const },
  });

  function renderTail(
    placements: DashboardPlacement[],
    presentations: [string, DashboardStandingPresentation][]
  ) {
    return renderToStaticMarkup(
      createElement(DashboardPlacementCanvas, {
        dateLabel: "August 29, 2026",
        placements,
        presentations: new Map(presentations),
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

  // EVERY group renders rows, and none of them renders a card shell (#4076). The
  // control slot is what a write-carrying entry earns instead — asserted here as the
  // pair, because "no card" alone passes just as happily on a tail that lost the
  // write with the card.
  it.each(["read", "understand", "setup", "act", "active-states"] as const)(
    "%s renders rows and no card shell",
    (group) => {
      const candidate = statement(`${group}-entry`);
      const html = renderTail(
        [everything(candidate, group, 0)],
        [
          [
            candidate.candidateId,
            {
              label: "Latest",
              value: "12",
              control: createElement("button", { type: "button" }, "Dismiss"),
            },
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
      expect(groupMarkup).toContain("Latest");
      expect(groupMarkup).not.toContain('class="card"');
      // …and the write the card used to be the only shape for is on the row.
      expect(groupMarkup).toContain('data-testid="dashboard-row-controls"');
      expect(groupMarkup).toContain("Dismiss");
    }
  );

  it("renders every everything placement exactly once", () => {
    const rows = [statement("row-a"), statement("row-b"), statement("row-c")];
    const html = renderTail(
      [
        everything(rows[0], "read", 0),
        everything(rows[1], "understand", 1),
        everything(rows[2], "setup", 2),
      ],
      rows.map((r) => [r.candidateId, { label: r.candidateId, value: "1" }])
    );
    for (const candidate of rows)
      expect(
        html.split(`data-candidate-id="${candidate.candidateId}"`).length - 1
      ).toBe(1);
  });

  it("fails loudly rather than silently dropping a placement with no row", () => {
    const orphan = statement("orphan");
    expect(() => renderTail([everything(orphan, "act", 0)], [])).toThrow(
      "Missing dashboard row presentation for orphan"
    );
  });
});

// ── THE BAND CAP (owner ruling 2026-09-03, #4065) ──────────────────────────────
//
// "Each of the Understand and Set up bands keeps at most three rows open, newest
// first, and the rest sit behind one fold per band whose closed state shows the
// count." Admission stays total — a folded row is still ON THE PAGE, just closed —
// so every claim below carries its positive control: the folded candidate's own id
// is asserted PRESENT in the markup, never merely absent from the open section.
describe("the band cap (#4065)", () => {
  function statementWithGroup(id: string, groupKey: string | null) {
    return statementCandidate({
      candidateId: id,
      factKey: `fact.${id}`,
      groupKey,
      subject,
      applicable: true,
      relevance: { kind: "event" },
      sourceOrder: 0,
    });
  }

  function bandPlacement(
    candidate: DashboardCandidate,
    everythingGroup: Extract<
      DashboardPlacement,
      { lane: "everything" }
    >["everythingGroup"],
    laneOrder: number
  ): DashboardPlacement {
    return {
      candidate,
      lane: "everything",
      laneOrder,
      timingDisposition: { kind: "active" },
      everythingGroup,
      memberOrder: laneOrder,
      admitted: true,
    };
  }

  function renderBand(
    group: Extract<
      DashboardPlacement,
      { lane: "everything" }
    >["everythingGroup"],
    candidates: readonly DashboardCandidate[]
  ) {
    const placements = candidates.map((candidate, index) =>
      bandPlacement(candidate, group, index)
    );
    const presentations = new Map<string, DashboardStandingPresentation>(
      candidates.map((candidate) => [
        candidate.candidateId,
        { label: candidate.candidateId, value: "1" },
      ])
    );
    return renderToStaticMarkup(
      createElement(DashboardPlacementCanvas, {
        dateLabel: "September 3, 2026",
        placements,
        presentations,
        aheadPresentations: new Map(),
        attentionBadgeCount: 0,
      })
    );
  }

  const foldTestId = (group: string) => `dashboard-everything-${group}-fold`;

  // THE BOUNDARY, EXACT (dispatch criterion 2): four eligible rows, three open, the
  // fourth behind the fold — not four open, not a "three plus ties" allowance.
  it.each(["understand", "setup"] as const)(
    "%s: three eligible rows render with no fold; a fourth opens exactly one, showing '1 more'",
    (group) => {
      const three = [0, 1, 2].map((i) =>
        statementWithGroup(`${group}-${i}`, null)
      );
      const threeHtml = renderBand(group, three);
      // Below the cap: every row present, no fold rendered at all.
      for (const candidate of three)
        expect(threeHtml).toContain(
          `data-candidate-id="${candidate.candidateId}"`
        );
      expect(threeHtml).not.toContain(foldTestId(group));

      const four = [...three, statementWithGroup(`${group}-3`, null)];
      const fourHtml = renderBand(group, four);
      // POSITIVE CONTROL: nothing dropped — all four ids are somewhere on the page,
      // open or folded, which is what makes the "exactly three OPEN" claim below
      // meaningful rather than a coincidence of an emptied band.
      for (const candidate of four)
        expect(fourHtml).toContain(
          `data-candidate-id="${candidate.candidateId}"`
        );
      expect(fourHtml).toContain(foldTestId(group));
      // The fold's own contents hold exactly the fourth row, and nothing from the
      // open three leaked into it.
      const fold = fourHtml.slice(
        fourHtml.indexOf(`data-testid="${foldTestId(group)}"`)
      );
      expect(fold).toContain(`data-candidate-id="${group}-3"`);
      for (const candidate of three)
        expect(fold).not.toContain(
          `data-candidate-id="${candidate.candidateId}"`
        );
      // THE COUNT NEVER HIDES (dispatch criterion 3): the closed state names how
      // many, in the ruling's own shape ("11 more").
      expect(fourHtml).toContain("1 more");
      // Stateless and closed on arrival: no `open` attribute on the fold's
      // <details>, so a first-time reader always sees the closed count first.
      const detailsOpenTag = fourHtml.slice(
        fourHtml.lastIndexOf(
          "<details",
          fourHtml.indexOf(`data-testid="${foldTestId(group)}"`)
        )
      );
      expect(detailsOpenTag.slice(0, detailsOpenTag.indexOf(">"))).not.toMatch(
        /\bopen\b/
      );
    }
  );

  // THE CAP IS SCOPED (dispatch criterion 4's converse): every other band keeps
  // rendering exactly as #4076 left it, however many rows it holds — this ruling
  // touches Understand and Setup only.
  it.each(["act", "read", "active-states"] as const)(
    "%s never folds, however many rows it holds",
    (group) => {
      const five = [0, 1, 2, 3, 4].map((i) =>
        statementWithGroup(`${group}-${i}`, null)
      );
      const html = renderBand(group, five);
      for (const candidate of five)
        expect(html).toContain(`data-candidate-id="${candidate.candidateId}"`);
      expect(html).not.toContain(foldTestId(group));
    }
  );

  // THE CAP UNIT IS THE MOMENT BLOCK, NOT THE ROW (#4076's "no two blocks share a
  // title" is what a per-row split would violate — see DashboardPlacementCanvas.tsx).
  // A four-member block that is entirely within the first three block SLOTS stays
  // open and undivided; the block that pushes past the cap folds whole.
  it("understand: a many-row block stays open and undivided when it is among the first three blocks", () => {
    const bigBlock = [0, 1, 2, 3, 4].map((i) =>
      statementWithGroup(`family-${i}`, "shared-family")
    );
    const solo1 = statementWithGroup("solo-1", null);
    const solo2 = statementWithGroup("solo-2", null);
    const solo3 = statementWithGroup("solo-3", null);
    const presentations = new Map<string, DashboardStandingPresentation>([
      ...bigBlock.map((candidate): [string, DashboardStandingPresentation] => [
        candidate.candidateId,
        {
          label: candidate.candidateId,
          value: "1",
          moment: { title: "Coaching observations" },
        },
      ]),
      ...[solo1, solo2, solo3].map(
        (candidate): [string, DashboardStandingPresentation] => [
          candidate.candidateId,
          { label: candidate.candidateId, value: "1" },
        ]
      ),
    ]);
    const placements = [...bigBlock, solo1, solo2, solo3].map(
      (candidate, index) => bandPlacement(candidate, "understand", index)
    );
    const html = renderToStaticMarkup(
      createElement(DashboardPlacementCanvas, {
        dateLabel: "September 3, 2026",
        placements,
        presentations,
        aheadPresentations: new Map(),
        attentionBadgeCount: 0,
      })
    );
    // Three blocks open: the big shared-groupKey block (1 block, 5 rows) plus
    // solo-1 and solo-2. solo-3 is the fourth block and folds.
    for (const candidate of bigBlock)
      expect(html).toContain(`data-candidate-id="${candidate.candidateId}"`);
    expect(html).toContain('data-candidate-id="solo-1"');
    expect(html).toContain('data-candidate-id="solo-2"');
    expect(html).toContain(foldTestId("understand"));
    const fold = html.slice(
      html.indexOf(`data-testid="${foldTestId("understand")}"`)
    );
    expect(fold).toContain('data-candidate-id="solo-3"');
    // NO DUPLICATE TITLE: the shared block's header prints exactly once, whole,
    // never split across the open section and the fold.
    expect(html.split("Coaching observations").length - 1).toBe(1);
    // The fold's count is the folded ROW count (1, for solo-3 alone) — not the
    // folded block count, which would also read 1 here and prove nothing; the next
    // test is the one that tells those two apart.
    expect(fold).toContain("1 more");
  });

  it("understand: a folded multi-row block reports its real row count, not 1", () => {
    const openFiller = [0, 1, 2].map((i) =>
      statementWithGroup(`filler-${i}`, null)
    );
    const foldedFamily = [0, 1, 2, 3].map((i) =>
      statementWithGroup(`late-${i}`, "late-family")
    );
    const presentations = new Map<string, DashboardStandingPresentation>(
      [...openFiller, ...foldedFamily].map((candidate) => [
        candidate.candidateId,
        {
          label: candidate.candidateId,
          value: "1",
          moment: { title: "Data quality" },
        },
      ])
    );
    const placements = [...openFiller, ...foldedFamily].map(
      (candidate, index) => bandPlacement(candidate, "understand", index)
    );
    const html = renderToStaticMarkup(
      createElement(DashboardPlacementCanvas, {
        dateLabel: "September 3, 2026",
        placements,
        presentations,
        aheadPresentations: new Map(),
        attentionBadgeCount: 0,
      })
    );
    // One folded BLOCK, four folded ROWS — the count names the rows.
    expect(html).toContain("4 more");
    const fold = html.slice(
      html.indexOf(`data-testid="${foldTestId("understand")}"`)
    );
    for (const candidate of foldedFamily)
      expect(fold).toContain(`data-candidate-id="${candidate.candidateId}"`);
  });
});

// WHAT THE TAIL DROPS (#3366/#4076). A fact whose whole content is a page the app's
// own nav already names is not drawn — and since #4076 no door row is drawn for it
// either (owner: the Elsewhere section is "utterly useless"). The guarantee that
// nothing is silently hidden did not move with the rendering: it is asserted against
// the real personas at the manifest tier
// (lib/__db_tests__/dashboard-placement-manifest.test.ts), which is the only place it
// could ever have gone red.
describe("Show everything drops (#3366/#4076)", () => {
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
    presentations: [string, DashboardStandingPresentation][]
  ) =>
    renderToStaticMarkup(
      createElement(DashboardPlacementCanvas, {
        dateLabel: "August 19, 2026",
        placements,
        presentations: new Map(presentations),
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

  it("draws admitted members and no door row at all", () => {
    const admitted = statement("admitted");
    const droppedA = linkOnly("dropped-a", "/medical/episodes");
    const droppedB = linkOnly("dropped-b", "/medical/episodes");
    const droppedC = linkOnly("dropped-c", "/trends");
    const html = canvas(
      [admitted, droppedA, droppedB, droppedC].map(tailPlacement),
      [[admitted.candidateId, { label: "Admitted row" }]]
    );
    // The positive control: the tail rendered and holds the admitted member, so the
    // absences below are about a populated tail and not an empty selector.
    expect(html).toContain("Admitted row");
    expect(html).not.toContain('data-candidate-id="dropped-a"');
    expect(html).not.toContain('data-testid="dashboard-all-door"');
    expect(html).not.toContain('aria-label="Elsewhere"');
  });

  it("renders a tail of nothing but drops as no tail at all", () => {
    const html = canvas([tailPlacement(linkOnly("only", "/trends"), 0)], []);
    expect(html).not.toContain('data-testid="dashboard-all"');
  });
});

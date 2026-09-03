import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import DashboardStandingCluster, {
  DashboardFactRow,
  type DashboardStandingPresentation,
} from "@/components/dashboard/DashboardStandingCluster";
import type { DashboardPlacement } from "@/lib/dashboard-relevance";
import type {
  StandingFamilyKey,
  StandingRenderedBand,
  StandingSectionKey,
} from "@/lib/dashboard-standing";

// Standing's rendered anatomy after #4232, which narrows #3548: the tier at the top
// and the stable rest in its fixed sections — TWO bands, both always open, because
// Standing is purely the glance surface now and everything static lives in the page's
// one bottom fold. The ranker decides membership (pinned in
// lib/__tests__/dashboard-standing.test.ts); what this tier can see is what the bands
// look like once they are on a page.

type StandingPlacement = Extract<DashboardPlacement, { lane: "standing" }>;

function placement(
  candidateId: string,
  family: StandingFamilyKey,
  section: StandingSectionKey,
  band: StandingRenderedBand,
  laneOrder: number
): StandingPlacement {
  return {
    candidate: {
      candidateId,
      factKey: `fact:${candidateId}`,
      groupKey: null,
      subject: { scope: "profile", profileId: 7 },
      applicable: true,
      relevance: {
        kind: "profile-data",
        presence: "current",
        engagement: "manual",
      },
      timing: { kind: "always" },
      rankReasons: {
        safety: false,
        owed: false,
        windowOpen: false,
        changed: false,
      },
      sourceOrder: laneOrder,
      kind: "reading",
    },
    lane: "standing",
    laneOrder,
    timingDisposition: { kind: "active" },
    standingFamilyKey: family,
    standingSection: section,
    standingBand: band,
  };
}

const BEHIND = placement(
  "target.weekly-progress:9",
  "weekly-targets",
  "longer-view",
  "attention",
  0
);
const STEPS = placement("activity.steps:d", "day-so-far", "today", "rest", 1);
const BP = placement(
  "vitals.blood-pressure:2026-08-19",
  "blood-pressure",
  "body",
  "rest",
  2
);
const RHR = placement(
  "vitals.resting-heart-rate:2026-08-19",
  "resting-heart-rate",
  "body",
  "rest",
  3
);

const PRESENTATIONS = new Map<string, DashboardStandingPresentation>([
  [
    BEHIND.candidate.candidateId,
    {
      label: "Lower body",
      value: "0 of 2",
      detail: (
        <>
          this week · <span data-testid="standing-pace">Behind</span>
        </>
      ),
      href: "/training?tab=goals",
      presence: "current",
    },
  ],
  [STEPS.candidate.candidateId, { value: "8,000", presence: "current" }],
  [BP.candidate.candidateId, { value: "118/74", presence: "current" }],
  [RHR.candidate.candidateId, { value: "54 bpm", presence: "current" }],
]);

const NO_DRAWINGS = new Map();

const cluster = (
  placements: readonly StandingPlacement[],
  presentations = PRESENTATIONS
) => (
  <DashboardStandingCluster
    placements={placements}
    presentations={presentations}
    drawings={NO_DRAWINGS}
  />
);

describe("Standing's rendered bands", () => {
  it("gives a leading identity body weight without changing label/value rows", () => {
    const { rerender } = render(
      <DashboardFactRow
        candidate={BEHIND.candidate}
        lane="now"
        presentation={{ label: "Omega-3 · 600 mg · Midday" }}
      />
    );
    expect(screen.getByTestId("standing-label").className).toBe(
      "text-sm text-slate-900 dark:text-slate-100"
    );

    rerender(
      <DashboardFactRow
        candidate={BEHIND.candidate}
        lane="standing"
        presentation={{ label: "Lower body", value: "0 of 2" }}
      />
    );
    expect(screen.getByTestId("standing-label").className).toBe(
      "text-xs text-slate-500 dark:text-slate-400"
    );
  });

  it("leads with the tier, keeps the rest in place, and draws no fold", () => {
    const { container } = render(cluster([BEHIND, STEPS, BP, RHR]));
    expect(
      [...container.querySelectorAll("[data-standing-band]")].map((node) =>
        node.getAttribute("data-standing-band")
      )
      // One `rest` section per registry SECTION that has members — Today for the
      // steps row, Body for the two vitals — and the tier above them.
    ).toEqual(["attention", "rest", "rest"]);

    // The tier does the telling: the behind word is present, exactly once, and it
    // is inside the tier rather than anywhere else on the surface.
    const tier = container.querySelector('[data-standing-band="attention"]')!;
    expect(screen.getAllByTestId("standing-pace")).toHaveLength(1);
    expect(
      tier.querySelector('[data-standing-family="weekly-targets"]')
    ).not.toBeNull();
    expect(screen.getByTestId("standing-pace").textContent).toBe("Behind");

    // ONE FOLD ON THE PAGE (#4232): Standing itself has none. No disclosure, no
    // summary, no quiet band.
    expect(screen.queryByTestId("dashboard-standing-tail")).toBeNull();
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).not.toContain("Quiet");
  });

  // THE CONVERSE OF THE REMOVAL ABOVE, AND THE REASON IT IS WRITTEN (#3934,
  // re-targeted by #4232): a guard that only asserts the fold is gone passes just as
  // happily on a tree where Standing collapsed entirely and took its rows with it.
  // These are the rows that must STILL be drawn, counted THROUGH THE SAME per-band
  // query the removal assertion runs through, so the pair cannot disagree about what
  // it is looking at.
  //
  // The other half of the pair — the former quiet rows arriving in their Show
  // everything groups — is asserted where both zones are on one page, in
  // lib/__tests__/dashboard-placement-canvas.test.ts; this tier is only handed
  // Standing and could never see it.
  it("keeps every claimed row on the open page", () => {
    const { container } = render(cluster([BEHIND, STEPS, BP, RHR]));
    const open = container.querySelectorAll(
      '[data-standing-band="attention"] [data-candidate-id], [data-standing-band="rest"] [data-candidate-id]'
    );
    expect(
      [...open].map((node) => node.getAttribute("data-candidate-id"))
    ).toEqual([
      "target.weekly-progress:9",
      "activity.steps:d",
      "vitals.blood-pressure:2026-08-19",
      "vitals.resting-heart-rate:2026-08-19",
    ]);
    // …and each one is VISIBLE rather than merely mounted: nothing on this surface
    // hides behind anything.
    for (const node of open) expect(node.closest("[hidden]")).toBeNull();
  });

  // No empty-band chrome: a surface with only a stable rest renders no tier header
  // (#3548's sparse-profile reading).
  it("renders no chrome for an empty tier", () => {
    const { container } = render(cluster([STEPS]));
    expect(
      container.querySelector('[data-standing-band="attention"]')
    ).toBeNull();
    expect(
      [...container.querySelectorAll("[data-standing-band]")].map((node) =>
        node.getAttribute("data-standing-band")
      )
    ).toEqual(["rest"]);
  });

  it("keeps a disclosure beside its value and the door on its rail", () => {
    const disclosure = "Protein uses the larger tracked or in-app floor";
    const presentations = new Map(PRESENTATIONS);
    presentations.set(STEPS.candidate.candidateId, {
      label: "Protein",
      value: "84 g",
      href: "/nutrition",
      disclosure,
      presence: "current",
    });
    const { container } = render(cluster([STEPS], presentations));
    const candidate = container.querySelector<HTMLElement>(
      `[data-candidate-id="${STEPS.candidate.candidateId}"]`
    )!;
    const wrapper = candidate.firstElementChild as HTMLElement;
    const link = screen.getByRole("link", { name: /protein/i });
    const info = screen.getByRole("button", { name: disclosure });
    const door = screen.getByTestId("standing-door");

    expect(wrapper.classList.contains("sm:pr-32")).toBe(true);
    expect(wrapper.classList.contains("pr-32")).toBe(false);
    expect(link.classList.contains("sm:pr-32")).toBe(false);
    expect(link.nextElementSibling).toBe(info.parentElement);
    expect(link.classList.contains("standing-stretch")).toBe(true);
    expect(door.classList.contains("absolute")).toBe(true);
    expect(door.classList.contains("right-0")).toBe(true);
  });
});

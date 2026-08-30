import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import DashboardStandingCluster, {
  type DashboardStandingPresentation,
} from "@/components/dashboard/DashboardStandingCluster";
import type { DashboardPlacement } from "@/lib/dashboard-relevance";
import type {
  StandingBandKey,
  StandingFamilyKey,
  StandingSectionKey,
} from "@/lib/dashboard-standing";

// Standing's rendered anatomy after #3548: the tier at the top, the stable rest in
// its fixed sections, and the quiet tail behind ONE disclosure that hides rather
// than unmounts. The ranker decides membership (pinned in
// lib/__tests__/dashboard-standing.test.ts); what this tier can see is what the
// three bands look like once they are on a page.

type StandingPlacement = Extract<DashboardPlacement, { lane: "standing" }>;

function placement(
  candidateId: string,
  family: StandingFamilyKey,
  section: StandingSectionKey,
  band: StandingBandKey,
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
const STEPS = placement("activity.steps:d", "steps-today", "today", "rest", 1);
const DORMANT_BP = placement(
  "vitals.blood-pressure:2019-01-01",
  "blood-pressure",
  "body",
  "tail",
  2
);
const PILLAR = placement(
  "healthspan.pillar:vo2",
  "healthspan-pillars",
  "longer-view",
  "tail",
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
  [
    DORMANT_BP.candidate.candidateId,
    {
      detail: "No blood pressure since Mar 2019",
      href: "/trends#body",
      actionLabel: "Log one",
      presence: "dormant",
    },
  ],
  [PILLAR.candidate.candidateId, { label: "VO2 max", value: "Quiet" }],
]);

const cluster = (
  placements: readonly StandingPlacement[],
  presentations = PRESENTATIONS
) => (
  <DashboardStandingCluster
    placements={placements}
    presentations={presentations}
  />
);

describe("Standing's rendered bands", () => {
  it("leads with the tier, keeps the rest in place, and folds the tail", () => {
    const { container } = render(cluster([BEHIND, STEPS, DORMANT_BP, PILLAR]));
    expect(
      [...container.querySelectorAll("[data-standing-band]")].map((node) =>
        node.getAttribute("data-standing-band")
      )
    ).toEqual(["attention", "rest", "tail"]);

    // The tier does the telling: the behind word is present, exactly once, and it
    // is inside the tier rather than anywhere else on the surface.
    const tier = container.querySelector('[data-standing-band="attention"]')!;
    expect(screen.getAllByTestId("standing-pace")).toHaveLength(1);
    expect(
      tier.querySelector('[data-standing-family="weekly-targets"]')
    ).not.toBeNull();
    expect(screen.getByTestId("standing-pace").textContent).toBe("Behind");

    // The tail is a labelled disclosure that HIDES rather than unmounts: the
    // dormant line and its log affordance are both still in the document.
    const tail = screen.getByTestId("dashboard-standing-tail");
    expect(tail.tagName).toBe("DETAILS");
    expect((tail as HTMLDetailsElement).open).toBe(false);
    expect(
      screen.getByTestId("dashboard-standing-tail-summary").textContent
    ).toBe("Quiet (2)");
    expect(
      tail.querySelector(
        '[data-candidate-id="vitals.blood-pressure:2019-01-01"]'
      )
    ).not.toBeNull();
    expect(tail.textContent).toContain("Log one");
  });

  // The converse of the removal above, and the reason it is written: a guard that
  // only asserts the dormant line has left the open page passes just as happily on
  // a tree where the whole family vanished. These are the surfaces that must STAY.
  it("keeps the open page's own rows out of the fold", () => {
    const { container } = render(cluster([BEHIND, STEPS, DORMANT_BP, PILLAR]));
    const tail = screen.getByTestId("dashboard-standing-tail");
    const open = container.querySelectorAll(
      '[data-standing-band="attention"] [data-candidate-id], [data-standing-band="rest"] [data-candidate-id]'
    );
    expect(
      [...open].map((node) => node.getAttribute("data-candidate-id"))
    ).toEqual(["target.weekly-progress:9", "activity.steps:d"]);
    expect(
      tail.contains(
        container.querySelector('[data-candidate-id="activity.steps:d"]')
      )
    ).toBe(false);
  });

  // No empty-band chrome: a surface with only a stable rest renders neither a tier
  // header nor a fold control (#3548's sparse-profile reading).
  it("renders no chrome for an empty tier or an empty tail", () => {
    const { container } = render(cluster([STEPS]));
    expect(
      container.querySelector('[data-standing-band="attention"]')
    ).toBeNull();
    expect(screen.queryByTestId("dashboard-standing-tail")).toBeNull();
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

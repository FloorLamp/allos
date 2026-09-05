// #2641 GAP 1 PHASE 2 — THE TAIL'S GATHERS RUN INSIDE THE BOUNDARY, WHICH IS THE
// ONE PROPERTY THE HTTP-TIER SPECS CANNOT SEE.
//
// e2e/upcoming-aggregate.spec.ts and e2e/visit-links.spec.ts compare marker INDEXES
// in the response body. That establishes three real things — the boundary exists,
// the shell's markers precede its fallback, and the tail rides the same response —
// and it is blind to the regression that would empty this work out: hoist the tail's
// gathers back into the page and pass the results down as props, and StreamedSection
// still yields, the fallback is still emitted, the document order is unchanged, and
// both specs stay green over a boundary that has become decorative. That is not a
// guess about them: StreamedSection awaits its yield UNCONDITIONALLY, so React
// suspends and emits the fallback wherever the reads live, and a buffered response
// cannot testify about when a byte was flushed either way. #5327 records the same
// gap in #4697's "structural proof is document order" claim.
//
// What DOES separate the two worlds is when the gathers run. Awaiting a page
// component runs that component's own body and stops at the tail's element: React has
// not invoked the async child yet. So with the reads where this change puts them the
// gathers have not run once the page resolves, and hoisting them into the page makes
// the page's own await run them.
//
// Each case reads its counter TWICE through the SAME spy — zero after the page
// resolves, non-zero after the boundary's child is driven by hand. The second read is
// the control, and it is the half that matters: it is what proves the counter can move
// at all, so a mock that had quietly stopped intercepting the page's import fails here
// instead of passing as a green.

import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import { Suspense, isValidElement, type ReactElement } from "react";
import { db } from "@/lib/db";
import { seedActor } from "../__action_tests__/harness";

// Both mocks WRAP the real implementation rather than stubbing it: the pages must
// still render truthfully, and a stub would make "did it run" unanswerable for the
// only reason anyone cares — the query load behind it.
vi.mock("@/lib/queries/attention", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/queries/attention")>();
  return {
    ...actual,
    collectMultiProfileSuppressed: vi.fn(actual.collectMultiProfileSuppressed),
    collectMultiProfileOffered: vi.fn(actual.collectMultiProfileOffered),
  };
});
vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    encountersForEpisode: vi.fn(actual.encountersForEpisode),
  };
});

const { collectMultiProfileSuppressed } = await import(
  "@/lib/queries/attention"
);
const { encountersForEpisode } = await import("@/lib/queries");
const UpcomingPage = (await import("@/app/(app)/upcoming/page")).default;
const EpisodePage = (
  await import("@/app/(app)/medical/episodes/[id]/page")
).default;

// Drive the async child React would have invoked at the boundary, walking the tree
// the page ACTUALLY returned rather than re-querying one of my own. <Suspense> holds
// <StreamedSection>, which holds the page's tail component; invoking each function
// element in turn is what React does when it resumes.
async function runBoundaryChild(tree: unknown): Promise<void> {
  const suspense = findSuspense(tree);
  expect(suspense, "the page rendered no <Suspense> boundary").toBeTruthy();
  let node: unknown = (suspense!.props as { children?: unknown }).children;
  while (isValidElement(node) && typeof node.type === "function") {
    const rendered = await (
      node.type as (props: unknown) => Promise<unknown> | unknown
    )(node.props);
    node = isValidElement(rendered)
      ? (rendered.props as { children?: unknown }).children
      : rendered;
  }
}

function findSuspense(node: unknown): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findSuspense(child);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === Suspense) return node;
  return findSuspense((node.props as { children?: unknown }).children);
}

function seedEpisode(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
         VALUES (?, 'boundary read case', '2026-03-01', NULL)`
      )
      .run(profileId).lastInsertRowid
  );
}

describe("streamed hub boundaries read inside themselves (#2641)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [
      "/upcoming",
      collectMultiProfileSuppressed as unknown as Mock,
      async () => {
        seedActor();
        return UpcomingPage({ searchParams: Promise.resolve({}) });
      },
    ],
    [
      "/medical/episodes/[id]",
      encountersForEpisode as unknown as Mock,
      async () => {
        const { profile } = seedActor();
        const episodeId = seedEpisode(profile.id);
        return EpisodePage({
          params: Promise.resolve({ id: String(episodeId) }),
          searchParams: Promise.resolve({}),
        });
      },
    ],
  ])(
    "%s resolves its shell without having run the tail's gather",
    async (_route, gather, renderPage) => {
      const tree = await renderPage();

      // The shell is finished and the tail's gather has not been asked for. This is
      // the assertion a hoist reds: a gather moved into the page runs during the
      // await above, and lands here as a call count of 1.
      expect(gather).not.toHaveBeenCalled();

      // CONTROL, through the same spy: the gather does run when the boundary's child
      // is driven, so the zero above is a real observation about placement and not a
      // counter that never moves.
      await runBoundaryChild(tree);
      expect(gather).toHaveBeenCalled();
    }
  );
});

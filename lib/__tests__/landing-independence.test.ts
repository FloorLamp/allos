import { describe, expect, it } from "vitest";
import {
  independenceNotice,
  judgeIndependence,
} from "../../scripts/orchestration/landing-independence-core.mjs";

// MERGES ARE SERIAL, PRs ARE NOT (owner, 2026-09-02). Every merge stales the
// other open PRs' CI, and re-running each one at ~16 minutes serialised the
// day at a median 26 minutes between merges. The runbook's escape — "write
// down why the two file sets cannot interact" — is now a function, and these
// pins hold the two ways it can be wrong: an overlap it misses, and a shared
// file it treats as ordinary.

describe("judgeIndependence", () => {
  it("is independent when the changed paths are disjoint and ordinary", () => {
    const v = judgeIndependence({
      candidate: ["lib/charts/intraday.ts", "components/IntradayChart.tsx"],
      landed: ["lib/notifications/recap.ts", "app/(app)/upcoming/page.tsx"],
    });
    expect(v).toEqual({ independent: true, overlap: [], shared: [] });
  });

  it("is not independent when any path was changed on both sides", () => {
    const v = judgeIndependence({
      candidate: ["lib/rank-core.ts", "components/Now.tsx"],
      landed: ["lib/rank-core.ts"],
    });
    expect(v.independent).toBe(false);
    expect(v.overlap).toEqual(["lib/rank-core.ts"]);
  });

  it("is not independent when EITHER side touched a shared file", () => {
    // Disjoint diffs to an append-only barrel still interact: keep BOTH
    // entries, later merge last (review-merge.md §Migrations).
    const candidateSide = judgeIndependence({
      candidate: [
        "lib/migrations/versions/index.ts",
        "lib/migrations/versions/20260902-x.ts",
      ],
      landed: ["lib/food-log.ts"],
    });
    expect(candidateSide.independent).toBe(false);
    expect(candidateSide.shared).toEqual(["lib/migrations/versions/index.ts"]);

    const landedSide = judgeIndependence({
      candidate: ["lib/food-log.ts"],
      landed: ["e2e/seed/training.ts"],
    });
    expect(landedSide.independent).toBe(false);
    expect(landedSide.shared).toEqual(["e2e/seed/training.ts"]);
  });

  it("says which way it decided, in one line", () => {
    expect(
      independenceNotice(
        12,
        judgeIndependence({ candidate: ["a"], landed: [] }),
        0
      )
    ).toMatch(/nothing landed/);
    expect(
      independenceNotice(
        12,
        judgeIndependence({ candidate: ["a"], landed: ["b"] }),
        2
      )
    ).toMatch(/no shared paths with the 2 merge.*not visible here/);
    expect(
      independenceNotice(
        12,
        judgeIndependence({ candidate: ["a"], landed: ["a"] }),
        1
      )
    ).toMatch(/NOT independent \(paths changed on both sides: a\)/);
  });
});

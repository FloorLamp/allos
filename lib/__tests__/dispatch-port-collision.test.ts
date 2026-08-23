// Two lanes on one E2E port range (#3608).
//
// A dispatch reserves a 200-port band, and the allocator hands out the first
// free one. But `--port-base` supplies the answer directly, and for a while that
// routed past the question entirely: `allocatePortBase` was the ONLY reader of
// which bands were taken, so a hand-supplied base was never compared against the
// active roster at all.
//
// The script already learned this lesson once, for a different predicate. The
// 6000-6099 band is one Next refuses ("Bad port: reserved for x11"), and the
// check for it was moved OUT of the allocator's loop into `RESERVED_PORT_REASON`
// precisely so a hand-supplied base could be held to it — the comment there says
// "a caller who supplies the answer never asks the question". The collision rule
// stayed inside the loop, which is the half that did not get applied.
//
// Measured on 2026-08-23: `--port-base 7600` was passed for a live e2e lane while
// a retired-but-unclosed dispatch still held 7600 in the ledger. Nothing
// complained. Both agents drive Playwright on their band, so had the first lane's
// agent still been alive the two would have shared worker ports — and the failure
// that produces is not a clean "address in use", it is one suite's browser
// answering another's navigation, which reads as a flake in code neither lane
// touched.
//
// So the predicate is tested in BOTH directions. A collision rule that only ever
// says yes would refuse every dispatch, and a green allocator over an empty
// roster proves nothing about a roster with entries in it.

import { describe, expect, it } from "vitest";

import { portBaseCollision } from "../../scripts/orchestration/dispatch-brief.mjs";

const ACTIVE = [
  { branch: "guards-that-cannot-see", portBase: 5400 },
  { branch: "integrations-error-and-ids", portBase: 5600 },
  { branch: "ride-detail-and-leftovers", portBase: 7600 },
];

describe("portBaseCollision", () => {
  it("does not let a dispatch collide with ITSELF, which is what a reprint is", () => {
    // `brief` reprints a LIVE dispatch with its own stored base, so the roster it is
    // checked against contains it. Without the exclusion every reprint refuses — and
    // that is not hypothetical: it is what this guard did the first time it fired for
    // real, hours after it shipped, against `brief intake-purposes-and-catalog`. A
    // guard whose first genuine firing is a false positive against a legitimate
    // operation gets routed around within the hour, which is worse than not having it.
    expect(
      portBaseCollision(7600, ACTIVE, "ride-detail-and-leftovers")
    ).toBeNull();
    // …and it still catches a DIFFERENT dispatch on that band.
    expect(portBaseCollision(7600, ACTIVE, "some-other-branch")).toBe(
      "port base 7600 is already held by the active dispatch ride-detail-and-leftovers"
    );
  });

  it("names the dispatch already holding the band, not just that one does", () => {
    // The message is the whole value of the refusal: an orchestrator who is told
    // "7600 is taken" still has to go and find out by whom before it can act.
    expect(portBaseCollision(7600, ACTIVE)).toBe(
      "port base 7600 is already held by the active dispatch ride-detail-and-leftovers"
    );
  });

  it("is silent on a band nobody holds", () => {
    expect(portBaseCollision(6600, ACTIVE)).toBeNull();
  });

  it("is silent against an empty roster, so the first dispatch of a session is not refused", () => {
    expect(portBaseCollision(5400, [])).toBeNull();
  });

  it("does not let a row carrying no port base collide with a real one", () => {
    // A roster row can reach the ledger without a band — an adopted Agent-tool
    // run that never asked for one. It must not stand between the allocator and
    // any band, or the first such row makes every subsequent base look taken.
    const withBandless = [
      ...ACTIVE,
      { branch: "adopted-lane", portBase: null },
    ];
    expect(portBaseCollision(5800, withBandless)).toBeNull();
    expect(portBaseCollision(7600, withBandless)).toBe(
      "port base 7600 is already held by the active dispatch ride-detail-and-leftovers"
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  classifyPull,
  shouldRefresh,
  PTR_MAX_PX,
  PTR_RESISTANCE,
  PTR_TRIGGER_PX,
  type PullInput,
} from "@/lib/pull-to-refresh";

// The standalone-PWA pull-to-refresh classifier (issue #1428, section B).

// Finger travel that lands exactly on the arming threshold after resistance.
const ARMING_TRAVEL = PTR_TRIGGER_PX / PTR_RESISTANCE;

function pull(over: Partial<PullInput> = {}): PullInput {
  return { startScrollY: 0, scrollY: 0, deltaY: 0, deltaX: 0, ...over };
}

describe("classifyPull", () => {
  it("arms once the pull passes the threshold", () => {
    const state = classifyPull(pull({ deltaY: ARMING_TRAVEL }));
    expect(state.kind).toBe("armed");
    expect(shouldRefresh(state)).toBe(true);
  });

  it("is still pulling — and refuses to refresh — just short of the threshold", () => {
    const state = classifyPull(pull({ deltaY: ARMING_TRAVEL - 2 }));
    expect(state.kind).toBe("pulling");
    expect(shouldRefresh(state)).toBe(false);
  });

  it("ignores a pull that did not START at the top of the page", () => {
    // The mid-page case the issue calls out: this is ordinary scrolling, and
    // arming a refresh under it would fire on release halfway down the page.
    expect(
      classifyPull(pull({ startScrollY: 400, deltaY: ARMING_TRAVEL })).kind
    ).toBe("idle");
  });

  it("ignores a pull that started at the top but has scrolled away since", () => {
    expect(
      classifyPull(pull({ scrollY: 300, deltaY: ARMING_TRAVEL })).kind
    ).toBe("idle");
  });

  it("ignores an UPWARD drag at the top — that is a scroll into the page", () => {
    expect(classifyPull(pull({ deltaY: -ARMING_TRAVEL })).kind).toBe("idle");
    expect(classifyPull(pull({ deltaY: 0 })).kind).toBe("idle");
  });

  it("ignores a mostly-horizontal swipe, wobble and all", () => {
    // A sideways swipe on a chip strip or a chart pan drifts vertically; it must
    // not arm the refresh as a side effect.
    expect(
      classifyPull(pull({ deltaY: ARMING_TRAVEL, deltaX: -ARMING_TRAVEL - 10 }))
        .kind
    ).toBe("idle");
    // A 45° diagonal is not a pull either (strictly-more-vertical).
    expect(
      classifyPull(pull({ deltaY: ARMING_TRAVEL, deltaX: ARMING_TRAVEL })).kind
    ).toBe("idle");
    // Predominantly vertical with a little sideways drift still counts.
    expect(classifyPull(pull({ deltaY: ARMING_TRAVEL, deltaX: 8 })).kind).toBe(
      "armed"
    );
  });

  it("tolerates sub-pixel scroll rounding at rest", () => {
    // Requiring an exact scrollY of 0 makes the gesture intermittently
    // impossible on devices that settle at 0.5.
    expect(
      classifyPull(
        pull({ startScrollY: 0.5, scrollY: 0.5, deltaY: ARMING_TRAVEL })
      ).kind
    ).toBe("armed");
  });

  it("resists the drag and caps how far the indicator travels", () => {
    const half = classifyPull(pull({ deltaY: 40 }));
    expect(half.kind).toBe("pulling");
    // Weighted, not stuck to the finger — which is what makes arming deliberate.
    expect(half.kind !== "idle" && half.distance).toBe(40 * PTR_RESISTANCE);

    const yanked = classifyPull(pull({ deltaY: 5000 }));
    expect(yanked.kind !== "idle" && yanked.distance).toBe(PTR_MAX_PX);
    expect(yanked.kind !== "idle" && yanked.progress).toBe(1);
  });

  it("reports progress as a 0..1 fraction of the arming threshold", () => {
    const state = classifyPull(pull({ deltaY: ARMING_TRAVEL / 2 }));
    expect(state.kind !== "idle" && state.progress).toBeCloseTo(0.5, 5);
  });
});

describe("shouldRefresh", () => {
  it("refreshes from `armed` and from nothing else", () => {
    expect(shouldRefresh({ kind: "idle" })).toBe(false);
    expect(
      shouldRefresh({ kind: "pulling", distance: 10, progress: 0.2 })
    ).toBe(false);
    expect(
      shouldRefresh({ kind: "armed", distance: PTR_TRIGGER_PX, progress: 1 })
    ).toBe(true);
  });
});

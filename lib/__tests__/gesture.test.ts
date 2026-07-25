import { describe, expect, it } from "vitest";
import {
  GESTURE_THRESHOLDS,
  axisOf,
  classifySwipe,
  directedTravel,
  directedVelocity,
  isEdgeStart,
  lockedAxis,
  shouldCommit,
  type GesturePoint,
} from "@/lib/gesture";

// Fixture traces for the gesture classifier (issues #1425, #1469).
//
// The three decisions this module owns are the ones that make a hand-rolled
// gesture feel broken, so each is pinned at its boundary: an axis that is
// claimed too early steals the page's scroll, a "travel" that counts movement
// the wrong way lets a sheet be dragged off its resting edge, and a commit rule
// that trusts velocity alone fires on a twitch.

const at = (x: number, y: number, t = 0): GesturePoint => ({ x, y, t });

describe("lockedAxis", () => {
  it("stays undecided until the finger clears the lock distance", () => {
    const from = at(100, 400);
    expect(lockedAxis(from, at(105, 400))).toBeNull();
    expect(lockedAxis(from, at(109, 400))).toBeNull();
    expect(lockedAxis(from, at(110, 400))).toBe("x");
  });

  it("claims the dominant axis once it clearly wins", () => {
    expect(lockedAxis(at(0, 0), at(60, 5))).toBe("x");
    expect(lockedAxis(at(0, 0), at(5, 60))).toBe("y");
  });

  it("reads a diagonal as undecided — an ambiguous gesture is a scroll", () => {
    // 45°: neither axis clears `axisRatio`, so nothing is claimed and the
    // browser keeps whatever it was going to do with the touch.
    expect(lockedAxis(at(0, 0), at(50, 50))).toBeNull();
    // Just inside the ratio in each direction.
    expect(
      lockedAxis(at(0, 0), at(50, 50 / GESTURE_THRESHOLDS.axisRatio))
    ).toBe("x");
    expect(
      lockedAxis(at(0, 0), at(50 / GESTURE_THRESHOLDS.axisRatio, 50))
    ).toBe("y");
  });

  it("never claims an axis for a tap that wobbled", () => {
    expect(lockedAxis(at(200, 500), at(203, 498))).toBeNull();
  });
});

describe("axisOf", () => {
  it("maps each direction to its axis", () => {
    expect(axisOf("left")).toBe("x");
    expect(axisOf("right")).toBe("x");
    expect(axisOf("up")).toBe("y");
    expect(axisOf("down")).toBe("y");
  });
});

describe("directedTravel", () => {
  it("measures movement toward the direction only", () => {
    expect(directedTravel(at(0, 0), at(0, 80), "down")).toBe(80);
    expect(directedTravel(at(0, 0), at(0, -80), "up")).toBe(80);
    expect(directedTravel(at(100, 0), at(20, 0), "left")).toBe(80);
    expect(directedTravel(at(0, 0), at(80, 0), "right")).toBe(80);
  });

  it("clamps movement the OTHER way at zero, never negative", () => {
    // This is what stops a bottom-anchored sheet being dragged UP off its
    // resting edge, and a left-anchored drawer being dragged past its width.
    expect(directedTravel(at(0, 0), at(0, -120), "down")).toBe(0);
    expect(directedTravel(at(0, 0), at(120, 0), "left")).toBe(0);
  });

  it("counts the NET travel of an out-and-back drag", () => {
    // Down 100 then back up to 30 is a 30px gesture, not a 100px one — the user
    // changed their mind and the release must see that.
    expect(directedTravel(at(0, 0), at(0, 30), "down")).toBe(30);
  });
});

describe("directedVelocity", () => {
  it("is travel over elapsed time", () => {
    expect(directedVelocity(at(0, 0, 0), at(0, 90, 100), "down")).toBeCloseTo(
      0.9
    );
  });

  it("returns 0 for an unmeasurable interval rather than Infinity", () => {
    // Two samples sharing a timestamp must never read as an infinitely fast
    // flick — that would commit every gesture the moment two events coalesce.
    expect(directedVelocity(at(0, 0, 50), at(0, 90, 50), "down")).toBe(0);
    expect(directedVelocity(at(0, 0, 50), at(0, 90, 20), "down")).toBe(0);
  });
});

describe("shouldCommit", () => {
  it("commits on distance alone", () => {
    expect(shouldCommit(GESTURE_THRESHOLDS.commitPx, 0)).toBe(true);
    expect(shouldCommit(GESTURE_THRESHOLDS.commitPx - 1, 0)).toBe(false);
  });

  it("commits a short FLICK that never covered the distance", () => {
    expect(shouldCommit(30, GESTURE_THRESHOLDS.flickPxPerMs)).toBe(true);
  });

  it("refuses a fast twitch that never cleared the axis lock", () => {
    // Speed without displacement is a tap landing badly, not a flick.
    expect(shouldCommit(GESTURE_THRESHOLDS.axisLockPx - 1, 5)).toBe(false);
  });

  it("refuses a slow, short drag", () => {
    expect(shouldCommit(20, 0.1)).toBe(false);
  });
});

describe("isEdgeStart", () => {
  it("accepts a start inside the edge zone and rejects one past it", () => {
    expect(isEdgeStart(0)).toBe(true);
    expect(isEdgeStart(GESTURE_THRESHOLDS.edgePx)).toBe(true);
    expect(isEdgeStart(GESTURE_THRESHOLDS.edgePx + 1)).toBe(false);
    expect(isEdgeStart(200)).toBe(false);
  });
});

describe("classifySwipe", () => {
  it("classifies a decisive leftward swipe as committed", () => {
    const out = classifySwipe(at(300, 400, 0), at(180, 410, 160));
    expect(out.axis).toBe("x");
    expect(out.direction).toBe("left");
    expect(out.travel).toBe(120);
    expect(out.committed).toBe(true);
  });

  it("classifies a decisive rightward swipe", () => {
    const out = classifySwipe(at(80, 400, 0), at(240, 396, 200));
    expect(out.direction).toBe("right");
    expect(out.committed).toBe(true);
  });

  it("returns nothing actionable for a vertical scroll", () => {
    // "Vertical scroll must win" expressed as data: a mostly-vertical drag on a
    // horizontally-swipeable surface yields no direction, so there is nothing
    // for a consumer to act on.
    const out = classifySwipe(at(200, 600, 0), at(206, 240, 260));
    expect(out.axis).toBe("y");
    expect(out.direction).toBe("up");
    // The Timeline only ever acts on a horizontal outcome; the vertical one is
    // reported honestly and simply matches no handler.
    expect(out.axis).not.toBe("x");
  });

  it("returns an unresolved outcome for a tap", () => {
    const out = classifySwipe(at(200, 600, 0), at(202, 601, 90));
    expect(out.axis).toBeNull();
    expect(out.direction).toBeNull();
    expect(out.travel).toBe(0);
    expect(out.committed).toBe(false);
  });

  it("returns an unresolved outcome for a diagonal drag", () => {
    const out = classifySwipe(at(100, 500, 0), at(190, 410, 200));
    expect(out.axis).toBeNull();
    expect(out.committed).toBe(false);
  });

  it("commits a fast flick that covered little ground", () => {
    const out = classifySwipe(at(300, 400, 0), at(268, 402, 40));
    expect(out.direction).toBe("left");
    expect(out.travel).toBe(32);
    expect(out.travel).toBeLessThan(GESTURE_THRESHOLDS.commitPx);
    expect(out.committed).toBe(true);
  });

  it("does not commit a slow horizontal drag that stopped short", () => {
    const out = classifySwipe(at(300, 400, 0), at(260, 400, 900));
    expect(out.direction).toBe("left");
    expect(out.committed).toBe(false);
  });
});

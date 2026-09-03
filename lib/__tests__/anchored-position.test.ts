// Where a portaled panel lands (#3271).
//
// The defect this replaces was a panel CLIPPED by an ancestor's `overflow`, and
// the thing that made it hard to catch is that a clipped list still renders, still
// reports a bounding box, and still passes "the options are present". So these
// assert CONTAINMENT — the panel's own bottom edge against the viewport's — and
// the SIDE it chose, never that a position was produced.

import { describe, it, expect } from "vitest";
import {
  anchoredPosition,
  ANCHOR_GAP,
  ANCHOR_MARGIN,
  type AnchorRect,
} from "../anchored-position";

const VIEWPORT = { width: 400, height: 800 };

// A control `width` wide whose top edge is at `top`, 40px tall — a field.
function field(top: number, left = 20, width = 200): AnchorRect {
  return { top, bottom: top + 40, left, right: left + width, width };
}

// The panel's bottom edge: it renders at whichever is smaller of the height it
// wanted and the cap it was given, which is what `max-height` means.
const bottomOf = (pos: { top: number; maxHeight: number }, height: number) =>
  pos.top + Math.min(height, pos.maxHeight);

describe("anchoredPosition — which side, and how tall", () => {
  it("sits below the anchor when the panel fits there", () => {
    const anchor = field(100);
    const pos = anchoredPosition({
      anchor,
      panel: { height: 224, width: 200 },
      viewport: VIEWPORT,
    });
    expect(pos.top).toBe(anchor.bottom + ANCHOR_GAP);
  });

  it("flips above when it will not fit below but does fit above", () => {
    // 700px down a 800px viewport: 92px below, 692px above.
    const anchor = field(700);
    const pos = anchoredPosition({
      anchor,
      panel: { height: 224, width: 200 },
      viewport: VIEWPORT,
    });
    expect(pos.top).toBe(anchor.top - ANCHOR_GAP - 224);
  });

  it("sends a panel that declared no cap to the roomier side too (#4776)", () => {
    // 400/440 of 800: 352 below, 388 above. A menu taller than either used to
    // stay below on the reasoning that flipping only moved the overflow — but
    // the panel now scrolls, so the roomier side is where more of it is legible.
    const anchor = field(400);
    const pos = anchoredPosition({
      anchor,
      panel: { height: 900, width: 200 },
      viewport: VIEWPORT,
    });
    expect(pos.maxHeight).toBe(anchor.top - ANCHOR_GAP - ANCHOR_MARGIN);
    expect(pos.top).toBe(ANCHOR_MARGIN);
  });

  it("sends a CAPPED panel to the roomier side when it fits neither", () => {
    // 400/440 of 800: 352 below, 388 above. Neither holds 500, so above wins —
    // it can shrink, so more room is strictly better.
    const anchor = field(400);
    const pos = anchoredPosition({
      anchor,
      panel: { height: 500, width: 200 },
      viewport: VIEWPORT,
      preferredMaxHeight: 500,
    });
    expect(pos.top).toBeLessThan(anchor.top);
    expect(pos.maxHeight).toBe(anchor.top - ANCHOR_GAP - ANCHOR_MARGIN);
  });
});

describe("anchoredPosition — containment", () => {
  // THE GUARANTEE, asserted as the property rather than as one example: a panel
  // that declares a preferred height is never left with its bottom edge past the
  // viewport's, and never with its top edge above it. This is the assertion the
  // bug could not have passed — a clipped panel's box ran straight off its
  // ancestor, and off the screen with it.
  // #4776 made this the guarantee for EVERY panel rather than only for one that
  // declared a preferred height, so the cases run over both — a 900px menu that
  // asked for nothing is the shape that used to run off the edge.
  it.each([
    { what: "a panel that declared a cap", height: 224, preferred: 224 },
    { what: "a panel that declared none", height: 224, preferred: undefined },
    { what: "one taller than the viewport", height: 900, preferred: undefined },
  ])(
    "keeps $what on screen from every anchor position",
    ({ height, preferred }) => {
      // Every position where the FIELD itself is on screen. (An anchor scrolled out
      // of view is the next case, and it is deliberately different.)
      for (let top = 0; top <= VIEWPORT.height - 40; top += 20) {
        const pos = anchoredPosition({
          anchor: field(top),
          panel: { height, width: 200 },
          viewport: VIEWPORT,
          ...(preferred == null ? {} : { preferredMaxHeight: preferred }),
        });
        expect(pos.top).toBeGreaterThanOrEqual(0);
        expect(bottomOf(pos, height)).toBeLessThanOrEqual(VIEWPORT.height);
      }
    }
  );

  it("shrinks rather than overflowing when the room is smaller than the panel", () => {
    // A short viewport — a landscape phone, or a small window. 300 tall, field
    // at 120: 136 below. The list wants 224 and must not get it.
    const pos = anchoredPosition({
      anchor: field(120),
      panel: { height: 224, width: 200 },
      viewport: { width: 400, height: 300 },
      preferredMaxHeight: 224,
    });
    expect(pos.maxHeight).toBeLessThan(224);
    expect(bottomOf(pos, 224)).toBeLessThanOrEqual(300);
  });

  // A panel FOLLOWS ITS ANCHOR off screen rather than detaching from it. Holding
  // it on screen while the field it belongs to has scrolled away would leave a
  // list floating over unrelated content with nothing to explain it — worse than
  // going away with the thing it describes. Recorded because the containment
  // property above deliberately stops short of it.
  it("lets the panel leave with an anchor that has scrolled out of view", () => {
    const pos = anchoredPosition({
      anchor: field(VIEWPORT.height + 20),
      panel: { height: 224, width: 200 },
      viewport: VIEWPORT,
      preferredMaxHeight: 224,
    });
    expect(bottomOf(pos, 224)).toBeGreaterThan(VIEWPORT.height);
  });

  it("never reports a negative height when the anchor is at the very bottom", () => {
    const pos = anchoredPosition({
      anchor: field(795),
      panel: { height: 224, width: 200 },
      viewport: { width: 400, height: 800 },
      preferredMaxHeight: 224,
    });
    expect(pos.maxHeight).toBeGreaterThanOrEqual(0);
  });
});

describe("anchoredPosition — horizontal placement", () => {
  it("lines up the left edges by default and the right edges on `end`", () => {
    const anchor = field(100, 120, 160);
    expect(
      anchoredPosition({
        anchor,
        panel: { height: 100, width: 160 },
        viewport: VIEWPORT,
      }).left
    ).toBe(120);
    expect(
      anchoredPosition({
        anchor,
        panel: { height: 100, width: 160 },
        viewport: VIEWPORT,
        align: "end",
      }).left
    ).toBe(anchor.right - 160);
  });

  it("pushes a panel back inside the viewport, margin beating alignment", () => {
    // A control at the right edge with a panel wider than the room beside it.
    const anchor = field(100, 380, 60);
    const pos = anchoredPosition({
      anchor,
      panel: { height: 100, width: 300 },
      viewport: VIEWPORT,
    });
    expect(pos.left).toBe(VIEWPORT.width - 300 - ANCHOR_MARGIN);

    // And the same on the left edge, where the clamp pushes the other way.
    const offLeft = anchoredPosition({
      anchor: field(100, -50, 60),
      panel: { height: 100, width: 300 },
      viewport: VIEWPORT,
    });
    expect(offLeft.left).toBe(ANCHOR_MARGIN);
  });

  it("takes the anchor's width only when asked, and reports it", () => {
    const anchor = field(100, 20, 240);
    expect(
      anchoredPosition({
        anchor,
        panel: { height: 100, width: 160 },
        viewport: VIEWPORT,
      }).width
    ).toBeUndefined();
    expect(
      anchoredPosition({
        anchor,
        panel: { height: 100, width: 160 },
        viewport: VIEWPORT,
        matchAnchorWidth: true,
      })
    ).toMatchObject({ left: 20, width: 240 });
  });
});

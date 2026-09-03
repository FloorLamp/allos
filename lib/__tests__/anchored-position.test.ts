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

  // THE TOOLTIP ALIGNMENT (#4511, owner ruling 2026-08-31). Both tooltip kinds ask
  // this function, so "below the control, centred on it, above only when there is no
  // room below" is decided here and nowhere else. A tooltip is small and its anchor is
  // a glyph, so the interesting cases are the ones where centring would push it off
  // an edge: the margin has to win there exactly as it does for `start` and `end`.
  it.each([
    // [what, anchor left, anchor width, panel width, expected left]
    ["centres a wide tooltip on a narrow glyph", 180, 44, 200, 180 + 22 - 100],
    [
      "clamps at the right edge rather than centring",
      370,
      24,
      200,
      400 - 200 - 8,
    ],
    ["clamps at the left edge rather than centring", 4, 24, 200, 8],
  ])("%s", (_what, left, width, panelWidth, expected) => {
    expect(
      anchoredPosition({
        anchor: field(100, left, width),
        panel: { height: 40, width: panelWidth },
        viewport: VIEWPORT,
        align: "center",
      }).left
    ).toBe(expected);
  });

  it("puts a centred tooltip BELOW its anchor, and flips it up only with no room", () => {
    // The side placements the info tooltip used to prefer are gone: this asks for the
    // one axis the ruling is about, at both ends of the viewport.
    const roomy = field(100, 180, 44);
    expect(
      anchoredPosition({
        anchor: roomy,
        panel: { height: 40, width: 200 },
        viewport: VIEWPORT,
        align: "center",
      }).top
    ).toBe(roomy.bottom + ANCHOR_GAP);

    // 4px of room below a 40px panel, and the whole viewport above it.
    const pinned = field(VIEWPORT.height - 60, 180, 44);
    expect(
      anchoredPosition({
        anchor: pinned,
        panel: { height: 40, width: 200 },
        viewport: VIEWPORT,
        align: "center",
      }).top
    ).toBe(pinned.top - ANCHOR_GAP - 40);
  });

  // THE EXEMPTION (#4917). `capHeight: false` is the tooltip's only way to opt
  // out of the #4776 bound, and it must show up in what comes back rather than
  // in a value the caller happens not to read.
  it("reports maxHeight: null when asked for capHeight: false, and still places the panel", () => {
    const anchor = field(700); // little room below, forcing the same flip logic
    const bounded = anchoredPosition({
      anchor,
      panel: { height: 224, width: 200 },
      viewport: VIEWPORT,
    });
    const unbounded = anchoredPosition({
      anchor,
      panel: { height: 224, width: 200 },
      viewport: VIEWPORT,
      capHeight: false,
    });
    expect(unbounded.maxHeight).toBeNull();
    // Placement — the part a height cap has nothing to do with — is unaffected.
    expect(unbounded.top).toBe(bounded.top);
    expect(unbounded.left).toBe(bounded.left);
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

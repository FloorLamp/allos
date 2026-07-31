import { describe, expect, it } from "vitest";
import {
  MIN_LABEL_PX,
  MOBILE_CHART_CONTENT_PX,
  clampLabel,
  effectiveFontPx,
  elideToWidth,
  hasNumericFontSize,
  placeRowLabels,
  scanScaledFontSizes,
  textExtent,
  textWidth,
  viewBoxFontSize,
  viewBoxScale,
} from "../chart-svg";

// The shared text geometry behind #1518 (how big is a viewBox label really) and
// #1573 (where does a label go so it stays inside the plot).

describe("effective size in a scaled viewBox (#1518)", () => {
  const INTRADAY_BEFORE = {
    viewBoxWidth: 720,
    minContainerPx: MOBILE_CHART_CONTENT_PX,
  };

  it("computes the scale factor the intraday panel actually rendered at", () => {
    expect(viewBoxScale(INTRADAY_BEFORE)).toBeCloseTo(0.497, 3);
  });

  it("reproduces the ~3.5px labels the blanket exemption let ship", () => {
    expect(effectiveFontPx(7, INTRADAY_BEFORE)).toBeCloseTo(3.48, 2);
    expect(effectiveFontPx(7, INTRADAY_BEFORE)).toBeLessThan(MIN_LABEL_PX);
  });

  it("a viewBox close to its container renders near 1:1", () => {
    const compact = { viewBoxWidth: 360, minContainerPx: 358 };
    expect(effectiveFontPx(10, compact)).toBeCloseTo(9.94, 2);
  });

  it("viewBoxFontSize returns the smallest half-unit size clearing the floor", () => {
    const compact = { viewBoxWidth: 360, minContainerPx: 320 };
    const size = viewBoxFontSize(compact);
    expect(size).toBe(10.5); // 9 × 360/320 = 10.125, rounded up to a half unit
    expect(effectiveFontPx(size, compact)).toBeGreaterThanOrEqual(MIN_LABEL_PX);
    // And it is genuinely the smallest: half a unit less falls under.
    expect(effectiveFontPx(size - 0.5, compact)).toBeLessThan(MIN_LABEL_PX);
  });

  it("a degenerate viewBox falls back to the floor rather than dividing by zero", () => {
    expect(viewBoxFontSize({ viewBoxWidth: 0, minContainerPx: 358 })).toBe(
      MIN_LABEL_PX
    );
    expect(viewBoxScale({ viewBoxWidth: 0, minContainerPx: 358 })).toBe(0);
  });
});

describe("the scaled-floor source scan (#1518)", () => {
  const WIDE = { viewBoxWidth: 720, minContainerPx: 358 };

  it("flags a 720-unit panel's fontSize 7 with its computed effective size", () => {
    const offenders = scanScaledFontSizes(
      `<text fontSize={7} fill="x">Sleep</text>`,
      WIDE
    );
    expect(offenders).toHaveLength(1);
    expect(offenders[0].fontSize).toBe(7);
    expect(offenders[0].effectivePx).toBeCloseTo(3.48, 2);
    expect(offenders[0].line).toBe(1);
  });

  it("passes the same panel at a legible size", () => {
    expect(scanScaledFontSizes(`<text fontSize={20} />`, WIDE)).toEqual([]);
  });

  it("passes the same fontSize once the viewBox matches the container", () => {
    expect(
      scanScaledFontSizes(`<text fontSize={7} />`, {
        viewBoxWidth: 360,
        minContainerPx: 358,
      })
    ).toHaveLength(1); // 7 × 0.994 = 6.96 — still under the floor
    expect(
      scanScaledFontSizes(`<text fontSize={10} />`, {
        viewBoxWidth: 360,
        minContainerPx: 358,
      })
    ).toEqual([]);
  });

  it("skips a panel with no numeric fontSize cleanly", () => {
    const source = `<text fontSize={geo.labelSize} fill="x">Sleep</text>`;
    expect(scanScaledFontSizes(source, WIDE)).toEqual([]);
    expect(hasNumericFontSize(source)).toBe(false);
    expect(hasNumericFontSize(`<text fontSize={7} />`)).toBe(true);
  });

  it("reports the line of each offender", () => {
    const offenders = scanScaledFontSizes(
      [
        "const a = 1;",
        "<text fontSize={7} />",
        "",
        "<tspan fontSize: 6.5 />",
      ].join("\n"),
      WIDE
    );
    expect(offenders.map((o) => o.line)).toEqual([2, 4]);
  });
});

describe("label width budget", () => {
  it("estimates a width proportional to length and size", () => {
    expect(textWidth("abcd", 10)).toBeCloseTo(24, 5);
  });

  it("returns the text untouched when it fits", () => {
    expect(elideToWidth("Sleep", 100, 10)).toBe("Sleep");
  });

  it("elides with an ellipsis when it does not", () => {
    const out = elideToWidth("Evening ride with the club", 60, 10);
    expect(out).not.toBeNull();
    expect(out!.endsWith("…")).toBe(true);
    expect(textWidth(out!, 10)).toBeLessThanOrEqual(60);
  });

  it("returns null rather than a lone ellipsis when nothing legible fits", () => {
    expect(elideToWidth("Evening ride", 6, 10)).toBeNull();
    expect(elideToWidth("   ", 100, 10)).toBeNull();
  });
});

describe("clamping a label inside the plot (#1573)", () => {
  const PLOT = { left: 30, right: 390 };

  it("leaves a comfortable label where it asked to be", () => {
    const placed = clampLabel({
      x: 200,
      text: "07:15",
      fontSize: 10,
      anchor: "middle",
      ...PLOT,
    });
    expect(placed).not.toBeNull();
    expect(placed!.x).toBe(200);
    expect(placed!.anchor).toBe("middle");
    expect(placed!.text).toBe("07:15");
  });

  it("flips the anchor inward at the right edge instead of painting past it", () => {
    const placed = clampLabel({
      x: 388,
      text: "23:40",
      fontSize: 10,
      anchor: "start",
      ...PLOT,
    })!;
    expect(placed.anchor).toBe("end");
    expect(placed.end).toBeLessThanOrEqual(PLOT.right);
    expect(placed.start).toBeGreaterThanOrEqual(PLOT.left);
  });

  it("flips the anchor inward at the left edge", () => {
    const placed = clampLabel({
      x: 31,
      text: "00:20",
      fontSize: 10,
      anchor: "end",
      ...PLOT,
    })!;
    expect(placed.anchor).toBe("start");
    expect(placed.start).toBeGreaterThanOrEqual(PLOT.left);
  });

  it("shifts when even the flipped anchor would overflow", () => {
    // A wide label anchored 20 units from the left edge: `start` runs off the
    // right, `end` runs off the left, so the label detaches and is shifted in.
    const placed = clampLabel({
      x: 50,
      text: "Red light 3–5×/week",
      fontSize: 10,
      anchor: "start",
      left: 30,
      right: 150,
    })!;
    expect(placed.start).toBeGreaterThanOrEqual(30 - 1e-9);
    expect(placed.end).toBeLessThanOrEqual(150 + 1e-9);
  });

  it("elides rather than clipping a label wider than the whole plot", () => {
    const placed = clampLabel({
      x: 200,
      text: "Red light therapy 3–5 times per week",
      fontSize: 14,
      anchor: "middle",
      left: 30,
      right: 220,
    })!;
    expect(placed.text).not.toBe("Red light therapy 3–5 times per week");
    expect(placed.text.endsWith("…")).toBe(true);
    expect(placed.start).toBeGreaterThanOrEqual(30 - 1e-9);
    expect(placed.end).toBeLessThanOrEqual(220 + 1e-9);
  });

  it("is null when the plot cannot hold anything legible", () => {
    expect(
      clampLabel({
        x: 5,
        text: "Sleep",
        fontSize: 10,
        left: 0,
        right: 4,
      })
    ).toBeNull();
    expect(
      clampLabel({ x: 5, text: "Sleep", fontSize: 10, left: 30, right: 10 })
    ).toBeNull();
  });
});

describe("collision handling on one label row (#1573)", () => {
  const ROW = { left: 0, right: 400 };

  it("keeps labels that do not touch", () => {
    const placed = placeRowLabels(
      [
        { key: "a", x: 20, text: "06:42", fontSize: 10 },
        { key: "b", x: 300, text: "22:10", fontSize: 10 },
      ],
      ROW
    );
    expect([...placed.keys()].sort()).toEqual(["a", "b"]);
  });

  it("drops the overlapping neighbour instead of smearing", () => {
    const placed = placeRowLabels(
      [
        { key: "a", x: 100, text: "06:42", fontSize: 10 },
        { key: "b", x: 104, text: "06:50", fontSize: 10 },
      ],
      ROW
    );
    expect(placed.has("a")).toBe(true);
    expect(placed.has("b")).toBe(false);
  });

  it("honors the gap budget, not just literal overlap", () => {
    const tight = placeRowLabels(
      [
        { key: "a", x: 100, text: "06:42", fontSize: 10 },
        { key: "b", x: 140, text: "06:50", fontSize: 10 },
      ],
      { ...ROW, minGap: 20 }
    );
    expect(tight.size).toBe(1);
  });

  it("resolves a collision by priority, not by input order", () => {
    const items = [
      { key: "low", x: 100, text: "06:42", fontSize: 10, priority: 0 },
      { key: "high", x: 104, text: "06:50", fontSize: 10, priority: 1 },
    ];
    for (const order of [items, [...items].reverse()]) {
      const placed = placeRowLabels(order, ROW);
      expect(placed.has("high")).toBe(true);
      expect(placed.has("low")).toBe(false);
    }
  });

  it("clamps every survivor inside the row bounds", () => {
    const placed = placeRowLabels(
      [
        {
          key: "a",
          x: 0,
          text: "00:05",
          fontSize: 10,
          anchor: "middle" as const,
        },
        {
          key: "b",
          x: 400,
          text: "23:55",
          fontSize: 10,
          anchor: "middle" as const,
        },
      ],
      ROW
    );
    for (const label of placed.values()) {
      expect(label.start).toBeGreaterThanOrEqual(ROW.left - 1e-9);
      expect(label.end).toBeLessThanOrEqual(ROW.right + 1e-9);
    }
  });
});

describe("textExtent", () => {
  it("places the box relative to the anchor", () => {
    expect(textExtent(100, 40, "start")).toEqual({ left: 100, right: 140 });
    expect(textExtent(100, 40, "middle")).toEqual({ left: 80, right: 120 });
    expect(textExtent(100, 40, "end")).toEqual({ left: 60, right: 100 });
  });
});

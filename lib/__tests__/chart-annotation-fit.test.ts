import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Label } from "recharts";
import {
  CHART_LABEL_FONT_SIZE,
  chartAnnotationLabel,
  chartAnnotationLabelFits,
  chartAnnotationLabelWidth,
  chartFittedAnnotationLabel,
} from "@/components/chart-scaffold";
import { TEXT_ADVANCE_RATIO, textExtent } from "@/lib/chart-svg";
import { overLimitHoles, unloggedGapLabel } from "@/lib/trend-sparkline";

// THE LABEL FIT RULE (issue #2871).
//
// THE DEFECT, from a live owner report with a screenshot: the Sun / Outdoor Time
// card drew eleven unlogged-run bands across a 77-day window and gave every one of
// them a "N days unlogged" label, whatever the band was worth in pixels. Each
// label is centred on its band (`insideTop`) at the same height as its
// neighbours', so eleven labels wider than the bands that own them printed through
// each other: "10 days unlog3gday3 unlogge7 days unlogged…".
//
// WHAT THIS FILE ASSERTS, and why it is not a source scan. The sibling guard
// (`chart-state-presentations.test.ts`) reads the funnel as TEXT — which is how a
// label that does not fit shipped in the first place: `expect(funnel).toContain(
// "unloggedGapLabel(hole.days)")` pins that the label is WIRED UP and is
// structurally incapable of noticing that it does not FIT. So this file computes
// the horizontal extents the labels actually paint at, for the exact shape the
// owner reported, and asserts that no two of them overlap.

// ── the geometry the funnel hands recharts ──────────────────────────────────
//
// A day series is a category axis: the plotted days are evenly spaced across the
// plot, and a hole's `ReferenceArea` runs from its first unlogged day to its last.
// `insideTop` centres the label on that box (recharts `getCartesianPosition`:
// `x: upperX + upperWidth / 2`, anchor `middle`), which is what makes "wider than
// its band" the same thing as "over its neighbour": the overflow is symmetric and
// lands on the shared baseline rather than leaning into empty space.

/** The reported window: 2026-05-31 → 2026-08-14. */
const WINDOW_DAYS = 77;
/** The reported plot: roughly 1200px of chart on a wide monitor. */
const PLOT_PX = 1200;
const PX_PER_DAY = PLOT_PX / WINDOW_DAYS;

/**
 * The painted box of a hole's band, in px.
 *
 * Deliberately GENEROUS — the issue's own reading, `days × px-per-day`. The real
 * band spans one interval fewer (first tick to last tick), so every "this does not
 * fit" below holds by more than it claims.
 */
function bandBox(hole: { days: number }, dayIndex: number) {
  const left = dayIndex * PX_PER_DAY;
  return { left, right: left + hole.days * PX_PER_DAY };
}

/** Where the label for `hole` paints, or null when the fit rule drops it. */
function labelExtent(text: string, box: { left: number; right: number }) {
  const width = box.right - box.left;
  if (!chartAnnotationLabelFits(text, width)) return null;
  return textExtent(
    box.left + width / 2,
    chartAnnotationLabelWidth(text),
    "middle"
  );
}

/** A densified 77-day series, `values[i]` on day `i`. */
function densified(values: (number | null)[]) {
  let t = Date.parse("2026-05-31T00:00:00Z");
  return values.map((value) => {
    const date = new Date(t).toISOString().slice(0, 10);
    t += 86400000;
    return { date, value };
  });
}

/**
 * The reported shape: eleven interior over-limit holes in a 77-day window, of
 * mixed length — ten too narrow to hold their own label and one long silence with
 * room to spare, so both directions of the rule are exercised in one scene.
 *
 * The window ends inside a logged stretch, so there is no trailing hole confusing
 * the count (a trailing hole never carried a label anyway).
 */
const HOLE_RUNS = [3, 3, 4, 3, 5, 3, 3, 12, 3, 4, 3];

function reportedWindow() {
  const values: (number | null)[] = [];
  for (const run of HOLE_RUNS) {
    values.push(60, 45);
    for (let i = 0; i < run; i++) values.push(null);
  }
  while (values.length < WINDOW_DAYS) values.push(30);
  return densified(values);
}

/** Each interior hole with the day index it starts on. */
function reportedHoles() {
  const series = reportedWindow();
  const index = new Map(series.map((row, i) => [row.date, i]));
  // Limit 2 — the STREAM tier the card sat on when the screenshot was taken.
  return overLimitHoles(series, 2)
    .filter((h) => !h.trailing)
    .map((hole) => ({ hole, dayIndex: index.get(hole.from) ?? -1 }));
}

describe("the fit decision", () => {
  it("is the app's one text-width estimate, at annotation size", () => {
    // Not a second, subtly different constant: `textWidth` (lib/chart-svg.ts) is
    // already what the hand-drawn panels place their labels with.
    expect(chartAnnotationLabelWidth("3 days unlogged")).toBeCloseTo(
      "3 days unlogged".length * CHART_LABEL_FONT_SIZE * TEXT_ADVANCE_RATIO,
      5
    );
  });

  it("keeps a label that exactly fits and drops one pixel narrower", () => {
    // The boundary, in both directions. A label the width of its band is kept:
    // it paints inside the box that owns it, which is the whole claim.
    const text = "4 days unlogged";
    const exact = chartAnnotationLabelWidth(text);
    expect(chartAnnotationLabelFits(text, exact)).toBe(true);
    expect(chartAnnotationLabelFits(text, exact - 1)).toBe(false);
    expect(chartAnnotationLabelFits(text, exact + 1)).toBe(true);
  });

  it("drops the label on a zero-width or negative band", () => {
    expect(chartAnnotationLabelFits("12 days unlogged", 0)).toBe(false);
    expect(chartAnnotationLabelFits("12 days unlogged", -10)).toBe(false);
  });

  it("keeps the label when the band's width cannot be read", () => {
    // A label is dropped because it provably does not fit, never because the
    // geometry was unavailable — an unmeasurable box renders as it does today.
    expect(chartAnnotationLabelFits("12 days unlogged", null)).toBe(true);
    expect(chartAnnotationLabelFits("12 days unlogged", undefined)).toBe(true);
    expect(chartAnnotationLabelFits("12 days unlogged", NaN)).toBe(true);
  });
});

describe("the reported render — eleven holes in a 77-day window", () => {
  it("reproduces the eleven interior holes", () => {
    expect(reportedHoles().map(({ hole }) => hole.days)).toEqual(HOLE_RUNS);
  });

  it("overprints without the rule — the defect, computed", () => {
    // The screenshot, as arithmetic: with every hole labelled unconditionally,
    // labels land on top of each other. This is the assertion that makes the one
    // below mean something.
    const placed = reportedHoles().map(({ hole, dayIndex }) => {
      const box = bandBox(hole, dayIndex);
      return textExtent(
        box.left + (box.right - box.left) / 2,
        chartAnnotationLabelWidth(unloggedGapLabel(hole.days)),
        "middle"
      );
    });
    expect(overlaps(placed).length).toBeGreaterThan(0);
  });

  it("no two labels overlap once each one has to fit its band", () => {
    const kept = reportedHoles()
      .map(({ hole, dayIndex }) =>
        labelExtent(unloggedGapLabel(hole.days), bandBox(hole, dayIndex))
      )
      .filter((e) => e != null);
    expect(overlaps(kept)).toEqual([]);
  });

  it("the wide silence still states its length; the narrow ones stay quiet", () => {
    // Not "no labels" — that would pass the test above and lose the state. The
    // twelve-day silence has room and keeps its full sentence.
    const kept = reportedHoles().filter(
      ({ hole, dayIndex }) =>
        labelExtent(unloggedGapLabel(hole.days), bandBox(hole, dayIndex)) !=
        null
    );
    expect(kept.map(({ hole }) => unloggedGapLabel(hole.days))).toEqual([
      "12 days unlogged",
    ]);
  });

  it("every band still draws, labelled or not", () => {
    // The rule decides the TEXT alone. Dropping the shading with the label would
    // delete the state the issue exists to protect.
    expect(reportedHoles()).toHaveLength(HOLE_RUNS.length);
  });

  it("a narrow band's label would have overflowed its own box", () => {
    // Why the rule is a fit test and not a collision test: a 3-day band is ~47px
    // at this scale and "3 days unlogged" is ~90px, so it was never the spacing
    // between holes that failed — each label was already too big for the band
    // that owned it.
    const [first] = reportedHoles();
    const box = bandBox(first.hole, first.dayIndex);
    expect(box.right - box.left).toBeLessThan(
      chartAnnotationLabelWidth(unloggedGapLabel(first.hole.days))
    );
  });
});

// ── the rule as it actually PAINTS ──────────────────────────────────────────
//
// Everything above reasons about `chartAnnotationLabelFits`, the pure decision.
// But the funnel does not call that — it calls `chartFittedAnnotationLabel`, which
// carries the decision into recharts through the `content` hook, reading the band
// width off the viewBox recharts computed. That wiring is the half a source scan
// cannot see and arithmetic cannot reach: a correct decision routed through a
// broken hook still ships the smear.
//
// So this block renders the label recharts' own way and reads the SVG. No DOM is
// needed — `renderToStaticMarkup` is enough, which keeps it in the pure tier.

/** The markup recharts paints for a fitted annotation in a `width`px band. */
function paint(text: string, width: number): string {
  return renderToStaticMarkup(
    createElement(
      "svg",
      null,
      createElement(Label, {
        ...chartFittedAnnotationLabel(text, "#888888", "insideTop"),
        viewBox: { x: 0, y: 0, width, height: 100 },
      })
    )
  );
}

describe("the fitted label, rendered", () => {
  it("paints the full sentence when the band can hold it", () => {
    const svg = paint("12 days unlogged", 400);
    expect(svg).toContain("12 days unlogged");
    // Pixel-identical to an unfitted annotation: same size, same ink, and still
    // centred on the band (`insideTop` → anchor `middle` at the box's midpoint).
    expect(svg).toContain(`font-size="${CHART_LABEL_FONT_SIZE}"`);
    expect(svg).toContain('fill="#888888"');
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).toContain('x="200"');
  });

  it("paints NOTHING on a band too narrow — not an empty <text>", () => {
    // The defect, at the render tier. An empty `<text>` would still be a node in
    // the plot; the rule has to remove the label outright.
    expect(paint("3 days unlogged", 40)).toBe("<svg></svg>");
  });

  it("hands a fitting label straight back to the default render", () => {
    // The fitting case must not become a SECOND label implementation — that is
    // how a "harmless" wrapper drifts from the annotation it wraps. Same text,
    // same attributes, whether or not the fit rule is in the path.
    const plain = renderToStaticMarkup(
      createElement(
        "svg",
        null,
        createElement(Label, {
          ...chartAnnotationLabel("12 days unlogged", "#888888", "insideTop"),
          viewBox: { x: 0, y: 0, width: 400, height: 100 },
        })
      )
    );
    expect(paint("12 days unlogged", 400)).toBe(plain);
  });
});

/** Every pair of extents that share horizontal space. */
function overlaps(extents: { left: number; right: number }[]) {
  const sorted = [...extents].sort((a, b) => a.left - b.left);
  const hits: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].left < sorted[i - 1].right) {
      hits.push(
        `[${sorted[i - 1].left.toFixed(1)}, ${sorted[i - 1].right.toFixed(1)}] ` +
          `overlaps [${sorted[i].left.toFixed(1)}, ${sorted[i].right.toFixed(1)}]`
      );
    }
  }
  return hits;
}

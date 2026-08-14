import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// THE CHART STATES LIVE IN THE FUNNEL (issue #2653).
//
// The issue's whole point is that six degenerate renders are ONE defect — a data
// shape the scaffolding has no designed presentation for — and that the fix is
// therefore one pass through the shared chart, not six patches at six call sites.
// #2671 proved the failure mode: it taught the trend-metric CARD to degrade a
// one-reading series to a marker, and the sleep, nutrition and longevity charts
// went on drawing a 30-day band with one clipped dot, because the decision had
// been made above the chart instead of inside it.
//
// So this file guards WHERE the decisions live, which is the property no runtime
// assertion on one page can see. It is a source scan for the same reason
// `chart-scaffold-scan` is: the claim is about every speaker at once.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const FUNNEL = "components/LineChartCardInner.tsx";
const funnel = fs.readFileSync(path.join(REPO, FUNNEL), "utf8");

describe("state 1 — one reading is a marker, not a plot", () => {
  it("the funnel itself degrades, so every consumer inherits it", () => {
    expect(
      /\bloneReading\(/.test(funnel),
      `${FUNNEL} must ask lib/trend-sparkline's loneReading — the shared predicate`
    ).toBe(true);
    expect(/<SingleReadingMark\b/.test(funnel)).toBe(true);
  });

  it("the marker returns BEFORE the plot is built, so no band is drawn behind it", () => {
    const mark = funnel.indexOf("<SingleReadingMark");
    const plot = funnel.indexOf("<ComposedChart");
    expect(mark).toBeGreaterThan(-1);
    expect(plot).toBeGreaterThan(-1);
    expect(
      mark,
      "the one-reading branch must return its own mark, not overlay a marker on " +
        "an empty 30-day band — that band is the render the issue calls a failure"
    ).toBeLessThan(plot);
  });

  it("the caption names the reading and its day, and claims nothing else", () => {
    // "Single reading · Jul 13" — a count and a date. Not "trend unavailable",
    // not a policy sentence. The words are pinned because the failure being
    // guarded is a caption that grows into an explanation.
    expect(funnel).toContain("Single reading ·");
    expect(/formatMonthDay\(lone\.date/.test(funnel)).toBe(true);
  });

  it("only a dated day-grain series may take it", () => {
    // A per-event or intraday x is not a calendar day, so "one reading on Jul 13"
    // is not a sentence about it. Same gate as every other honesty state here.
    const branch = funnel.slice(
      funnel.indexOf("const lone ="),
      funnel.indexOf("<SingleReadingMark")
    );
    expect(branch).toContain("isoDates");
    expect(branch).toContain('key === "value"');
  });
});

describe("states 2 and 4 — the quiet span is visibly quiet, and names itself", () => {
  it("the live outage is drawn AND captioned, not one or the other", () => {
    // The two halves are separable and both were missing: day-fill already kept
    // the trailing hole, so the line stopped short of the axis edge — mutely.
    expect(funnel).toContain("trailingHole");
    expect(/trailingOutageCaption\(/.test(funnel)).toBe(true);
    expect(/data-testid="chart-trailing-outage-note"/.test(funnel)).toBe(true);
  });

  it("the caption links to where the diagnosis lives, at the chart", () => {
    // Owner ruling 2026-08-13: the label renders at the chart, with the link, and
    // routes to Data → Review rather than re-homing #2146's verdict onto the card.
    expect(funnel).toContain('dataSectionHref("review")');
    expect(funnel).toContain("Data → Review");
  });

  it("the since-date is read off the plotted series, never recomputed", () => {
    // A caption naming a different day than the drawing is the failure mode of
    // any annotation derived twice.
    expect(/const lastReadingDate\s*=/.test(funnel)).toBe(true);
    expect(
      funnel.slice(
        funnel.indexOf("const lastReadingDate"),
        funnel.indexOf("const strokeRuns")
      )
    ).toContain("series");
  });
});

describe("state 3 — an over-limit hole earns a hole", () => {
  it("the run is drawn as a band the width of the days it covers", () => {
    expect(/holes\.map\(\(hole\)/.test(funnel)).toBe(true);
    expect(funnel).toContain("unloggedGapLabel(hole.days)");
  });

  it("the band is neutral ink, never a second series", () => {
    // A shaded span in a series colour would read as data. It is the grid token,
    // which is the app's word for scaffolding.
    const band = funnel.slice(
      funnel.indexOf("key={`hole-"),
      funnel.indexOf("{snapped.map")
    );
    expect(band).toContain("fill={c.grid}");
    expect(band).toContain('stroke="none"');
  });

  it("only an opted-in series has its stroke cut", () => {
    // Owner call 2: a declared bridge policy is never silently changed. Every
    // other series' over-limit hole is named and drawn exactly as before.
    expect(/gapBreaksPastLimit\(/.test(funnel)).toBe(true);
    expect(
      funnel.slice(
        funnel.indexOf("const breaksPastLimit"),
        funnel.indexOf("const interiorHoles")
      )
    ).toContain("gapBreaksPastLimit");
  });

  it("the cut is per-run strokes, so short holes still bridge", () => {
    // recharts' connectNulls is all-or-nothing, and the declared policy is
    // neither. The runs are what express it.
    expect(/const strokeRuns/.test(funnel)).toBe(true);
    const runs = funnel.slice(funnel.indexOf("strokeRuns.length > 1 &&"));
    expect(runs.slice(0, 900)).toContain("connectNulls");
  });

  it("the runs carry stroke only — one tooltip and one set of marks survive", () => {
    const runs = funnel.slice(
      funnel.indexOf("strokeRuns.length > 1 &&"),
      funnel.indexOf('dataKey={key}')
    );
    expect(runs).toContain("dot={false}");
    expect(runs).toContain('tooltipType="none"');
  });

  it("no run invents a value to span anything", () => {
    // The runs are slices of the plotted series. An interpolated fill would draw
    // the same pixels and be a different claim, which is the whole point of the
    // issue.
    const build = funnel.slice(
      funnel.indexOf("const runData"),
      funnel.indexOf("const tickFmt")
    );
    expect(build).toContain("? row.value : null");
    expect(build).not.toMatch(/interpolat|\/\s*2\b/);
  });
});

describe("nothing here is carried by motion (#2654)", () => {
  it("no state presentation introduces an animation of its own", () => {
    // Reduced motion is the designed state. Every mark added by #2653 — the
    // bands, the labels, the captions, the runs — is static, and the runs take
    // the same shared chartMarkMotion the ordinary line does rather than a
    // duration of their own.
    const added = funnel.slice(funnel.indexOf("{holes.map"));
    expect(added).not.toMatch(/animationDuration=|transition-|animate-/);
  });
});

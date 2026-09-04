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
// The funnel is the CARD since #4925, not an Inner: the recharts tree moved to
// the shared renderer and everything that decides what a day-grain series MEANS
// — the fill, the runs, the sparse verdict, the sources, the one-reading degrade
// — stayed here. So this scan follows the decisions, which is what it was ever
// about, and not the file that used to hold them.
const FUNNEL = "components/LineChartCard.tsx";
const funnel = fs.readFileSync(path.join(REPO, FUNNEL), "utf8");
// Since #4924 the funnel decides WHAT each caption says and the card's footer
// band renders it, so the sentences and their markers are read here. The split
// is the point of that fix — the chart owns the claim, the card owns the layout —
// and a scan that kept looking for the markup in the funnel would be asserting
// the arrangement the screenshot was filed about.
const BAND = "components/ChartCaptionBand.tsx";
const band = fs.readFileSync(path.join(REPO, BAND), "utf8");
// The RENDERER, and the scaffold half that resolves a spec's named marks back
// into recharts props. #4925 moved the chart TREE out of the funnel and into a
// renderer five cards share, so the marks this file pins are read where they are
// now drawn. The DECISIONS stayed in the funnel and are still read there — which
// is the split this scan has always been about.
const SCAFFOLD = "components/chart-scaffold.tsx";
const scaffold = fs.readFileSync(path.join(REPO, SCAFFOLD), "utf8");

/**
 * The text between two anchors, THROWING when either is missing.
 *
 * `indexOf` returns -1 for an anchor that has moved, and `slice(-1, -1)` is the
 * empty string — so a window whose anchors drifted makes every `not.toContain`
 * in it pass and every `toContain` fail with a message about the wrong thing.
 * One of those halves is silent, and this file is nothing but windows.
 */
function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to);
  if (a < 0) throw new Error(`anchor not found: ${from}`);
  if (b < 0) throw new Error(`anchor not found: ${to}`);
  if (b < a) throw new Error(`anchors out of order: ${from} … ${to}`);
  return text.slice(a, b);
}

/** The one place a chart's unlogged-run band is drawn, since #4925. */
const unloggedMark = between(scaffold, 'case "unlogged":', 'case "now":');

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
    const plot = funnel.indexOf("<TimeSeriesChart");
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

  it("a caller that declared itself chart-shaped is not overruled", () => {
    // The regression this pins: moving the degrade into the funnel made it
    // outrank `singleReadingAsChart`, a per-caller declaration that predates it
    // ("sleep is a chart at every range"). Three sleep tiles rendered no chart
    // subtree at all. A shared decision must still read the declarations its
    // callers already carry.
    const gate = between(funnel, "const lone =", "<SingleReadingMark");
    expect(gate).toContain("!singleReadingAsChart");
    expect(/singleReadingAsChart\?: boolean/.test(funnel)).toBe(true);
  });

  it("only a dated day-grain series may take it", () => {
    // A per-event or intraday x is not a calendar day, so "one reading on Jul 13"
    // is not a sentence about it. Same gate as every other honesty state here.
    const branch = between(funnel, "const lone =", "<SingleReadingMark");
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
    expect(/trailingOutage:/.test(funnel)).toBe(true);
    expect(/data-testid="chart-trailing-outage-note"/.test(band)).toBe(true);
  });

  it("the caption links to where the diagnosis lives, at the chart", () => {
    // Owner ruling 2026-08-13: the label renders at the chart, with the link, and
    // routes to Data → Review rather than re-homing #2146's verdict onto the card.
    expect(band).toContain('dataSectionHref("review")');
    expect(band).toContain("Data → Review");
  });

  it("the since-date never reaches for an index that may not exist", () => {
    // `findIndex` returns -1 for a date not in the series, and `slice(0, -1)`
    // silently drops the LAST element instead of erroring — a wrong answer with
    // no symptom. The date is selected by comparison instead.
    const derive = between(funnel, "const lastReadingDate", "const strokeRuns");
    expect(derive).not.toContain("findIndex");
    expect(derive).toContain("d.date < trailingHole.from");
  });

  it("the since-date is read off the plotted series, never recomputed", () => {
    // A caption naming a different day than the drawing is the failure mode of
    // any annotation derived twice.
    expect(/const lastReadingDate\s*=/.test(funnel)).toBe(true);
    expect(
      between(funnel, "const lastReadingDate", "const strokeRuns")
    ).toContain("series");
  });
});

describe("state 3 — an over-limit hole earns a hole", () => {
  it("the run is drawn as a band the width of the days it covers", () => {
    expect(/holes\.map\(\(hole\)/.test(funnel)).toBe(true);
    expect(funnel).toContain("unloggedGapLabel(hole.days)");
  });

  it("the count is stated through the fit rule, not unconditionally (#2871)", () => {
    // The label a band cannot hold is the defect this state shipped with: eleven
    // labels wider than the bands that owned them, every one centred on the same
    // baseline, printing through each other. The DECISION lives in the scaffold
    // beside `chartAnnotationLabel`, and the geometry it produces is asserted on
    // computed extents in `chart-annotation-fit.test.ts`. What this line guards
    // is only that the funnel still goes through it.
    expect(unloggedMark).toContain("chartFittedAnnotationLabel(");
    // And the funnel still decides WHICH runs get words: the live trailing one
    // takes its sentence from the caption band instead, where the route to the
    // fix can be a real link.
    expect(funnel).toContain(
      "hole.trailing ? null : unloggedGapLabel(hole.days)"
    );
    expect(
      /[^a-zA-Z]chartAnnotationLabel\(/.test(unloggedMark),
      "an unlogged band's label must go through the fit rule — a raw " +
        "chartAnnotationLabel here is the overprinting render of #2871"
    ).toBe(false);
  });

  it("a gap day still answers 'No data' when hovered (#2871)", () => {
    // THE CHANNEL THE DROPPED LABEL LEANS ON. Omitting the count on a narrow
    // band is only honest because the run's length stays reachable: the shading
    // says a silence is here, and hovering a day inside it says so in words. If
    // `filterNull` went back to its recharts default, nulls would stop reaching
    // the formatter and a narrow hole would become genuinely mute — turning
    // #2871's fix from "stated in another channel" into "unstated". That is why
    // this sits in state 3 and not only with #2258, where the line was written.
    expect(
      funnel,
      "nulls must reach the tooltip formatter, or a hovered gap day is an " +
        "unlabelled empty box (#2258) and the fit rule of #2871 loses the " +
        "channel it drops the label in favour of"
    ).toContain("filterNull: false");
    expect(funnel).toContain(
      'return name === "band" ? null : ["No data", label];'
    );
  });

  it("an unlogged band is distinguishable from a protocol window", () => {
    // Both are recharts reference areas. Without a class of its own, a silence
    // in the data answers "is a protocol shaded here?" — which is exactly how
    // toggling protocols off came to leave ten shaded areas on the plot.
    expect(unloggedMark).toContain('className="chart-unlogged-band"');
  });

  it("the band is neutral ink, never a second series", () => {
    // A shaded span in a series colour would read as data. It is the grid token,
    // which is the app's word for scaffolding.
    expect(unloggedMark).toContain("fill={c.grid}");
    expect(unloggedMark).toContain('stroke="none"');
  });

  it("only an opted-in series has its stroke cut", () => {
    // Owner call 2: a declared bridge policy is never silently changed. Every
    // other series' over-limit hole is named and drawn exactly as before.
    expect(/gapBreaksPastLimit\(/.test(funnel)).toBe(true);
    expect(
      between(funnel, "const breaksPastLimit", "const interiorHoles")
    ).toContain("gapBreaksPastLimit");
  });

  it("the cut is per-run strokes, so short holes still bridge", () => {
    // recharts' connectNulls is all-or-nothing, and the declared policy is
    // neither. The runs are what express it.
    expect(/const strokeRuns/.test(funnel)).toBe(true);
    // Bounded by the block that FOLLOWS the runs, not by a character count: the
    // count was an arbitrary 900 and #4924 pushed `connectNulls` past it with a
    // comment. The companion-mark lines below also carry a `connectNulls`, so the
    // window still has to end before them or a neighbour could satisfy this.
    const runs = between(
      funnel,
      "THE PER-RUN STROKES",
      "THE SECOND ACCOUNT OF A DAY"
    );
    expect(runs).toContain("connectNulls: true");
  });

  it("the runs carry stroke only — one tooltip and one set of marks survive", () => {
    const runs = between(
      funnel,
      "THE PER-RUN STROKES",
      "THE SECOND ACCOUNT OF A DAY"
    );
    expect(runs).toContain('dots: { policy: "none" }');
    expect(runs).toContain("hideFromTooltip: true");
  });

  it("no run invents a value to span anything", () => {
    // The runs are slices of the plotted series. An interpolated fill would draw
    // the same pixels and be a different claim, which is the whole point of the
    // issue.
    const build = between(funnel, "const runData", "const tickFmt");
    expect(build).toContain("? row.value : null");
    expect(build).not.toMatch(/interpolat|\/\s*2\b/);
  });
});

// THE FAMILY THAT NEVER JOINED (#3497 item 1).
//
// #2615's convergence covered the tiles and the LineChartCard funnel above, and its
// whole claim is that "a tile and the surface it taps through to cannot render the
// identical situation two ways". `BiomarkerChartInner` is that surface for every lab
// analyte and it was not in the convergence: a one-reading ApoB drew a full-height
// band, empty apart from one dot, under an axis that printed the same day three
// times. Nothing could see it, because the funnel's guard above reads the funnel and
// this chart does not go through the funnel.
//
// It is a SECOND file to scan rather than a widening of the block above, because the
// property is not "the funnel decides" — it is "every full-size chart family decides
// the same way". #3235 owns the third instance (EquipmentTrend) and is deliberately
// NOT asserted here; when it lands it adds its own block.
const BIOMARKER = "components/BiomarkerChart.tsx";
const biomarker = fs.readFileSync(path.join(REPO, BIOMARKER), "utf8");

describe("the biomarker detail chart draws a mark, not a plot (#3497)", () => {
  it("it asks the SHARED predicate, not a length check of its own", () => {
    // `data.length === 1` is the tempting local spelling and it is wrong for a
    // densified series: `loneReading` counts NON-NULL points, which is the
    // distinction that makes a tile and this chart agree.
    expect(
      /\bloneReading\(/.test(biomarker),
      `${BIOMARKER} must ask lib/trend-sparkline's loneReading`
    ).toBe(true);
    expect(/<SingleReadingMark\b/.test(biomarker)).toBe(true);
    expect(
      /data\.length === 1/.test(biomarker),
      "a local one-point check would disagree with the tiles on a densified series"
    ).toBe(false);
  });

  it("the mark returns BEFORE the plot, so no band is drawn behind it", () => {
    const mark = biomarker.indexOf("<SingleReadingMark");
    const plot = biomarker.indexOf("<TimeSeriesChart");
    expect(mark).toBeGreaterThan(-1);
    expect(plot).toBeGreaterThan(-1);
    expect(
      mark,
      "the one-reading branch must return its own mark — the empty band behind a " +
        "single dot is the render docs/internals/charts.md calls a failure"
    ).toBeLessThan(plot);
  });

  it("the mark returns before the AXIS is even built", () => {
    // The duplicate day ticks ("07-09 · 07-09 · 07-09") were the same defect's
    // second symptom. A lone reading now draws no axis at all, so they cannot
    // appear on it however the tick maths changes.
    const branch = biomarker.slice(0, biomarker.indexOf("<SingleReadingMark"));
    expect(branch).not.toContain("timeAxisTicks(");
  });

  it("the caption names the reading and its day, and claims nothing else", () => {
    expect(biomarker).toContain("Single reading ·");
    // With the YEAR, unlike the funnel's formatMonthDay: a lab series is the
    // sparsest this app draws and a single reading is regularly years old. Still
    // through the display boundary (copy.md §9), never a stored string.
    expect(/formatDateWithYear\(lone\.date/.test(biomarker)).toBe(true);
    expect(biomarker).not.toContain("Trend unavailable");
  });
});

describe("nothing here is carried by motion (#2654)", () => {
  it("no state presentation introduces an animation of its own", () => {
    // Reduced motion is the designed state. Every mark added by #2653 — the
    // bands, the labels, the captions, the runs — is static, and the runs take
    // the same shared chartMarkMotion the ordinary line does rather than a
    // duration of their own.
    // Anchored through `between`, so a moved anchor throws rather than leaving a
    // `not.toMatch` to pass over an empty string.
    const added = between(funnel, "const references", "const spec:");
    expect(added).not.toMatch(/animationDuration|transition-|animate-/);
    // The marks the renderer draws for those states carry no motion either.
    expect(unloggedMark).not.toMatch(/animationDuration|transition-|animate-/);
  });
});

describe("state 6 — two sources on one day are two marks, in the funnel", () => {
  it("the funnel asks the shared decision and draws the scaffold's companion", () => {
    expect(/\bsourceSpreadCompanions\(/.test(funnel)).toBe(true);
    // The funnel NAMES the mark and the scaffold resolves the name: since #4925 a
    // card cannot hand a chart a prop bag (that would drag recharts across the
    // code-split seam), so both halves are pinned rather than the old one line.
    expect(funnel).toContain('dots: { policy: "other-source" }');
    expect(
      between(scaffold, 'case "other-source":', 'case "curve-end-label":')
    ).toContain("chartOtherSourceDot(c)");
    expect(band).toContain('data-testid="chart-source-spread-note"');
  });

  it("only a dated day-grain series plotted on value takes it — never a sparkline or an aggregated plot", () => {
    expect(
      /isoDates && key === "value" && !longRange && !sparkline\s*\?\s*sourceSpreadCompanions\(/.test(
        funnel
      )
    ).toBe(true);
  });

  it("the companion is drawn BEFORE the series' own line, so the plotted reading is never painted over", () => {
    const companion = funnel.indexOf("key: `other${column}`");
    const own = funnel.indexOf("color: strokeRuns.length > 1 ? null : color");
    expect(companion).toBeGreaterThan(-1);
    expect(companion).toBeLessThan(own);
  });

  it("the companion spends no spoken-for channel: solid, ordinary radius, the declared neutral, offset in x", () => {
    const body = scaffold.slice(
      scaffold.indexOf("export function chartOtherSourceDot")
    );
    const dot = body.slice(0, body.indexOf("\n}\n"));
    expect(dot).toContain("r={CHART_DOT_R}");
    expect(dot).toContain("fill={chartNeutral}");
    expect(dot).not.toContain("fill={c.surface}");
    expect(dot).toContain("cx={cx + CHART_PAIR_OFFSET_X}");
    expect(/export const CHART_PAIR_OFFSET_X = [1-9]\d*;/.test(scaffold)).toBe(
      true
    );
  });
});

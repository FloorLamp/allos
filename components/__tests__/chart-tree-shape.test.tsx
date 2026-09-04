import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import BarSparkline from "@/components/BarSparkline";
import BiomarkerChart from "@/components/BiomarkerChart";
import CompareChart from "@/components/CompareChart";
import GrowthChart from "@/components/GrowthChart";
import LineChartCard from "@/components/LineChartCard";
import ScatterChartCard from "@/components/ScatterChartCard";
import SourceCompareChart from "@/components/SourceCompareChart";
import StackedBarCard from "@/components/StackedBarCard";
import ZoneMinutesCard from "@/components/ZoneMinutesCard";

// THE RENDERED-TREE CONTROL (#4925).
//
// #4925 replaces nine hand-built recharts trees with two renderers driven by a
// spec, under one invariant: "no consumer's rendered output changes except where
// #4924 already changed it". That invariant needs an instrument, and the only
// honest one is a reading of the tree each card ACTUALLY draws — taken through
// the PUBLIC card, never through an Inner, so the refactor cannot reshape the
// thing measuring it. The numbers below were read off `main` before a line of the
// migration was written, and every one is a LITERAL: a count derived from the
// code under test would follow that code wherever it went.
//
// WHAT IT CAN SEE. Series strokes, filled areas, bars, marks, reference lines,
// reference areas, the unlogged-gap band, and both axes' tick text. Those are the
// channels a chart carries its facts in, so a spec that drops a series, loses a
// reference mark, moves a tick or stops drawing a gap band fails here.
//
// EVERY LITERAL BELOW IS A READING OF `main`, and that is checked rather than
// asserted: the whole file was run at the pinned base commit 81633f1ba, with all
// nine hand-built Inner cards still in the tree, and passed 13/13 there before it
// passed 13/13 over the renderers.
//
// WHAT IT CANNOT. Tooltip ROWS: recharts computes its hover state from
// `getBoundingClientRect`, which jsdom answers with zeros, so a synthesised
// mousemove leaves the tooltip empty however it is stubbed (measured, not
// assumed). Tooltip content stays proved by the e2e specs that drive a real
// hover — e2e/trends-line-card.spec.ts, e2e/trends-day-gaps.spec.ts,
// e2e/trends-annotations.spec.ts. Nor does it see PAINT: color, stroke width and
// opacity are the mark specs' business and chart-scaffold-scan's.

// recharts sizes itself against a real box. jsdom has none, so every element
// reports one: without this the ResponsiveContainer renders zero children and
// every count below would be 0 — a fingerprint that passes on any tree at all.
const BOX_W = 600;
const BOX_H = 300;

beforeAll(() => {
  for (const p of ["clientWidth", "offsetWidth"])
    Object.defineProperty(HTMLElement.prototype, p, {
      configurable: true,
      get: () => BOX_W,
    });
  for (const p of ["clientHeight", "offsetHeight"])
    Object.defineProperty(HTMLElement.prototype, p, {
      configurable: true,
      get: () => BOX_H,
    });
  global.ResizeObserver = class {
    constructor(private cb: ResizeObserverCallback) {}
    observe() {
      this.cb(
        [{ contentRect: { width: BOX_W, height: BOX_H } }] as never,
        this as never
      );
    }
    unobserve() {}
    disconnect() {}
  } as never;
});

interface Shape {
  /** Series: one entry per drawn `<Line>` / `<Area>` / `<Bar>` / `<Scatter>`. */
  lines: number;
  areas: number;
  bars: number;
  scatters: number;
  /** Per-point marks, however the card draws them — the scaffold's dot bags emit
   *  a `.recharts-dot`, a card's own render fn emits a bare `<circle>`, and both
   *  land inside the mark layer. Counting the LAYER's shapes sees both. */
  marks: number;
  refLines: number;
  refAreas: number;
  /** The unlogged-run band, which carries its own class so a protocol window and
   *  a silence in the data are never confused (LineChartCardInner). */
  gapBands: number;
  /** The document order of the drawn layers. A renderer emits its reference
   *  marks in ONE place in the tree, where nine cards each chose their own, so
   *  "the same marks in a different order" is a change this has to be able to
   *  see. */
  layers: string[];
  legend: string[];
  xTicks: string[];
  yTicks: string[];
  /** The plot box the card hands its consumer: its classes and the `data-*`
   *  attributes e2e addresses it by. The classes are SORTED — Tailwind utilities
   *  are order-independent in the cascade, so their written order is not a
   *  rendered fact and pinning it would red on a cosmetic rewrite while saying
   *  nothing about the picture. Which classes are THERE is the fact. */
  box: string;
}

function readShape(root: HTMLElement): Shape {
  const n = (sel: string) => root.querySelectorAll(sel).length;
  const t = (sel: string) =>
    [...root.querySelectorAll(sel)].map((e) => e.textContent ?? "");
  const outer = root.firstElementChild;
  return {
    lines: n(".recharts-line"),
    areas: n(".recharts-area"),
    bars: n(".recharts-bar"),
    scatters: n(".recharts-scatter"),
    marks:
      n(".recharts-line-dots circle") +
      n(".recharts-area-dots circle") +
      n(".recharts-scatter-symbol"),
    refLines: n(".recharts-reference-line"),
    refAreas: n(".recharts-reference-area"),
    gapBands: n(".chart-unlogged-band"),
    layers: [
      ...root.querySelectorAll(
        ".recharts-line, .recharts-area, .recharts-bar, .recharts-scatter, .recharts-reference-line, .recharts-reference-area"
      ),
    ].map((e) =>
      (e.getAttribute("class") ?? "").replace(/^recharts-layer /, "")
    ),
    legend: t('[data-testid="chart-legend-item"]'),
    xTicks: t(
      ".recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value"
    ),
    yTicks: t(
      ".recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value"
    ),
    box: [
      (outer?.getAttribute("class") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .sort()
        .join(" "),
      outer?.getAttribute("data-testid") ?? "",
      outer?.getAttribute("data-axis-mode") ?? "",
      outer?.getAttribute("data-axis-scale") ?? "",
    ]
      .filter(Boolean)
      .join(" | "),
  };
}

const day = (n: number) =>
  new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);

// A run of readings, a hole longer than `metric:mood`'s two-day limit, and a run
// after it: the shape that makes LineChartCard cut its stroke into runs, draw an
// unlogged band, and leave the readings either side of the cut their marks.
const MOOD_WINDOW = { from: day(0), to: day(11) };
const MOOD_POINTS = [
  { date: day(0), value: 3 },
  { date: day(1), value: 4 },
  { date: day(2), value: 3 },
  // days 3-8 unlogged: six days, past STREAM_GAP_LIMIT
  { date: day(9), value: 5 },
  { date: day(10), value: 4 },
  { date: day(11), value: 5 },
];

const CASES: ReadonlyArray<{
  name: string;
  plot: ReactElement;
  shape: Shape;
}> = [
  {
    name: "line plain",
    plot: (
      <LineChartCard
        label="Weight"
        unit=" kg"
        data={[
          { date: day(0), value: 80 },
          { date: day(1), value: 81 },
          { date: day(2), value: 79 },
        ]}
      />
    ),
    shape: {
      lines: 1,
      areas: 0,
      bars: 0,
      scatters: 0,
      marks: 3,
      refLines: 0,
      refAreas: 0,
      gapBands: 0,
      layers: ["recharts-line"],
      legend: [],
      xTicks: ["01-01", "01-02", "01-03"],
      yTicks: ["79", "79.5", "80", "80.5", "81", "81.5"],
      box: "h-64 max-w-full min-w-0",
    },
  },
  {
    name: "line with gap band, annotations, window and reference marks",
    plot: (
      <LineChartCard
        label="Mood"
        data={MOOD_POINTS}
        gapFill={{ seriesKey: "metric:mood", ...MOOD_WINDOW }}
        annotations={[
          { kind: "medication", date: day(1), label: "Started" },
          { kind: "appointment", date: day(10), label: "Review" },
        ]}
        windows={[
          { kind: "protocol", start: day(1), end: day(2), label: "Protocol" },
        ]}
        referenceValue={{ value: 4, label: "Target" }}
        referenceBand={{ low: 3, high: 5, label: "Usual" }}
        highlightDate={{ date: day(11), label: "Now" }}
        yDomain={[1, 5]}
      />
    ),
    shape: {
      lines: 3,
      areas: 0,
      bars: 0,
      scatters: 0,
      marks: 6,
      refLines: 4,
      refAreas: 3,
      gapBands: 1,
      layers: [
        "recharts-reference-area",
        "recharts-reference-area",
        "recharts-reference-area chart-unlogged-band",
        "recharts-reference-line",
        "recharts-reference-line",
        "recharts-reference-line",
        "recharts-reference-line",
        "recharts-line",
        "recharts-line",
        "recharts-line",
      ],
      legend: [],
      xTicks: ["01-02", "01-04", "01-06", "01-08", "01-10", "01-12"],
      yTicks: ["1", "2", "3", "4", "5"],
      box: "h-64 max-w-full min-w-0",
    },
  },
  {
    // The LONG-RANGE plot (#1938): past 180 days a dense daily series becomes
    // calendar-bucket means with a low-high spread band, which is the only case
    // in this table that draws an `<Area>` at all — and the mark
    // e2e/trends-metric-pages.spec.ts finds by `.recharts-area`.
    name: "line aggregated to weekly buckets with a spread band",
    plot: (
      <LineChartCard
        label="Weight"
        unit=" kg"
        data={Array.from({ length: 200 }, (_, i) => ({
          date: day(i),
          value: 80 + (i % 5),
        }))}
      />
    ),
    shape: {
      lines: 1,
      areas: 1,
      bars: 0,
      scatters: 0,
      marks: 30,
      refLines: 0,
      refAreas: 0,
      gapBands: 0,
      layers: ["recharts-area", "recharts-line"],
      legend: [],
      xTicks: ["01-18", "04-19", "07-19"],
      yTicks: ["80", "81", "82", "83", "84", "85"],
      box: "h-64 max-w-full min-w-0",
    },
  },
  {
    name: "line sparkline",
    plot: (
      <LineChartCard
        label="Steps"
        sparkline
        heightClass="h-20"
        data={[
          { date: day(0), value: 5000 },
          { date: day(1), value: 6000 },
          { date: day(2), value: 4000 },
        ]}
      />
    ),
    shape: {
      lines: 1,
      areas: 0,
      bars: 0,
      scatters: 0,
      marks: 0,
      refLines: 0,
      refAreas: 0,
      gapBands: 0,
      layers: ["recharts-line"],
      legend: [],
      xTicks: [],
      yTicks: [],
      box: "h-20 max-w-full min-w-0",
    },
  },
  {
    name: "biomarker with both bands, a bound reading and a window",
    plot: (
      <BiomarkerChart
        unit="mg/dL"
        data={[
          { date: day(0), value: 100 },
          { date: day(30), value: 120, bound: "<" },
          { date: day(70), value: 95 },
        ]}
        bands={{ refLow: 70, refHigh: 130, optimalLow: 80, optimalHigh: 110 }}
        annotations={[{ kind: "medication", date: day(30), label: "Statin" }]}
        windows={[
          { kind: "protocol", start: day(0), end: day(30), label: "Protocol" },
        ]}
      />
    ),
    shape: {
      lines: 1,
      areas: 0,
      bars: 0,
      scatters: 0,
      marks: 3,
      refLines: 1,
      refAreas: 3,
      gapBands: 0,
      layers: [
        "recharts-reference-area",
        "recharts-reference-area",
        "recharts-reference-area",
        "recharts-reference-line",
        "recharts-line",
      ],
      legend: [],
      xTicks: ["01-01", "01-15", "01-29", "02-12", "02-26", "03-12"],
      yTicks: ["65", "85", "105", "125", "135"],
      box: "h-64 w-full",
    },
  },
  {
    name: "compare dual axis",
    plot: (
      <CompareChart
        labelA="LDL"
        labelB="Weight"
        colorA="#111111"
        colorB="#222222"
        unitA=" mg/dL"
        unitB=" kg"
        normalized={false}
        data={[
          { date: day(0), a: 100, b: 80 },
          { date: day(1), a: 110, b: 81 },
          { date: day(2), a: 105, b: 79 },
        ]}
        annotations={[{ kind: "medication", date: day(1), label: "Statin" }]}
        windows={[
          { kind: "protocol", start: day(0), end: day(1), label: "Protocol" },
        ]}
      />
    ),
    shape: {
      lines: 2,
      areas: 0,
      bars: 0,
      scatters: 0,
      marks: 6,
      refLines: 1,
      refAreas: 1,
      gapBands: 0,
      layers: [
        "recharts-reference-area",
        "recharts-reference-line",
        "recharts-line",
        "recharts-line",
      ],
      legend: ["LDL", "Weight"],
      xTicks: ["01-01", "01-02", "01-03"],
      yTicks: [
        "100",
        "102",
        "104",
        "106",
        "108",
        "110",
        "79",
        "79.5",
        "80",
        "80.5",
        "81",
        "81.5",
      ],
      box: "flex flex-col h-72 w-full | compare-chart | dual | time",
    },
  },
  {
    name: "compare shared axis",
    plot: (
      <CompareChart
        labelA="LDL"
        labelB="HDL"
        colorA="#111111"
        colorB="#222222"
        unitA=" mg/dL"
        unitB=" mg/dL"
        normalized={false}
        data={[
          { date: day(0), a: 100, b: 50 },
          { date: day(1), a: 110, b: 55 },
          { date: day(2), a: 105, b: 52 },
        ]}
      />
    ),
    shape: {
      lines: 2,
      areas: 0,
      bars: 0,
      scatters: 0,
      marks: 6,
      refLines: 0,
      refAreas: 0,
      gapBands: 0,
      layers: ["recharts-line", "recharts-line"],
      legend: ["LDL", "HDL"],
      xTicks: ["01-01", "01-02", "01-03"],
      yTicks: ["40", "60", "80", "100", "120", "140"],
      box: "flex flex-col h-72 w-full | compare-chart | shared | time",
    },
  },
  {
    name: "growth",
    plot: (
      <GrowthChart
        unit=" cm"
        currentAgeMonths={18}
        minMonths={0}
        maxMonths={24}
        bands={[
          {
            percentile: 3,
            points: [
              { ageMonths: 0, value: 46 },
              { ageMonths: 12, value: 71 },
              { ageMonths: 24, value: 82 },
            ],
          },
          {
            percentile: 50,
            points: [
              { ageMonths: 0, value: 50 },
              { ageMonths: 12, value: 76 },
              { ageMonths: 24, value: 87 },
            ],
          },
          {
            percentile: 97,
            points: [
              { ageMonths: 0, value: 54 },
              { ageMonths: 12, value: 81 },
              { ageMonths: 24, value: 92 },
            ],
          },
        ]}
        points={[
          {
            date: day(0),
            ageMonths: 6,
            ageMonthsExact: 6.2,
            value: 66,
            percentile: 48,
          },
          {
            date: day(180),
            ageMonths: 12,
            ageMonthsExact: 12.4,
            value: 76,
            percentile: 51,
          },
          {
            date: day(360),
            ageMonths: 18,
            ageMonthsExact: 18.1,
            value: 81,
            percentile: 49,
          },
        ]}
      />
    ),
    shape: {
      lines: 4,
      areas: 0,
      bars: 0,
      scatters: 0,
      marks: 3,
      refLines: 1,
      refAreas: 0,
      gapBands: 0,
      layers: [
        "recharts-reference-line",
        "recharts-line",
        "recharts-line",
        "recharts-line",
        "recharts-line",
      ],
      legend: [],
      xTicks: ["0m", "5m", "10m", "15m", "20m", "24m"],
      yTicks: ["40", "60", "80", "100", "120", "140"],
      box: "h-72 min-w-0",
    },
  },
  {
    name: "source compare",
    plot: (
      <SourceCompareChart
        unit=" steps"
        series={[
          {
            key: "manual",
            label: "Manual",
            color: "#111111",
            data: [
              { date: day(0), value: 5000 },
              { date: day(2), value: 7000 },
            ],
          },
          {
            key: "oura",
            label: "Oura",
            color: "#222222",
            data: [
              { date: day(0), value: 5200 },
              { date: day(1), value: 6100 },
            ],
          },
        ]}
      />
    ),
    shape: {
      lines: 2,
      areas: 0,
      bars: 0,
      scatters: 0,
      marks: 4,
      refLines: 0,
      refAreas: 0,
      gapBands: 0,
      layers: ["recharts-line", "recharts-line"],
      legend: ["Manual", "Oura"],
      xTicks: ["01-01", "01-02", "01-03"],
      yTicks: ["5000", "5500", "6000", "6500", "7000", "7500"],
      box: "flex flex-col h-64 w-full",
    },
  },
  {
    name: "stacked bars",
    plot: (
      <StackedBarCard
        unit=" g"
        series={[
          { key: "carbs", label: "Carbs", color: "#111111" },
          { key: "protein", label: "Protein", color: "#222222" },
        ]}
        data={[
          { date: day(0), carbs: 200, protein: 100 },
          { date: day(1), carbs: 180, protein: 120 },
          { date: day(3), carbs: 210, protein: 110 },
        ]}
        gapFill={{ seriesKey: "metric:macros", from: day(0), to: day(3) }}
      />
    ),
    shape: {
      lines: 0,
      areas: 0,
      bars: 2,
      scatters: 0,
      marks: 0,
      refLines: 0,
      refAreas: 0,
      gapBands: 0,
      layers: ["recharts-bar", "recharts-bar"],
      legend: [],
      xTicks: ["01-01", "01-02", "01-03", "01-04"],
      yTicks: ["0 g", "100 g", "200 g", "300 g", "400 g", "500 g"],
      box: "h-64 max-w-full min-w-0",
    },
  },
  {
    name: "zone minutes with target",
    plot: (
      <ZoneMinutesCard
        zone2Target={120}
        data={[
          { week: day(0), z1: 10, z2: 60, z3: 20, z4: 5, z5: 1 },
          { week: day(7), z1: 15, z2: 90, z3: 25, z4: 8, z5: 2 },
        ]}
      />
    ),
    shape: {
      lines: 0,
      areas: 0,
      bars: 5,
      scatters: 0,
      marks: 0,
      refLines: 1,
      refAreas: 0,
      gapBands: 0,
      layers: [
        "recharts-bar",
        "recharts-bar",
        "recharts-bar",
        "recharts-bar",
        "recharts-bar",
        "recharts-reference-line",
      ],
      legend: [],
      xTicks: ["01-01", "01-08"],
      yTicks: ["0 min", "50 min", "100 min", "150 min", "200 min", "250 min"],
      box: "h-64 w-full",
    },
  },
  {
    name: "bar sparkline",
    plot: (
      <BarSparkline
        label="Volume"
        unit=" kg"
        data={[
          { date: day(0), value: 1000 },
          { date: day(1), value: 0 },
          { date: day(2), value: 1500 },
        ]}
      />
    ),
    shape: {
      lines: 0,
      areas: 0,
      bars: 1,
      scatters: 0,
      marks: 0,
      refLines: 0,
      refAreas: 0,
      gapBands: 0,
      layers: ["recharts-bar"],
      legend: [],
      xTicks: [],
      yTicks: [],
      box: "h-20 max-w-full min-w-0",
    },
  },
  {
    name: "scatter",
    plot: (
      <ScatterChartCard
        xLabel="Sleep"
        yLabel="Mood"
        data={[
          { x: 7, y: 4 },
          { x: 8, y: 5 },
          { x: 6, y: 3 },
        ]}
      />
    ),
    shape: {
      lines: 0,
      areas: 0,
      bars: 0,
      scatters: 1,
      marks: 3,
      refLines: 0,
      refAreas: 0,
      gapBands: 0,
      layers: ["recharts-scatter"],
      legend: [],
      xTicks: ["6", "6.5", "7", "7.5", "8", "8.5"],
      yTicks: ["3", "3.5", "4", "4.5", "5", "5.5"],
      box: "h-64 max-w-full min-w-0 | scatter-chart",
    },
  },
];

describe("chart tree shape", () => {
  // Bounds the LAZY IMPORT behind each public card's `next/dynamic` boundary, not
  // a render — the same cost components/__tests__/chart-empty-states.test.tsx
  // measures and documents (2.2s cold, 5.7-7.8s cold under load). Nothing is
  // asserted under it.
  const CHART_CHUNK_MS = 20_000;

  it.each(CASES)("$name", async ({ plot, shape }) => {
    const { container } = render(<div data-testid="host">{plot}</div>);
    await waitFor(
      () => expect(container.querySelector(".recharts-wrapper")).not.toBeNull(),
      { timeout: CHART_CHUNK_MS }
    );
    expect(readShape(screen.getByTestId("host"))).toEqual(shape);
  });
});

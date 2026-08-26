import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import BarSparkline from "@/components/BarSparkline";
import BiomarkerChart from "@/components/BiomarkerChart";
import ChartCard from "@/components/ChartCard";
import CompareChart from "@/components/CompareChart";
import LineChartCard from "@/components/LineChartCard";
import ScatterChartCard from "@/components/ScatterChartCard";
import SourceCompareChart from "@/components/SourceCompareChart";
import StackedBarCard from "@/components/StackedBarCard";
import ZoneMinutesCard from "@/components/ZoneMinutesCard";

const EMPTY_CHARTS: ReadonlyArray<{
  name: string;
  message: string;
  plot: ReactElement;
}> = [
  {
    name: "bar sparkline",
    message: "No data yet",
    plot: <BarSparkline data={[]} label="Volume" />,
  },
  {
    name: "biomarker",
    message: "No numeric readings to chart yet",
    plot: <BiomarkerChart data={[]} bands={{}} />,
  },
  {
    name: "compare",
    message: "No overlapping data in this range",
    plot: (
      <CompareChart
        data={[]}
        labelA="A"
        labelB="B"
        colorA="#000"
        colorB="#fff"
        unitA=""
        unitB=""
        normalized={false}
      />
    ),
  },
  {
    name: "line",
    message: "No data yet",
    plot: <LineChartCard data={[]} label="Reading" />,
  },
  {
    name: "scatter",
    message: "No paired data yet",
    plot: <ScatterChartCard data={[]} xLabel="X" yLabel="Y" />,
  },
  {
    name: "source comparison",
    message: "No data yet",
    plot: <SourceCompareChart series={[]} />,
  },
  {
    name: "stacked bars",
    message: "No data yet",
    plot: <StackedBarCard data={[]} series={[]} />,
  },
  {
    name: "zone minutes",
    message: "No zone minutes yet",
    plot: <ZoneMinutesCard data={[]} />,
  },
];

function stubMatchMedia(): void {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) satisfies MediaQueryList;
}

// Bounds the LAZY IMPORT below, not a render, and it is deliberately generous
// because of where it sits: it is spent in a hook, so vitest's hook budget (2x the
// per-test ceiling, so 30 000 ms in CI) is what it has to fit inside, and no
// assertion runs under it. Measured mounting a chart through its public wrapper on
// the dispatch box: 2 157 ms cold / 56 ms warm on an idle tree, 5 682-7 793 ms cold
// / 121-466 ms warm with four extra CPU burners running.
const CHART_CHUNK_WARMUP_MS = 20_000;

describe("chart empty states", () => {
  // Every chart here is reached through its PUBLIC wrapper, which is a
  // `next/dynamic` boundary — so mounting one waits on a lazy import of the chart
  // module graph, not only on a render. The FIRST chart to mount in this file pays
  // that graph; the rest are served from the module cache (the warm numbers above).
  // testing-library's findBy* ceiling is a 1 000 ms default, under the cold cost and
  // far under it when the box is loaded, so whichever case was listed first failed
  // while the other seven passed — a footprint failure in `bar sparkline` that was
  // really the bundler, and it survived a 15x `--testTimeout` because that knob does
  // not reach findBy's own ceiling.
  //
  // Pay the import once, here, and each case below then measures the render it
  // names at the strict default. Warming through the same table keeps this honest:
  // no second list to drift, and nothing reaches past the wrapper.
  beforeAll(async () => {
    stubMatchMedia();
    for (const { message, plot } of EMPTY_CHARTS) {
      render(
        <ChartCard title="Warm up" detailHref="/">
          {plot}
        </ChartCard>
      );
      await screen.findByText(message, undefined, {
        timeout: CHART_CHUNK_WARMUP_MS,
      });
      // `afterEach` in the tier setup cannot reach a `beforeAll` render.
      cleanup();
    }
  });

  beforeEach(stubMatchMedia);

  it.each(EMPTY_CHARTS)(
    "$name keeps its reason and directly releases the chart footprint",
    async ({ message, plot }) => {
      render(
        <ChartCard title="Test chart" detailHref="/">
          {plot}
        </ChartCard>
      );

      const plotSlot = screen.getByTestId("chart-card-plot");
      const empty = await screen.findByText(message);
      expect(empty.getAttribute("data-empty-state")).not.toBeNull();
      expect(plotSlot.firstElementChild).toBe(empty);
    }
  );
});

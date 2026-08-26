import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
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

describe("chart empty states", () => {
  beforeEach(() => {
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
  });

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

import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import BarSparklineInner from "@/components/BarSparklineInner";
import BiomarkerChartInner from "@/components/BiomarkerChartInner";
import ChartCard from "@/components/ChartCard";
import CompareChartInner from "@/components/CompareChartInner";
import LineChartCardInner from "@/components/LineChartCardInner";
import ScatterChartCardInner from "@/components/ScatterChartCardInner";
import SourceCompareChartInner from "@/components/SourceCompareChartInner";
import StackedBarCardInner from "@/components/StackedBarCardInner";
import ZoneMinutesCardInner from "@/components/ZoneMinutesCardInner";

const EMPTY_CHARTS: ReadonlyArray<{
  name: string;
  message: string;
  plot: ReactElement;
}> = [
  {
    name: "bar sparkline",
    message: "No data yet",
    plot: <BarSparklineInner data={[]} label="Volume" />,
  },
  {
    name: "biomarker",
    message: "No numeric readings to chart yet",
    plot: <BiomarkerChartInner data={[]} bands={{}} />,
  },
  {
    name: "compare",
    message: "No overlapping data in this range",
    plot: (
      <CompareChartInner
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
    plot: <LineChartCardInner data={[]} label="Reading" />,
  },
  {
    name: "scatter",
    message: "No paired data yet",
    plot: <ScatterChartCardInner data={[]} xLabel="X" yLabel="Y" />,
  },
  {
    name: "source comparison",
    message: "No data yet",
    plot: <SourceCompareChartInner series={[]} />,
  },
  {
    name: "stacked bars",
    message: "No data yet",
    plot: <StackedBarCardInner data={[]} series={[]} />,
  },
  {
    name: "zone minutes",
    message: "No zone minutes yet",
    plot: <ZoneMinutesCardInner data={[]} />,
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
    ({ message, plot }) => {
      render(
        <ChartCard title="Test chart" detailHref="/">
          {plot}
        </ChartCard>
      );

      const plotSlot = screen.getByTestId("chart-card-plot");
      const empty = screen.getByText(message);
      expect(empty.getAttribute("data-empty-state")).not.toBeNull();
      expect(plotSlot.firstElementChild).toBe(empty);
    }
  );
});

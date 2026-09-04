import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import TrendMetricCharts, {
  type TrendChartSpec,
} from "@/components/TrendMetricCharts";

// The synced daily cards render their headline through the ONE `headlineFor` path
// (#4763). Steps and Active Calories used to be hand-built nodes that passed no
// headline, so the owner's screenshot showed two empty corners beside Resting HR's
// "63 bpm" — the current value lived only in the last point's hover tooltip. Every
// case below is a spec the body census now hands this component; the assertions are
// the header's, not the plot's (the plot sits behind a lazy chart boundary).

const TODAY = "2026-09-02";

function spec(over: Partial<TrendChartSpec> & { key: string }): TrendChartSpec {
  return {
    title: over.key,
    data: [],
    unit: "",
    color: "#000",
    detailHref: "/trends",
    ...over,
  };
}

afterEach(cleanup);

describe("synced daily cards read their headline through headlineFor (#4763)", () => {
  it.each([
    {
      // The grouping is DERIVED from the key now (#4924): `steps` is a count
      // metric in the registry, so the card reads the same axis treatment the
      // four call sites used to spread in by hand — and a card that forgot to
      // got recharts' defaults silently.
      name: "steps groups today's total like its axis",
      chart: spec({
        key: "steps",
        data: [
          { date: "2026-09-01", value: 8412 },
          { date: TODAY, value: 2120 },
        ],
      }),
      headline: "2,120",
      asOf: false,
    },
    {
      name: "a stale active-calories total carries its as-of stamp (14-day floor)",
      chart: spec({
        key: "active-calories",
        unit: " kcal",
        data: [{ date: "2026-08-01", value: 1412 }],
      }),
      headline: "1,412 kcal",
      asOf: true,
    },
    {
      name: "sleep keeps one decimal and no registry stamp",
      chart: spec({
        key: "sleep",
        unit: " h",
        decimals: 1,
        singleReadingAsChart: true,
        data: [{ date: TODAY, value: 7.5 }],
      }),
      headline: "7.5 h",
      asOf: false,
    },
    {
      // BOTH DIRECTIONS, one table (#4924). A `partial` flag that is always true
      // — or never — passes a one-sided test happily, so the same metric, the
      // same window and the same last value appear twice, differing only in
      // whether the day the reading belongs to has finished.
      name: "an unfinished day says so, instead of a staleness stamp",
      chart: spec({
        key: "hr",
        unit: " bpm",
        data: [
          { date: "2026-09-01", value: 71 },
          { date: TODAY, value: 59, partial: true },
        ],
      }),
      headline: "59 bpm",
      asOf: false,
      partial: true,
    },
    {
      name: "a window that ended before today carries no partial note",
      chart: spec({
        key: "hr",
        unit: " bpm",
        data: [
          { date: "2026-08-31", value: 71 },
          { date: "2026-09-01", value: 59 },
        ],
      }),
      headline: "59 bpm",
      asOf: false,
      partial: false,
    },
    {
      name: "heart rate reads its daily average",
      chart: spec({
        key: "hr",
        unit: " bpm",
        data: [{ date: TODAY, value: 63 }],
      }),
      headline: "63 bpm",
      asOf: false,
    },
  ])("$name", ({ chart, headline, asOf, partial = false }) => {
    render(
      <TrendMetricCharts
        items={[{ id: chart.key, chart }]}
        annotations={[]}
        today={TODAY}
      />
    );
    const header = screen.getByTestId("chart-card-headline");
    expect(header.textContent?.startsWith(headline)).toBe(true);
    expect(screen.queryAllByTestId("chart-card-headline-asof")).toHaveLength(
      asOf ? 1 : 0
    );
    expect(screen.queryAllByTestId("chart-card-headline-partial")).toHaveLength(
      partial ? 1 : 0
    );
    if (partial) expect(header.textContent).toMatch(/so far today/);
  });

  it("sleep is a chart at one reading; a metric is a marker", () => {
    const night = [{ date: TODAY, value: 7.5 }];
    render(
      <TrendMetricCharts
        items={[
          {
            id: "sleep",
            chart: spec({
              key: "sleep",
              singleReadingAsChart: true,
              data: night,
            }),
          },
          { id: "hr", chart: spec({ key: "hr", data: night }) },
        ]}
        annotations={[]}
        today={TODAY}
      />
    );
    const marks = screen.getAllByTestId("chart-card-single-reading");
    expect(marks).toHaveLength(1);
    expect(
      marks[0].closest("[data-testid='body-stack-item-hr']")
    ).not.toBeNull();
  });
});

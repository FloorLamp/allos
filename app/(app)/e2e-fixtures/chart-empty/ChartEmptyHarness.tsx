"use client";

import { Suspense } from "react";
import ChartCard from "@/components/ChartCard";
import ChartErrorBoundary, {
  ChartUnavailable,
} from "@/components/ChartErrorBoundary";
import ChartLoading from "@/components/ChartLoading";
import CompareChart from "@/components/CompareChart";
import LineChartCard from "@/components/LineChartCard";
import ScatterChartCard from "@/components/ScatterChartCard";

function FailedChart() {
  if (typeof window !== "undefined") {
    throw new Error("Intentional chart fixture failure");
  }
  return <ChartLoading />;
}

function FixtureCard({
  testid,
  children,
}: {
  testid: string;
  children: React.ReactNode;
}) {
  return (
    <ChartCard title={testid} detailHref={null} testid={testid}>
      {children}
    </ChartCard>
  );
}

export default function ChartEmptyHarness() {
  return (
    <main className="space-y-4" data-testid="chart-empty-harness">
      <FixtureCard testid="ordinary-empty-card">
        <LineChartCard data={[]} label="Reading" />
      </FixtureCard>
      <FixtureCard testid="no-overlap-empty-card">
        <CompareChart
          data={[]}
          labelA="A"
          labelB="B"
          colorA="#2563eb"
          colorB="#dc2626"
          unitA=""
          unitB=""
          normalized={false}
        />
      </FixtureCard>
      <FixtureCard testid="no-paired-empty-card">
        <ScatterChartCard data={[]} xLabel="X" yLabel="Y" />
      </FixtureCard>
      <FixtureCard testid="populated-card">
        <LineChartCard
          data={[
            { date: "2026-08-24", value: 1 },
            { date: "2026-08-25", value: 2 },
          ]}
          label="Reading"
        />
      </FixtureCard>
      <FixtureCard testid="loading-card">
        <ChartErrorBoundary fallback={<ChartUnavailable />}>
          <Suspense fallback={<ChartLoading />}>
            <ChartLoading />
          </Suspense>
        </ChartErrorBoundary>
      </FixtureCard>
      <FixtureCard testid="error-card">
        <ChartErrorBoundary fallback={<ChartUnavailable />}>
          <FailedChart />
        </ChartErrorBoundary>
      </FixtureCard>
    </main>
  );
}

import LineChartCard from "@/components/LineChartCard";
import type { WeightUnit } from "@/lib/settings";
import WidgetHeader from "./WidgetHeader";

// Weight-trend card (thin wrapper around LineChartCard; markup preserved).
export default function WeightTrendWidget({
  data,
  weightUnit,
}: {
  data: { date: string; value: number }[];
  weightUnit: WeightUnit;
}) {
  return (
    <div className="card">
      <WidgetHeader
        title="Weight trend"
        href="/trends?tab=body"
        linkLabel="View all"
      />
      <LineChartCard data={data} label="Weight" unit={` ${weightUnit}`} />
    </div>
  );
}

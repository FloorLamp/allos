"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useChartColors } from "./useChartColors";
import { formatLongDate } from "@/lib/format-date";
import { ZONES, ZONE_COLORS } from "@/lib/training-zones";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// One row per week: { week: "YYYY-MM-DD", z1, z2, z3, z4, z5 } (minutes per zone).
export interface ZoneWeekDatum {
  week: string;
  z1: number;
  z2: number;
  z3: number;
  z4: number;
  z5: number;
}

const ZONE_KEYS = ["z1", "z2", "z3", "z4", "z5"] as const;

// Weekly stacked HR-zone minutes with an optional Zone 2 weekly-target reference
// line (issue #159). Colors ramp easy→hard (ZONE_COLORS). Client-only (recharts
// needs a real DOM box), code-split by the ZoneMinutesCard wrapper.
export default function ZoneMinutesCardInner({
  data,
  zone2Target,
}: {
  data: ZoneWeekDatum[];
  zone2Target?: number;
}) {
  const c = useChartColors();
  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-slate-400 dark:text-slate-500">
        No zone minutes yet
      </div>
    );
  }
  const tickFmt = ISO_DATE.test(data[0].week)
    ? (v: string) => String(v).slice(5)
    : undefined;
  const labelFmt = ISO_DATE.test(data[0].week)
    ? (v: string) => `Week of ${formatLongDate(String(v))}`
    : undefined;

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 10, right: 16, bottom: 0, left: -8 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke={c.grid} />
          <XAxis
            dataKey="week"
            tickFormatter={tickFmt}
            tick={{ fontSize: 11, fill: c.tick }}
            stroke={c.axis}
          />
          <YAxis
            tick={{ fontSize: 11, fill: c.tick }}
            stroke={c.axis}
            unit=" min"
          />
          <Tooltip
            cursor={{ fill: c.grid, fillOpacity: 0.5 }}
            formatter={(v, name) => [`${v} min`, name]}
            labelFormatter={labelFmt ? (v) => labelFmt(String(v)) : undefined}
            contentStyle={{
              fontSize: 12,
              borderRadius: 8,
              background: c.tooltipBg,
              border: `1px solid ${c.tooltipBorder}`,
              color: c.tooltipText,
            }}
            labelStyle={{ color: c.tooltipText }}
            itemStyle={{ color: c.tooltipText }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {ZONE_KEYS.map((key, i) => (
            <Bar
              key={key}
              dataKey={key}
              name={`${ZONES[i].name} · ${ZONES[i].label}`}
              stackId="zones"
              fill={ZONE_COLORS[i]}
            />
          ))}
          {zone2Target != null && zone2Target > 0 && (
            <ReferenceLine
              y={zone2Target}
              stroke={ZONE_COLORS[1]}
              strokeDasharray="4 3"
              label={{
                value: `Z2 target ${zone2Target}m`,
                position: "insideTopRight",
                fontSize: 11,
                fill: ZONE_COLORS[1],
              }}
            />
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

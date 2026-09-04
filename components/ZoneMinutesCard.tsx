"use client";

import BarSeriesChart from "./BarSeriesChart";
import type { BarSeriesSpec } from "./chart-spec";
import { formatLongDate } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { ZONES, ZONE_COLORS } from "@/lib/training-zones";
import { EmptyState } from "@/components/ui";

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
// line (issue #159). Colors ramp easy→hard (ZONE_COLORS). A spec over
// `BarSeriesChart` since #4925.
export default function ZoneMinutesCard({
  data,
  zone2Target,
}: {
  data: ZoneWeekDatum[];
  zone2Target?: number;
}) {
  const formatPrefs = useFormatPrefs();
  if (data.length === 0) {
    return <EmptyState message="No zone minutes yet" />;
  }
  const isoWeeks = ISO_DATE.test(data[0].week);
  const spec: BarSeriesSpec = {
    frame: { boxClass: "h-64 w-full", heightClass: "h-64" },
    rows: data as unknown as Record<string, unknown>[],
    // WEEKS, so a calendar-DAY tick policy has nothing to say about this axis —
    // which is why `category` exists beside `day` in the spec's union.
    x: {
      kind: "category",
      dataKey: "week",
      tickFormatter: isoWeeks ? (v) => String(v).slice(5) : undefined,
    },
    y: [{ unit: " min" }],
    legend: true,
    bars: ZONE_KEYS.map((key, i) => ({
      key,
      name: `${ZONES[i].name} · ${ZONES[i].label}`,
      color: ZONE_COLORS[i],
      stackId: "zones",
    })),
    references:
      zone2Target != null && zone2Target > 0
        ? [
            {
              mark: "target",
              y: zone2Target,
              color: ZONE_COLORS[1],
              dash: "target",
              label: `Z2 target ${zone2Target}m`,
              labelPosition: "insideTopRight",
              labelFontSize: 11,
            },
          ]
        : undefined,
    tooltip: {
      cursor: "bar",
      row: (v, name) => [`${v} min`, name],
      label: isoWeeks
        ? (v) => `Week of ${formatLongDate(v, formatPrefs)}`
        : undefined,
    },
  };
  return <BarSeriesChart spec={spec} />;
}

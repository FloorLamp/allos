"use client";

import RouteMap from "@/components/RouteMap";
import {
  formatRideElapsed,
  type RideTimedRoutePoint,
} from "@/lib/cycling-analytics";
import { useRideChartLink } from "./RideChartLink";

export default function RideRouteMap({
  polyline,
  timedRoute,
  title,
  className,
}: {
  polyline: string;
  timedRoute: RideTimedRoutePoint[];
  title: string;
  className: string;
}) {
  const { activeElapsedSec } = useRideChartLink();
  let highlightIndex: number | null = null;
  if (activeElapsedSec != null && timedRoute.length > 0) {
    let bestDistance = Infinity;
    for (let index = 0; index < timedRoute.length; index++) {
      const distance = Math.abs(
        timedRoute[index].elapsedSec - activeElapsedSec
      );
      if (distance < bestDistance) {
        highlightIndex = index;
        bestDistance = distance;
      }
    }
  }
  return (
    <RouteMap
      polyline={polyline}
      points={timedRoute.map((point) => [point.lat, point.lng])}
      highlightIndex={highlightIndex}
      highlightTitle={
        activeElapsedSec == null
          ? undefined
          : `${formatRideElapsed(activeElapsedSec)} elapsed`
      }
      width={720}
      height={260}
      title={title}
      className={className}
    />
  );
}

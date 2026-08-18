"use client";

// Shared route treatment for the canonical activity detail page. Timed route
// points are optional; cycling supplies them to link the map and trace cursor.

import RouteMap from "@/components/RouteMap";
import {
  formatSessionElapsed,
  type SessionTimedRoutePoint,
} from "@/lib/cycling-analytics";
import { useSessionChartLink } from "./SessionChartLink";

export default function SessionRouteMap({
  polyline,
  timedRoute,
  title,
  className,
}: {
  polyline: string;
  timedRoute: SessionTimedRoutePoint[];
  title: string;
  className: string;
}) {
  const { activeElapsedSec } = useSessionChartLink();
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
          : `${formatSessionElapsed(activeElapsedSec)} elapsed`
      }
      width={720}
      height={260}
      title={title}
      className={className}
    />
  );
}

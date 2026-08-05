"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  nearestRideElapsedIndex,
  rideElapsedSeconds,
} from "@/lib/ride-chart-link";

interface RideChartLinkValue {
  activeElapsedSec: number | null;
  setActiveLabel: (label: string | null) => void;
}

const RideChartLinkContext = createContext<RideChartLinkValue | null>(null);

// Recharts' value sync requires exact categories. Telemetry can be sampled every
// few seconds while wearable HR is one point per minute, so select the nearest
// elapsed category instead of pretending their array indexes represent one time.
export function rideChartSyncMethod(
  ticks: ReadonlyArray<{ value?: string | number }>,
  data: { activeLabel?: string | number }
): number {
  return nearestRideElapsedIndex(
    ticks.map((tick) => tick.value),
    data.activeLabel
  );
}

export function RideChartLinkProvider({ children }: { children: ReactNode }) {
  const [activeElapsedSec, setActiveElapsedSec] = useState<number | null>(null);
  const setActiveLabel = useCallback((label: string | null) => {
    setActiveElapsedSec(label == null ? null : rideElapsedSeconds(label));
  }, []);
  const value = useMemo(
    () => ({ activeElapsedSec, setActiveLabel }),
    [activeElapsedSec, setActiveLabel]
  );
  return (
    <RideChartLinkContext.Provider value={value}>
      {children}
    </RideChartLinkContext.Provider>
  );
}

export function useRideChartLink(): RideChartLinkValue {
  const value = useContext(RideChartLinkContext);
  if (!value) {
    throw new Error(
      "useRideChartLink must be used inside RideChartLinkProvider"
    );
  }
  return value;
}

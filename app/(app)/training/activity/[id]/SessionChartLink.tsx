"use client";

// Shared chart coordination for the canonical activity detail page.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  nearestSessionElapsedIndex,
  sessionElapsedSeconds,
} from "@/lib/session-chart-link";

interface SessionChartLinkValue {
  activeElapsedSec: number | null;
  setActiveLabel: (label: string | null) => void;
}

const SessionChartLinkContext = createContext<SessionChartLinkValue | null>(
  null
);

// Recharts' value sync requires exact categories. Telemetry can be sampled every
// few seconds while wearable HR is one point per minute, so select the nearest
// elapsed category instead of pretending their array indexes represent one time.
export function sessionChartSyncMethod(
  ticks: ReadonlyArray<{ value?: string | number }>,
  data: { activeLabel?: string | number }
): number {
  return nearestSessionElapsedIndex(
    ticks.map((tick) => tick.value),
    data.activeLabel
  );
}

export function SessionChartLinkProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [activeElapsedSec, setActiveElapsedSec] = useState<number | null>(null);
  const setActiveLabel = useCallback((label: string | null) => {
    setActiveElapsedSec(label == null ? null : sessionElapsedSeconds(label));
  }, []);
  const value = useMemo(
    () => ({ activeElapsedSec, setActiveLabel }),
    [activeElapsedSec, setActiveLabel]
  );
  return (
    <SessionChartLinkContext.Provider value={value}>
      {children}
    </SessionChartLinkContext.Provider>
  );
}

// Linking is a COORDINATION between sibling charts, so a chart with no siblings
// needs none: hosts that render one of these charts alone (the canonical
// activity page's heart-rate block, #2870) get an inert link rather than a
// crash. Throwing here took down the whole page through the error boundary —
// and it did it exactly where the feature was supposed to pay off, on every
// non-cycling activity that HAS heart-rate minutes to draw.
const UNLINKED: SessionChartLinkValue = {
  activeElapsedSec: null,
  setActiveLabel: () => {},
};

export function useSessionChartLink(): SessionChartLinkValue {
  return useContext(SessionChartLinkContext) ?? UNLINKED;
}

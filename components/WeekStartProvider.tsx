"use client";

import { createContext, useContext } from "react";

// Distributes the active profile's configured first day of the week (0=Sun …
// 6=Sat, profile_settings key 'week_start') to client components so calendars and
// weekly views break the week where the profile expects. The server reads
// getWeekStart() once in the root layout and feeds it in here. Mirrors
// TimezoneProvider. Defaults to Sunday.
const WeekStartContext = createContext<number>(0);

export function WeekStartProvider({
  weekStart,
  children,
}: {
  weekStart: number;
  children: React.ReactNode;
}) {
  return (
    <WeekStartContext.Provider value={weekStart}>
      {children}
    </WeekStartContext.Provider>
  );
}

export function useWeekStart(): number {
  return useContext(WeekStartContext);
}

"use client";

import { createContext, useContext } from "react";

// Distributes the server-resolved app timezone (settings key 'timezone') to client
// components so their date defaults (e.g. a form's "today", the journal calendar's
// circled day) match the app's notion of "today" rather than the browser's TZ. The
// server reads getTimezone() once in the root layout and feeds it in here.
const TimezoneContext = createContext<string>("UTC");

export function TimezoneProvider({
  tz,
  children,
}: {
  tz: string;
  children: React.ReactNode;
}) {
  return (
    <TimezoneContext.Provider value={tz}>{children}</TimezoneContext.Provider>
  );
}

export function useTimezone(): string {
  return useContext(TimezoneContext);
}

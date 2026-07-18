"use client";

import { createContext, useContext } from "react";
import {
  DEFAULT_FORMAT_PREFS,
  type DisplayFormatPrefs,
} from "@/lib/format-date";

// Distributes the signed-in login's date/time display preferences (login_settings
// keys 'time_format' / 'date_format', #964) to client components so their date/time
// renders follow the login's chosen clock (12h/24h) and date shape (mdy/dmy/iso)
// rather than a hardcoded convention. The server reads getDisplayFormatPrefs() once
// in the root layout and feeds it in here. Mirrors TimezoneProvider / WeekStartProvider.
// Defaults to the status quo (24h; "Mon D, YYYY") so nothing shifts until a login opts in.
const FormatPrefsContext =
  createContext<DisplayFormatPrefs>(DEFAULT_FORMAT_PREFS);

export function FormatPrefsProvider({
  prefs,
  children,
}: {
  prefs: DisplayFormatPrefs;
  children: React.ReactNode;
}) {
  return (
    <FormatPrefsContext.Provider value={prefs}>
      {children}
    </FormatPrefsContext.Provider>
  );
}

export function useFormatPrefs(): DisplayFormatPrefs {
  return useContext(FormatPrefsContext);
}

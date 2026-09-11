"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  DayContextBoundary,
  ProfileDaysBoundary,
  urlDayContextValue,
  useLiveProfileClocks,
} from "@/components/DayContext";
import { dateStrInTz, shiftDateStr, zonedWallTimeToUtc } from "@/lib/date";
import { clampHistoryDay } from "@/lib/history-format";
import {
  historyDayHref,
  nutritionDayHref,
  parseNutritionTab,
} from "@/lib/hrefs";
import type { AppRoute } from "@/lib/hrefs";
import { isPastWriteAccepted } from "@/lib/log-manifest";

/**
 * The shell's live profile clocks — every mount's "what day is it now", the
 * dock, sidebar, palette and shortcut handler included.
 *
 * THE ROUTE'S DAY IS NOT PUBLISHED HERE (#5769). This boundary used to carry the
 * URL-backed `DayContextBoundary` too, which put a dated page's day above the
 * GLOBAL quick-log mounts standing beside `<main>`: the sidebar's `+ Log` panel
 * and the dock sheet, the command palette, the keyboard shortcuts. Owner ruling
 * 2026-09-10: "the mount is global, therefore the context shouldn't change based
 * on page" — a chip reading today's due doses must not open yesterday's list. The
 * route day now mounts at the PAGE (`RouteDayBoundary`, around `{children}`), so
 * those hosts see no day context and take the sheet's own state-backed one, while
 * page-own openers under `{children}` keep inheriting the day they stand on.
 */
export default function RouteDayContext({
  profileId,
  timeZone,
  profileTimeZones = [],
  children,
}: {
  profileId: number;
  timeZone: string;
  profileTimeZones?: readonly {
    profileId: number;
    timeZone: string;
  }[];
  children: ReactNode;
}) {
  const [dayRevision, setDayRevision] = useState(0);
  const clockProfiles = useMemo(() => {
    const byProfile = new Map<number, string>([[profileId, timeZone]]);
    for (const entry of profileTimeZones) {
      byProfile.set(entry.profileId, entry.timeZone);
    }
    return [...byProfile].map(([id, tz]) => ({ profileId: id, timeZone: tz }));
  }, [profileId, timeZone, profileTimeZones]);
  const liveClocks = useMemo(
    () =>
      new Map(
        clockProfiles.map((entry) => [
          entry.profileId,
          {
            today: dateStrInTz(entry.timeZone),
            timeZone: entry.timeZone,
          },
        ])
      ),
    [clockProfiles, dayRevision]
  );

  // App layouts persist across client navigation. Wake this one day owner at the
  // profile's next local midnight rather than treating the server layout's day as a
  // live clock. Route navigation also renders against the current clock immediately.
  useEffect(() => {
    const now = Date.now();
    const delay = Math.min(
      ...clockProfiles.map((entry) => {
        const profileToday = liveClocks.get(entry.profileId)!.today;
        const tomorrow = shiftDateStr(profileToday, 1);
        const boundary = zonedWallTimeToUtc(entry.timeZone, tomorrow, "00:00");
        return boundary && dateStrInTz(entry.timeZone, boundary) === tomorrow
          ? Math.max(1, boundary.getTime() - now + 25)
          : 60_000;
      })
    );
    const timer = window.setTimeout(
      () => setDayRevision((revision) => revision + 1),
      delay
    );
    return () => window.clearTimeout(timer);
  }, [clockProfiles, liveClocks, dayRevision]);

  return (
    <ProfileDaysBoundary clocks={liveClocks}>{children}</ProfileDaysBoundary>
  );
}

/**
 * The day a DATED ROUTE stands on, published to that page's own subtree only.
 *
 * Mounted around the page's `{children}` rather than the shell (#5769), so the
 * openers that inherit it are the ones the route owns — the record's add row and
 * forms, Nutrition Day's forms, the Trends measurements panel, the protocol log
 * button. Reads the live clock from `RouteDayContext` above it, so a midnight
 * rollover moves this day with everything else.
 */
export function RouteDayBoundary({
  profileId,
  timeZone,
  children,
}: {
  profileId: number;
  timeZone: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const liveClocks = useLiveProfileClocks();
  const today = liveClocks.get(profileId)?.today ?? dateStrInTz(timeZone);

  let day: string | undefined;
  let hrefForDay: ((date: string) => AppRoute) | null = null;
  if (pathname === "/history") {
    day = clampHistoryDay(params.get("day") ?? undefined, today);
    hrefForDay = historyDayHref;
  } else if (
    pathname === "/nutrition" &&
    parseNutritionTab(params.get("tab") ?? undefined) === "food"
  ) {
    const requested = params.get("date");
    day =
      requested && isPastWriteAccepted(today, requested) ? requested : today;
    hrefForDay = nutritionDayHref;
  }

  return (
    <DayContextBoundary
      value={
        day && hrefForDay
          ? urlDayContextValue({
              profileId,
              today,
              reach: { kind: "dated" },
              day,
              hrefForDay,
            })
          : null
      }
    >
      {children}
    </DayContextBoundary>
  );
}

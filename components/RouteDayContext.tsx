"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  DayContextBoundary,
  ProfileDaysBoundary,
  urlDayContextValue,
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
  const pathname = usePathname();
  const params = useSearchParams();
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
  const today = liveClocks.get(profileId)?.today ?? dateStrInTz(timeZone);

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
    <ProfileDaysBoundary clocks={liveClocks}>
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
    </ProfileDaysBoundary>
  );
}

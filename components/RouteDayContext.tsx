"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { DayContextProvider } from "@/components/DayContext";
import { dateStrInTz, shiftDateStr, zonedWallTimeToUtc } from "@/lib/date";
import { clampHistoryDay } from "@/lib/history-format";
import { historyDayHref, nutritionDayHref } from "@/lib/hrefs";
import type { AppRoute } from "@/lib/hrefs";
import { isPastWriteAccepted } from "@/lib/log-manifest";

export default function RouteDayContext({
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
  const [, setDayRevision] = useState(0);
  const today = dateStrInTz(timeZone);

  // App layouts persist across client navigation. Wake this one day owner at the
  // profile's next local midnight rather than treating the server layout's day as a
  // live clock. Route navigation also renders against the current clock immediately.
  useEffect(() => {
    const tomorrow = shiftDateStr(today, 1);
    const boundary = zonedWallTimeToUtc(timeZone, tomorrow, "00:00");
    const delay = boundary
      ? Math.max(1, boundary.getTime() - Date.now() + 25)
      : 60_000;
    const timer = window.setTimeout(
      () => setDayRevision((revision) => revision + 1),
      delay
    );
    return () => window.clearTimeout(timer);
  }, [timeZone, today]);

  let day: string | undefined;
  let hrefForDay: ((date: string) => AppRoute) | null = null;
  if (pathname === "/history") {
    day = clampHistoryDay(params.get("day") ?? undefined, today);
    hrefForDay = historyDayHref;
  } else if (
    pathname === "/nutrition" &&
    (params.get("tab") == null || params.get("tab") === "food")
  ) {
    const requested = params.get("date");
    day =
      requested && isPastWriteAccepted(today, requested) ? requested : today;
    hrefForDay = nutritionDayHref;
  }

  if (!day || !hrefForDay) return children;
  return (
    <DayContextProvider
      profileId={profileId}
      today={today}
      reach={{ kind: "dated" }}
      backing={{ kind: "url", day, hrefForDay }}
    >
      {children}
    </DayContextProvider>
  );
}

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
  dayContextKey,
  type DayContextKey,
  type DayContextParts,
} from "@/lib/day-context-key";
import { isWithinReach, type TapReach } from "@/lib/log-manifest";
import type { AppRoute } from "@/lib/hrefs";

export type DayBacking =
  | { readonly kind: "state"; readonly initialDay: string }
  | {
      readonly kind: "url";
      readonly day: string;
      readonly hrefForDay: (day: string) => AppRoute;
    };

export interface DayContextValue {
  readonly parts: DayContextParts;
  readonly key: DayContextKey;
  readonly today: string;
  readonly backing: DayBacking["kind"];
  readonly isPrimaryDay: boolean;
  readonly select: ((day: string) => void) | null;
  readonly hrefForDay: ((day: string) => AppRoute) | null;
}

const Context = createContext<DayContextValue | null>(null);

function valueFor(
  profileId: number,
  today: string,
  reach: TapReach,
  day: string,
  backing: DayBacking["kind"],
  select: DayContextValue["select"],
  hrefForDay: DayContextValue["hrefForDay"]
): DayContextValue {
  const parts = { profileId, day, reach } satisfies DayContextParts;
  return {
    parts,
    key: dayContextKey(parts),
    today,
    backing,
    isPrimaryDay: day === today,
    select,
    hrefForDay,
  };
}

function StateDayContext({
  profileId,
  today,
  reach,
  initialDay,
  children,
}: {
  profileId: number;
  today: string;
  reach: TapReach;
  initialDay: string;
  children: ReactNode;
}) {
  const [day, setDay] = useState(() =>
    isWithinReach(reach, today, initialDay) ? initialDay : today
  );
  const select = useCallback(
    (nextDay: string) => {
      if (isWithinReach(reach, today, nextDay)) setDay(nextDay);
    },
    [reach, today]
  );
  const value = useMemo(
    () => valueFor(profileId, today, reach, day, "state", select, null),
    [profileId, today, reach, day, select]
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function DayContextProvider({
  profileId,
  today,
  reach,
  backing,
  children,
}: {
  profileId: number;
  today: string;
  reach: TapReach;
  backing: DayBacking;
  children: ReactNode;
}) {
  if (backing.kind === "state") {
    return (
      <StateDayContext
        key={dayContextKey({ profileId, day: backing.initialDay, reach })}
        profileId={profileId}
        today={today}
        reach={reach}
        initialDay={backing.initialDay}
      >
        {children}
      </StateDayContext>
    );
  }
  const day = isWithinReach(reach, today, backing.day) ? backing.day : today;
  return (
    <Context.Provider
      value={valueFor(
        profileId,
        today,
        reach,
        day,
        "url",
        null,
        backing.hrefForDay
      )}
    >
      {children}
    </Context.Provider>
  );
}

export function useOptionalDayContext(): DayContextValue | null {
  return useContext(Context);
}

export function useDayContext(): DayContextValue {
  const value = useOptionalDayContext();
  if (!value)
    throw new Error("useDayContext must be used within DayContextProvider");
  return value;
}

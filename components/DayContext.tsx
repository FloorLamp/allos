"use client";

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
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
export interface LiveProfileClock {
  readonly today: string;
  readonly timeZone: string;
}

const ProfileClocksContext = createContext<ReadonlyMap<
  number,
  LiveProfileClock
> | null>(null);
const EMPTY_PROFILE_CLOCKS = new Map<number, LiveProfileClock>();
const EMPTY_PROFILE_DAYS = new Map<number, string>();

export function ProfileDaysBoundary({
  clocks,
  children,
}: {
  clocks: ReadonlyMap<number, LiveProfileClock>;
  children: ReactNode;
}) {
  return (
    <ProfileClocksContext.Provider value={clocks}>
      {children}
    </ProfileClocksContext.Provider>
  );
}

export function useLiveProfileClocks(): ReadonlyMap<number, LiveProfileClock> {
  return useContext(ProfileClocksContext) ?? EMPTY_PROFILE_CLOCKS;
}

export function useLiveProfileDays(): ReadonlyMap<number, string> {
  const clocks = useLiveProfileClocks();
  return useMemo(
    () =>
      clocks.size === 0
        ? EMPTY_PROFILE_DAYS
        : new Map([...clocks].map(([id, clock]) => [id, clock.today])),
    [clocks]
  );
}

export function DayContextBoundary({
  value,
  children,
}: {
  value: DayContextValue | null;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

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

export function urlDayContextValue({
  profileId,
  today,
  reach,
  day,
  hrefForDay,
}: {
  profileId: number;
  today: string;
  reach: TapReach;
  day: string;
  hrefForDay: (day: string) => AppRoute;
}): DayContextValue {
  const selected = isWithinReach(reach, today, day) ? day : today;
  return valueFor(profileId, today, reach, selected, "url", null, hrefForDay);
}

function StateDayContext({
  profileId,
  today,
  reach,
  initialDay,
  children,
  onSelectedDayChange,
}: {
  profileId: number;
  today: string;
  reach: TapReach;
  initialDay: string;
  children: ReactNode;
  onSelectedDayChange?: (day: string) => void;
}) {
  const [day, setDay] = useState(() =>
    isWithinReach(reach, today, initialDay) ? initialDay : today
  );
  // A selected day can age out when the profile's calendar advances. Reconcile in
  // this render so no consumer observes the expired value. Do not key the subtree on
  // `today`: when the selected day remains reachable it is the same context, and a
  // pending draft beneath it must keep its identity.
  const reconciledDay = isWithinReach(reach, today, day)
    ? day
    : isWithinReach(reach, today, initialDay)
      ? initialDay
      : today;
  if (reconciledDay !== day) setDay(reconciledDay);
  const reportedDay = useRef(reconciledDay);
  useLayoutEffect(() => {
    if (reportedDay.current === reconciledDay) return;
    reportedDay.current = reconciledDay;
    onSelectedDayChange?.(reconciledDay);
  }, [reconciledDay, onSelectedDayChange]);
  const select = useCallback(
    (nextDay: string) => {
      if (isWithinReach(reach, today, nextDay) && nextDay !== reconciledDay) {
        setDay(nextDay);
      }
    },
    [reach, today, reconciledDay]
  );
  const value = useMemo(
    () =>
      valueFor(profileId, today, reach, reconciledDay, "state", select, null),
    [profileId, today, reach, reconciledDay, select]
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function DayContextProvider({
  profileId,
  today,
  reach,
  backing,
  children,
  onSelectedDayChange,
}: {
  profileId: number;
  today: string;
  reach: TapReach;
  backing: DayBacking;
  children: ReactNode;
  onSelectedDayChange?: (day: string) => void;
}) {
  if (backing.kind === "state") {
    return (
      <StateDayContext
        key={dayContextKey({ profileId, day: backing.initialDay, reach })}
        profileId={profileId}
        today={today}
        reach={reach}
        initialDay={backing.initialDay}
        onSelectedDayChange={onSelectedDayChange}
      >
        {children}
      </StateDayContext>
    );
  }
  return (
    <DayContextBoundary
      value={urlDayContextValue({
        profileId,
        today,
        reach,
        day: backing.day,
        hrefForDay: backing.hrefForDay,
      })}
    >
      {children}
    </DayContextBoundary>
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

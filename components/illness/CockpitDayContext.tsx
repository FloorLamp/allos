"use client";

import { createContext, useContext, useState } from "react";
import { useTimezone } from "@/components/TimezoneProvider";
import { dateStrInTz } from "@/lib/date";

// THE DAY A CARD IS STANDING ON (issue #4691), supplied to every control beneath it.
//
// The Today/Yesterday toggle used to be local state inside `SymptomLogBar`, which made
// it the Symptoms SECTION's day rather than the card's: the temperature fold beside it
// hard-set the primary date, and the Meds rows below it could not see the toggle at
// all, so one card displayed one day and bound its writes three ways. A toggle inside
// one child that governs a sibling's writes is the shape that regresses — so the day
// lives here, above both siblings, and the toggle only sets it.
//
// FALLBACK, NOT A FLAG (the IntakeOptionsContext shape). A bar mounted without a
// provider — the Timeline's day view, the cycles page, the quick-entry sheet — is a
// single-day surface with no toggle and no second day to offer, so `useCockpitDay`
// answers null and each such mount stands on the day it was handed. There is no second
// code path for them to drift down.
export interface CockpitDay {
  // The card's primary day. Its "now" is a real instant, which is what lets a control
  // beneath it fall back to the current clock.
  date: string;
  // The second day the toggle offers, when the card offers one.
  altDate?: string;
  // The day every write and statement beneath this card binds to.
  activeDate: string;
  // Whether `activeDate` is THE PROFILE'S TODAY — not merely the card's primary day.
  // A day that has ENDED has no "now", so anything that would otherwise stamp the
  // current clock — a reading time, a dose time — must ask instead.
  //
  // THE DISTINCTION IS THE WHOLE POINT, and reading it as "the primary prop" was a
  // real defect: a CLOSED episode's panel stands on the episode's last active day, and
  // `/history?day=<past>` stands on the day being read, so both had a "primary" day
  // that ended weeks ago and neither asked for the minute. The action then stored those
  // readings untimed. Asked of the calendar, this cannot drift with the mount.
  isPrimaryDay: boolean;
  dateLabel: string;
  altDateLabel: string;
  select: (day: string) => void;
}

const CockpitDayContext = createContext<CockpitDay | null>(null);

export function CockpitDayProvider({
  date,
  altDate,
  dateLabel = "Today",
  altDateLabel = "Yesterday",
  tz,
  children,
}: {
  date: string;
  altDate?: string;
  dateLabel?: string;
  altDateLabel?: string;
  // The SUBJECT profile's zone, for a card logging a household member (#858). Defaults
  // to the app-wide provider, the acting profile's.
  tz?: string;
  children: React.ReactNode;
}) {
  const appTz = useTimezone();
  const [activeDate, setActiveDate] = useState(date);
  // THE CARD'S DAY RESYNCS WHEN THE SERVER'S DOES. `date` is server state, and a
  // cockpit left open across local midnight is the overnight fevered-child case this
  // card exists for: yesterday's date arrives as the new `date`, the untouched state
  // still holds it, and every write beneath silently binds to the previous day. The
  // two-day drift self-corrects through the primary-day floor below; the one-day case
  // is exactly the one that does not, because the stale value is the new alt day.
  const [seenDate, setSeenDate] = useState(date);
  if (seenDate !== date) {
    setSeenDate(date);
    setActiveDate(date);
  }
  // The primary day is the floor: a card whose alt day is withdrawn (an episode that
  // closed while open in another tab) can never be left standing on a day it no
  // longer offers.
  const day = activeDate === altDate && altDate ? altDate : date;
  const todayStr = dateStrInTz(tz ?? appTz);
  return (
    <CockpitDayContext.Provider
      value={{
        date,
        altDate,
        activeDate: day,
        isPrimaryDay: day === todayStr,
        dateLabel,
        altDateLabel,
        select: setActiveDate,
      }}
    >
      {children}
    </CockpitDayContext.Provider>
  );
}

// The card's day, or null when this control is not inside one.
export function useCockpitDay(): CockpitDay | null {
  return useContext(CockpitDayContext);
}

// THE DAY BINDING EVERY CONTROL READS, card or no card — so `isPrimaryDay` has ONE
// definition rather than a context arm and a hand-written fallback that drifted from
// it. An unwrapped mount is a single-day surface standing on the day it was handed;
// asking the calendar whether that day is today is the same question the provider
// asks, which is what makes the required-time rule reach the unwrapped mounts too.
export function useDayBinding(fallbackDate: string, tz?: string): CockpitDay {
  const card = useCockpitDay();
  const appTz = useTimezone();
  const todayStr = dateStrInTz(tz ?? appTz);
  if (card) return card;
  return {
    date: fallbackDate,
    activeDate: fallbackDate,
    isPrimaryDay: fallbackDate === todayStr,
    dateLabel: "Today",
    altDateLabel: "Yesterday",
    select: () => {},
  };
}

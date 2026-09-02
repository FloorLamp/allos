"use client";

import { createContext, useContext, useState } from "react";

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
  // Whether `activeDate` is the primary day. A day that has ENDED has no "now", so
  // anything that would otherwise stamp the current clock — a reading time, a dose
  // time — must ask instead. Expressed once, here, rather than at each mount.
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
  children,
}: {
  date: string;
  altDate?: string;
  dateLabel?: string;
  altDateLabel?: string;
  children: React.ReactNode;
}) {
  const [activeDate, setActiveDate] = useState(date);
  // The primary day is the floor: a card whose alt day is withdrawn (an episode that
  // closed while open in another tab) can never be left standing on a day it no
  // longer offers.
  const day = activeDate === altDate && altDate ? altDate : date;
  return (
    <CockpitDayContext.Provider
      value={{
        date,
        altDate,
        activeDate: day,
        isPrimaryDay: day === date,
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

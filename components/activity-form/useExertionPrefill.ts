"use client";

import { useEffect, useState } from "react";
import { exertionPrefillOffer } from "@/app/(app)/training/activity-actions";
import type { ExertionOffer } from "@/lib/exertion-offer";

/**
 * What one day's trace answered.
 *
 * AN ANSWER IS ABOUT A DAY, and that is why this wraps the offer rather than being it.
 * `offer: null` is the answer "this day holds no unclaimed effort" — a different value
 * from "nothing has come back yet", which is this hook returning null. A form that
 * cannot tell those two apart keeps the previous day's clocks when the date changes to
 * a day whose trace says nothing, and goes on marking them as derived.
 */
export interface ExertionAnswer {
  /** The profile-local day this is an answer about. */
  date: string;
  offer: ExertionOffer | null;
}

// WHAT THE HEART RATE SAYS THE SESSION WAS (#5195, reader 2 of #5113).
//
// A form opened with no clocks of its own, on a day whose trace holds a finished effort
// nothing has claimed, defaults Start and End to that effort — marked as derived, with
// Adjust beside it, because a value the person did not state must say where it came
// from.
//
// ASKED, NEVER PROPPED. The gather is a day of heart rate plus ten prior windows; the
// editor's provider sits in the app shell and is mounted on every page, so propping
// this would put that read on every page load for an editor nobody opened. One Server
// Action, once, when a form that could actually use the answer opens.
//
// AND IT IS A SUGGESTION, NOT A WRITE. Nothing here saves. The answer lands in two
// fields the person edits or ignores, and the row is created by the save they tap —
// the #5194 ruling, which this reader inherits rather than re-argues.
export function useExertionPrefill({
  enabled,
  date,
}: {
  // A create form that stated no clocks of its own. An edit carries the row's times, a
  // live session is already running, and a form opened ON a window (#4950's chart door)
  // was told what it is about — none of the three has anything to ask.
  enabled: boolean;
  date: string;
}): ExertionAnswer | null {
  const [answer, setAnswer] = useState<ExertionAnswer | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void exertionPrefillOffer(date).then((offer) => {
      // Stamped with the day it was asked about: the date is mutable on the form, so
      // each answer replaces the last one whole rather than only when it is non-null.
      if (live) setAnswer({ date, offer });
    });
    return () => {
      live = false;
    };
  }, [enabled, date]);
  return answer;
}

"use client";

import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { zonedDateParts } from "@/lib/date";
import { foodSlotForHhmm, type FoodSlotBoundaries } from "@/lib/food-slot";
import { useUnsavedInputWithin } from "@/components/DirtyFormRegistry";

// ── THE SHEET DOES NOT SURVIVE A BOUNDARY IT CARES ABOUT (issue #5902) ────────
//
// Background the PWA at breakfast and come back at dinner. If the OS discarded the
// page the reopen is a cold load and everything is fresh; if the page SURVIVED, the
// quick-log sheet is exactly as it was and nothing in it notices the return. The
// morning's "Due & usual now" chips still stand, a visited body still holds the
// morning's rows, and the food header still reads "Add to Morning" while a bare tap
// files the serving there.
//
// Owner ruling 2026-09-15: the sheet CLOSES on that return when the clock has
// crossed a boundary it cares about, and NEVER over a draft. Regathering in place
// was considered and reversed for size, so nothing here re-reads anything — the
// next puck tap gathers fresh, exactly as it does today.
//
// WHY A MODULE AND NOT A BLOCK INSIDE THE VISIT OWNER. `QuickEntryProvider.tsx` is
// the visit owner and is where this hook is CALLED, but it is also 2,200 non-comment
// lines, which docs/change-policy.md holds to a shrink rule. Resume staleness is its
// own subject — a clock, two windows and a draft question — so it gets its own file
// rather than another concern folded into that one.
//
// TWO GUARDS, AND NO TIMER. Nothing runs while the sheet is closed or while the
// document is hidden: the facts are taken once on the way out and compared once on
// the way back. A return INSIDE the same window on the same day does nothing at all,
// so an ordinary app switch is free. There is no minute threshold either, because
// "long enough to matter" is exactly "the clock left the window" — a fact rather
// than a guess about one.

// The two facts a visit is allowed to go stale against: which profile-local DAY it
// is, and which food WINDOW that day is in. Both read the profile's own clock, never
// the device's.
interface VisitBoundaryFacts {
  day: string;
  // Null until the open-time gather publishes boundaries (it failed, or nothing has
  // gathered yet). Null on BOTH sides compares equal, so the profile day stays a
  // live boundary even then.
  slot: string | null;
}

/**
 * The provider-owned half: the two things the listener reads at event time, neither
 * of which is state, because nothing renders from either.
 *
 * Created once by `useVisitResumeWatch` in the provider and handed back through the
 * quick-entry context — `noteSlotBoundaries` to whoever gathered the windows
 * (`QuickLogMenu`'s `loadLogSheetContext`), `bodiesRef` to the element the visited
 * bodies render inside.
 */
export interface VisitResumeWatch {
  noteSlotBoundaries: (boundaries: FoodSlotBoundaries | null) => void;
  bodiesRef: RefObject<HTMLDivElement | null>;
  boundaries: RefObject<FoodSlotBoundaries | null>;
}

export function useVisitResumeWatch(): VisitResumeWatch {
  const boundaries = useRef<FoodSlotBoundaries | null>(null);
  const bodiesRef = useRef<HTMLDivElement | null>(null);
  const noteSlotBoundaries = useCallback((next: FoodSlotBoundaries | null) => {
    boundaries.current = next;
  }, []);
  return useMemo(
    () => ({ noteSlotBoundaries, bodiesRef, boundaries }),
    [noteSlotBoundaries]
  );
}

/**
 * The visit-owner half: one `visibilitychange` listener, live only while a visit is
 * open, that closes the sheet through `onCrossed` when the return lands in another
 * food window or on another profile day.
 *
 * `onCrossed` is the visit's EXISTING invalidation — the flag both hosts already
 * turn into their close through `onInvalidated`. There is no new close path here and
 * no new gather path.
 *
 * `timeZone` is the acting profile's live clock zone; null (no clock yet) disables
 * the comparison rather than guessing at the device's.
 */
export function useVisitResumeBoundary({
  watching,
  timeZone,
  watch,
  onCrossed,
}: {
  watching: boolean;
  timeZone: string | null;
  watch: VisitResumeWatch;
  onCrossed: () => void;
}): void {
  const hasUnsavedInputWithin = useUnsavedInputWithin();
  const backgroundedAt = useRef<VisitBoundaryFacts | null>(null);
  // THE DAY IS DERIVED AT EVENT TIME, not read off the last render. The live clock
  // (`RouteDayContext`) advances on its own midnight timer, which also fires on
  // resume — but nothing orders that timer against this listener, so reading its
  // rendered `today` here would decide a midnight crossing on a race. The zone is
  // the clock's; the day is the same Intl derivation the clock itself renders,
  // asked now.
  const read = useRef<() => VisitBoundaryFacts | null>(() => null);
  read.current = () => {
    if (!timeZone) return null;
    const { date, hhmm } = zonedDateParts(timeZone, new Date());
    const splits = watch.boundaries.current;
    return { day: date, slot: splits ? foodSlotForHhmm(hhmm, splits) : null };
  };

  useEffect(() => {
    if (!watching) return;
    backgroundedAt.current = null;
    const onVisibilityChange = () => {
      if (document.hidden) {
        backgroundedAt.current = read.current();
        return;
      }
      const before = backgroundedAt.current;
      backgroundedAt.current = null;
      const after = read.current();
      if (!before || !after) return;
      if (before.day === after.day && before.slot === after.slot) return;
      // NEVER OVER A DRAFT. The header keeps naming the window it gathered in,
      // which is the accepted cost of not putting a confirm in front of someone who
      // has just picked their phone back up. The registry is asked about the
      // visited bodies' subtree ONLY: a dirty form on the page behind the sheet is
      // not this sheet's unsaved work.
      if (hasUnsavedInputWithin(watch.bodiesRef.current)) return;
      onCrossed();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      backgroundedAt.current = null;
    };
  }, [hasUnsavedInputWithin, onCrossed, watch, watching]);
}

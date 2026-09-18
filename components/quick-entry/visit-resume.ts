"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { zonedDateParts } from "@/lib/date";
import {
  foodSlotForHhmm,
  type FoodSlot,
  type FoodSlotBoundaries,
} from "@/lib/food-slot";
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
// TWO HOSTS, ONE RULE (PM ruling 2026-09-16, slice 2). The phone sheet reaches these
// forms through a VISIT; the desktop panel (`SidebarLogButton` above `md`) reaches
// them through the provider's DIRECT overlay, which has no visit to invalidate. The
// boundary facts, the two event-time reads and the draft question are identical, so
// the hosts differ in exactly one thing: WHOSE subtree holds the draft. That is the
// `host` key below, and it is the whole extension — a second copy of this clock is
// what it exists to prevent.
//
// WHY A MODULE AND NOT A BLOCK INSIDE THE VISIT OWNER. Resume staleness is its own
// subject — a profile clock, two food windows and a draft question — and it shares
// nothing with the visit machinery beyond the flag it ends at. `QuickEntryProvider`
// CALLS this and keeps the ref pair alive; it does not need to carry the reasoning,
// and it is already long enough that folding one more concern in would bury both.
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
  slot: FoodSlot | null;
}

/**
 * Which host's overlay a watch is about. Not a presentation and not a viewport: it
 * names the subtree whose unsaved input holds that host open, and the two never run
 * at once (opening the direct overlay takes the visit identity away from any sheet
 * host, and starting a visit closes the direct overlay).
 */
export type QuickEntryResumeHost = "visit" | "panel";

/**
 * The provider-owned half: the two boxes the listener reads at event time, neither
 * of which is state, because nothing renders from either.
 *
 * Created once by `useVisitResumeWatch` in the provider and handed back through the
 * quick-entry context — `noteSlotBoundaries` to whoever gathered the windows
 * (`QuickLogMenu`'s `loadLogSheetContext`, which BOTH hosts mount, so the windows are
 * published once), `attachBodies` to the element each host's bodies render inside,
 * `peek` to the listener that reads both back.
 *
 * THREE FUNCTIONS AND NO REF OBJECTS. The boxes ARE refs, but they stay private to
 * this module: a context value carrying a `RefObject` field makes every property
 * read off that value a render-time ref access as far as react-hooks/refs is
 * concerned, and that verdict reaches the JSX standing beside the wrapper. Two
 * commit-time writers and one event-time reader say the same thing while keeping
 * the rule's guarantee honest — none of the three is called during render.
 */
export interface VisitResumeWatch {
  noteSlotBoundaries: (boundaries: FoodSlotBoundaries | null) => void;
  attachBodies: (
    host: QuickEntryResumeHost,
    node: HTMLDivElement | null
  ) => void;
  peek: (host: QuickEntryResumeHost) => {
    bodies: HTMLDivElement | null;
    boundaries: FoodSlotBoundaries | null;
  };
}

export function useVisitResumeWatch(): VisitResumeWatch {
  const boundaries = useRef<FoodSlotBoundaries | null>(null);
  // Keyed rather than one box: both hosts mount their bodies from the same provider,
  // and a host that is closed leaves its key null instead of overwriting the other's.
  const bodies = useRef<Record<QuickEntryResumeHost, HTMLDivElement | null>>({
    visit: null,
    panel: null,
  });
  const noteSlotBoundaries = useCallback((next: FoodSlotBoundaries | null) => {
    boundaries.current = next;
  }, []);
  const attachBodies = useCallback(
    (host: QuickEntryResumeHost, node: HTMLDivElement | null) => {
      bodies.current[host] = node;
    },
    []
  );
  const peek = useCallback(
    (host: QuickEntryResumeHost) => ({
      bodies: bodies.current[host],
      boundaries: boundaries.current,
    }),
    []
  );
  return useMemo(
    () => ({ noteSlotBoundaries, attachBodies, peek }),
    [attachBodies, noteSlotBoundaries, peek]
  );
}

/**
 * The host half: one `visibilitychange` listener, live only while that host's overlay
 * is open, that closes it through `onCrossed` when the return lands in another food
 * window or on another profile day.
 *
 * `onCrossed` is always the host's OWN EXISTING close — the visit's `invalidate`,
 * which every visit host already turns into its close through `onInvalidated`, or the
 * provider's `close` for the direct overlay, which is the same callback its scrim tap
 * and Escape run. There is no new close path here and no new gather path.
 *
 * `timeZone` is the acting profile's live clock zone; null (no clock yet) disables
 * the comparison rather than guessing at the device's.
 */
export function useVisitResumeBoundary({
  watching,
  timeZone,
  watch,
  host,
  onCrossed,
}: {
  watching: boolean;
  timeZone: string | null;
  watch: VisitResumeWatch;
  host: QuickEntryResumeHost;
  onCrossed: () => void;
}): void {
  const hasUnsavedInputWithin = useUnsavedInputWithin();

  useEffect(() => {
    if (!watching) return;
    // THE DAY IS DERIVED AT EVENT TIME, not read off the last render. The live clock
    // (`RouteDayContext`) advances on its own midnight timer, which also fires on
    // resume — but nothing orders that timer against this listener, so reading its
    // rendered `today` here would decide a midnight crossing on a race. The zone is
    // the clock's; the day is the same Intl derivation the clock itself renders,
    // asked now.
    const read = (): VisitBoundaryFacts | null => {
      if (!timeZone) return null;
      const { date, hhmm } = zonedDateParts(timeZone, new Date());
      const splits = watch.peek(host).boundaries;
      return { day: date, slot: splits ? foodSlotForHhmm(hhmm, splits) : null };
    };
    // Scoped to this subscription, so a closed sheet or a changed clock discards
    // the outbound snapshot rather than comparing against it later.
    let backgroundedAt: VisitBoundaryFacts | null = null;
    const onVisibilityChange = () => {
      if (document.hidden) {
        backgroundedAt = read();
        return;
      }
      const before = backgroundedAt;
      backgroundedAt = null;
      const after = read();
      if (!before || !after) return;
      if (before.day === after.day && before.slot === after.slot) return;
      // NEVER OVER A DRAFT. The header keeps naming the window it gathered in,
      // which is the accepted cost of not putting a confirm in front of someone who
      // has just picked their phone back up. The registry is asked about THIS host's
      // bodies' subtree only: a dirty form on the page behind the sheet, or in the
      // other host, is not this overlay's unsaved work.
      if (hasUnsavedInputWithin(watch.peek(host).bodies)) return;
      onCrossed();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [hasUnsavedInputWithin, host, onCrossed, timeZone, watch, watching]);
}

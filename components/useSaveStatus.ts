"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { RefObject } from "react";

// Shared autosave state for the settings cards (issue #477). Every settings form
// used to do `startTransition(async () => { await saveX(fd); setSavedAt(...) })`
// with NO catch — so a transient failure (a SQLITE_BUSY at the top of the hour per
// #468, a network blip) rejected inside the transition and escalated to the ROUTE
// error boundary, nuking the whole settings page instead of showing the inline
// error icon `SaveStatus` already supports.
//
// This hook owns the pending/savedAt/error triad, the catch, AND the value the
// control shows (#4688). It owns the value because the rollback has to be
// structural: every one of these surfaces used to keep its own `useState` and paint
// it before the save, so a REFUSED write stayed on screen beside the error icon —
// `setIsMuted(next)`, a throw, and a checkbox still claiming the profile is muted.
// Making the revert each call site's job made it nobody's. Here, `save` restores the
// last value the server accepted whatever the caller did.
export interface SaveStatusApi<T> {
  pending: boolean;
  savedAt: number;
  error: boolean;
  // What the control shows: the destination value from the moment of the tap, then
  // whatever the save settled on.
  value: T;
  // Move the on-screen value WITHOUT saving — the keystrokes of a save-on-blur
  // field. A failed save reverts to the last SAVED value, not to the last keystroke.
  edit: (next: T) => void;
  // Paint `next` now, run the save, and put the last saved value back if it throws.
  // `run` may resolve a value to commit what the server actually stored (a
  // normalized URL), which then becomes both what shows and what a later failure
  // restores. A rejection is caught and surfaced as `error` instead of reaching the
  // error boundary; it is never inspected, so the deploy-skew and offline
  // classifications downstream see the error the action threw.
  save: (next: T, run: () => Promise<T | void>) => void;
}

export function useSaveStatus<T>(initial: T): SaveStatusApi<T> {
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState(0);
  const [error, setError] = useState(false);
  const [value, setValue] = useState(initial);
  // The last value the server accepted. A ref, because the restore is read when the
  // save SETTLES, not in the render whose closure started it.
  const saved = useRef(initial);

  const save = useCallback((next: T, run: () => Promise<T | void>) => {
    setValue(next);
    startTransition(async () => {
      try {
        const settled = await run();
        const landed = settled === undefined ? next : settled;
        saved.current = landed;
        setValue(landed);
        setError(false);
        setSavedAt(Date.now());
      } catch {
        // Keep the form mounted and show the inline "Couldn't save" icon rather
        // than letting the rejection reach the route error boundary — and take the
        // painted value back, so the icon stops sitting next to a value that
        // contradicts it.
        setValue(saved.current);
        setError(true);
      }
    });
  }, []);

  return { pending, savedAt, error, value, edit: setValue, save };
}

// The save-on-blur tier rule (issue #794 cluster 10b). Autosave-on-blur is the
// SETTINGS convention only: the settings cards persist each field on blur/change
// (via useSaveStatus above); records everywhere else use an explicit submit button.
// The one gap in blur-saving is a value still FOCUSED when the tab is backgrounded
// — on mobile especially the app can be suspended before any blur fires, dropping
// the edit. useFlushOnHide closes it by blurring the focused field inside `ref` on
// visibilitychange→hidden, so that field's existing onBlur handler runs and saves —
// the same "flush the pending edit on the way out" that ActivityForm's unmount
// flush does, minus any second save engine. Fields that save on change (selects,
// checkboxes) have nothing pending, so this is a no-op for them.
export function useFlushOnHide(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState !== "hidden") return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && ref.current?.contains(active)) {
        active.blur();
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [ref]);
}

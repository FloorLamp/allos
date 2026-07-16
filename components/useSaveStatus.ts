"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import type { RefObject } from "react";

// Shared autosave state for the settings cards (issue #477). Every settings form
// used to do `startTransition(async () => { await saveX(fd); setSavedAt(...) })`
// with NO catch — so a transient failure (a SQLITE_BUSY at the top of the hour per
// #468, a network blip) rejected inside the transition and escalated to the ROUTE
// error boundary, nuking the whole settings page instead of showing the inline
// error icon `SaveStatus` already supports.
//
// This hook owns the pending/savedAt/error triad and the catch: `save(run)` runs
// `run` inside a transition, marks `savedAt` on success, and flips `error` true on
// a throw (cleared on the next successful save). Feed all three into <SaveStatus />.
export interface SaveStatusApi {
  pending: boolean;
  savedAt: number;
  error: boolean;
  // Run an async save; a rejection is caught and surfaced as `error` instead of
  // reaching the error boundary. Returns nothing — read state from the fields.
  save: (run: () => Promise<void>) => void;
}

export function useSaveStatus(): SaveStatusApi {
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState(0);
  const [error, setError] = useState(false);

  const save = useCallback((run: () => Promise<void>) => {
    startTransition(async () => {
      try {
        await run();
        setError(false);
        setSavedAt(Date.now());
      } catch {
        // Keep the form mounted and show the inline "Couldn't save" icon rather
        // than letting the rejection reach the route error boundary.
        setError(true);
      }
    });
  }, []);

  return { pending, savedAt, error, save };
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

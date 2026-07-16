"use client";

import { useEffect, useState } from "react";
import { IconLoader2, IconCheck, IconAlertTriangle } from "@tabler/icons-react";

// How long the "saved" check lingers before fading out. Shared so every
// autosave indicator in the app agrees on the timing.
export const SAVED_FADE_MS = 3000;

// Unified autosave indicator — icon-only: a spinner while a save is in flight,
// a check for a few seconds after it lands, an alert while errored, and nothing
// when idle. Used by the settings cards and the activity form footer.
export default function SaveStatus({
  pending,
  savedAt,
  error = false,
}: {
  pending: boolean;
  // Timestamp of the last successful save (0 = never); each new value re-shows
  // the check and resets its fade timer, so back-to-back saves each confirm.
  savedAt: number;
  error?: boolean;
}) {
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => {
    if (!savedAt) return;
    setShowSaved(true);
    const t = setTimeout(() => setShowSaved(false), SAVED_FADE_MS);
    return () => clearTimeout(t);
  }, [savedAt]);

  return (
    <span className="flex items-center" aria-live="polite">
      {pending ? (
        <IconLoader2
          className="h-4 w-4 animate-spin text-slate-500 motion-reduce:animate-none dark:text-slate-400"
          aria-label="Saving"
        />
      ) : error ? (
        <IconAlertTriangle
          className="h-4 w-4 text-rose-500 dark:text-rose-400"
          aria-label="Couldn’t save"
        />
      ) : showSaved ? (
        <IconCheck className="h-4 w-4 text-emerald-500" aria-label="Saved" />
      ) : null}
    </span>
  );
}

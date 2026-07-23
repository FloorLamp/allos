"use client";

import { IconBolt, IconFlagCheck } from "@tabler/icons-react";
import RestTimer from "./RestTimer";
import { useActivityEditor } from "@/components/ActivityEditorProvider";
import { useWakeLock } from "@/components/useWakeLock";
import { subjectActionLabel } from "@/lib/own-profile";

// The live-mode control panel (issue #340), pinned above the shared ActivityForm.
// It doesn't fork the form — the whole form still renders below it, so "finish"
// simply collapses this strip back to the normal editor for notes/intensity/review
// (one-question-one-computation: the form state is the single engine). Holds the
// rest timer, a big Finish button that stamps end=now, and a screen wake lock so
// the phone doesn't sleep between sets.
export default function LiveWorkoutPanel({
  leadExercise,
  restStartKey,
  onFinish,
}: {
  // The lift currently being worked — sets the rest timer's default duration.
  leadExercise: string;
  // Bumped by the form each time a set is checked off, auto-starting rest.
  restStartKey: number;
  // Stamp end=now and leave live mode (back to the normal form).
  onFinish: () => void;
}) {
  // Not-self stamp (issue #1013): the running session belongs to the acting profile;
  // when that isn't the login's own profile, name it on the live control strip so a
  // set logged in the wrong record is caught at the point of action.
  const { subjectName } = useActivityEditor();

  // Keep the screen awake for the phone-at-the-gym surface — the shared hook (#1275).
  useWakeLock();

  return (
    <div
      data-testid="live-workout-panel"
      className="space-y-3 rounded-xl border border-brand-300 bg-brand-50/40 p-3 dark:border-brand-800 dark:bg-brand-950/30"
    >
      <div className="flex items-center justify-between gap-2">
        <span
          data-testid="live-workout-subject"
          className="flex items-center gap-1.5 text-sm font-semibold text-brand-700 dark:text-brand-300"
        >
          <IconBolt className="h-4 w-4" stroke={2} />
          {subjectActionLabel("Live workout", subjectName)}
        </span>
        <button
          type="button"
          onClick={onFinish}
          data-testid="finish-workout"
          className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-500 active:scale-95"
        >
          <IconFlagCheck className="h-4 w-4" />
          {subjectActionLabel("Finish workout", subjectName)}
        </button>
      </div>
      <RestTimer exercise={leadExercise} autoStartKey={restStartKey} />
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Log each set below — the rest timer starts when you add the next set.
        Tap Finish to stamp your end time.
      </p>
    </div>
  );
}

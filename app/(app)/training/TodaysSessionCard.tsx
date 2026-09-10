"use client";

import { useActivityEditor } from "@/components/ActivityEditorProvider";
import type { ActivityEditData } from "@/components/ActivityForm";
import Button from "@/components/Button";
import LogActivityButton from "@/components/LogActivityButton";
import type { ReactNode } from "react";

// The routine-aware "Today's session" card (#740): renders today's resolved
// routine day — the day label, its focus, and each slot's filled exercise with
// its prescription and (when the lift has history) a concrete load target. The
// "Log this session" button hands the pre-filled slate to the live workout mode
// (#340) via the shared activity editor, so a routine day goes straight into the
// in-gym flow. Cold start is a designed state: with no history a slot shows sets ×
// rep range and no load.
export interface SessionCardSlot {
  exercise: string;
  prescription: string; // e.g. "4 × 5–8"
  target: string | null; // e.g. "62.5 kg × 5", or null (cold start)
}

export default function TodaysSessionCard({
  label,
  focus,
  slots,
  prefill,
  deloadWeek = false,
  context,
}: {
  label: string;
  focus: string[];
  slots: SessionCardSlot[];
  prefill: ActivityEditData;
  // The routine's mesocycle says this is the deload week (#741): the slates below
  // are already deload-adjusted (lighter load, fewer sets); the badge names it.
  deloadWeek?: boolean;
  context?: ReactNode;
}) {
  const { openSession, canStartWorkout, workoutOffer } = useActivityEditor();

  return (
    <div className="card" data-testid="todays-session-card">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <h3 className="section-label">Today&apos;s session</h3>
          <p
            className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100"
            data-testid="todays-session-title"
          >
            {label}
          </p>
          {deloadWeek && (
            <p
              className="mt-1 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
              data-testid="deload-badge"
            >
              Deload week — lighter to recover
            </p>
          )}
          {focus.length > 0 && (
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {focus.join(" · ")}
            </p>
          )}
          <ul className="mt-3 space-y-1.5 text-sm">
            {slots.map((s, i) => (
              <li
                key={`${s.exercise}-${i}`}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5"
                data-testid="todays-session-slot"
              >
                <span className="font-medium text-slate-800 dark:text-slate-100">
                  {s.exercise}
                </span>
                <span className="text-slate-500 dark:text-slate-400">
                  {s.prescription}
                  {s.target ? (
                    <span className="ml-2 font-semibold text-slate-700 dark:text-slate-200">
                      {s.target}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
        {/* THIS CARD'S OWN ACTION ROW, AND IT IS NOT `TrainingOverviewActions`
            (#5711). It writes that component's unstacked shape by hand, but the
            controls differ: the primary here is `log-this-session`, which hands
            the routine slate over, where `TrainingOverviewActions` renders
            `training-overview-start-workout`. Both rows answered to
            `training-overview-actions` until #5711, so a reader following the
            name from a spec landed on whichever file they opened first — which
            is the likeliest reason #4978's ruling 8 names this mount while the
            directive it defers to is about the other one. That discrepancy is
            recorded, not resolved: the two controls are still different
            controls. One name, one row. */}
        <div
          className="flex shrink-0 flex-wrap gap-2"
          data-testid="todays-session-actions"
        >
          {canStartWorkout && (
            // FILLED BECAUSE IT IS THIS CARD'S ONE LOUD CONTROL, not because it
            // is a form commit (#4978 rulings 5-neighbour and 6): the surface is
            // the card, and the action this card exists for is starting the day
            // it just described. "Log activity" beside it stays quiet.
            //
            // `data` is how the offer state reaches the DOM (#4978 ruling 8).
            // The primitive's prop set is closed, so writing
            // `data-workout-offer` as a bare JSX attribute here would compile,
            // lint and test green while dropping the attribute off the page.
            <Button
              variant="primary"
              data-testid="log-this-session"
              data={{ "data-workout-offer": workoutOffer.kind }}
              onClick={() => openSession(prefill)}
            >
              {/* The label names the write (#1893/#1892): while a session is already
                  live this reads "Resume workout" and openSession reopens it, because
                  handing the routine slate over used to reset the running clock and
                  drop the sets already logged. The routine day is still one tap away
                  once that session is finished. */}
              {workoutOffer.kind === "resume"
                ? workoutOffer.label
                : "Log this session"}
            </Button>
          )}
          <LogActivityButton testId="training-overview-log-activity">
            Log activity
          </LogActivityButton>
        </div>
      </div>
      {context}
    </div>
  );
}

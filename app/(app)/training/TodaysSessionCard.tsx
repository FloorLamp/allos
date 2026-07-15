"use client";

import { useActivityEditor } from "@/components/ActivityEditorProvider";
import type { ActivityEditData } from "@/components/ActivityForm";

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
}: {
  label: string;
  focus: string[];
  slots: SessionCardSlot[];
  prefill: ActivityEditData;
  // The routine's mesocycle says this is the deload week (#741): the slates below
  // are already deload-adjusted (lighter load, fewer sets); the badge names it.
  deloadWeek?: boolean;
}) {
  const { openSession, canStartWorkout } = useActivityEditor();

  return (
    <div className="card" data-testid="todays-session-card">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Today&apos;s session
          </h3>
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
            <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
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
        {canStartWorkout && (
          <div className="shrink-0">
            <button
              type="button"
              className="btn"
              data-testid="log-this-session"
              onClick={() => openSession(prefill)}
            >
              Log this session
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

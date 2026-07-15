"use client";

import { useState } from "react";
import type { FormResult } from "@/lib/types";
import { initialVisitTense, visitTenseForDate } from "@/lib/visit-entry";
import type { VisitTense } from "@/lib/visit-entry";
import AppointmentForm from "./AppointmentForm";
import EncounterForm from "./EncounterForm";

// The single "Add visit" entry (issue #566). Appointments (future, scheduling) and
// encounters (past, clinical) stay two tables and two forms — this is a
// presentation-layer wrapper that closes the "which form do I use?" seam by
// branching on TENSE behind one affordance:
//   • a segmented Upcoming / Already happened toggle picks the branch, and
//   • picking a past date in the form auto-flips it to the encounter branch (and a
//     future date back), so the date the user is already entering routes the shape.
// The chosen date is owned here and passed controlled into whichever form renders,
// so it survives the flip. A prefill / ?new=1 deep link (the #85 Book CTA, the #29
// command-palette action, the calendar-feed hookup) forces the appointment branch,
// preserving every existing entry path.
export default function AddVisitEntry({
  createAppointment,
  addEncounter,
  defaultDate,
  today,
  prefill,
  focusNew,
}: {
  createAppointment: (formData: FormData) => Promise<FormResult>;
  addEncounter: (formData: FormData) => Promise<FormResult>;
  defaultDate: string;
  today: string;
  prefill?: {
    title: string | null;
    provider: string | null;
    location: string | null;
    kind?: string | null;
  };
  focusNew: boolean;
}) {
  const [date, setDate] = useState(defaultDate);
  const [tense, setTense] = useState<VisitTense>(
    initialVisitTense({
      hasPrefill: !!prefill,
      focusNew,
      date: defaultDate,
      today,
    })
  );

  // Follow the date the user is entering to the matching branch — the "pick a date
  // first" routing from the issue. A blank/partial entry keeps the current branch.
  function handleDateChange(v: string) {
    setDate(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) setTense(visitTenseForDate(v, today));
  }

  const upcoming = tense === "upcoming";

  return (
    <div className="card space-y-3" data-testid="visits-add">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Add visit
        </h2>
      </div>

      {/* Tense toggle — the single entry's branch selector. */}
      <div
        className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 text-sm dark:bg-ink-800"
        role="tablist"
        aria-label="Visit timing"
        data-testid="visit-tense-toggle"
      >
        <button
          type="button"
          role="tab"
          aria-selected={upcoming}
          data-testid="visit-tense-upcoming"
          onClick={() => setTense("upcoming")}
          className={`rounded-md px-3 py-1.5 font-medium transition ${
            upcoming
              ? "bg-white text-slate-900 shadow-sm dark:bg-ink-900 dark:text-slate-100"
              : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          }`}
        >
          Upcoming
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={!upcoming}
          data-testid="visit-tense-past"
          onClick={() => setTense("past")}
          className={`rounded-md px-3 py-1.5 font-medium transition ${
            !upcoming
              ? "bg-white text-slate-900 shadow-sm dark:bg-ink-900 dark:text-slate-100"
              : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          }`}
        >
          Already happened
        </button>
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        {upcoming
          ? "Scheduling a future visit — it books an appointment and surfaces on Upcoming."
          : "Logging a visit that already happened — it's saved to your visit history below."}
      </p>

      {/* One branch renders at a time; the shared date carries across the flip. */}
      {upcoming ? (
        <AppointmentForm
          action={createAppointment}
          defaultDate={defaultDate}
          prefill={prefill}
          date={date}
          onDateChange={handleDateChange}
          embedded
        />
      ) : (
        <EncounterForm
          action={addEncounter}
          defaultDate={defaultDate}
          date={date}
          onDateChange={handleDateChange}
          embedded
        />
      )}
    </div>
  );
}

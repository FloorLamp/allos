"use client";

import { useState } from "react";
import type { FormResult } from "@/lib/types";
import { initialVisitTense, visitTenseForDate } from "@/lib/visit-entry";
import type { VisitTense } from "@/lib/visit-entry";
import { useAddEntryModalClose } from "@/components/AddEntryPanel";
import AppointmentForm from "./AppointmentForm";
import EncounterForm from "./EncounterForm";

// The single "Add visit" entry (issue #566, #3223). Appointments (future, scheduling)
// and encounters (past, clinical) stay two tables, two Server Actions and two forms —
// this is a presentation-layer wrapper that closes the "which form do I use?" seam.
//
// THE TENSE IS A DERIVED FACT OF THE DATE, NOT A QUESTION ASKED FIRST (#3223). This
// wrapper used to open with a segmented Upcoming / Already happened tablist and a
// paragraph explaining the two branches — a question the person had to answer about the
// app's storage model before they could type anything about their visit. But the date
// they are already entering answers it: a future day is a booking, a past day is a
// record of something that happened. So the branch is DERIVED and then STATED, with one
// control to correct it — the same derived-and-correctable grammar the intake form's
// kind chip uses, and the reason the facts-with-editors pattern suits this pair at all.
//
// A CORRECTION STICKS UNTIL THE DATE MOVES AGAIN. Overriding says "I know what this is
// and the derivation is wrong", so a re-render must not quietly undo it; but typing a
// new date is a fresh statement of when, and the derivation gets to answer again. Both
// halves matter: without the first the correction is unusable, and without the second a
// single stray tap would pin the wrong branch for the rest of the entry.
//
// The chosen date is owned here and passed controlled into whichever form renders, so it
// survives the flip. A prefill / ?new=1 deep link (the #85 Book CTA, the #29
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
  const closeEntryModal = useAddEntryModalClose();
  const [date, setDate] = useState(defaultDate);
  const [tense, setTense] = useState<VisitTense>(
    initialVisitTense({
      hasPrefill: !!prefill,
      focusNew,
      date: defaultDate,
      today,
    })
  );

  // The date the person is entering routes the shape. A blank/partial entry keeps the
  // current branch, and re-deriving here is what lets a correction be undone by a fresh
  // date rather than surviving one.
  function handleDateChange(v: string) {
    setDate(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) setTense(visitTenseForDate(v, today));
  }

  const upcoming = tense === "upcoming";

  return (
    <div className="space-y-3" data-testid="visits-add">
      {/* The derived tense, STATED with its consequence and one control to correct it.
          Not a tablist any more: there is no question here to answer, only a reading of
          the date that the person can disagree with. */}
      <p
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400"
        data-testid="visit-tense-toggle"
        data-tense={tense}
      >
        <span data-testid="visit-tense-derived">
          {upcoming
            ? "Scheduling a future visit — it books an appointment and surfaces on Upcoming."
            : "Logging a visit that already happened — it's saved to your visit history."}
        </span>
        {upcoming ? (
          <button
            type="button"
            data-testid="visit-tense-past"
            onClick={() => setTense("past")}
            className="tap-target font-medium text-brand-700 underline underline-offset-2 dark:text-brand-300"
          >
            Already happened
          </button>
        ) : (
          <button
            type="button"
            data-testid="visit-tense-upcoming"
            onClick={() => setTense("upcoming")}
            className="tap-target font-medium text-brand-700 underline underline-offset-2 dark:text-brand-300"
          >
            Upcoming instead
          </button>
        )}
      </p>

      {/* One branch renders at a time; the shared date carries across the flip. */}
      {upcoming ? (
        <AppointmentForm
          action={createAppointment}
          defaultDate={defaultDate}
          prefill={prefill}
          date={date}
          onDateChange={handleDateChange}
          onSaved={closeEntryModal ?? undefined}
          embedded
        />
      ) : (
        <EncounterForm
          action={addEncounter}
          defaultDate={defaultDate}
          date={date}
          onDateChange={handleDateChange}
          onSaved={closeEntryModal ?? undefined}
          embedded
        />
      )}
    </div>
  );
}

"use client";

import { useState, type FormEvent } from "react";
import DateField from "@/components/DateField";
import { useToast } from "@/components/Toast";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import { logPractice } from "@/app/(app)/wellness/actions";
import type { PracticeLogOutcome } from "@/lib/types";

// The deliberate historical/correction form shared by Wellness and the backfill
// launcher. It is intentionally separate from the two quick intents: choosing a
// date and window is a different statement from starting now or just finishing.
export default function PracticeSessionForm({
  practice,
  today,
  defaultDurationMin = null,
  initialDate,
  minDate,
  maxDate,
  onLogged,
}: {
  practice: string;
  today: string;
  defaultDurationMin?: number | null;
  initialDate?: string;
  minDate?: string;
  maxDate?: string;
  onLogged?: (outcome: PracticeLogOutcome) => void;
}) {
  const [pending, setPending] = useState(false);
  const toast = useToast();
  const stampLoggedVia = useLoggedViaStamp();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const fd = new FormData(event.currentTarget);
    stampLoggedVia(fd);
    fd.set("practice", practice);
    try {
      const outcome = await logPractice(fd);
      if (outcome.kind === "logged") {
        if (onLogged) onLogged(outcome);
        else
          toast(
            outcome.date === today
              ? "Logged today's session"
              : "Logged past session"
          );
      } else {
        toast("Couldn't log that session.");
      }
    } catch {
      toast("Couldn't log that session. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="grid gap-3 sm:grid-cols-2"
      data-testid="practice-log-details"
    >
      <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
        Date
        <DateField
          name="date"
          defaultValue={initialDate ?? today}
          min={minDate}
          max={maxDate}
          inputClassName="mt-1 w-full"
          required
        />
      </label>
      <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
        Start
        <input type="time" name="start_time" className="input mt-1 w-full" />
      </label>
      <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
        End
        <input type="time" name="end_time" className="input mt-1 w-full" />
      </label>
      <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
        Duration (minutes)
        <input
          type="number"
          name="duration_min"
          min="1"
          step="1"
          defaultValue={defaultDurationMin ?? ""}
          className="input mt-1 w-full"
        />
      </label>
      <label className="text-sm font-medium text-slate-700 dark:text-slate-200 sm:col-span-2">
        Notes
        <textarea name="notes" rows={2} className="input mt-1 w-full" />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="btn w-fit disabled:opacity-50 sm:col-span-2"
        data-testid="practice-log-detailed-submit"
      >
        {pending ? "Logging…" : "Log session"}
      </button>
    </form>
  );
}

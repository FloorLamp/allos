"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { IconCheck } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import DateField from "@/components/DateField";
import type { PracticeLogOutcome } from "@/lib/types";
import { logPractice } from "@/app/(app)/wellness/actions";

// One-tap "Log session" button for a wellness practice (#1259). Logs a session for
// TODAY through the shared write core and answers from its typed outcome — NEVER an
// unconditional confirm (a session log is not idempotent; multi-session days are the
// point). Today's running count sits beside the button (the PRN widget shape) so a
// deliberate second tap is informed, not accidental. The button is a plain formatter
// over the one server action every practice surface shares.
export default function LogPracticeButton({
  practice,
  todayCount,
  atCeiling = false,
  today,
  defaultDurationMin = null,
  showDetails = false,
}: {
  practice: string;
  todayCount: number;
  atCeiling?: boolean;
  today?: string;
  defaultDurationMin?: number | null;
  showDetails?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [count, setCount] = useState(todayCount);
  const [duration, setDuration] = useState(
    defaultDurationMin == null ? "" : String(defaultDurationMin)
  );

  function report(outcome: PracticeLogOutcome) {
    if (outcome.kind === "logged") {
      setCount(outcome.count);
      toast(
        outcome.count === 1
          ? "Logged today's session"
          : `Logged — ${outcome.count} sessions today`
      );
      router.refresh();
      return;
    }
    toast("Couldn't log that session.");
  }

  async function onClick() {
    setPending(true);
    let outcome: PracticeLogOutcome;
    try {
      const fd = new FormData();
      fd.set("practice", practice);
      outcome = await logPractice(fd);
    } catch {
      setPending(false);
      toast("Couldn't log that session. Try again.");
      return;
    }
    setPending(false);
    report(outcome);
  }

  async function onDetailedSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    const fd = new FormData(form);
    fd.set("practice", practice);
    try {
      const outcome = await logPractice(fd);
      report(outcome);
      if (outcome.kind === "logged") {
        form.reset();
        setDuration(duration || "");
      }
    } catch {
      toast("Couldn't log that session. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-1">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={onClick}
          data-testid="practice-log-button"
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          <IconCheck className="h-4 w-4" stroke={2} aria-hidden />
          Log session
        </button>
        <span
          className="text-xs text-slate-500 dark:text-slate-400"
          data-testid="practice-today-count"
        >
          {count === 0
            ? "None logged today"
            : count === 1
              ? "1 logged today"
              : `${count} logged today`}
          {atCeiling ? " · that's plenty this week" : ""}
        </span>
      </div>
      {showDetails && today && (
        <details className="mt-2" data-testid="practice-log-details">
          <summary className="cursor-pointer text-xs font-medium text-brand-700 dark:text-brand-300">
            Add time, duration, or notes
          </summary>
          <form
            onSubmit={onDetailedSubmit}
            className="mt-2 grid gap-2 rounded-lg border border-black/10 p-3 dark:border-white/10 sm:grid-cols-2"
          >
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Date
              <DateField
                name="date"
                defaultValue={today}
                inputClassName="mt-1 w-full"
                required
              />
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Time
              <input type="time" name="time" className="input mt-1 w-full" />
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Duration (minutes)
              <input
                type="number"
                name="duration_min"
                min="1"
                step="1"
                value={duration}
                onChange={(event) => setDuration(event.target.value)}
                className="input mt-1 w-full"
              />
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400 sm:col-span-2">
              Notes
              <textarea name="notes" rows={2} className="input mt-1 w-full" />
            </label>
            <button
              type="submit"
              disabled={pending}
              className="btn w-fit disabled:opacity-50 sm:col-span-2"
              data-testid="practice-log-detailed-submit"
            >
              {pending ? "Logging…" : "Log with details"}
            </button>
          </form>
        </details>
      )}
    </div>
  );
}

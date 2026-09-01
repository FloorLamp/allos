"use client";

import { useState, type FormEvent } from "react";
import DateField from "@/components/DateField";
import InlineError from "@/components/InlineError";
import { useToast } from "@/components/Toast";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import {
  editPracticeSession,
  logPractice,
} from "@/app/(app)/wellness/actions";

// THE PRACTICE DOMAIN'S ONE FORM (#4424 ruling 1), named by
// `LOG_MANIFEST.practice.pieces.form`. `row` absent posts the log core; `row` present
// seeds from that row and posts the correction core under its own bounds. ONE layout —
// the mode decides seed and action only, never which fields exist.
//
// It replaces four spellings of the same five fields: this form (the Wellness card's
// modal and the backfill launcher), `PracticeSessionHistory`'s own edit form, the
// `/history` add door's, and that record row's correction. The door's and the row's
// each stated a START and no END, so a window a person had stated in the expanded form
// could only ever be corrected on the Wellness card — which is what "one form" fixes
// rather than documents.
//
// THE PRACTICE IS PART OF THE ROW'S ADDRESS, not a field a correction may move:
// `updatePracticeSession` rewrites date, window, duration and notes and never the
// name. So a mount that can CHOOSE hands the list and the picker renders; a mount
// standing on one practice hands one and it collapses. Both draw the same field set.
//
// THE SUBJECT IS OPTIONAL AND SPELLED ONCE (ruling 4): absent is the acting profile,
// present posts `profile_id` and is re-gated by `gateItemProfile` server-side.
//
// THE START/END PAIR IS RAW, and stays on the #2236 ratchet's allowlist for the reason
// its entry gives: a two-clock RANGE on one day is a shape `WhenControl` does not
// model. Converging the door and the record row onto this form moved two hand-rolled
// spellings ONTO the one allowlisted file rather than adding a fifth.

export interface PracticeSessionRow {
  id: number;
  date: string;
  startTime: string | null;
  endTime: string | null;
  durationMin: number | null;
  notes: string | null;
}

export default function PracticeSessionForm({
  practices,
  today,
  date,
  minDate,
  maxDate,
  defaultDurationMin = null,
  row,
  subjectProfileId,
  onSaved,
  onCancel,
}: {
  /** What this mount may write against. One entry collapses the picker. */
  practices: readonly string[];
  /** The SUBJECT's today. Only the confirmation reads it — a backfill that landed on
   *  a past day must not be told it landed on this one — and only the server's
   *  calendar knows it, so no mount derives it from a browser clock. */
  today: string;
  /** The day in hand (ruling 2). A seeded row's own date wins. */
  date: string;
  minDate?: string;
  maxDate?: string;
  /** What the duration starts at in ADD mode — `practiceDurationPrefill`, never
   *  re-derived here. A seeded row's own duration wins. */
  defaultDurationMin?: number | null;
  row?: PracticeSessionRow;
  subjectProfileId?: number;
  /** The write as the SERVER settled it: the day's running count in add mode, `null`
   *  for a correction, which answers with the row rather than with a count. */
  onSaved?: (logged: { count: number; date: string } | null) => void;
  /** Rendered only where there is somewhere to dismiss TO — a modal, a row's edit
   *  panel, a door. The backfill launcher is a standing section and offers none. */
  onCancel?: () => void;
}) {
  const toast = useToast();
  // WHICH SURFACE THIS WRITE CAME FROM (#3087), read off the region: one form renders
  // on the Wellness card, in the launcher, on the record's door and in its rows, and
  // the action cannot know which.
  const stampLoggedVia = useLoggedViaStamp();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [practice, setPractice] = useState(practices[0] ?? "");

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const fd = stampLoggedVia(new FormData(event.currentTarget));
    fd.set("practice", practice);
    if (subjectProfileId != null)
      fd.set("profile_id", String(subjectProfileId));
    if (row) fd.set("id", String(row.id));
    setPending(true);
    try {
      if (row) {
        const outcome = await editPracticeSession(fd);
        setPending(false);
        if (outcome.kind !== "updated") {
          setError(
            outcome.kind === "invalid-date"
              ? "Choose a date within 30 days of today."
              : "Couldn't find that session."
          );
          return;
        }
        setError(null);
        toast("Session updated");
        onSaved?.(null);
        return;
      }
      const outcome = await logPractice(fd);
      setPending(false);
      if (outcome.kind !== "logged") {
        setError("Couldn't log that session.");
        return;
      }
      setError(null);
      toast(
        outcome.date === today
          ? "Logged today's session"
          : "Logged past session"
      );
      onSaved?.({ count: outcome.count, date: outcome.date });
    } catch {
      setPending(false);
      setError("Couldn't save that session. Try again.");
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="grid gap-3 sm:grid-cols-2"
      data-testid="practice-log-details"
    >
      {practices.length > 1 ? (
        <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
          Practice
          <select
            className="input mt-1 w-full"
            value={practice}
            onChange={(event) => setPractice(event.target.value)}
            data-testid="practice-form-picker"
          >
            {practices.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
        Date
        <DateField
          name="date"
          defaultValue={row?.date ?? date}
          min={minDate}
          max={maxDate}
          inputClassName="mt-1 w-full"
          required
        />
      </label>
      {/* START AND END (#3142). Both optional and both presence-posted: an empty
          Start is the statement "this session has no instant", which `logPractice`
          reads as null rather than stamping the filing minute onto a past day. */}
      <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
        Start
        <input
          type="time"
          name="start_time"
          defaultValue={row?.startTime ?? ""}
          className="input mt-1 w-full"
        />
      </label>
      <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
        End
        <input
          type="time"
          name="end_time"
          defaultValue={row?.endTime ?? ""}
          min={row?.startTime ?? undefined}
          className="input mt-1 w-full"
        />
      </label>
      <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
        Duration (minutes)
        <input
          type="number"
          name="duration_min"
          min="1"
          step="1"
          defaultValue={row?.durationMin ?? defaultDurationMin ?? ""}
          className="input mt-1 w-full"
        />
      </label>
      {/* Both cores rewrite the note they are handed, so a form without this field
          would silently clear one somebody wrote. */}
      <label className="text-sm font-medium text-slate-700 dark:text-slate-200 sm:col-span-2">
        Notes
        <textarea
          name="notes"
          rows={2}
          defaultValue={row?.notes ?? ""}
          className="input mt-1 w-full"
        />
      </label>
      <InlineError>{error}</InlineError>
      <div className="flex items-end gap-2 sm:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="btn w-fit disabled:opacity-50"
          data-testid="practice-log-detailed-submit"
        >
          {pending ? "Saving…" : row ? "Save" : "Log session"}
        </button>
        {onCancel ? (
          <button className="btn-ghost" type="button" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

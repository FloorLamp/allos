"use client";

import { useState, type FormEvent } from "react";
import DateField from "@/components/DateField";
import InlineError from "@/components/InlineError";
import TimeRangeFields from "@/components/TimeRangeFields";
import { useTimezone } from "@/components/TimezoneProvider";
import { useToast } from "@/components/Toast";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import { editPracticeSession, logPractice } from "@/app/(app)/wellness/actions";
import { minutesBetween } from "@/lib/activity-meta";
import { practiceLogOutcomeText } from "@/lib/practice";
import SubmitButton from "@/components/SubmitButton";

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
// THE START/END PAIR IS THE HOUSE ONE (#4384 fix 6). It is still raw relative to
// `WhenControl` — a two-clock RANGE on one day is a shape that control does not model —
// but it is no longer this form's own: `components/TimeRangeFields.tsx` is the pair,
// and the activity form mounts the same one. What that buys here is #336's interplay,
// which this form did not have: a "now" on each clock, a ±duration offer that fills the
// other one, the third of {Start, End, Duration} DERIVED rather than typed twice, and
// an End before its Start refused in the same words the activity form refuses it in.

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
  const tz = useTimezone();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [practice, setPractice] = useState(practices[0] ?? "");
  // The window and the duration are CONTROLLED because they read each other (#336):
  // an uncoupled trio cannot offer a shortcut, cannot derive a third, and cannot know
  // that its end precedes its start. A seeded row's own values win, exactly as the
  // uncontrolled defaults they replace did.
  const [startTime, setStartTime] = useState(row?.startTime ?? "");
  const [endTime, setEndTime] = useState(row?.endTime ?? "");
  const [duration, setDuration] = useState(
    String(row?.durationMin ?? defaultDurationMin ?? "")
  );
  const timeError = !!startTime && !!endTime && endTime < startTime;
  // With both clocks stated the span IS the duration, so the field stops being a
  // second place to type one. `minutesBetween` is null for anything that is not a
  // positive span, so an inverted window derives nothing and the refusal below is what
  // the reader sees. The typed value is kept in state underneath: clearing a clock
  // hands the reader back what they had rather than an empty box.
  const span = minutesBetween(startTime, endTime);
  const typedDuration = Number(duration);
  // What the ± offers are worth: only a duration the reader actually stated.
  const derivableDurationMin =
    Number.isFinite(typedDuration) && typedDuration > 0 ? typedDuration : null;
  const shownDuration = span != null ? String(span) : duration;

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
      toast(practiceLogOutcomeText(outcome, today));
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
      <TimeRangeFields
        idPrefix="practice"
        startTime={startTime}
        endTime={endTime}
        tz={tz}
        timeError={timeError}
        derivableDurationMin={derivableDurationMin}
        startName="start_time"
        endName="end_time"
        onStartTime={setStartTime}
        onEndTime={setEndTime}
      />
      <div>
        <label className="label mb-0" htmlFor="practice-duration">
          Duration
        </label>
        <div className="relative mt-1">
          <input
            id="practice-duration"
            type="number"
            name="duration_min"
            inputMode="numeric"
            min="1"
            step="1"
            value={shownDuration}
            readOnly={span != null}
            onChange={(event) => setDuration(event.target.value)}
            className={`input pr-9 ${
              span != null ? "text-slate-500 dark:text-slate-400" : ""
            }`}
          />
          <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-slate-500 dark:text-slate-400">
            min
          </span>
        </div>
        {span != null && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Calculated from start and end.
          </p>
        )}
      </div>
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
        <SubmitButton
          variant="primary"
          disabled={pending || timeError}
          data-testid="practice-log-detailed-submit"
        >
          {pending ? "Saving…" : row ? "Save" : "Log session"}
        </SubmitButton>
        {onCancel ? (
          <button className="btn-ghost" type="button" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

"use client";

import { useState, type FormEvent } from "react";
import InlineError from "@/components/InlineError";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import { useTimezone } from "@/components/TimezoneProvider";
import WhenControl, { type WhenValue } from "@/components/WhenControl";
import { BRISTOL_STOOL_TYPES } from "@/lib/bristol-stool";
import { statedHhmm } from "@/lib/stated-time";
import { correctStoolReading, logStoolForm } from "@/app/(app)/stool-actions";
import SubmitButton from "@/components/SubmitButton";

// THE STOOL DOMAIN'S ONE FORM (#4424 ruling 1), named by
// `LOG_MANIFEST.stool.pieces.form`: the record's "Log a movement" door and that row's
// correction. `row` absent posts the log action on the day the mount is standing on;
// `row` present seeds from that row and posts the correction. ONE layout — the mode
// decides seed, action and which fields the row's ADDRESS has already fixed.
//
// THE INSTANT IS THE ADDRESS, WHICH IS WHY A CORRECTION HAS NO WHEN. A Bristol reading's
// natural key IS its instant (`logBristolStool`): restating the same minute upserts onto
// the row, and stating a different one writes a SECOND row beside it — so a date or time
// field in edit mode would not move the reading, it would fork it. This is `symptom`'s
// (date, symptom) argument on a different key. What a correction moves is the TYPE,
// which is the mis-tap #4433 names; a reading logged on the wrong day is a delete and a
// re-log, and the ⋯ offers both.
//
// A SELECT, NOT THE SEVEN ICONS. The picker is the domain's TAP surface
// (`StoolTypeControl`) and belongs where a tap is the whole interaction; inside a form
// the type is one field beside a date and a time, and the scale's own descriptions are
// what a reader picks against — which a full-width option list carries and a phone-sized
// icon caption cannot.
//
// THE SUBJECT IS OPTIONAL AND SPELLED ONCE (ruling 4): absent is the acting profile,
// present posts `profile_id` and is re-gated by `gateItemProfile`.

export interface StoolReadingRow {
  /** The `metric_samples` row id — the correction's whole address. */
  id: number;
  type: number;
}

export default function StoolForm({
  date,
  maxDate,
  row,
  subjectProfileId,
  defaultStatedAt = null,
  onSaved,
  onCancel,
}: {
  /** The day in hand (ruling 2) — the record day, never a re-derived today. */
  date: string;
  /** The subject's own today: any real past day is writable, never the future. */
  maxDate: string;
  row?: StoolReadingRow;
  subjectProfileId?: number;
  /**
   * A stated instant to OPEN on, spelled as `MeasurementsQuickAdd` spells it — the
   * window a day chart was showing when this door was opened (#4950). A default a
   * person can change, never a write.
   */
  defaultStatedAt?: string | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  // WHICH SURFACE THIS WRITE CAME FROM (#3087), read off the region: one form renders
  // in the record's door and on its rows, and the action cannot know which.
  const stampLoggedVia = useLoggedViaStamp();
  const tz = useTimezone();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState(row?.type ?? 4);
  // THE PAIR, held as one value (#2236 invariant 1). `date` opens on the day the reader
  // was looking at and `statedAt` opens on the instant the door was opened at, or EMPTY
  // — never defaulted to now, so a backfill that states no minute still states none and
  // the record renders it honestly.
  const [when, setWhen] = useState<WhenValue>(() => ({
    date,
    statedAt: defaultStatedAt,
  }));

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const fd = stampLoggedVia(new FormData(event.currentTarget));
    fd.set("type", String(type));
    if (subjectProfileId != null)
      fd.set("profile_id", String(subjectProfileId));
    if (row) fd.set("id", String(row.id));
    else {
      fd.set("date", when.date);
      // The absolute profile-local wall clock the action reads (#2053), empty when
      // nothing was stated — which the write core treats as "the moment IS now".
      const stated = statedHhmm(when.statedAt, tz);
      if (stated) fd.set("at", stated);
    }
    setPending(true);
    let result: { ok: boolean; error?: string };
    try {
      result = row ? await correctStoolReading(fd) : await logStoolForm(fd);
    } catch {
      setPending(false);
      setError("Couldn't save that movement.");
      return;
    }
    setPending(false);
    if (!result.ok) {
      setError(result.error || "Couldn't save that movement.");
      return;
    }
    setError(null);
    onSaved();
  }

  return (
    <form
      className="grid gap-2 sm:grid-cols-2"
      onSubmit={(event) => void submit(event)}
    >
      {row ? null : (
        <div className="sm:col-span-2">
          <WhenControl
            mode="state"
            grain="minute"
            value={when}
            onChange={setWhen}
            maxDate={maxDate}
            dateLabel="Date"
            timeLabel="Time it happened"
            testId="stool-form-when"
          />
        </div>
      )}
      <label className="text-xs text-slate-500 dark:text-slate-400 sm:col-span-2">
        Type
        <select
          data-testid="stool-form-type"
          value={type}
          onChange={(event) => setType(Number(event.target.value))}
          className="input mt-1 w-full"
        >
          {BRISTOL_STOOL_TYPES.map((entry) => (
            <option key={entry.type} value={entry.type}>
              {`Type ${entry.type} — ${entry.description}`}
            </option>
          ))}
        </select>
      </label>
      <InlineError>{error}</InlineError>
      <div className="flex items-end gap-2 sm:col-span-2">
        <SubmitButton
          variant="primary"
          data-testid="stool-form-save"
          disabled={pending}
        >
          {pending ? "Saving…" : row ? "Save" : "Add"}
        </SubmitButton>
        <button className="btn-ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

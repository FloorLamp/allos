"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import ModalShell from "@/components/ModalShell";
import MoodValencePicker from "@/components/MoodValencePicker";
import { saveSleepMoodEntry } from "./actions";
import { isRealIsoDate } from "@/lib/date";
import { moodLabel } from "@/lib/mood";
import type { SleepMoodHistoryRow } from "@/lib/sleep-summary";

type DialogProps =
  | {
      mode: "edit";
      row: SleepMoodHistoryRow;
      dateLabel: string;
    }
  | {
      mode: "add";
      history: SleepMoodHistoryRow[];
      defaultDate: string;
      minDate: string;
      maxDate: string;
    };

function emptyRow(date: string): SleepMoodHistoryRow {
  return {
    date,
    sleepHours: null,
    valence: null,
    moodDetails: null,
    stages: null,
    bedtimeSupplements: null,
    sleepEditable: true,
    sleepEditHours: null,
  };
}

function durationFields(hours: number | null): {
  hours: string;
  minutes: string;
} {
  if (hours == null) return { hours: "", minutes: "" };
  const totalMinutes = Math.round(hours * 60);
  return {
    hours: String(Math.floor(totalMinutes / 60)),
    minutes: String(totalMinutes % 60),
  };
}

export default function SleepMoodEditDialog(
  props: DialogProps & {
    onClose: () => void;
  }
) {
  const { onClose } = props;
  const initialDate =
    props.mode === "edit" ? props.row.date : props.defaultDate;
  const rowForDate = (date: string) =>
    props.mode === "edit"
      ? props.row
      : (props.history.find((entry) => entry.date === date) ?? emptyRow(date));
  const initialRow = rowForDate(initialDate);
  const [date, setDate] = useState(initialDate);
  const [row, setRow] = useState(initialRow);
  const router = useRouter();
  const sleepHoursRef = useRef<HTMLInputElement>(null);
  const initialDuration = durationFields(initialRow.sleepEditHours);
  const [sleepHours, setSleepHours] = useState(initialDuration.hours);
  const [sleepMinutes, setSleepMinutes] = useState(initialDuration.minutes);
  const [valence, setValence] = useState(initialRow.valence);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setDuration(row: SleepMoodHistoryRow) {
    const fields = durationFields(row.sleepEditHours);
    setSleepHours(fields.hours);
    setSleepMinutes(fields.minutes);
  }

  function changeDate(nextDate: string) {
    setDate(nextDate);
    if (!isRealIsoDate(nextDate)) return;
    const nextRow = rowForDate(nextDate);
    setRow(nextRow);
    setDuration(nextRow);
    setValence(nextRow.valence);
    setError(null);
  }

  const dateInvalid =
    !isRealIsoDate(date) ||
    (props.mode === "add" && (date < props.minDate || date > props.maxDate));
  const sleepEntered = sleepHours.trim() !== "" || sleepMinutes.trim() !== "";
  const parsedHours = sleepHours.trim() === "" ? 0 : Number(sleepHours);
  const parsedMinutes = sleepMinutes.trim() === "" ? 0 : Number(sleepMinutes);
  const sleepInvalid =
    sleepEntered &&
    (!Number.isInteger(parsedHours) ||
      !Number.isInteger(parsedMinutes) ||
      parsedHours < 0 ||
      parsedHours > 24 ||
      parsedMinutes < 0 ||
      parsedMinutes > 59 ||
      parsedHours * 60 + parsedMinutes < 1 ||
      parsedHours * 60 + parsedMinutes > 24 * 60);
  const sleepTotalMinutes = sleepInvalid
    ? null
    : parsedHours * 60 + parsedMinutes;
  const originalSleepMinutes =
    row.sleepEditHours == null ? null : Math.round(row.sleepEditHours * 60);
  const sleepChanged =
    row.sleepEditable &&
    sleepEntered &&
    sleepTotalMinutes != null &&
    sleepTotalMinutes !== originalSleepMinutes;
  const moodChanged = valence != null && valence !== row.valence;

  async function save() {
    if (dateInvalid || sleepInvalid || (!sleepChanged && !moodChanged)) return;
    setPending(true);
    setError(null);
    try {
      const entryData = new FormData();
      entryData.set("date", date);
      if (sleepChanged && sleepTotalMinutes != null) {
        entryData.set("sleep_hours", String(sleepTotalMinutes / 60));
      }
      if (moodChanged && valence != null) {
        entryData.set("valence", String(valence));
        if (row.moodDetails?.energy != null)
          entryData.set("energy", String(row.moodDetails.energy));
        if (row.moodDetails?.anxiety != null)
          entryData.set("anxiety", String(row.moodDetails.anxiety));
        for (const factor of row.moodDetails?.factors ?? [])
          entryData.append("factors", factor);
        if (row.moodDetails?.notes)
          entryData.set("note", row.moodDetails.notes);
      }
      const result = await saveSleepMoodEntry(entryData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    } catch {
      setError("Couldn’t save those changes. Try again.");
    } finally {
      setPending(false);
    }
  }

  const title = props.mode === "edit" ? `Edit ${props.dateLabel}` : "Add entry";

  return (
    <ModalShell
      title={title}
      onClose={onClose}
      initialFocusRef={row.sleepEditable ? sleepHoursRef : undefined}
      className="w-full max-w-lg rounded-xl bg-white p-4 shadow-xl outline-none sm:p-5 dark:bg-ink-900"
    >
      <div className="mt-4 space-y-5" data-testid="sleep-mood-edit-dialog">
        {props.mode === "add" && (
          <div>
            <label className="label mb-2 block" htmlFor="sleep-entry-date">
              Date
            </label>
            <DateField
              id="sleep-entry-date"
              value={date}
              onChange={changeDate}
              min={props.minDate}
              max={props.maxDate}
              required
              data-testid="sleep-entry-date"
            />
          </div>
        )}

        <section>
          <h3 className="label mb-2">Sleep duration</h3>
          {row.sleepEditable ? (
            <div>
              <div className="grid max-w-xs grid-cols-2 gap-3">
                <label className="text-xs text-slate-500 dark:text-slate-400">
                  Hours
                  <input
                    ref={sleepHoursRef}
                    type="number"
                    min="0"
                    max="24"
                    step="1"
                    inputMode="numeric"
                    className="input mt-1"
                    value={sleepHours}
                    onChange={(event) => setSleepHours(event.target.value)}
                    data-testid="sleep-history-edit-hours"
                  />
                </label>
                <label className="text-xs text-slate-500 dark:text-slate-400">
                  Minutes
                  <input
                    type="number"
                    min="0"
                    max="59"
                    step="1"
                    inputMode="numeric"
                    className="input mt-1"
                    value={sleepMinutes}
                    onChange={(event) => setSleepMinutes(event.target.value)}
                    data-testid="sleep-history-edit-minutes"
                  />
                </label>
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {row.sleepEditHours == null
                  ? "Adds a manual duration for this date."
                  : "Updates this date’s manual duration-only entry."}
              </p>
            </div>
          ) : (
            <p
              className="rounded-lg bg-slate-50 p-3 text-sm text-slate-500 dark:bg-ink-800 dark:text-slate-400"
              data-testid="sleep-history-edit-readonly"
            >
              Only duration-only manual entries can be edited here. Sleep
              windows and synced readings remain read-only.
            </p>
          )}
          {row.stages && (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Sleep stages are source data and remain read-only.
            </p>
          )}
        </section>

        <section>
          <h3 className="label mb-2">Mood</h3>
          <MoodValencePicker
            value={valence}
            onChange={setValence}
            disabled={pending}
            testIdPrefix="sleep-history-mood"
          />
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            {valence == null
              ? "Choose a rating to add mood for this date."
              : row.valence == null
                ? `${moodLabel(valence)} (${valence}/5).`
                : `${moodLabel(valence)} (${valence}/5). Changes the mood rating only; any detailed check-in stays intact.`}
          </p>
        </section>

        {dateInvalid && (
          <p className="text-sm text-rose-600 dark:text-rose-400">
            Choose a date within the visible log range.
          </p>
        )}
        {sleepInvalid && (
          <p className="text-sm text-rose-600 dark:text-rose-400">
            Enter a sleep duration from 1 minute to 24 hours.
          </p>
        )}
        {error && (
          <p
            className="text-sm text-rose-600 dark:text-rose-400"
            data-testid="sleep-mood-edit-error"
          >
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={
              pending ||
              dateInvalid ||
              sleepInvalid ||
              (!sleepChanged && !moodChanged)
            }
            onClick={save}
            data-testid="sleep-mood-edit-save"
          >
            {pending
              ? "Saving…"
              : props.mode === "edit"
                ? "Save changes"
                : "Save entry"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

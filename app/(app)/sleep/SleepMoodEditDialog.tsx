"use client";

import { useRef, useState } from "react";
import DateField from "@/components/DateField";
import ModalShell from "@/components/ModalShell";
import MoodValencePicker from "@/components/MoodValencePicker";
import FactEditorHost, {
  useFactEditor,
} from "@/components/facts/FactEditorHost";
import SleepFactRow from "@/components/sleep/SleepFactRow";
import { saveSleepMoodEntry } from "./actions";
import { isRealIsoDate } from "@/lib/date";
import {
  DEFAULT_FORMAT_PREFS,
  type DisplayFormatPrefs,
} from "@/lib/format-date";
import { moodLabel } from "@/lib/mood";
import {
  sleepFactSummary,
  sleepNightLabel,
  typicalSleepMinutes,
  type SleepFactKey,
} from "@/lib/sleep-facts";
import type { SleepMoodHistoryRow } from "@/lib/sleep-summary";

// The manual sleep-and-mood entry, stated in the shared facts-with-editors grammar
// (#3222 / #3218): after it opens, the dialog renders NO editors — it renders what it is
// about to write, and complexity is paid only per fact the person disagrees with.
//
// THE WRITE PATH IS UNTOUCHED. `saveSleepMoodEntry` receives the identical FormData it
// received before: the same keys, built from the same state, under the same
// changed-since-open guards. Only the presentation moved. This dialog was already fully
// state-controlled — it built its FormData by hand rather than letting the browser
// collect it from mounted inputs — which is what makes it safe for a closed panel to be
// unmounted rather than hidden.

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
    sleepSampleId: null,
    moodLogId: null,
    sleepSuspect: false,
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
    formatPrefs?: DisplayFormatPrefs;
  }
) {
  const { onClose, formatPrefs = DEFAULT_FORMAT_PREFS } = props;
  const initialDate =
    props.mode === "edit" ? props.row.date : props.defaultDate;
  const rowForDate = (date: string) =>
    props.mode === "edit"
      ? props.row
      : (props.history.find((entry) => entry.date === date) ?? emptyRow(date));

  // What the profile's own recent manual nights say a duration usually is. Available
  // only on the add path, which is the only path that has the history to read — an edit
  // opens one existing row and has no business borrowing another night's number.
  const typical =
    props.mode === "add" ? typicalSleepMinutes(props.history) : null;

  // A night with no manual duration of its own starts from that typical value, MARKED as
  // a suggestion (#846): the chip says where the number came from, and touching the
  // editor makes it the person's own. A profile with no manual nights to borrow from
  // gets a dashed prompt instead — nothing is invented silently.
  function seedDuration(row: SleepMoodHistoryRow): {
    hours: string;
    minutes: string;
    suggested: boolean;
  } {
    if (row.sleepEditHours != null)
      return { ...durationFields(row.sleepEditHours), suggested: false };
    if (row.sleepEditable && typical != null)
      return { ...durationFields(typical / 60), suggested: true };
    return { hours: "", minutes: "", suggested: false };
  }

  const initialRow = rowForDate(initialDate);
  const initialDuration = seedDuration(initialRow);
  const [date, setDate] = useState(initialDate);
  const [row, setRow] = useState(initialRow);
  const [sleepHours, setSleepHours] = useState(initialDuration.hours);
  const [sleepMinutes, setSleepMinutes] = useState(initialDuration.minutes);
  const [durationSuggested, setDurationSuggested] = useState(
    initialDuration.suggested
  );
  const [valence, setValence] = useState(initialRow.valence);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The one-editor-at-a-time state and its Done/Esc contract come from the shared
  // facts-with-editors primitive (#3218); this dialog supplies only its own fact keys.
  // The dialog body is the scope the primitive searches to hand focus back to the chip
  // that opened an editor (#3311) — the same element that answers its keydown.
  const factScopeRef = useRef<HTMLDivElement>(null);
  const { openEditor, open, close, onKeyDown } = useFactEditor<SleepFactKey>({
    scopeRef: factScopeRef,
  });

  function changeDate(nextDate: string) {
    setDate(nextDate);
    if (!isRealIsoDate(nextDate)) return;
    const nextRow = rowForDate(nextDate);
    setRow(nextRow);
    const seed = seedDuration(nextRow);
    setSleepHours(seed.hours);
    setSleepMinutes(seed.minutes);
    setDurationSuggested(seed.suggested);
    setValence(nextRow.valence);
    setError(null);
  }

  // Typing into the duration is what turns a borrowed number into a stated one.
  function editHours(next: string) {
    setSleepHours(next);
    setDurationSuggested(false);
  }
  function editMinutes(next: string) {
    setSleepMinutes(next);
    setDurationSuggested(false);
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
  const hasSomethingToSave = sleepChanged || moodChanged;

  // WHAT THE DISCARD GUARD READS (#3356). This dialog is not a `<form>` and has not
  // one named control — it composes its save by hand out of the state above — so the
  // dirty-form registry could only ever answer "clean" about it, and a flick or a
  // scrim tap on its host ModalShell discarded a stated mood with nothing asking.
  // `data-unsaved` on the body below is the answer it gives instead.
  //
  // AND IT IS DELIBERATELY NOT `hasSomethingToSave`, which is the obvious thing to
  // reach for and is WRONG here. On the add path a blank night borrows the profile's
  // typical duration (#846) — saveable the instant the dialog opens, and nobody typed
  // it. Publishing that as unsaved input puts a "Discard your changes?" in front of a
  // person who has done nothing but open the dialog, which is the click-through the
  // guard exists to avoid. The registry draws the same line for its own fields:
  // dirty means EDITED, never merely "holds a value".
  //
  // So this is the other question — has anything moved since this opened? — asked the
  // way `lib/offline/drafts.ts#shouldPersistDraft` and the activity editor's autosave
  // both ask it: one signature, compared against the one the surface mounted with.
  //
  // THESE ARE THE RAW FIELD STRINGS ON PURPOSE, AND DO NOT NORMALISE THEM. A duration
  // the person typed but that does not parse — "99" hours — is unsaveable, so
  // `hasSomethingToSave` is false about it and the Save button stays disabled. It is
  // still something they typed and still something a flick would throw away, and the
  // ONLY reason the guard catches it is that "99" differs textually from what this
  // mounted with. Trimming, parsing or rounding this signature would silently delete
  // that guard while every test stayed green — which is the exact shape of the two
  // bugs this whole change exists to close (#3352, #3356).
  const stateSignature = [date, sleepHours, sleepMinutes, valence ?? ""].join(
    "|"
  );
  // Lazy initial state rather than a ref: this IS read during render, which is what
  // `react-hooks/refs` refuses a ref for, and "the value this mounted with" is exactly
  // what a lazy initializer is.
  const [openedWith] = useState(() => stateSignature);
  const hasUnsavedEdit = stateSignature !== openedWith;

  const summary = sleepFactSummary({
    // An edit's date is stated by the dialog's own title and is not editable, so it is
    // not a chip: a disclosure that opens onto nothing is worse than no disclosure.
    nightLabel:
      props.mode === "add"
        ? sleepNightLabel(date, props.maxDate, formatPrefs)
        : null,
    durationMinutes: sleepEntered && !sleepInvalid ? sleepTotalMinutes : null,
    durationEditable: row.sleepEditable,
    importedMinutes:
      row.sleepHours == null ? null : Math.round(row.sleepHours * 60),
    durationSuggested,
    valence,
  });

  async function save() {
    if (dateInvalid || sleepInvalid || !hasSomethingToSave) return;
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
    } catch {
      setError("Couldn’t save those changes. Try again.");
    } finally {
      setPending(false);
    }
  }

  const title = props.mode === "edit" ? `Edit ${props.dateLabel}` : "Add entry";

  function renderPanel() {
    switch (openEditor) {
      case "night":
        return (
          props.mode === "add" && (
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
          )
        );
      case "duration":
        return (
          <section>
            <h3 className="label mb-2">Sleep duration</h3>
            {row.sleepEditable ? (
              <div>
                <div className="grid max-w-xs grid-cols-2 gap-3">
                  <label className="text-xs text-slate-500 dark:text-slate-400">
                    Hours
                    <input
                      type="number"
                      min="0"
                      max="24"
                      step="1"
                      inputMode="numeric"
                      className="input mt-1"
                      value={sleepHours}
                      onChange={(event) => editHours(event.target.value)}
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
                      onChange={(event) => editMinutes(event.target.value)}
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
        );
      case "mood":
        return (
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
        );
      case null:
        return null;
    }
  }

  return (
    <ModalShell title={title} onClose={onClose} size="sm">
      {/* No initialFocusRef: a summary-first surface opens onto a row of chips, not
          onto a field, so there is no one input to land in. The shared focus trap
          focuses the first chip, which is the fact the person is most likely to
          correct. */}
      <div
        ref={factScopeRef}
        className="space-y-5"
        data-testid="sleep-mood-edit-dialog"
        // THIS DIALOG ANSWERS FOR ITSELF (#3356). See `hasUnsavedEdit` above: the
        // registry tracks named controls inside a `<form>`, and this surface has
        // neither, so without this the discard guard on the host ModalShell was
        // permanently absent. `components/DirtyFormRegistry.tsx` reads the attribute
        // and resolves it the fail-safe way (`unsavedAnswerForForm`).
        //
        // TO THE READER WHO WANTS TO DELETE IT as untested instrumentation: it is not
        // instrumentation, it is the signal the guard runs on, and
        // e2e/sleep-page.spec.ts dismisses this dialog by GESTURE to prove it. That
        // spec also asserts it reads "false" on open, which is the half a borrowed
        // duration would quietly break.
        data-unsaved={hasUnsavedEdit ? "true" : "false"}
        onKeyDown={onKeyDown}
      >
        {openEditor == null ? (
          <SleepFactRow
            summary={summary}
            openEditor={openEditor}
            onOpen={open}
          />
        ) : (
          <FactEditorHost
            testId="sleep-editor"
            doneTestId="sleep-editor-done"
            panel={openEditor}
            onDone={close}
          >
            {renderPanel()}
          </FactEditorHost>
        )}

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
              pending || dateInvalid || sleepInvalid || !hasSomethingToSave
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

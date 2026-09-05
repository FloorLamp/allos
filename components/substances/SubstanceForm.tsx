"use client";

import { useState, type FormEvent } from "react";
import WhenControl, { type WhenValue } from "@/components/WhenControl";
import InlineError from "@/components/InlineError";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import { useToast } from "@/components/Toast";
import { MAX_SUBSTANCE_ENTRY_AMOUNT, substanceDef } from "@/lib/substance-use";
import {
  addSubstanceDailyTotalAction,
  correctSubstanceUseAction,
} from "@/app/(app)/medical/substance-use/actions";
import SubmitButton from "@/components/SubmitButton";

// THE SUBSTANCE DOMAIN'S ONE FORM (#4424 ruling 1), named by
// `LOG_MANIFEST.substance.pieces.form`, replacing the `/history` add door's spelling,
// that record row's correction and the substance card's add/edit pair. `row` absent
// posts the log action; `row` present seeds from that row and posts the correction
// action under its core's bounds. ONE layout — the mode decides seed and action only.
//
// THE AMOUNT CARRIES ITS UNIT (#4211, absorbed here): "Amount" alone means standard
// drinks on one row and uses on the next.
//
// THE SUBSTANCE IS PART OF THE ROW'S ADDRESS, not a field a correction may move — a
// use is addressed by its event id, which already knows its substance — so a mount that
// can choose hands the list, one that cannot hands a single entry and its picker
// collapses away. The key posts from state on the ADD door; the correction door does
// not post it at all.
//
// THE SUBJECT IS OPTIONAL AND SPELLED ONCE (ruling 4): absent is the acting profile,
// present posts `profile_id` and is re-gated by `gateItemProfile`.
//
// EVERY SUBSTANCE MAY STATE A TIME (#3295 phase 1, widened by #5026 phase 2). A time
// was offered for alcohol alone while the other keys rode a structurally timeless day
// counter, because offering one there would have collected a value the store then threw
// away. Both ledgers carry `occurred_at` + `time_source` now, so the shared
// `WhenControl` replaces the bare date at every mount and the `DateField` branch is
// gone with the state it existed for. The control owns the PAIR (#2236 invariant 1): a
// stated instant's profile-local date IS the entry's date, and changing the day
// re-anchors or clears the time rather than leaving the two to disagree. `timeRequired`
// is false and `mode="state"`, so an untouched field emits null — a use with no stated
// time is still a use, and nothing invents one (#2053).
//
// EDIT MODE CORRECTS ONE EVENT, NOT A DAY (#5026 phase 2). A consumable is an EVENT
// (owner ruling, 2026-09-04), so what a correction moves is this use's day and the
// minute stated for it. TWO FIELDS THAT WERE HERE ARE NOT: the amount, because one
// event is one unit and there is no day count left to restate; and the day's NOTE,
// which stays a fact about the day rather than about any use under it — #5077 owns
// where a day note lives now, and this is the phase it was sequenced behind. A DRINK
// never reaches edit mode at all: its record row carries the FOOD edit payload and
// corrects through the serving's own form.

export interface SubstanceChoice {
  key: string;
  label: string;
}

/** One recorded use, as the correction door addresses it (#5026 phase 2). */
export interface SubstanceEntryRow {
  eventId: number;
  substance: string;
  date: string;
  /** The stated use instant, or null for the commonest answer: nobody said. */
  statedAt: string | null;
}

export default function SubstanceForm({
  substances,
  date,
  maxDate,
  row,
  subjectProfileId,
  onSaved,
  onCancel,
  testId,
}: {
  /** What this mount may write against. One entry collapses the picker. */
  substances: readonly SubstanceChoice[];
  /** The day in hand (ruling 2). A seeded row's own date wins. */
  date: string;
  maxDate: string;
  row?: SubstanceEntryRow;
  subjectProfileId?: number;
  onSaved: () => void;
  onCancel: () => void;
  testId?: string;
}) {
  const toast = useToast();
  // WHICH SURFACE THIS WRITE CAME FROM (#3087), read off the region: one form renders
  // on the record, in the card's modal and in a row, and the action cannot know which.
  const stampLoggedVia = useLoggedViaStamp();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [substance, setSubstance] = useState(
    row?.substance ?? substances[0]?.key ?? ""
  );
  const unit = substanceDef(substance).unitPlural;
  const [when, setWhen] = useState<WhenValue>({
    date: row?.date ?? date,
    // Seeded from the row's own `occurred_at`, so a correction opens on the minute the
    // person actually stated and a re-save does not silently clear it.
    statedAt: row?.statedAt ?? null,
  });

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const fd = stampLoggedVia(new FormData(event.currentTarget));
    fd.set("date", when.date);
    // ALWAYS POSTED, EVEN EMPTY. An absent field means "leave the row's instant alone"
    // and an empty one means "clear it" (the correction action's three states), so a
    // form that omitted the field when the control is empty could never clear a time
    // somebody wants gone.
    fd.set("stated_at", when.statedAt ?? "");
    if (subjectProfileId != null)
      fd.set("profile_id", String(subjectProfileId));
    setPending(true);
    let result;
    try {
      if (row) {
        fd.set("event_id", String(row.eventId));
        result = await correctSubstanceUseAction(fd);
      } else {
        fd.set("substance", substance);
        result = await addSubstanceDailyTotalAction(fd);
      }
    } catch {
      setPending(false);
      setError("Couldn't save that entry.");
      return;
    }
    setPending(false);
    if (result.kind !== "added" && result.kind !== "updated") {
      setError(refusal(result.kind));
      return;
    }
    setError(null);
    // THE CAP VERDICT RIDES THE SAVE, at every mount (#998/#3279): the tap surfaces
    // render it beside the button and the form surfaces had no readout at all. Derived
    // by the action AFTER the write, and null for a profile that set no cap. A
    // correction moves no count, so it has none to name.
    toast(
      result.kind === "updated"
        ? "Corrected."
        : ["Added to the record.", result.capProgress].filter(Boolean).join(" ")
    );
    onSaved();
  }

  return (
    <form
      className="grid gap-2 sm:grid-cols-2"
      onSubmit={(event) => void submit(event)}
      data-testid={testId}
    >
      {!row && substances.length > 1 ? (
        <label className="text-xs text-slate-500 dark:text-slate-400">
          Substance
          <select
            className="input mt-1 w-full"
            value={substance}
            onChange={(event) => setSubstance(event.target.value)}
          >
            {substances.map((choice) => (
              <option key={choice.key} value={choice.key}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="text-xs text-slate-500 dark:text-slate-400 sm:col-span-2">
        When
        <div className="mt-1">
          <WhenControl
            mode="state"
            grain="minute"
            value={when}
            onChange={setWhen}
            maxDate={maxDate}
            timeLabel="Time"
            testId="substance-when"
          />
        </div>
      </div>
      {/* THE ADD DOOR'S FIELDS, and only the add door's. A correction addresses ONE
          use, so there is no amount to restate and no day note to rewrite through it
          (#5026 phase 2). */}
      {row ? null : (
        <>
          <label className="text-xs text-slate-500 dark:text-slate-400">
            {`Amount (${unit})`}
            <input
              type="number"
              name="amount"
              min={1}
              max={MAX_SUBSTANCE_ENTRY_AMOUNT}
              step={1}
              defaultValue={1}
              required
              className="input mt-1 w-full"
            />
          </label>
          <label className="text-xs text-slate-500 dark:text-slate-400 sm:col-span-2">
            Notes
            <textarea name="notes" rows={2} className="input mt-1 w-full" />
          </label>
        </>
      )}
      <InlineError>{error}</InlineError>
      <div className="flex items-end gap-2 sm:col-span-2">
        <SubmitButton variant="primary" disabled={pending}>
          {pending ? "Saving…" : row ? "Save" : "Add"}
        </SubmitButton>
        <button className="btn-ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// The refusals both modes reach, in one copy. `invalid-stated-at` is the correction
// door's own: the statement IS its submission there, so a refused instant costs the
// save and is said rather than silently dropped (#2296) — the log door's opposite
// posture keeps the use and loses only the minute, so it never reaches this map.
const REFUSALS: Record<string, string> = {
  "invalid-date": "Enter a valid date.",
  "invalid-amount": `Enter an amount between 1 and ${MAX_SUBSTANCE_ENTRY_AMOUNT}.`,
  "invalid-stated-at": "Enter a time on that day, not in the future.",
};
const refusal = (kind: string) => REFUSALS[kind] ?? "Couldn't save that entry.";

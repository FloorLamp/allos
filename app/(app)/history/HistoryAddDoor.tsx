"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import InlineError from "@/components/InlineError";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import { useToast } from "@/components/Toast";
import { logFoodServing } from "@/app/(app)/nutrition/actions";
import { logPractice } from "@/app/(app)/wellness/actions";
import { addSubstanceDailyTotalAction } from "@/app/(app)/medical/substance-use/actions";
import { addBodyMetric } from "@/app/(app)/trends/body-actions";
import { validateBodyMetricInput } from "@/lib/body-metric-input";
import { FOOD_GROUPS } from "@/lib/food-groups";
import { FOOD_SLOTS } from "@/lib/food-slot";
import type { WeightUnit } from "@/lib/settings";

// THE ADD DOOR RESOLVES IN PLACE (#4045 §1), which is what #3958 asked for and what
// only the dose kind shipped: "one door, kind-resolved — filtered to a kind it IS that
// kind's backfill". The other four kinds rendered plain redirect links, so the page
// built for FINDING a gap in the record sent the reader somewhere else to fill it and
// lost the day they were looking at on the way. `body` was the loudest of them: it
// pointed at `/trends/metric/weight`, as if a body reading were only ever a weight.
//
// NO SIXTH WRITE CORE. Each form below posts the domain's own create action —
// `logFoodServing`, `logPractice`, `addSubstanceDailyTotalAction`, `addBodyMetric` —
// exactly as HistoryRows' correction forms post that domain's own update action. Each
// one re-checks write access server-side, so the door is an affordance and never a gate.
//
// THE CONTROL KEEPS ONE IDENTITY while its form is open, and dismissal belongs to the
// form. `DoseBackfillLauncher` swaps its label to "Cancel" — that is #3911's defect,
// re-housed here with the launcher, and copying its shape into four more controls is
// exactly the "never inherit the defect" #2816 warns about. The dose door's own repair
// is #3911's to land.
//
// THE DATE OPENS ON THE DAY THE READER WAS LOOKING AT, not on today: the whole reason
// to add from here is a gap you just found. Bounded by today at every kind, which is
// the record's own never-the-future rule.

const KIND_LABEL = {
  food: "Log food",
  practice: "Log a practice",
  substance: "Log a use",
  body: "Log a reading",
} as const;

export type HistoryAddKind = keyof typeof KIND_LABEL;

/** The per-kind vocabulary the server reads once for the page. */
export interface HistoryAddVocabulary {
  /** Practices this profile tracks. An empty list renders no practice door. */
  practices: string[];
  /** This profile's substance keys, with the label its record prints. */
  substances: { key: string; label: string }[];
  /** The login's weight unit — what the value the reader types is in. */
  weightUnit: WeightUnit;
}

export default function HistoryAddDoor({
  kind,
  date,
  maxDate,
  vocabulary,
}: {
  kind: HistoryAddKind;
  /** The day the reader is looking at, or today. */
  date: string;
  maxDate: string;
  vocabulary: HistoryAddVocabulary;
}) {
  const router = useRouter();
  const toast = useToast();
  // WHICH SURFACE THIS WRITE CAME FROM (#3087). The record is a page and `page` is what
  // this resolves to, but it is declared rather than left to the action's fallback:
  // three of these four actions read the surface off the post, and an undeclared
  // mounting answers `page` whether or not it is one.
  const stampLoggedVia = useLoggedViaStamp();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (kind === "practice" && vocabulary.practices.length === 0) return null;
  if (kind === "substance" && vocabulary.substances.length === 0) return null;

  function close(): void {
    setOpen(false);
    setError(null);
  }

  // One submit path for four forms: post, report a refusal inline, and on success
  // re-read the feed so the row the reader just wrote is IN the record they are
  // looking at. Without the refresh the door would write silently and read as dead —
  // the same complaint as the redirect it replaces.
  async function post(
    event: FormEvent<HTMLFormElement>,
    run: (fd: FormData) => Promise<string | null>
  ): Promise<void> {
    event.preventDefault();
    const fd = stampLoggedVia(new FormData(event.currentTarget));
    setError(null);
    setPending(true);
    let failure: string | null;
    try {
      failure = await run(fd);
    } catch {
      failure = "Couldn't save that entry.";
    }
    setPending(false);
    if (failure) {
      setError(failure);
      return;
    }
    toast("Added to the record.");
    close();
    router.refresh();
  }

  const dateField = (
    <label className="text-xs text-slate-500 dark:text-slate-400">
      Date
      <DateField
        name="date"
        defaultValue={date}
        max={maxDate}
        required
        inputClassName="mt-1 w-full"
      />
    </label>
  );

  const buttons = (
    <div className="flex items-end gap-2">
      <button className="btn" type="submit" disabled={pending}>
        {pending ? "Saving…" : "Add"}
      </button>
      <button className="btn-ghost" type="button" onClick={close}>
        Cancel
      </button>
    </div>
  );

  function form(): ReactNode {
    switch (kind) {
      case "food":
        return (
          <form
            className="grid gap-2 sm:grid-cols-2"
            onSubmit={(event) =>
              void post(event, async (fd) => {
                const outcome = await logFoodServing(fd);
                return outcome.ok ? null : outcome.error;
              })
            }
          >
            {dateField}
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Food group
              <select name="group_key" className="input mt-1 w-full">
                {FOOD_GROUPS.map((group) => (
                  <option key={group.slug} value={group.slug}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Meal
              <select name="meal_slot" className="input mt-1 w-full">
                {FOOD_SLOTS.map((slot) => (
                  <option key={slot}>{slot}</option>
                ))}
              </select>
            </label>
            {buttons}
          </form>
        );
      case "practice":
        return (
          <form
            className="grid gap-2 sm:grid-cols-2"
            onSubmit={(event) =>
              void post(event, async (fd) => {
                const outcome = await logPractice(fd);
                return outcome.kind === "logged"
                  ? null
                  : "Couldn't log that session.";
              })
            }
          >
            {dateField}
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Practice
              <select name="practice" className="input mt-1 w-full">
                {vocabulary.practices.map((practice) => (
                  <option key={practice}>{practice}</option>
                ))}
              </select>
            </label>
            {/* A BACKFILLED SESSION STATES NO CLOCK, and the field is posted EMPTY
                rather than omitted: `logPractice` reads presence, not value (#2204),
                so an absent field means "you have the clock" and would stamp the
                filing instant onto a day that is not today. Empty is the honest
                statement — this session has no minute. Correcting one stays on the
                practice card, where the full editor is. */}
            <input type="hidden" name="time" value="" />
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Duration (minutes)
              <input
                type="number"
                name="duration_min"
                min={1}
                className="input mt-1 w-full"
              />
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400 sm:col-span-2">
              Notes
              <input type="text" name="notes" className="input mt-1 w-full" />
            </label>
            {buttons}
          </form>
        );
      case "substance":
        return (
          <form
            className="grid gap-2 sm:grid-cols-2"
            onSubmit={(event) =>
              void post(event, async (fd) => {
                const outcome = await addSubstanceDailyTotalAction(fd);
                return outcome.kind === "added"
                  ? null
                  : "Couldn't save that entry.";
              })
            }
          >
            {dateField}
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Substance
              <select name="substance" className="input mt-1 w-full">
                {vocabulary.substances.map((substance) => (
                  <option key={substance.key} value={substance.key}>
                    {substance.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Amount
              <input
                type="number"
                name="amount"
                min={1}
                defaultValue={1}
                className="input mt-1 w-full"
                required
              />
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400 sm:col-span-2">
              Notes
              <input type="text" name="notes" className="input mt-1 w-full" />
            </label>
            {buttons}
          </form>
        );
      case "body":
        return (
          <form
            className="grid gap-2 sm:grid-cols-2"
            onSubmit={(event) =>
              void post(event, async (fd) => {
                // THE ACTION SILENTLY SKIPS an out-of-range number, so a reader who
                // typed one would watch the door close over nothing. The same pure
                // guard the two weight quick-adds run answers first.
                const refusal = validateBodyMetricInput({
                  weight: fd.get("weight") as string | null,
                  bodyFatPct: fd.get("body_fat_pct") as string | null,
                  restingHr: fd.get("resting_hr") as string | null,
                });
                if (refusal) return refusal;
                await addBodyMetric(fd);
                return null;
              })
            }
          >
            {dateField}
            {/* EVERY BODY MEASURE THE RECORD SHOWS, not weight alone — `body_metrics`
                holds three quantities per day and `bodyMetricMeasures` fans all three
                onto the feed, so a door that took only a weight could not backfill two
                thirds of the rows it sits above. `addBodyMetric` writes whichever
                fields carry a value. */}
            <label className="text-xs text-slate-500 dark:text-slate-400">
              {`Weight (${vocabulary.weightUnit})`}
              <input
                type="number"
                step="any"
                name="weight"
                className="input mt-1 w-full"
              />
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Body fat (%)
              <input
                type="number"
                step="any"
                name="body_fat_pct"
                className="input mt-1 w-full"
              />
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Resting HR (bpm)
              <input
                type="number"
                name="resting_hr"
                className="input mt-1 w-full"
              />
            </label>
            {buttons}
          </form>
        );
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn-ghost btn-sm shrink-0"
        aria-expanded={open}
        data-testid={`history-add-open-${kind}`}
        onClick={() => setOpen((value) => !value)}
      >
        {KIND_LABEL[kind]}
      </button>
      {open ? (
        <div className="mt-2" data-testid={`history-add-panel-${kind}`}>
          {form()}
          <InlineError data-testid={`history-add-error-${kind}`}>
            {error}
          </InlineError>
        </div>
      ) : null}
    </>
  );
}

"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import WhenControl from "@/components/WhenControl";
import { statedHhmm, type WhenValue } from "@/lib/stated-time";
import { useTimezone } from "@/components/TimezoneProvider";
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
//
// AND THE WHEN IS `WhenControl`, WHICH #3958 NAMES — "WhenControl absolutes only,
// #2236 invariant 4". Phase 1's doors carried a bare date and posted the time EMPTY on
// purpose, because the alternative on offer was an eleventh hand-rolled
// <input type="time"> and the #2236 ratchet refuses those, correctly. The shared
// control is the answer that was missing, and #4060 converged the quick logger's
// vocabulary onto it, so there is no longer a second spelling to collide with.
//
// It buys the thing the empty field could not: a reader backfilling yesterday's 7am
// session can SAY 7am. What it does not do is invent one — invariant 3, an untouched
// time field stays empty and emits null, so a backfill that states nothing still
// states nothing, which is the behaviour phase 1 was protecting.
//
// TWO KINDS KEEP A BARE DATE, and neither is an oversight:
//   • SUBSTANCE — `substance_daily_totals` is a DAY TOTAL. It has a `recorded_at`
//     (when the use was logged) and no event instant at all, which is why the record
//     renders these rows date-only and sinks them below the day's timed ones. A time
//     field here would collect a statement with nowhere to be stored.
//   • BODY — `body_metrics.occurred_at` exists (migration 165, #2235) and the write
//     core takes it, but `addBodyMetric` deliberately states no time, and its
//     find-then-write CLEARS the column on an empty submission while leaving it alone
//     for a time-blind one. Choosing between those is a decision about the body
//     domain's write contract, not about this door, so it is raised rather than
//     guessed at here.

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
  const tz = useTimezone();
  // THE PAIR, held as one value (#2236 invariant 1). `date` opens on the day the
  // reader was looking at and `statedAt` opens EMPTY — never defaulted to now.
  const [when, setWhen] = useState<WhenValue>({ date, statedAt: null });
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

  // The DATE-ONLY kinds' field. Still `DateField` rather than a `WhenControl` with the
  // time hidden: a control rendered without half of itself is a variant, and these two
  // kinds are date-only in the SCHEMA rather than by presentation choice.
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

  // The TIMED kinds' field, and the day and the minute come out of it together.
  // `mode="state"` because a backfill is an assertion rather than an amendment, and
  // `timeRequired` is false because stating a time is optional here — the record's own
  // clock grammar already has an honest rendering for a row that names none.
  const whenField = (
    <div className="sm:col-span-2">
      <WhenControl
        mode="state"
        grain="minute"
        value={when}
        onChange={setWhen}
        maxDate={maxDate}
        dateLabel="Date"
        timeLabel="Time"
        testId={`history-add-when-${kind}`}
      />
      {/* THE WIRE SHAPE IS THE DOMAIN'S, and both of these actions read an ABSOLUTE
          profile-local wall clock rather than a client instant — the server resolves
          it against its own clock and the profile's timezone (#2053), so no browser
          has to be trusted with the answer. `statedHhmm` is the one conversion, and
          it returns "" for an unstated instant, which is exactly the empty string
          both actions read as "no time was stated". */}
      <input type="hidden" name="date" value={when.date} />
    </div>
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
                // The eating-time statement (#2053), as the wall clock the action
                // reads. Empty when nothing was stated, which `logFoodServing`
                // already treats as "no eating time" rather than as a refusal.
                fd.set("occurred_at", statedHhmm(when.statedAt, tz));
                const outcome = await logFoodServing(fd);
                return outcome.ok ? null : outcome.error;
              })
            }
          >
            {whenField}
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
            {whenField}
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Practice
              <select name="practice" className="input mt-1 w-full">
                {vocabulary.practices.map((practice) => (
                  <option key={practice}>{practice}</option>
                ))}
              </select>
            </label>
            {/* THE FIELD IS ALWAYS POSTED, AND ITS VALUE IS NOW THE READER'S.
                `logPractice` reads PRESENCE, not value (#2204): an absent `time`
                means "you have the clock" and would stamp the filing instant onto a
                day that is not today, so this stays present unconditionally. What
                changed is that its value is the wall clock WhenControl collected
                instead of a hardcoded empty string — and an unstated time still
                resolves to "", which is the same honest "this session has no
                minute" the door has always been able to say. */}
            <input
              type="hidden"
              name="time"
              value={statedHhmm(when.statedAt, tz)}
            />
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

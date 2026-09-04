"use client";

import { useState } from "react";
import InlineError from "@/components/InlineError";
import WhenControl from "@/components/WhenControl";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import { useTimezone } from "@/components/TimezoneProvider";
import {
  statedHhmm,
  statedInstantOnDate,
  type WhenValue,
} from "@/lib/stated-time";
import { eatingHoursOnDate } from "@/lib/food-eating-time";
import {
  FOOD_SLOTS,
  foodSlotForHhmm,
  type FoodSlot,
  type FoodSlotBoundaries,
} from "@/lib/food-slot";
import {
  logFoodServing,
  updateFoodLogEvent,
  type FoodEventEditResult,
} from "@/app/(app)/nutrition/actions";
import SubmitButton from "@/components/SubmitButton";

// THE FOOD DOMAIN'S ONE FORM (#4424 ruling 1), named by `LOG_MANIFEST.food.pieces.form`.
// `row` absent posts `logFoodServing`; `row` present seeds from that row and posts
// `updateFoodLogEvent` under that core's own bounds. ONE layout — the mode decides seed
// and action only, never which fields exist.
//
// IT REPLACES THREE SPELLINGS, and each had dropped something the others kept: the
// `/history` add door stated a time but had no meal-follows-the-hour; the record row's
// correction had NO TIME FIELD AT ALL, so a serving filed at the wrong hour was
// correctable on the nutrition page and nowhere else; the bar's modal had both and was
// the only one that could clear a statement. All three now do all three.
//
// WHAT THE MODE CHANGES, and why neither is a field-membership flag: a CORRECTION picks
// from the day's own offered hours and can choose "Not stated" to clear a statement
// somebody made, which is a thing only an existing row has; an ADD states a minute and
// has nothing to clear. Both draw the same three fields.
//
// THE MOUNT ANNOUNCES, NOT THE FORM, and food is the domain where that matters. Its
// siblings toast from inside; the nutrition bar's channel is PROFILE-SCOPED, because a
// correction resolving after a profile switch must not surface a note about the previous
// subject's food. A toast fired from in here could not know which scope it was in.
//
// THE SUBJECT IS OPTIONAL AND SPELLED ONCE (ruling 4): absent is the acting profile,
// present posts `profile_id` and is re-gated server-side by `gateItemProfile`.

// WHAT THE WRITE SETTLED, carried back so a mount with its own projection adopts the
// SERVER's figures rather than its guess (the `SymptomForm` contract). A correction
// answers with both placements — the coordinate it vacated and the one it landed on.
export type FoodServingSaved =
  | { kind: "added" }
  | ({ kind: "corrected" } & Omit<
      Extract<FoodEventEditResult, { ok: true }>,
      "ok"
    >);

export interface FoodGroupChoice {
  slug: string;
  name: string;
}

/** The serving being corrected, as every mount already holds it. */
export interface FoodServingRow {
  eventId: number;
  groupKey: string;
  date: string;
  mealSlot: FoodSlot;
  /** Profile-local "HH:MM" the serving was EATEN at, or null when nobody stated one. */
  eatenAt: string | null;
  /** Profile-local "HH:MM" of the tap instant. Never edited; it names the alternative. */
  loggedAt: string | null;
}

export default function FoodServingForm({
  groups,
  date,
  slot,
  slotBoundaries,
  minDate,
  maxDate,
  row,
  subjectProfileId,
  defaultStatedAt = null,
  tz: tzProp,
  onSaved,
  onCancel,
  testId,
}: {
  /** The catalog this mount may write against, in the order it should be read. */
  groups: readonly FoodGroupChoice[];
  /** The day in hand (ruling 2). A seeded row's own date wins. */
  date: string;
  /** The meal a bare add files into. A seeded row's own window wins. */
  slot?: FoodSlot;
  /** The SUBJECT's bucket schedule, so the meal follows the hour on their own day. */
  slotBoundaries: FoodSlotBoundaries;
  minDate?: string;
  maxDate: string;
  row?: FoodServingRow;
  subjectProfileId?: number;
  /**
   * A stated instant to OPEN on, spelled as `MeasurementsQuickAdd` spells it — the
   * window a day chart was showing when this door was opened (#4950). A default a
   * person can change, never a write; a seeded row's own instant beats it, and the
   * meal follows this hour exactly as it follows an hour the person picks.
   */
  defaultStatedAt?: string | null;
  /** The SUBJECT's zone (#4009 item 1); the acting profile's when a mount omits it. */
  tz?: string;
  onSaved: (saved: FoodServingSaved) => void;
  onCancel: () => void;
  /**
   * The marker prefix every field on this form hangs off — `{testId}-group`,
   * `-slot`, `-when`, `-save`, `-cancel`, `-provenance`. Required, because a form
   * that mounts on three surfaces cannot carry ONE set of fixed ids: the record's
   * row and the nutrition sheet can be on screen at the same time.
   */
  testId: string;
}) {
  // WHICH SURFACE THIS WRITE CAME FROM (#3087), read off the region: one form renders
  // on the record, in the bar's modal and in the door, and the action cannot know which.
  const stampLoggedVia = useLoggedViaStamp();
  const contextTz = useTimezone();
  const tz = tzProp ?? contextTz;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groupKey, setGroupKey] = useState(
    row?.groupKey ?? groups[0]?.slug ?? ""
  );
  // The meal a stated instant falls in. ONE reading of that question, so the meal an
  // opening instant lands in and the meal a picked hour moves to cannot drift apart.
  function slotForStated(statedAt: string, onDate: string): FoodSlot {
    const offered = eatingHoursOnDate(
      onDate,
      tz,
      new Date(),
      slotBoundaries
    ).find((option) => option.iso === statedAt);
    return (
      offered?.slot ?? foodSlotForHhmm(statedHhmm(statedAt, tz), slotBoundaries)
    );
  }
  // The row's stated instant, rebuilt from its local wall clock on its own day, or the
  // instant this mount was opened on. An untouched time is omitted from the save,
  // precisely so this reconstruction is never written back over a second-precision
  // original.
  const openingStatedAt = row
    ? row.eatenAt
      ? (statedInstantOnDate(row.date, row.eatenAt, tz)?.toISOString() ?? null)
      : null
    : defaultStatedAt;
  const [mealSlot, setMealSlot] = useState<FoodSlot>(
    () =>
      row?.mealSlot ??
      (openingStatedAt !== null
        ? slotForStated(openingStatedAt, row?.date ?? date)
        : (slot ?? FOOD_SLOTS[0]))
  );
  const [mealTouched, setMealTouched] = useState(false);
  const [when, setWhen] = useState<WhenValue>(() => ({
    date: row?.date ?? date,
    statedAt: openingStatedAt,
  }));

  function moveWhen(next: WhenValue): void {
    if (
      !mealTouched &&
      next.statedAt !== null &&
      next.statedAt !== when.statedAt
    ) {
      setMealSlot(slotForStated(next.statedAt, next.date));
    }
    setWhen(next);
  }

  async function submit(): Promise<void> {
    const fd = stampLoggedVia(new FormData());
    fd.set("group_key", groupKey);
    fd.set("date", when.date);
    fd.set("meal_slot", mealSlot);
    if (subjectProfileId != null)
      fd.set("profile_id", String(subjectProfileId));
    const hhmm = statedHhmm(when.statedAt, tz) || null;
    if (row) {
      fd.set("event_id", String(row.eventId));
      // Three wire values (#2227): absent = unchanged, "none" = clear, "HH:MM" = state
      // that wall time on the submitted day.
      if (hhmm === null) {
        if (row.eatenAt !== null) fd.set("occurred_at", "none");
      } else if (hhmm !== row.eatenAt || when.date !== row.date) {
        fd.set("occurred_at", hhmm);
      }
    } else {
      // An untouched field states nothing, which `logFoodServing` reads as "no eating
      // time" rather than as a refusal — a backfill that says nothing still says nothing.
      fd.set("occurred_at", hhmm ?? "");
    }
    setPending(true);
    let outcome;
    try {
      outcome = row ? await updateFoodLogEvent(fd) : await logFoodServing(fd);
    } catch {
      setPending(false);
      setError("Couldn't save that serving.");
      return;
    }
    setPending(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setError(null);
    onSaved(
      "from" in outcome
        ? { kind: "corrected", from: outcome.from, to: outcome.to }
        : { kind: "added" }
    );
  }

  return (
    <form
      className="grid gap-2 sm:grid-cols-2"
      data-testid={`${testId}-form`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {row ? (
        // The one place the eating-time/tap split is answered (#2227 decision 7): the
        // binary a reader cares about is whether an eating time exists at all, and
        // "Logged at" over an eating time was a wrong claim.
        <p
          data-testid={`${testId}-provenance`}
          className="text-xs text-slate-500 sm:col-span-2 dark:text-slate-400"
        >
          {row.eatenAt
            ? `Ate at ${row.eatenAt}.`
            : `No eating time recorded${row.loggedAt ? ` — logged at ${row.loggedAt}` : ""}.`}{" "}
          Correcting moves this serving — the day&rsquo;s totals and meal
          tallies follow it.
        </p>
      ) : null}
      <label className="text-xs text-slate-500 dark:text-slate-400">
        Food group
        <select
          name="group_key"
          data-testid={`${testId}-group`}
          className="input mt-1 w-full"
          value={groupKey}
          onChange={(event) => setGroupKey(event.target.value)}
        >
          {groups.map((group) => (
            <option key={group.slug} value={group.slug}>
              {group.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-slate-500 dark:text-slate-400">
        Meal
        <select
          name="meal_slot"
          data-testid={`${testId}-slot`}
          className="input mt-1 w-full"
          value={mealSlot}
          onChange={(event) => {
            // A hand-set Meal wins from here on: the follow-the-hour default stops
            // moving it once the user has spoken.
            setMealSlot(event.target.value as FoodSlot);
            setMealTouched(true);
          }}
        >
          {FOOD_SLOTS.map((meal) => (
            <option key={meal} value={meal}>
              {meal}
            </option>
          ))}
        </select>
      </label>
      <div className="sm:col-span-2">
        <span className="label">When</span>
        {/* `recorded_at` is deliberately not here — the tap instant is audit history,
            never editable. */}
        <WhenControl
          mode={row ? "correct" : "state"}
          grain={row ? "hour" : "minute"}
          value={when}
          onChange={moveWhen}
          tz={tzProp}
          minDate={minDate}
          maxDate={maxDate}
          dateLabel="Date"
          timeLabel={row ? "Time eaten" : "Time"}
          testId={`${testId}-time`}
        />
      </div>
      <InlineError>{error}</InlineError>
      <div className="flex items-end gap-2 sm:col-span-2">
        <SubmitButton
          variant="primary"
          data-testid={`${testId}-save`}
          disabled={pending}
        >
          {pending ? "Saving…" : row ? "Save" : "Add"}
        </SubmitButton>
        <button
          className="btn-ghost"
          type="button"
          data-testid={`${testId}-cancel`}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

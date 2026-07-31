"use client";

import type { Dispatch, SetStateAction } from "react";
import { IconPlus, IconX } from "@tabler/icons-react";
import Combobox from "@/components/Combobox";
import DateField from "@/components/DateField";
import {
  TIME_BUCKETS,
  FOOD_TIMINGS,
  FOOD_TIMING_LABELS,
} from "@/lib/supplement-schedule";
import type { FoodTiming } from "@/lib/types";
import { WeekdayChips } from "@/components/intake/CadenceEditor";
import { doseCadenceLabel, normalizeWeekdays } from "@/lib/intake-cadence";

// One editable dose row's client state (shared by both intake forms, #846).
export interface DoseState {
  id?: number;
  amount: string;
  time_of_day: string;
  food_timing: FoodTiming;
  // Per-row calendar (#1602), behind the Advanced reveal. `weekdays` empty = every one
  // of the item's on-days. The date window is what expresses a TAPER as several rows
  // instead of a series of destructive amount edits.
  weekdays: number[];
  start_date: string;
  end_date: string;
}

export const emptyDose = (): DoseState => ({
  amount: "",
  time_of_day: "",
  food_timing: "any",
  weekdays: [],
  start_date: "",
  end_date: "",
});

// The dose-rows editor shared by both intake forms (#846): one or more amount /
// time-of-day / food-timing rows with add + remove. `dosageOptions` feeds the amount
// Combobox's suggestions (#1177) — the supplement catalog's dosages for a supplement,
// the OTC label strengths for a medication (each form supplies its own source; the
// editor is kind-blind). Free text is always allowed (a custom amount).
export default function DoseRowsEditor({
  doses,
  setDoses,
  dosageOptions,
  amountPlaceholder = "amount",
  singleAmountOnly = false,
  weekStart = 0,
}: {
  doses: DoseState[];
  setDoses: Dispatch<SetStateAction<DoseState[]>>;
  dosageOptions: string[];
  amountPlaceholder?: string;
  // The profile's first day of the week, so the per-dose chips are ordered exactly
  // like every other calendar surface.
  weekStart?: number;
  // PRN ⇒ amount-only mode (#851 item 9): a PRN medication carries exactly ONE
  // amount-only dose (plus its with-food relation) — no time-of-day slots, no split,
  // no add/remove — because the redose interval owns "when". A no-op for the scheduled
  // supplement/medication editor, which keeps the full slot + split affordances.
  singleAmountOnly?: boolean;
}) {
  function setDose(i: number, patch: Partial<DoseState>) {
    setDoses((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  }

  if (singleAmountOnly) {
    const d = doses[0] ?? emptyDose();
    return (
      <div className="sm:col-span-2" data-testid="prn-dose-row">
        <div className="mb-2 section-label">Dose</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Combobox
            ariaLabel="Amount"
            value={d.amount}
            onChange={(v) =>
              setDoses((ds) => {
                const first = ds[0] ?? emptyDose();
                return [{ ...first, amount: v, time_of_day: "" }];
              })
            }
            options={dosageOptions}
            allowFreeText
            placeholder={amountPlaceholder}
          />
          <select
            value={d.food_timing}
            onChange={(e) =>
              setDoses((ds) => {
                const first = ds[0] ?? emptyDose();
                return [
                  {
                    ...first,
                    food_timing: e.target.value as FoodTiming,
                    time_of_day: "",
                  },
                ];
              })
            }
            className="input"
            aria-label="Food timing"
          >
            {FOOD_TIMINGS.map((ft) => (
              <option key={ft} value={ft}>
                {FOOD_TIMING_LABELS[ft]}
              </option>
            ))}
          </select>
        </div>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          As-needed doses have no set time — the redose reminder covers “when”.
        </p>
      </div>
    );
  }

  return (
    <div className="sm:col-span-2">
      <div className="mb-2 section-label">Doses</div>
      <div className="space-y-2">
        {doses.map((d, i) => (
          <div
            key={i}
            className={`grid gap-2 sm:items-center ${
              doses.length > 1
                ? "sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.25fr)_2.5rem]"
                : "sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.25fr)]"
            }`}
          >
            <Combobox
              ariaLabel="Amount"
              value={d.amount}
              onChange={(v) => setDose(i, { amount: v })}
              options={dosageOptions}
              allowFreeText
              placeholder={amountPlaceholder}
            />
            <select
              value={d.time_of_day || "Anytime"}
              onChange={(e) => setDose(i, { time_of_day: e.target.value })}
              className="input"
              aria-label="Time of day"
            >
              {TIME_BUCKETS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select
              value={d.food_timing}
              onChange={(e) =>
                setDose(i, { food_timing: e.target.value as FoodTiming })
              }
              className="input"
              aria-label="Food timing"
            >
              {FOOD_TIMINGS.map((ft) => (
                <option key={ft} value={ft}>
                  {FOOD_TIMING_LABELS[ft]}
                </option>
              ))}
            </select>
            {doses.length > 1 && (
              <button
                type="button"
                onClick={() => setDoses((ds) => ds.filter((_, j) => j !== i))}
                className="tap-target flex h-10 w-10 items-center justify-center justify-self-end rounded-lg text-slate-500 transition hover:bg-rose-50 hover:text-rose-600 dark:text-slate-400 dark:hover:bg-rose-950 dark:hover:text-rose-400"
                aria-label="Remove dose"
                title="Remove dose"
              >
                <IconX className="h-4 w-4" />
              </button>
            )}
            {/* Per-row calendar (#1602) behind a reveal: most rows never need it, and
                putting weekday chips and a date window on every dose would make the
                ordinary two-slot schedule look like a scheduling system. The summary
                stays OPEN once the row has a rule, so a constraint that changes when
                the dose lands is never hidden behind a closed disclosure. */}
            <details
              className="sm:col-span-full"
              open={d.weekdays.length > 0 || !!d.start_date || !!d.end_date}
            >
              <summary
                className="cursor-pointer text-xs text-slate-500 dark:text-slate-400"
                data-testid={`dose-advanced-${i}`}
              >
                {doseCadenceLabel({
                  weekdays: normalizeWeekdays(d.weekdays),
                  start_date: d.start_date || null,
                  end_date: d.end_date || null,
                }) ?? "Only on certain days or dates"}
              </summary>
              <div className="mt-2 space-y-2 border-l-2 border-black/10 pl-3 dark:border-white/10">
                <WeekdayChips
                  value={d.weekdays}
                  onChange={(weekdays) => setDose(i, { weekdays })}
                  weekStart={weekStart}
                  idPrefix={`dose-${i}`}
                />
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-xs text-slate-500 dark:text-slate-400">
                    From
                    <DateField
                      value={d.start_date}
                      onChange={(start_date) => setDose(i, { start_date })}
                      inputClassName="mt-1"
                      data-testid={`dose-${i}-start-date`}
                    />
                  </label>
                  <label className="text-xs text-slate-500 dark:text-slate-400">
                    Until
                    <DateField
                      value={d.end_date}
                      onChange={(end_date) => setDose(i, { end_date })}
                      inputClassName="mt-1"
                      data-testid={`dose-${i}-end-date`}
                    />
                  </label>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Ending a dose here stops it being due — its history is kept.
                </p>
              </div>
            </details>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setDoses((ds) => [...ds, emptyDose()])}
        className="btn-ghost btn-sm mt-2"
      >
        <IconPlus className="h-4 w-4" stroke={2} aria-hidden="true" />
        Add dose
      </button>
    </div>
  );
}
